// The UniFi Access notifications WebSocket (official reference §11.1,
// `docs/reference/access-endpoints-v4.2.16.md`): `wss://<console>:12445/api/v1/developer/devices/
// notifications`, scope `view:device`, Access 1.20.11 or later — as a self-healing subscription
// that hands each parsed frame to its caller.
//
// ⚠️ Documented, not yet run against hardware: no Access console exists on the development network,
// so OS-1 is what confirms the console behaves this way. Modelled on `../protect/subscriptions.ts`,
// which *was* verified, with the differences the Access reference calls for.
//
// What this socket is good for, and what it is not:
//
//  1. **It says that something happened, not what state a door is in.** The reference shows three
//     events — a doorbell ringing (`access.remote_view`), its status changing
//     (`access.remote_view.change`) and a remote unlock by an admin
//     (`access.data.device.remote_unlock`, whose `data.unique_id` is the door id) — and does not
//     say the list is complete. No frame carries `door_lock_relay_status` and there is no relock
//     event, so the relay is still read with `GET /doors` (`./client.ts`). A frame is a hint to
//     re-read, which is why every mapper here is lenient: an unknown event still parses, and a
//     frame that does not is dropped without closing anything.
//  2. **Nothing but text JSON is acted on.** Community clients see the console send plain text such
//     as `Hello` on this socket as a keepalive (not in the reference). A frame that is not JSON is
//     ignored quietly; one that is JSON but not a notification is logged by reason only. The body
//     of a frame is **never** logged: a doorbell frame carries a `token` of its own.
//  3. **An auth failure must not become a retry loop.** No token at all, or a 401/403 on the
//     upgrade where the runtime reports one (undici 7 does not, see `authStatusOf`; the door-state
//     monitor's REST read is what catches a rejected token), stops the subscription for good: the fix is in Settings (the token, or its
//     `view:device` scope). A TLS pin failure stops for the same reason (CON-3: never retried,
//     never downgraded). Everything else reconnects with backoff — 1 s doubling to 60 s with
//     jitter, forgiven only once a connection has stayed open for `stableAfterMs`.
//  4. **No rate limiter and no special close code.** Unlike Protect (shared request budget, close
//     code 4500), the Access reference documents neither for this socket, so an upgrade is not
//     metered here and every close is just a close.
//
// **DOOR-0 is the caller's job.** This module checks the token and nothing else: it does not know
// whether Access is enabled. Its caller must only `start()` it while Access is switched on, and
// must `stop()` it when the switch goes off — unlike `./client.ts`, which gates every request.
//
// **No secret anywhere.** The token is read through `token()` at each upgrade and goes into the
// `Authorization: Bearer` header and nowhere else — not into the URL, not into a log line, not into
// an error message (CON-2, NFR-9). Errors carry `host:port` only, so they are safe to show and log.
//
// **Read-only.** Nothing here can move a door, and nothing a frame says may be turned into an
// unlock (DOOR-3/4).
//
// No Electron import, and the clock, the delay, the randomness, the dispatcher and the `WebSocket`
// constructor are parameters, so the unit tests drive a fake socket on a fake clock in plain Node
// (tests/unit/accessNotifications.test.ts).
import { WebSocket, type Dispatcher } from 'undici'
import {
  ACCESS_AUTH_ADVICE,
  AccessApiError,
  accessErrorFromThrown,
  schemaMismatchReason,
} from './client'
import {
  ACCESS_EVENT_REMOTE_UNLOCK,
  ACCESS_NOTIFICATIONS_PATH,
  AccessNotificationSchema,
  AccessRemoteUnlockDataSchema,
  type AccessNotification,
} from './types'
import type { ConsoleEndpoint } from '../console/endpoints'
import { causeChain } from '../net/errorCause'

/** Backoff defaults: 1 s, doubling, capped at 60 s, ±30 % jitter, as for the Protect sockets. */
export const ACCESS_NOTIFICATIONS_DEFAULT_BACKOFF = {
  initialMs: 1000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.3,
} as const

/**
 * How long a connection must stay open before the backoff is forgiven. Without this, a socket that
 * opens and dies immediately (a console mid-reboot) would retry at `initialMs` for ever.
 */
export const ACCESS_NOTIFICATIONS_STABLE_AFTER_MS = 10_000

/** `readyState` values we act on. Named so the close guard does not read as a magic number. */
const WS_CONNECTING = 0
const WS_OPEN = 1

// --- the minimal WebSocket surface we use -------------------------------------------------------

/**
 * What this module needs from a WebSocket, and nothing more, so a test can pass a hand-driven fake.
 * undici's `WebSocket` satisfies it as is. Same surface as `ProtectWebSocketLike`.
 */
export interface AccessWebSocketLike {
  /** Set to `arraybuffer` so a stray binary frame is readable without an await in the handler. */
  binaryType?: 'arraybuffer' | 'blob'
  readonly readyState: number
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  addEventListener(
    type: 'close',
    listener: (event: { readonly code: number; readonly reason: string }) => void,
  ): void
  addEventListener(
    type: 'error',
    listener: (event: { readonly error?: unknown; readonly message?: string }) => void,
  ): void
  close(code?: number, reason?: string): void
}

/** undici's constructor form: the header and the pinned dispatcher travel in the init object. */
export type AccessWebSocketCtor = new (
  url: string,
  init: { headers: Record<string, string>; dispatcher: Dispatcher },
) => AccessWebSocketLike

const DEFAULT_WEB_SOCKET: AccessWebSocketCtor = WebSocket

// --- public API ---------------------------------------------------------------------------------

/**
 * `idle` before the first `start()`, `stopped` after `stop()` or an unrecoverable failure (auth,
 * pin). `reconnecting` is the backoff wait; a first attempt is `connecting`, as is every retry.
 */
export type AccessNotificationsState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export interface AccessNotificationsOptions {
  /** From accessNotificationsUrl(accessEndpoint(config.console)). */
  readonly url: string
  /** Read at every upgrade. null/empty → stops with an auth error, no upgrade attempted. */
  readonly token: () => string | null
  /** The pinned agent, read per upgrade; may throw PinRequiredError → stop with kind 'pin'. */
  readonly dispatcher: () => Dispatcher
  /** One parsed frame (AccessNotificationSchema). Never called with an unparseable frame. */
  readonly onNotification: (notification: AccessNotification) => void
  /** Every state transition. */
  readonly onStateChange?: (state: AccessNotificationsState) => void
  /**
   * A failure: each failed attempt, and the final one when it stops for good. Safe message, no
   * token.
   */
  readonly onError?: (error: AccessApiError) => void
  /** Injected for tests. Defaults to undici's `WebSocket`. */
  readonly webSocketImpl?: AccessWebSocketCtor
  readonly backoff?: { initialMs?: number; maxMs?: number; factor?: number; jitter?: number }
  /** Forgive the backoff only once a connection has stayed open this long. Default 10_000. */
  readonly stableAfterMs?: number
  /** Deterministic time for tests. */
  readonly now?: () => number
  /**
   * The backoff wait. `signal` aborts when `stop()` is called, so an implementation can clear its
   * timer; it does not have to honour it, because the wait is also raced against the stop.
   */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
  /** Safe lines only (state, close codes, event names — never a frame body). Default: no-op. */
  readonly log?: (line: string) => void
}

export interface AccessNotifications {
  /** Idempotent. After stop() or an unrecoverable stop, start() begins afresh. */
  start(): void
  /**
   * Idempotent. Closes the socket, cancels any backoff wait. No callbacks fire after it returns
   * except the final 'stopped' state change.
   */
  stop(): void
  readonly state: AccessNotificationsState
}

/**
 * `wss://…/api/v1/developer/devices/notifications` from the Access endpoint's baseUrl (https→wss)
 * + ACCESS_NOTIFICATIONS_PATH.
 */
export function accessNotificationsUrl(endpoint: ConsoleEndpoint): string {
  return `${endpoint.baseUrl.replace(/^https:/, 'wss:')}${ACCESS_NOTIFICATIONS_PATH}`
}

/** The door id of an `access.data.device.remote_unlock` frame (data.unique_id), else null. */
export function remoteUnlockDoorId(notification: AccessNotification): string | null {
  if (notification.event !== ACCESS_EVENT_REMOTE_UNLOCK) return null
  const data = AccessRemoteUnlockDataSchema.safeParse(notification.data)
  return data.success ? data.data.unique_id : null
}

// --- the subscription ---------------------------------------------------------------------------

/** What one connection attempt ended up being, which is all the retry loop needs to know. */
interface AttemptOutcome {
  /** Stop for good: the token or the pin is wrong, and retrying cannot fix either. */
  readonly fatal: boolean
  /** The connection was open for at least `stableAfterMs`, so the backoff is forgiven. */
  readonly stable: boolean
}

const ABORTED: AttemptOutcome = { fatal: false, stable: false }

/**
 * One `start()` … `stop()` span. Everything a run owns hangs off its `AbortController`, so a
 * `stop()` followed at once by a `start()` cannot have the old loop or an old socket's late events
 * leak into the new run.
 */
interface Run {
  readonly controller: AbortController
  /** Resolves when the run is aborted; awaits are raced against it so none outlives the run. */
  readonly aborted: Promise<void>
  socket: AccessWebSocketLike | null
}

export function createAccessNotifications(
  options: AccessNotificationsOptions,
): AccessNotifications {
  const {
    url,
    token,
    dispatcher,
    onNotification,
    onStateChange,
    onError,
    webSocketImpl = DEFAULT_WEB_SOCKET,
    stableAfterMs = ACCESS_NOTIFICATIONS_STABLE_AFTER_MS,
  } = options
  const backoff = { ...ACCESS_NOTIFICATIONS_DEFAULT_BACKOFF, ...options.backoff }
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const log = options.log ?? ((): void => undefined)
  const sleep = options.sleep ?? defaultSleep
  // `host:port` for error messages. The URL carries no credential (the token is a header), but the
  // endpoint is what Settings shows, so that is all the errors need.
  const endpoint = hostOf(url)
  const WHAT = 'The Access notifications connection'

  let state: AccessNotificationsState = 'idle'
  /** The live run, or `null` while idle or stopped. */
  let run: Run | null = null
  // Read through a function: `run` is reassigned from `start()`/`stop()` while handlers hold an
  // older one, and a plain comparison would let the compiler narrow it wrongly inside closures.
  const isLive = (candidate: Run): boolean => run === candidate

  const setState = (next: AccessNotificationsState): void => {
    if (state === next) return
    state = next
    safely('onStateChange', () => {
      onStateChange?.(next)
    })
  }

  /** A consumer callback must never take the socket down with it. */
  function safely(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      log(`access notifications: ${what} threw: ${messageOf(err)}`)
    }
  }

  const report = (err: AccessApiError): void => {
    log(`access notifications: ${err.kind}: ${err.message}`)
    safely('onError', () => {
      onError?.(err)
    })
  }

  const closeQuietly = (ws: AccessWebSocketLike, reason: string): void => {
    if (ws.readyState !== WS_OPEN && ws.readyState !== WS_CONNECTING) return
    try {
      ws.close(1000, reason)
    } catch (err) {
      log(`access notifications: closing the socket failed: ${messageOf(err)}`)
    }
  }

  /**
   * Exponential backoff with jitter. The cap is applied to the un-jittered delay, so the actual
   * wait stays within ±`jitter` of `maxMs` once capped.
   */
  const delayMs = (failures: number): number => {
    const base = Math.min(backoff.maxMs, backoff.initialMs * Math.pow(backoff.factor, failures))
    const spread = base * backoff.jitter * (random() * 2 - 1)
    return Math.max(0, Math.round(base + spread))
  }

  /** Classifies a thrown or `error`-event failure of an upgrade. See {@link authStatusOf}. */
  function asAccessError(raw: unknown): AccessApiError {
    if (raw instanceof AccessApiError) return raw
    const status = authStatusOf(raw)
    if (status !== null) {
      return new AccessApiError(
        `${WHAT} was refused with HTTP ${String(status)}.${ACCESS_AUTH_ADVICE}`,
        { kind: 'auth', status, endpoint, cause: raw },
      )
    }
    return accessErrorFromThrown({ err: raw, what: WHAT, endpoint: endpoint ?? '' })
  }

  /** One upgrade, from the constructor to the socket being finished with. Never rejects. */
  function connectOnce(current: Run, bearer: string): Promise<AttemptOutcome> {
    let ws: AccessWebSocketLike
    try {
      ws = new webSocketImpl(url, {
        // The one and only place the token appears.
        headers: { authorization: `Bearer ${bearer}` },
        // May throw `PinRequiredError` (no certificate accepted yet), which lands in the catch and
        // becomes `kind: 'pin'` — fatal, like a mismatch during the handshake.
        dispatcher: dispatcher(),
      })
    } catch (err) {
      const failure = asAccessError(err)
      report(failure)
      return Promise.resolve({ fatal: isFatal(failure), stable: false })
    }
    current.socket = ws
    ws.binaryType = 'arraybuffer'

    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false
      let openedAt: number | null = null
      /** We closed this socket ourselves and already said why; the close must not report twice. */
      let selfClosed = false

      const finish = (fatal: boolean): void => {
        if (settled) return
        settled = true
        if (current.socket === ws) current.socket = null
        resolve({ fatal, stable: openedAt !== null && now() - openedAt >= stableAfterMs })
      }

      ws.addEventListener('open', () => {
        if (!isLive(current)) return
        openedAt = now()
        log('access notifications: open')
        setState('open')
      })

      ws.addEventListener('message', (event) => {
        // After `stop()` nothing more is delivered, even if the socket had a frame in flight.
        if (!isLive(current)) return
        const text = frameText(event.data)
        if (text === null) {
          log('access notifications: ignored a frame that is not text')
          return
        }
        let json: unknown
        try {
          json = JSON.parse(text) as unknown
        } catch {
          // The console's plain-text keepalive ("Hello") lands here. Quietly: it is expected, it
          // may arrive every few seconds, and a log line per keepalive would bury everything else.
          return
        }
        const parsed = AccessNotificationSchema.safeParse(json)
        if (!parsed.success) {
          // The reason only — which field, what was wrong. Never the frame.
          log(`access notifications: dropped a frame (${schemaMismatchReason(parsed.error)})`)
          return
        }
        safely('onNotification', () => {
          onNotification(parsed.data)
        })
      })

      ws.addEventListener('error', (event) => {
        if (settled || !isLive(current)) return
        // undici reports a failed upgrade (non-101, including 401/403, and a TLS pin mismatch) as
        // an `error` event and may or may not follow it with a `close`, so this settles it.
        const failure = asAccessError(
          event.error ?? event.message ?? 'the socket reported an error',
        )
        report(failure)
        selfClosed = true
        // Settled before the close, so a `close` event fired from inside it cannot decide the
        // outcome (it would say "not fatal").
        finish(isFatal(failure))
        closeQuietly(ws, 'error')
      })

      ws.addEventListener('close', (event) => {
        const code = typeof event.code === 'number' ? event.code : 0
        const reason = typeof event.reason === 'string' ? event.reason : ''
        if (isLive(current)) {
          const shown = `code ${String(code)}${reason === '' ? '' : `, "${reason}"`}`
          log(`access notifications: closed (${shown})`)
          if (!selfClosed && !settled) {
            report(
              new AccessApiError(`${WHAT} was closed by the console (${shown}). Reconnecting.`, {
                kind: 'network',
                endpoint,
              }),
            )
          }
        }
        finish(false)
      })
    })
  }

  /** The token check and the connection. Never rejects. */
  async function attempt(current: Run): Promise<AttemptOutcome> {
    const bearer = token()?.trim() ?? ''
    if (bearer === '') {
      // No upgrade is attempted: the console would only answer 401, and the message can say where
      // the token goes.
      report(
        new AccessApiError(
          `${WHAT} was not opened: no Access API token is saved.${ACCESS_AUTH_ADVICE}`,
          { kind: 'auth', endpoint },
        ),
      )
      return { fatal: true, stable: false }
    }
    setState('connecting')
    return await Promise.race([connectOnce(current, bearer), current.aborted.then(() => ABORTED)])
  }

  /** The retry loop of one run. Ends when the run is stopped or fails for good. */
  async function loop(current: Run): Promise<void> {
    /** Consecutive attempts that did not reach `stableAfterMs`; the backoff exponent. */
    let failures = 0
    while (isLive(current)) {
      let outcome: AttemptOutcome
      try {
        outcome = await attempt(current)
      } catch (err) {
        // Only a bug here reaches this. Reporting and stopping beats a loop that cannot tell
        // whether it is making progress.
        if (!isLive(current)) return
        report(
          new AccessApiError(`${WHAT} stopped after an internal error: ${messageOf(err)}.`, {
            kind: 'network',
            endpoint,
            cause: err,
          }),
        )
        outcome = { fatal: true, stable: false }
      }
      if (!isLive(current)) return
      if (outcome.fatal) {
        // Stopped for good, until the caller starts it again (with a new token or pin).
        run = null
        current.controller.abort()
        setState('stopped')
        return
      }
      if (outcome.stable) failures = 0
      const delay = delayMs(failures)
      failures++
      setState('reconnecting')
      log(`access notifications: reconnecting in ${String(delay)} ms (attempt ${String(failures)})`)
      try {
        await Promise.race([sleep(delay, current.controller.signal), current.aborted])
      } catch (err) {
        // An injected sleep that rejects on abort is fine; one that rejects otherwise must not
        // turn the backoff into a tight loop, so it ends the run like any internal error.
        if (!isLive(current)) return
        report(
          new AccessApiError(`${WHAT} stopped after an internal error: ${messageOf(err)}.`, {
            kind: 'network',
            endpoint,
            cause: err,
          }),
        )
        run = null
        current.controller.abort()
        setState('stopped')
        return
      }
    }
  }

  return {
    start() {
      if (run !== null) return
      const controller = new AbortController()
      const aborted = new Promise<void>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            resolve()
          },
          { once: true },
        )
      })
      const started: Run = { controller, aborted, socket: null }
      run = started
      void loop(started)
    },
    stop() {
      const current = run
      // Cleared first: every handler and the loop check `isLive`, so from here on nothing of the
      // old run reports, delivers or changes state.
      run = null
      if (current !== null) {
        current.controller.abort()
        const ws = current.socket
        current.socket = null
        if (ws !== null) closeQuietly(ws, 'stopped')
      }
      setState('stopped')
    },
    get state() {
      return state
    },
  }
}

// --- failure classification ---------------------------------------------------------------------

/** The kinds no amount of retrying can fix; both are resolved in Settings (CON-3, DOOR-1). */
function isFatal(err: AccessApiError): boolean {
  return err.kind === 'auth' || err.kind === 'pin'
}

/**
 * 401 or 403 if a failed upgrade says so anywhere we can read it, else `null`. Both mean the token:
 * missing or invalid (401), or without the `view:device` scope this socket needs (403, §2.2).
 *
 * **With undici 7 this finds nothing for a real refusal** (measured against the mock,
 * tests/unit/doorStateLive.test.ts): a non-101 answer fails the connection with an empty
 * `TypeError`, no status and no cause, and a 1006 close. So a refused upgrade is, in practice, a
 * retryable network error bounded by the backoff (at most one attempt a minute). What stops a
 * rejected token for real is the door-state monitor: its `GET /doors` answers 401, which it treats
 * as fatal and stops this socket with it (`./doorStateMonitor.ts`). The check stays for a runtime
 * that does expose the status. A token that reads doors but lacks `view:device` therefore keeps
 * retrying the socket slowly while polling carries the door state.
 */
function authStatusOf(raw: unknown): 401 | 403 | null {
  for (const value of causeChain(raw)) {
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      for (const key of ['status', 'statusCode'] as const) {
        const candidate = record[key]
        if (candidate === 401 || candidate === 403) return candidate
      }
    }
    const text = typeof value === 'string' ? value : value instanceof Error ? value.message : ''
    if (/\b401\b/.test(text) || /unauthorized/i.test(text)) return 401
    if (/\b403\b/.test(text) || /forbidden/i.test(text)) return 403
  }
  return null
}

// --- small helpers ------------------------------------------------------------------------------

/** The default backoff wait: a timer that `stop()` clears through the signal. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const decoder = new TextDecoder()

/** The text of a frame; a binary one is decoded rather than awaited (see `binaryType`). */
function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return decoder.decode(data)
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return null
}

/** `host:port` of the subscription URL, for error messages. Carries no credential. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
