// Everything about the go2rtc sidecar that is a *value* rather than an action (P2.1, SPEC §5.3):
// the generated YAML config, the per-launch API credentials, the loopback URLs, the Protect →
// go2rtc source transform, the log redactors and the allowlisted `/api/streams` summary.
//
// It is deliberately pure — no filesystem, no process, no network, no Electron, no module state —
// because this is where the security-relevant decisions of the streaming pipeline are made, and a
// pure module can have every one of those decisions asserted line by line in a unit test
// (`tests/unit/go2rtcConfig.test.ts`). `go2rtcManager.ts` is the only thing that does I/O with it.
//
// Ported from the reviewed P0.5 spike: `scripts/spikes/video-spike/lib.ts`. `src/main` may not
// import from `scripts/`, so the code is **copied** rather than shared, and this comment is here so
// the duplication is visible and intentional. The spike files stay untouched (their tests still
// run). Differences from the spike are marked `Deviation from the spike` below.
//
// Why each rule in `buildGo2rtcConfig` exists (SPEC §5.3 "go2rtc process contract" / "API auth"):
//
//  1. **Only four modules.** `api`, `ws`, `rtsp` (the RTSP *client*, for the RTSPS upstream) and
//     `mp4` (the MSE WebSocket handler). WebRTC, HomeKit, SRTP and RTMP never load, so they can
//     never open a listener or a hole in the loopback-only posture.
//  2. **`api.listen: 127.0.0.1:<port>` and `rtsp.listen: ""`.** The API port is the process's only
//     listening socket; the RTSP server is off while the RTSP client still works (verified with
//     `lsof` during the P0.5 run). CLAUDE.md: "go2rtc listens on 127.0.0.1 only".
//  3. **`api.origin: ""`.** go2rtc's default same-origin WebSocket check stays on. Never `"*"`:
//     any website open in the user's browser could then attach to the loopback port and watch the
//     cameras. Main rewrites `Origin` for the renderer instead (a later task).
//  4. **`allow_paths` = `/api`, `/api/ws`, `/api/streams`.** No web UI, no `/api/config` (which
//     would hand out the credentials), no `/api/exit`.
//  5. **Random credentials plus `api.local_auth: true`.** Loopback-only is not enough: another
//     local process could otherwise read `/api/streams` or attach to `/api/ws`. go2rtc v1.9.15
//     *skips* Basic auth for loopback clients unless `local_auth` is set, so without that flag the
//     credentials would do nothing at all (P0.5 §"Security"). The credentials live for one launch,
//     in memory and in a `0600` file that is deleted as soon as the API answers, and they go into
//     the redactors below so they can never reach a log line (CON-2, NFR-9).
//
// **No secrets leave main.** The RTSPS source URLs (whose 16-char alias is the credential for the
// camera stream) and the API credentials are inputs here and never outputs: the renderer only ever
// gets a port and a stream name (CON-2, NFR-9, SPEC §6.1 "No secrets, ever").

/** The file `go2rtcManager` writes into `<userData>/` (ARCHITECTURE §4). Never hand-edited. */
export const GO2RTC_CONFIG_FILE = 'go2rtc.yaml'

/** The only modules go2rtc loads (SPEC §5.3). `rtsp` is the client; the server is disabled below. */
export const GO2RTC_MODULES: readonly string[] = ['api', 'ws', 'rtsp', 'mp4']

/** The only API paths go2rtc serves: no web UI, no `/api/config`, no `/api/exit` (SPEC §5.3). */
export const GO2RTC_ALLOW_PATHS: readonly string[] = ['/api', '/api/ws', '/api/streams']

/** The one interface go2rtc may bind (CLAUDE.md, ARCHITECTURE §2 rule 2). */
export const GO2RTC_HOST = '127.0.0.1'

// ---------------------------------------------------------------------------------------------
// Source URL transform (SPEC §5.3 "Source URL transform", R4)

/**
 * Protect RTSPS URL → go2rtc source:
 *
 *     rtsps://<console-host>:7441/<alias>?enableSrtp   →   rtspx://<console-host>:7441/<alias>
 *
 * `rtsps://` becomes `rtspx://`, go2rtc's TLS RTSP scheme with **certificate verification off**,
 * because the console's leaf certificate is self-signed and go2rtc cannot pin one (R4). `enableSrtp`
 * must be **stripped** or the console expects SRTP and go2rtc's RTSP-over-TLS session fails
 * (go2rtc issue #81); other query parameters and the path are kept verbatim.
 *
 * R4's whole mitigation is that this unpinned scheme is only ever used toward the pinned console
 * host, which is why {@link sourceHostIs} exists and why `go2rtcManager` refuses any other source.
 */
export function toGo2rtcSource(rtspsUrl: string): string {
  const m = /^rtsps:\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:\?([^#\s]*))?$/i.exec(rtspsUrl.trim())
  if (!m) throw new Error('Not an rtsps:// URL')
  const [, authority = '', path = '', query] = m
  const kept = (query ?? '')
    .split('&')
    .filter((p) => p !== '' && p.split('=')[0]?.toLowerCase() !== 'enablesrtp')
  return `rtspx://${authority}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}`
}

/**
 * The host an RTSP client would actually connect to: lower-cased, **without** IPv6 brackets, and
 * `null` when the source cannot be parsed unambiguously — fail closed, because this is the only
 * thing standing between the unpinned `rtspx://` scheme and an off-host target (R4).
 *
 * The authority's userinfo is everything up to its **last** `@`, which is how Go's `net/url` — and
 * therefore go2rtc — reads it. Reading the host as "up to the first `:`" instead is the bypass this
 * function exists to refuse: in `rtspx://console.local:7441@evil.example:7441/alias` the pinned
 * host appears as a *password* and the connection goes to `evil.example`.
 */
function sourceHost(source: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(source.trim())
  const authority = m?.[1]
  if (authority === undefined || authority === '') return null
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostPort === '') return null
  if (hostPort.startsWith('[')) {
    // An IPv6 literal: `[host]` optionally followed by `:port`, and nothing else.
    const end = hostPort.indexOf(']')
    if (end < 1) return null
    const rest = hostPort.slice(end + 1)
    if (rest !== '' && !/^:[0-9]+$/.test(rest)) return null
    return hostPort.slice(1, end).toLowerCase()
  }
  // A name or an IPv4 literal: at most one `:port`, and nothing that could hide a second host.
  const parts = hostPort.split(':')
  const host = parts[0] ?? ''
  if (host === '' || parts.length > 2) return null
  if (parts.length === 2 && !/^[0-9]+$/.test(parts[1] ?? '')) return null
  if (/[[\]]/.test(host)) return null
  return host.toLowerCase()
}

/**
 * True if the source's real host is `host` (the no-verify scheme is only ever used toward the
 * pinned console host, R4). Anything that cannot be parsed, and any empty pin, is refused.
 *
 * Both sides are compared without IPv6 brackets, so the pin matches in every form the app can
 * produce: `console/endpoints.ts` hands out an unbracketed `host` (`::1`), while the source URL
 * carries the bracketed authority (`rtspx://[::1]:7441/…`).
 *
 * **Deviation from the spike:** the spike reads the host as the authority up to the first `:`,
 * which both makes an IPv6 console address unable to match itself and lets a userinfo *with a
 * colon* impersonate the pinned host. `scripts/spikes/video-spike/lib.ts` still has that version;
 * it is recorded P0.5 evidence and is not used by the app.
 */
export function sourceHostIs(source: string, host: string): boolean {
  const pinned = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (pinned === '') return false
  const actual = sourceHost(source)
  return actual !== null && actual === pinned
}

// ---------------------------------------------------------------------------------------------
// Per-launch API credentials

/** Credentials for go2rtc's HTTP/WS API (Basic auth), generated fresh for every launch. */
export interface Go2rtcAuth {
  username: string
  password: string
}

/**
 * base64url only, at least 16 characters: no `:` (Basic auth splits the decoded value on it) and
 * nothing YAML gives a meaning to, so a credential can never change the shape of the config.
 */
const AUTH_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

export function isValidAuthToken(value: string): boolean {
  return AUTH_TOKEN.test(value)
}

/**
 * New random API credentials. `random(n)` must return `n` cryptographically random bytes
 * (`crypto.randomBytes` in `go2rtcManager`). 18 bytes → 24 base64url characters, so 144 bits each.
 */
export function createGo2rtcAuth(random: (n: number) => Uint8Array): Go2rtcAuth {
  const token = (): string => Buffer.from(random(18)).toString('base64url')
  const auth: Go2rtcAuth = { username: `vp_${token()}`, password: token() }
  if (!isValidAuthToken(auth.username) || !isValidAuthToken(auth.password))
    throw new Error('Random source returned too few bytes')
  return auth
}

/**
 * The `Authorization` header value for go2rtc. **Main-process use only** (CON-2, NFR-9): it
 * authenticates every one of main's own calls (health, `/api/streams`, `PUT /api/streams`) and is
 * injected into the renderer's requests by a `webRequest` hook in a later task, so the renderer
 * itself never holds it.
 */
export function basicAuthHeader(auth: Go2rtcAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`
}

/** Every string form of the credentials that could end up in a log line, for {@link redactSecrets}. */
export function authSecrets(auth: Go2rtcAuth): string[] {
  const header = basicAuthHeader(auth)
  return [header.slice('Basic '.length), auth.password, auth.username]
}

/**
 * Replaces each secret (longest first, so a token is not half-replaced through a substring of
 * another) and any `Basic`/`Bearer` value with `<redacted>`. Values shorter than 4 characters are
 * ignored: redacting those would mangle unrelated text without protecting anything.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, '$1 <redacted>')
  for (const s of [...secrets].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length))
    out = out.split(s).join('<redacted>')
  return out
}

/**
 * Redacts anything that looks like an RTSP(S) URL. The alias in a Protect RTSPS URL *is* the
 * credential for that camera's stream, and go2rtc logs its sources on connect and on every
 * reconnect error, so this runs over every line of the child's output (CON-2, NFR-9).
 */
export function redactSourceUrls(line: string): string {
  return line.replace(/\brtsp[sx]?:\/\/[^\s"',}]+/gi, '<redacted-source-url>')
}

// ---------------------------------------------------------------------------------------------
// Loopback URLs

/** `http://127.0.0.1:<port><path>`, for main's own authenticated API calls. */
export function go2rtcApiUrl(port: number, path = '/api'): string {
  return `http://${GO2RTC_HOST}:${String(port)}${path}`
}

/** The loopback MSE WebSocket URL for one stream — the only streaming detail the renderer gets. */
export function go2rtcWsUrl(port: number, stream: string): string {
  return `ws://${GO2RTC_HOST}:${String(port)}/api/ws?src=${encodeURIComponent(stream)}`
}

// ---------------------------------------------------------------------------------------------
// The generated config

/** Stream names the renderer may see: letters, digits, `_` and `-` only (`<cameraId>_<quality>`). */
export function isSafeStreamName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

export interface Go2rtcConfigInput {
  /** Loopback port for the HTTP/WS API — the process's only listener. */
  port: number
  /** go2rtc stream name → source URL. May be empty; see the note in {@link buildGo2rtcConfig}. */
  streams: Readonly<Record<string, string>>
  /** Per-launch API credentials. Enforced for loopback clients too (`local_auth: true`). */
  auth: Go2rtcAuth
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
}

/**
 * The go2rtc YAML config. See this file's header for why each line is there; the shape is the one
 * verified in P0.5 against go2rtc v1.9.15. Scalars are JSON-quoted, which is valid YAML and means
 * no value can ever be reinterpreted as YAML syntax.
 *
 * **Deviation from the spike:** an empty `streams:` section is legal here. The spike always had
 * exactly one hard-coded stream and threw on none, whereas the app starts go2rtc before it knows
 * any camera — the registry (P2.2) registers streams at runtime through `PUT /api/streams`, and
 * every launch with no View open yet is a zero-stream launch. go2rtc accepts an empty section.
 */
export function buildGo2rtcConfig(input: Go2rtcConfigInput): string {
  const { port, streams, auth } = input
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  if (!isValidAuthToken(auth.username) || !isValidAuthToken(auth.password))
    throw new Error('Invalid go2rtc API credentials')
  const q = (s: string): string => JSON.stringify(s)
  const lines = [
    `# Generated by src/main/streams/go2rtcManager.ts (${GO2RTC_CONFIG_FILE}).`,
    '# Contains RTSPS credentials: never commit, never hand-edit. Deleted once go2rtc has read it.',
    'app:',
    `  modules: [${GO2RTC_MODULES.map(q).join(', ')}]`,
    'api:',
    `  listen: ${q(`${GO2RTC_HOST}:${String(port)}`)}`,
    `  origin: ${q('')}`,
    `  allow_paths: [${GO2RTC_ALLOW_PATHS.map(q).join(', ')}]`,
    `  username: ${q(auth.username)}`,
    `  password: ${q(auth.password)}`,
    '  local_auth: true',
    'rtsp:',
    `  listen: ${q('')}`,
    'log:',
    `  level: ${q(input.logLevel ?? 'info')}`,
    'streams:',
  ]
  for (const [name, source] of Object.entries(streams)) {
    if (!isSafeStreamName(name)) throw new Error(`Unsafe stream name "${name}"`)
    lines.push(`  ${name}: ${q(source)}`)
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// `/api/streams` summary (R7)

/**
 * What main is willing to know about a go2rtc stream. R7: cameras carry no codec field, so H.265 vs
 * H.264 can only be told from the producer go2rtc negotiated, and P2.3/P2.5 need exactly this much.
 */
export interface StreamCodecSummary {
  /** e.g. `video, recvonly, H265` / `audio, recvonly, MPEG4-GENERIC` from the producer medias. */
  producerMedias: string[]
  /** Codec names go2rtc negotiated with the camera (e.g. `H265`, `AAC`). */
  producerCodecs: string[]
  consumers: number
  /** Codec names sent to consumers. */
  consumerCodecs: string[]
  /** Per-track counters. `drops` counts packets dropped because a consumer could not keep up. */
  tracks: TrackCounters[]
}

export interface TrackCounters {
  side: 'receiver' | 'sender'
  codec: string
  packets: number
  bytes: number
  drops: number
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : []
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function trackCounters(tracks: unknown, side: TrackCounters['side']): TrackCounters[] {
  return asArray(tracks).flatMap((t) => {
    const r = asRecord(t)
    if (!r) return []
    const name = asRecord(r.codec)?.codec_name
    return [
      {
        side,
        codec: typeof name === 'string' ? name : '?',
        packets: num(r.packets),
        bytes: num(r.bytes),
        drops: num(r.drops),
      },
    ]
  })
}

function codecNames(tracks: unknown): string[] {
  return asArray(tracks).flatMap((t) => {
    const name = asRecord(asRecord(t)?.codec)?.codec_name
    return typeof name === 'string' ? [name] : []
  })
}

/**
 * Allowlist summary of go2rtc's `GET /api/streams?src=<name>` body. The producer `url` (an RTSPS
 * URL), remote addresses and user agents are **dropped**, and what is kept still goes through
 * {@link redactSourceUrls}: this value may travel towards the renderer, so nothing that is not
 * media description or a codec name may survive the parse (CON-2, NFR-9).
 *
 * Lenient on purpose. go2rtc's body is not a contract we own, so a surprising field must produce a
 * thinner summary, never an exception on a health-adjacent path.
 */
export function summarizeGo2rtcStream(body: unknown): StreamCodecSummary {
  const stream = asRecord(body)
  const producers = asArray(stream?.producers).map(asRecord)
  const consumers = asArray(stream?.consumers).map(asRecord)
  const producerMedias = producers.flatMap((p) =>
    asArray(p?.medias).filter((m): m is string => typeof m === 'string'),
  )
  return {
    producerMedias: producerMedias.map(redactSourceUrls),
    producerCodecs: [...new Set(producers.flatMap((p) => codecNames(p?.receivers)))],
    consumers: consumers.length,
    consumerCodecs: [...new Set(consumers.flatMap((c) => codecNames(c?.senders)))],
    tracks: [
      ...producers.flatMap((p) => trackCounters(p?.receivers, 'receiver')),
      ...consumers.flatMap((c) => trackCounters(c?.senders, 'sender')),
    ],
  }
}
