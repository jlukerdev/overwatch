// Trust-on-first-use TLS certificate pinning (CON-3, NFR-9). This productionizes the P0.3 spike:
// scripts/spikes/lib/tls.ts proved the approach, docs/spikes/P0.3-protect-api.md §8 records it.
//
// Every HTTPS/WSS call the app makes goes through an Agent from here: the Protect Integration API
// on the console's 443 and, when Access is enabled, the Access API on 12445, whose certificate may
// differ (P0.4 §4, SPEC §5.2). Pins and Agents are therefore keyed by `host:port`, and one Agent
// is kept per endpoint so connections are reused — P1.3's 10 req/s throttling depends on that.
// The same Agent is the `dispatcher` for `fetch` **and** for undici's `WebSocket`: that is how
// P0.3 drove /subscribe/{devices,events}, and both paths get the same pin check.
//
// Three rules this module exists to keep:
//  1. Global TLS verification is never touched (CLAUDE.md). `rejectUnauthorized: false` lives in
//     this one connector, and it is always paired with a leaf-fingerprint check that runs before
//     any request bytes are written.
//  2. A mismatched fingerprint blocks the connection with a clear warning. Re-pinning is always a
//     deliberate user action (CON-3), never automatic.
//  3. Nothing here touches a secret (NFR-9, R5): the inputs are hosts, ports and certificates, and
//     the module does no logging at all, so no key or token can leak through it.
//
// Scope: HTTPS and WSS only. The RTSPS leg into go2rtc is *not* pinned — go2rtc cannot pin a
// certificate, so host equality plus loopback binding is the whole mitigation there (R4, SPEC §5.3).
//
// Deliberately free of config, Electron and UI imports: pins arrive and are committed through the
// injected `PinStore` port, so P1.6 can back it with the config store without this file knowing.
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { TLSSocket, connect as tlsConnect, type Certificate, type PeerCertificate } from 'node:tls'
import { Agent, buildConnector } from 'undici'

/** How long `fetchLeafCert` waits for a handshake before giving up. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000
const DEFAULT_BODY_TIMEOUT_MS = 30_000

/** What the CON-3 accept dialog shows the user, plus the fingerprint that gets pinned. */
export interface LeafCertInfo {
  host: string
  port: number
  /** `host:port`, the key this endpoint's pin and Agent are stored under. */
  hostPort: string
  /** Colon-separated uppercase SHA-256 of the DER leaf certificate (Node's `fingerprint256`). */
  fingerprint256: string
  /** Subject CN, or null when the certificate has none. */
  subjectCommonName: string | null
  /** Issuer CN, or null when the certificate has none. */
  issuerCommonName: string | null
  /** Validity window, as Node formats it (e.g. `Dec  5 00:00:00 2024 GMT`). */
  validFrom: string
  validTo: string
  /** True when issuer and subject are the same name, as on the console's own certificate. */
  selfSigned: boolean
}

/**
 * The pin storage port. The real implementation is backed by the config store (a later task);
 * this module never imports it. `get` returns null only when the endpoint has no pin at all.
 */
export interface PinStore {
  get(hostPort: string): string | null
  set(hostPort: string, fingerprint256: string): void
}

export interface PinEndpoint {
  host: string
  port: number
  hostPort: string
}

/**
 * The three states CON-3 implies, as explicit results: P1.6's accept dialog and P1.3/P1.4's
 * clients both branch on them, so they are not booleans and not thrown strings.
 * - `no-pin`: nothing pinned yet. Show the fingerprint, and on "Trust" call `acceptPin`.
 * - `match`: proceed; `agentFor` will hand out a pinned Agent.
 * - `mismatch`: block and warn. Only an explicit `repin` may replace the pin.
 */
export type PinCheckResult =
  | { state: 'no-pin'; endpoint: PinEndpoint; cert: LeafCertInfo }
  | { state: 'match'; endpoint: PinEndpoint; fingerprint256: string; cert: LeafCertInfo }
  | {
      state: 'mismatch'
      endpoint: PinEndpoint
      expected: string
      actual: string
      cert: LeafCertInfo
      /** Ready to show in Settings; carries both fingerprints. */
      message: string
    }

export interface PinnedAgentOptions {
  /** `host:port`, used in error messages. */
  endpoint?: string | null
  connectTimeoutMs?: number
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
}

export interface PinRegistryOptions {
  probeTimeoutMs?: number
  /** Timeouts for every Agent the registry builds. `endpoint` is set per Agent and ignored here. */
  agent?: Omit<PinnedAgentOptions, 'endpoint'>
}

export interface PinRegistry {
  /** Reads the leaf and compares it with the stored pin. Sends no request. */
  checkEndpoint(host: string, port: number, timeoutMs?: number): Promise<PinCheckResult>
  /** The pinned fingerprint for an endpoint, or null when it has none yet. */
  pinnedFingerprint(host: string, port: number): string | null
  /** Commits the first pin ("Trust this certificate", CON-3). Throws if one is already pinned. */
  acceptPin(host: string, port: number, fingerprint256: string): void
  /** Replaces an existing pin. The UI drives this; it never happens on its own (CON-3). */
  repin(host: string, port: number, fingerprint256: string): void
  /** The pinned Agent for an endpoint, created on first use and reused afterwards. */
  agentFor(host: string, port: number): Agent
  /** Destroys and forgets the cached Agent for an endpoint. */
  invalidate(host: string, port: number): void
  /** Closes every cached Agent. Call on app shutdown. */
  closeAll(): Promise<void>
}

/** A leaf that does not match its pin. Carries both fingerprints so Settings can show them. */
export class PinMismatchError extends Error {
  override readonly name = 'PinMismatchError'
  readonly endpoint: string | null
  readonly expected: string
  /** The presented fingerprint, or null when the peer sent no certificate at all. */
  readonly actual: string | null

  constructor(args: { endpoint?: string | null; expected: string; actual: string | null }) {
    super(pinMismatchMessage(args.endpoint ?? null, args.expected, args.actual))
    this.endpoint = args.endpoint ?? null
    this.expected = args.expected
    this.actual = args.actual
  }
}

/** An endpoint was used before its certificate was accepted. The caller must run the dialog. */
export class PinRequiredError extends Error {
  override readonly name = 'PinRequiredError'
  readonly endpoint: string

  constructor(endpoint: string) {
    super(
      `No TLS certificate is pinned for ${endpoint} yet. Connect once from Settings and accept ` +
        "the certificate's SHA-256 fingerprint first (CON-3).",
    )
    this.endpoint = endpoint
  }
}

/**
 * Canonical pin/Agent key. Pins are per host **and** port: the certificate the console presents
 * on 12445 may differ from the one on 443 (P0.4 §4), so one pin per endpoint, never per host.
 */
export function hostPortKey(host: string, port: number): string {
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return `${bare.includes(':') ? `[${bare}]` : bare}:${String(port)}`
}

/**
 * Normalises `aa:bb...`, `AABB...`, `aa-bb-...` or spaced hex to Node's `AA:BB:...`
 * `fingerprint256` form. Separators may be `:`, `-` or whitespace; anything else, or a digit
 * count other than 64, is rejected rather than quietly stripped.
 */
export function normalizeFingerprint(fp: string): string {
  const bad = 'A SHA-256 fingerprint must be 64 hex digits, optionally separated by ":" or "-"'
  const hex = fp.replace(/[\s:-]/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error(bad)
  const pairs = hex.match(/../g)
  // 64 digits always pair up; the guard only narrows `string[] | null` away.
  if (pairs === null) throw new Error(bad)
  return pairs.join(':')
}

/**
 * True when both arguments name the same certificate, whatever formatting they arrived in: both
 * sides are normalized first, so a pin typed by hand compares equal to Node's own form. Invalid
 * input is `false`, never a throw, so this is safe to call on whatever a peer presents.
 *
 * A fingerprint is public, so a timing leak buys an attacker nothing (they would still need the
 * matching private key), but a constant-time compare costs nothing here.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  let left: string
  let right: string
  try {
    left = normalizeFingerprint(a)
    right = normalizeFingerprint(b)
  } catch {
    return false
  }
  // Both are exactly 95 characters after normalizing, so this cannot throw on a length mismatch.
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'))
}

/** The warning Settings and the pinned Agent both show on a mismatch. */
export function pinMismatchMessage(
  endpoint: string | null,
  expected: string,
  actual: string | null,
): string {
  const where = endpoint === null ? '' : ` for ${endpoint}`
  const presented =
    actual === null
      ? 'the server presented no certificate (a resumed TLS session would also look like this)'
      : `the server presented ${actual}`
  return (
    `TLS certificate pin mismatch${where}: expected ${expected}, but ${presented}. ` +
    'Refusing to connect. If you replaced or reinstalled the console, check its new fingerprint ' +
    'on the console itself and re-pin it in Settings; otherwise someone may be intercepting the ' +
    'connection.'
  )
}

/** SNI is a hostname field: sending an IP literal in it is invalid, so only set it for names. */
function sniName(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined
}

function commonName(name: Certificate | undefined): string | null {
  const cn = name?.CN
  return typeof cn === 'string' && cn.length > 0 ? cn : null
}

/** Issuer and subject are the same name — true for the console's own certificate (P0.3 §8). */
function isSelfSigned(cert: PeerCertificate): boolean {
  return JSON.stringify(cert.issuer) === JSON.stringify(cert.subject)
}

/**
 * Node types `fingerprint256` as `string`, but a connection that resumed a TLS session carries no
 * peer certificate and leaves it unset — exactly the P0.3 §8 failure. `maxCachedSessions: 0` keeps
 * that from happening; reading it defensively keeps it a clear error if it ever does.
 */
function presentedFingerprint(socket: TLSSocket): string | undefined {
  const value: unknown = socket.getPeerCertificate().fingerprint256
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The TOFU read step: one handshake with verification off, purely to read the leaf certificate so
 * the user can be shown its fingerprint and accept it (CON-3). Nothing is ever sent over this
 * socket, and it is destroyed on every path — success, mismatch, timeout and error — so a failed
 * probe leaves nothing behind.
 */
export function fetchLeafCert(
  host: string,
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LeafCertInfo> {
  return new Promise((resolve, reject) => {
    const endpoint = hostPortKey(host, port)
    const name = sniName(host)
    const socket = tlsConnect({
      host,
      port,
      // Scoped to this one probe: it reads a certificate and sends nothing.
      rejectUnauthorized: false,
      ...(name === undefined ? {} : { servername: name }),
    })
    let settled = false
    // A wall-clock deadline, not socket.setTimeout: `timeoutMs` is how long the caller is willing
    // to wait, and an inactivity timer can be kept alive indefinitely by a trickling peer.
    const timer = setTimeout(() => {
      fail(
        new Error(`Reading the certificate of ${endpoint} timed out after ${String(timeoutMs)} ms`),
      )
    }, timeoutMs)
    // Destroying the socket on every path — success, no certificate, timeout, error — is the
    // point: a probe that fails must leave nothing open.
    function stop(): void {
      settled = true
      clearTimeout(timer)
      socket.destroy()
    }
    function fail(err: Error): void {
      if (settled) return
      stop()
      reject(err)
    }
    function succeed(info: LeafCertInfo): void {
      if (settled) return
      stop()
      resolve(info)
    }

    socket.once('error', fail)
    socket.once('close', () => {
      fail(new Error(`${endpoint} closed the connection before the TLS handshake finished`))
    })
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      if (!cert.fingerprint256) {
        fail(new Error(`${endpoint} did not present a TLS certificate`))
        return
      }
      succeed({
        host,
        port,
        hostPort: endpoint,
        fingerprint256: normalizeFingerprint(cert.fingerprint256),
        subjectCommonName: commonName(cert.subject),
        issuerCommonName: commonName(cert.issuer),
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        selfSigned: isSelfSigned(cert),
      })
    })
  })
}

/**
 * An undici `Agent` whose handshakes only complete when the leaf matches `fingerprint256`; on
 * anything else the socket is destroyed and the connection fails with a `PinMismatchError`.
 *
 * Usable as the `dispatcher` for both `fetch` and undici's `WebSocket`. For a WebSocket the
 * header/body timeouts only cover the handshake: undici hands the socket over on upgrade.
 */
export function createPinnedAgent(fingerprint256: string, options: PinnedAgentOptions = {}): Agent {
  const expected = normalizeFingerprint(fingerprint256)
  const endpoint = options.endpoint ?? null
  // `maxCachedSessions: 0` — TLS session resumption MUST stay off. On a resumed session
  // getPeerCertificate() returns no fingerprint, so the check below fails and every connection
  // after the first one breaks (P0.3 §8, SPEC §5.1 TLS bullet). Do not "optimize" this back.
  //
  // `rejectUnauthorized: false` is confined to this connector: the chain cannot validate against
  // a CA because the console signs its own certificate, so the pin *is* the verification, and it
  // runs before the socket is handed to undici — i.e. before any request bytes are written.
  const base = buildConnector({
    rejectUnauthorized: false,
    maxCachedSessions: 0,
    timeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  })
  return new Agent({
    headersTimeout: options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    bodyTimeout: options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
    connect(opts, callback) {
      base(opts, (err, socket) => {
        if (err !== null) {
          callback(err, null)
          return
        }
        if (!(socket instanceof TLSSocket)) {
          socket.destroy()
          callback(new Error('The pinned Agent refuses plaintext connections; use https://'), null)
          return
        }
        const presented = presentedFingerprint(socket)
        if (presented === undefined || !fingerprintsMatch(presented, expected)) {
          socket.destroy()
          callback(new PinMismatchError({ endpoint, expected, actual: presented ?? null }), null)
          return
        }
        callback(null, socket)
      })
    },
  })
}

/**
 * Keeps one pin and one Agent per `host:port`, and turns the pin state into the three explicit
 * results above. It owns no storage: pins are read from and written to the injected `PinStore`.
 */
export function createPinRegistry(store: PinStore, options: PinRegistryOptions = {}): PinRegistry {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const agentOptions = options.agent ?? {}
  const agents = new Map<string, { agent: Agent; fingerprint256: string }>()

  /**
   * A stored value that is not a fingerprint is an error, never "unpinned": treating it as
   * unpinned would silently re-pin the next connection, which CON-3 forbids.
   */
  const readPin = (hostPort: string): string | null => {
    const raw = store.get(hostPort)
    if (raw === null) return null
    try {
      return normalizeFingerprint(raw)
    } catch {
      throw new Error(
        `The stored TLS pin for ${hostPort} is not a SHA-256 fingerprint. Re-accept the ` +
          'certificate in Settings (repin) to replace it.',
      )
    }
  }

  /** Drops a cached Agent so it cannot outlive the pin it was built for. */
  const drop = (hostPort: string): void => {
    const cached = agents.get(hostPort)
    if (cached === undefined) return
    agents.delete(hostPort)
    // destroy, not close: in-flight requests are bound to a pin that is no longer trusted, so
    // they must fail rather than drain.
    void cached.agent.destroy()
  }

  const commit = (host: string, port: number, fingerprint256: string, replace: boolean): void => {
    const hostPort = hostPortKey(host, port)
    const next = normalizeFingerprint(fingerprint256)
    // Only the first-pin path reads what is stored. `repin` is an explicit overwrite, and it has to
    // work even when the stored value is unparsable — that is precisely when the user is recovering
    // from it, and `PinStore` has no clear() for them to use instead.
    if (!replace) {
      const current = readPin(hostPort)
      if (current !== null && !fingerprintsMatch(current, next)) {
        throw new Error(
          `${hostPort} is already pinned to a different certificate. Re-pinning is an explicit ` +
            'user action (CON-3): use repin() from the Settings flow.',
        )
      }
    }
    store.set(hostPort, next)
    drop(hostPort)
  }

  return {
    async checkEndpoint(host, port, timeoutMs = probeTimeoutMs) {
      const endpoint: PinEndpoint = { host, port, hostPort: hostPortKey(host, port) }
      const expected = readPin(endpoint.hostPort)
      const cert = await fetchLeafCert(host, port, timeoutMs)
      if (expected === null) return { state: 'no-pin', endpoint, cert }
      if (fingerprintsMatch(expected, cert.fingerprint256))
        return { state: 'match', endpoint, fingerprint256: expected, cert }
      return {
        state: 'mismatch',
        endpoint,
        expected,
        actual: cert.fingerprint256,
        cert,
        message: pinMismatchMessage(endpoint.hostPort, expected, cert.fingerprint256),
      }
    },

    pinnedFingerprint(host, port) {
      return readPin(hostPortKey(host, port))
    },

    acceptPin(host, port, fingerprint256) {
      commit(host, port, fingerprint256, false)
    },

    repin(host, port, fingerprint256) {
      commit(host, port, fingerprint256, true)
    },

    agentFor(host, port) {
      const hostPort = hostPortKey(host, port)
      const pinned = readPin(hostPort)
      if (pinned === null) throw new PinRequiredError(hostPort)
      const cached = agents.get(hostPort)
      if (cached !== undefined) {
        // The store is the source of truth: if its pin changed behind our back, the cached Agent
        // was built for a pin that no longer applies.
        if (cached.fingerprint256 === pinned) return cached.agent
        drop(hostPort)
      }
      const agent = createPinnedAgent(pinned, { ...agentOptions, endpoint: hostPort })
      agents.set(hostPort, { agent, fingerprint256: pinned })
      return agent
    },

    invalidate(host, port) {
      drop(hostPortKey(host, port))
    },

    async closeAll() {
      const open = [...agents.values()]
      agents.clear()
      await Promise.all(open.map((cached) => cached.agent.close()))
    },
  }
}
