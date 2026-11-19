// The two Protect Integration API WebSockets (SPEC §5.1): `wss://…/v1/subscribe/events` (CELL-2)
// and `wss://…/v1/subscribe/devices` (CAM-2/3), each as a self-healing subscription that maps what
// it receives onto the trimmed runtime model in `@shared/models`.
//
// Why this module exists at all, rather than two `new WebSocket(...)` calls at the app edge:
//
//  1. **Both sockets spend the REST request budget.** A rate-limited *upgrade* is accepted, sent one
//     JSON text frame with the 429 body and then closed with code 4500 (SPEC §5.1 rate-limit block,
//     P0.3 §5/§7). So an upgrade has to take a permit from the **same** `RateLimiter` the REST
//     client uses (R9), and a 4500 has to feed the 429's `windowMs` back into it with `penalize()`.
//     Reconnects are upgrades too, which is why the backoff lives here and not in the caller.
//  2. **The console sends no keepalive.** In 9 minutes it sent **no pings** and did not close an
//     idle socket (P0.3 §5), so nothing tells us a socket has died except TCP. That is also why
//     `idleTimeoutMs` defaults to **off**: the feeds are legitimately silent for long stretches (the
//     devices socket saw 0 messages in 9 minutes because nothing changed), and undici's connector
//     already sets TCP keepalive on the socket, so an app-level idle timeout would mostly tear down
//     healthy connections and spend permits reconnecting. A caller that would rather have a false
//     reconnect than a silently dead socket can set it (NFR-7).
//  3. **The devices feed sends no initial state and its shapes are unverified** (SPEC §5.1, R11): it
//     is a change feed only. The inventory therefore comes from `GET /v1/cameras`, and
//     `onConnected` fires after **every** successful connect so the caller re-reads it (R11) —
//     whatever was missed while the socket was down is recovered by that read, not by this feed.
//     Every mapper here is lenient for the same reason: one surprising field must not throw, and
//     must not take the socket down with it.
//  4. **An auth failure must not become a retry loop.** A 401/403 on the upgrade, or no key at all,
//     stops the subscription for good: hammering the console with a bad key is worse than being
//     offline, and the fix is in Settings (CON-4). A TLS pin failure stops for the same reason
//     (`./errors.ts`: `pin` is the one kind a caller must never retry). Everything else reconnects.
//
// **No secret anywhere.** The key is read through `apiKey()` at each upgrade and goes into the
// `X-API-KEY` header and nowhere else — not into the URL, not into a log line, not into an error
// message (CON-2, NFR-9). Error messages carry `host:port` only, so they are safe to show and log.
//
// No Electron import, and the clock, the delay, the randomness, the dispatcher and even the
// `WebSocket` constructor are parameters, so the unit tests drive a fake socket on a fake clock in
// plain Node (tests/unit/protectSubscriptions.test.ts) instead of waiting out a real backoff.
import { WebSocket, type Dispatcher } from 'undici'
import { ProtectApiError, protectErrorFromThrown } from './errors'
import { startBackoffWait, timerSleep, type BackoffWait } from '../net/backoffWait'
import { causeChain } from '../net/errorCause'
import { PROTECT_RATE_WINDOW_MS, type RateLimiter } from '../net/rateLimiter'
import {
  CameraEventSchema,
  CameraStateChangeSchema,
  type CameraEvent,
  type CameraStateChange,
  type MotionTrigger,
} from '@shared/models'

/** Close code the console uses for a rate-limited upgrade (P0.3 §5; not a standard code). */
export const PROTECT_WS_CLOSE_RATE_LIMITED = 4500

/** `name` of the 429 body, which arrives as the single text frame before a 4500 close. */
export const PROTECT_RATE_LIMIT_ERROR_NAME = 'TOO_MANY_REQUESTS_ERROR'

/** Backoff defaults: 1 s, doubling, capped at 60 s, ±30 % jitter. */
export const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.3 } as const

/**
 * How long a connection must stay open before the backoff is forgiven. Without this, a socket that
 * opens and dies immediately (the 4500 case, or a console mid-reboot) would retry at `initialMs`
 * for ever instead of backing off.
 */
export const DEFAULT_STABLE_AFTER_MS = 10_000

/** `readyState` values we act on. Named so the close guard does not read as a magic number. */
const WS_CONNECTING = 0
const WS_OPEN = 1

/**
 * Guard against an injected `sleep` that resolves without the injected clock moving, which would
 * otherwise spin the idle watcher for ever. Same idea as the rate limiter's round guard.
 */
const MAX_IDLE_ROUNDS = 100

// --- the minimal WebSocket surface we use -------------------------------------------------------

/**
 * What this module needs from a WebSocket, and nothing more, so a test can pass a hand-driven fake
 * without pulling in DOM types or a real socket. undici's `WebSocket` satisfies it as is.
 *
 * The event payloads are the loosest shape we actually read: only `data` on a message, `code` and
 * `reason` on a close, and `error`/`message` on an error (undici reports a failed upgrade through
 * `ErrorEvent`, whose `error` carries the real cause).
 */
export interface ProtectWebSocketLike {
  /**
   * Protect sends text frames, but a stray binary frame is only readable synchronously as an
   * `ArrayBuffer` — undici's default is a `Blob`, which would need an await inside the handler.
   */
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

/** The constructor form the spike used and P1.2's pinned agent needs (P0.3 §8). */
export type ProtectWebSocketCtor = new (
  url: string,
  init: { headers: Record<string, string>; dispatcher: Dispatcher },
) => ProtectWebSocketLike

const DEFAULT_WEB_SOCKET: ProtectWebSocketCtor = WebSocket

// --- public API ---------------------------------------------------------------------------------

/**
 * `idle` before `start()`, `stopped` after `stop()` or an unrecoverable failure (auth, pin).
 * `reconnecting` is the backoff wait; a first attempt is `connecting`, as is every retry.
 */
export type SubscriptionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export interface ProtectSubscriptionOptions {
  /** From `protectSubscribeUrl(protectEndpoint(config.console), channel)`. */
  url: string
  /**
   * Read at **every** upgrade rather than captured once: the user can change the key in Settings
   * while the app runs, and a stopped subscription is restarted with the new one (CON-4).
   */
  apiKey: () => string | null
  /** Read per upgrade too: P1.2 replaces the pinned agent when the pin is re-accepted. */
  dispatcher: () => Dispatcher
  /** Shared with the REST client: an upgrade spends a request permit (R9). */
  limiter?: RateLimiter
  /** Injected for tests. Defaults to undici's `WebSocket`. */
  webSocketImpl?: ProtectWebSocketCtor
  backoff?: { initialMs?: number; maxMs?: number; factor?: number; jitter?: number }
  /** Reset the backoff only once a connection has stayed open this long. Default 10_000. */
  stableAfterMs?: number
  /**
   * Reconnect when no frame arrives for this long. Default `null` = off: the console sends no pings
   * (P0.3 §5), the feeds can legitimately be silent for many minutes (0 messages in 9 minutes on
   * devices) and undici's connector already sets TCP keepalive, so an app-level idle timeout would
   * mostly cause pointless reconnects — each of which spends a rate-limit permit (R9).
   * When set, it also bounds a handshake that never completes.
   */
  idleTimeoutMs?: number | null
  onStateChange?: (state: SubscriptionState) => void
  /** Every failure, as a `ProtectApiError`. The subscription keeps retrying unless it stopped. */
  onError?: (err: ProtectApiError) => void
  /** Fires after each successful (re)connect. The caller re-reads `GET /v1/cameras` (R11). */
  onConnected?: (attempt: { reconnect: boolean }) => void
  /** Safe lines only. Default: no-op. */
  log?: (line: string) => void
  /** Deterministic time for tests. */
  now?: () => number
  /**
   * The backoff and idle waits. `signal` aborts when `stop()` or a `reconnectNow()` ends the wait,
   * so an implementation can clear its timer; it does not have to honour it, because the wait is
   * also raced against both (`../net/backoffWait.ts`).
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
}

export interface ProtectSubscription {
  start(): void
  /** Stops for good: no further reconnect, socket closed with 1000. Idempotent. */
  stop(): Promise<void>
  /**
   * NFR-7 (P6.2): the machine woke from sleep or its network changed, so the socket may be dead
   * without TCP having noticed yet (keepalive takes a minute or more), and any backoff that grew
   * while the network was gone is now only a delay. By state:
   *
   * - `open` / `connecting` with a socket: closes it as our own close (no error reported, not
   *   counted as a failure) and connects again at once, with the backoff reset.
   * - `connecting` while still waiting for the permit: the backoff is reset; the attempt that is
   *   about to start is already a fresh one.
   * - `reconnecting` (the backoff wait): the wait is cut short and it connects now, backoff reset —
   *   but never below a rate-limit floor: a wait that a 429's `windowMs` set is held until that
   *   window has passed (the console said so; waking does not change it).
   * - `idle` / `stopped` (never started, stopped by the caller, or stopped for good on an auth or pin
   *   failure — rule 4): nothing. A wake does not make a wrong key right.
   *
   * Every reconnect still takes a permit from the shared `RateLimiter` (R9), so a wake cannot burst
   * past the budget, and `onConnected` still fires after it, so the inventory is re-read (R11).
   */
  reconnectNow(): void
  readonly state: SubscriptionState
}

/**
 * The events feed (CELL-2). `onEvent` fires for the event types in SPEC §5.1 "Event types relevant
 * to View Protect" and for nothing else; everything that arrives, mapped or not, still reaches
 * `onMessage`.
 *
 * **Consumers must be idempotent on `(id, end)`.** The opening `add` omits `end`, the closing
 * `update` carries the full event, and that closing update **may be repeated** (two or three times,
 * 0–0.5 s apart, in P0.3 §5). Repeats are passed through deliberately: dropping them here would
 * hide the lifecycle from P4.1, which is where the dedupe and `motionHoldSec` belong.
 */
export function createEventsSubscription(
  options: ProtectSubscriptionOptions & {
    onEvent: (event: CameraEvent) => void
    /** Every message, mapped or not, for diagnostics. Optional. */
    onMessage?: (message: unknown) => void
  },
): ProtectSubscription {
  return createSubscription(options, 'events', (message) => {
    const event = toCameraEvent(message)
    if (event !== null) options.onEvent(event)
  })
}

/**
 * The devices feed (CAM-2/3). **No initial state is sent** and the message shapes are unverified
 * (SPEC §5.1, R11), so this reports only what it can recognise with confidence — a camera item's
 * `state`, and the fact that a camera was added or removed — and leaves the authoritative inventory
 * to `GET /v1/cameras`, which `onConnected` asks the caller to re-read after every connect.
 */
export function createDevicesSubscription(
  options: ProtectSubscriptionOptions & {
    onCameraState: (change: CameraStateChange) => void
    /** A camera was added or removed: the caller re-reads `GET /v1/cameras` (R11). */
    onInventoryChanged: (reason: 'add' | 'remove') => void
    onMessage?: (message: unknown) => void
  },
): ProtectSubscription {
  return createSubscription(options, 'devices', (message) => {
    for (const change of toCameraStateChanges(message)) options.onCameraState(change)
    const reason = inventoryChangeReason(message)
    if (reason !== null) options.onInventoryChanged(reason)
  })
}

// --- mapping ------------------------------------------------------------------------------------

/**
 * Protect's `item.type` → the cell trigger it counts as (CELL-2), or `null` to ignore it.
 *
 * The three `smartDetect*` types collapse into one trigger because a cell's `motionTriggers` is
 * about *what kind of thing happened*, not which zone geometry matched; `Cell.smartDetectTypes`
 * filters the object types inside it. `nfcCardScanned`, `fingerprintIdentified` and every sensor,
 * alarm-hub and relay event are ignored here (SPEC §5.1 "others") — they still reach `onMessage`,
 * so an MVP feature can pick them up without changing this mapping.
 */
export function motionTriggerFor(protectEventType: string): MotionTrigger | null {
  switch (protectEventType) {
    case 'motion':
      return 'motion'
    case 'smartDetectZone':
    case 'smartDetectLine':
    case 'smartDetectLoiterZone':
      return 'smartDetect'
    case 'ring':
      return 'ring'
    default:
      return null
  }
}

/**
 * Lenient map of an events-WS message onto `CameraEvent`, or `null` when it is not a camera trigger.
 *
 * Lenient means: anything that is not an object, or has no usable `item`, `id`, `device`, `type` or
 * `start`, returns `null` instead of throwing (R8/R11) — a console upgrade that adds or renames a
 * field must not be able to kill the feed. `end` is **absent** on the opening `add`, not `null`
 * (SPEC §5.1 event lifecycle, P0.3 §5), so it is read as "missing means still running" and never
 * required. `item.modelKey` is deliberately not checked: the event `type` is what decides whether
 * this is a camera trigger, and requiring a second discriminator only adds a way to reject a valid
 * event. `CameraEventSchema` is the final gate, so this and the config path agree on the shape.
 */
export function toCameraEvent(message: unknown): CameraEvent | null {
  const item = itemOf(message)
  if (item === null) return null
  const protectType = typeof item.type === 'string' ? item.type : ''
  const trigger = motionTriggerFor(protectType)
  if (trigger === null) return null
  const parsed = CameraEventSchema.safeParse({
    id: item.id,
    cameraId: item.device,
    trigger,
    protectType,
    start: item.start,
    end: item.end ?? null,
    smartDetectTypes: stringArray(item.smartDetectTypes),
  })
  return parsed.success ? parsed.data : null
}

/**
 * Lenient map of a devices-WS message onto the camera state changes it implies (CAM-2/3).
 *
 * A list, not one value, because a bulk item addresses several devices at once: `item.id` is
 * `string | string[]` in the contract (`deviceBulk*`), and which form the console really sends is
 * **unverified** (0 messages in 9 minutes, R11), so both are handled. Non-camera `modelKey`s (`nvr`,
 * `sensor`, …) and messages without a usable `state` map to nothing — an `update` is a partial, so
 * a missing `state` means "something else about this camera changed", not "state is unknown".
 * `type` is not read here: `add` carries a `state` too, and reporting it is both harmless and
 * closer to the truth than ignoring it.
 */
export function toCameraStateChanges(message: unknown): CameraStateChange[] {
  const item = itemOf(message)
  if (item?.modelKey !== 'camera') return []
  const state = item.state
  if (typeof state !== 'string' || state === '') return []
  const changes: CameraStateChange[] = []
  for (const cameraId of deviceIds(item.id)) {
    const parsed = CameraStateChangeSchema.safeParse({ cameraId, state })
    if (parsed.success) changes.push(parsed.data)
  }
  return changes
}

/**
 * `add`/`remove` of a **camera** → the reason to re-read the inventory (R11), else `null`.
 *
 * Only `modelKey: 'camera'` counts. An unknown or missing `modelKey` is ignored rather than treated
 * as a camera: every re-read spends a rate-limit permit (R9), the next reconnect re-reads anyway,
 * and an alarm-hub or sensor churning would otherwise drive REST traffic. The ignored cases are
 * logged, so a console that sends a shape we did not expect is diagnosable.
 */
function inventoryChangeReason(message: unknown): 'add' | 'remove' | null {
  if (typeof message !== 'object' || message === null) return null
  const envelope = message as Record<string, unknown>
  const type = envelope.type
  if (type !== 'add' && type !== 'remove') return null
  const item = itemOf(message)
  if (item?.modelKey !== 'camera') return null
  return type
}

/** The `item` of a `{ type, item }` envelope, or `null` when there is nothing object-shaped there. */
function itemOf(message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const item = (message as Record<string, unknown>).item
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  return item as Record<string, unknown>
}

/** `item.id` as a de-duplicated list, accepting the single and the bulk (`string[]`) form. */
function deviceIds(id: unknown): string[] {
  if (typeof id === 'string') return id === '' ? [] : [id]
  if (!Array.isArray(id)) return []
  const ids = new Set<string>()
  for (const entry of id) if (typeof entry === 'string' && entry !== '') ids.add(entry)
  return [...ids]
}

/** Keeps only the non-empty strings of a value that should be `string[]`; anything else is `[]`. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * The rate-limit window from a 429 body, or `null` when this frame is not one. Recognised by `name`
 * rather than by being the first frame: the console sends exactly one such frame before a 4500
 * close, but nothing in the contract promises that is the only time it can arrive.
 */
function rateLimitWindowMs(message: unknown): number | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const body = message as Record<string, unknown>
  if (body.name !== PROTECT_RATE_LIMIT_ERROR_NAME) return null
  const windowMs = body.windowMs
  return typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : PROTECT_RATE_WINDOW_MS
}

// --- the subscription ---------------------------------------------------------------------------

/** What one connection attempt ended up being, which is all the retry loop needs to know. */
interface AttemptOutcome {
  /** Stop for good: the key or the pin is wrong, and retrying cannot fix either. */
  readonly fatal: boolean
  /** The connection was open for at least `stableAfterMs`, so the backoff is forgiven. */
  readonly stable: boolean
  /** A floor for the next delay, from a 429's `windowMs`. */
  readonly penaltyMs: number | null
}

const ABORTED: AttemptOutcome = { fatal: false, stable: false, penaltyMs: null }

function createSubscription(
  options: ProtectSubscriptionOptions & { onMessage?: (message: unknown) => void },
  channel: 'devices' | 'events',
  handle: (message: unknown) => void,
): ProtectSubscription {
  const {
    url,
    apiKey,
    dispatcher,
    limiter,
    webSocketImpl = DEFAULT_WEB_SOCKET,
    stableAfterMs = DEFAULT_STABLE_AFTER_MS,
    idleTimeoutMs = null,
    onStateChange,
    onError,
    onConnected,
    onMessage,
  } = options
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff }
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const log = options.log ?? ((): void => undefined)
  // `host:port` for error messages; the URL itself carries no credential (the key is a header), but
  // the endpoint is what Settings shows, so that is all the errors need.
  const endpoint = hostOf(url)

  // The default clears its timer on the signal, so `stop()` and a wake leave none pending (rule 9).
  const sleep = options.sleep ?? timerSleep

  let state: SubscriptionState = 'idle'
  let stopped = false
  // Read through a function, not directly: `stopped` is set from `stop()` and from the retry loop,
  // and a plain read would let the compiler narrow it to its initial value inside the handlers.
  const isStopped = (): boolean => stopped
  let started = false
  /** Consecutive attempts that did not reach `stableAfterMs`; the backoff exponent. */
  let failures = 0
  let connectedOnce = false
  let socket: ProtectWebSocketLike | null = null
  let loop: Promise<void> | null = null
  /**
   * NFR-7: `reconnectNow()` ended the live attempt on purpose, so the loop goes straight to the next
   * one instead of waiting out a backoff. Cleared by the loop when it acts on it.
   */
  let reconnectRequested = false
  /** Ends the live attempt as our own close; set while an upgrade or connection is in progress. */
  let abortAttempt: (() => void) | null = null
  /** The backoff wait a wake may cut short; set only while the loop is in one. */
  let backoffWait: BackoffWait | null = null
  /**
   * Until when a 429 forbids the next upgrade (`windowMs` from the console), or `null`. A wake cuts
   * the backoff short but never this floor.
   */
  let penaltyUntil: number | null = null
  /** Aborted by every stop, so every wait (backoff, idle) clears its timer at once. */
  const stopController = new AbortController()
  let releaseStop = (): void => undefined
  const untilStopped = new Promise<void>((resolve) => {
    releaseStop = () => {
      stopController.abort()
      resolve()
    }
  })

  const setState = (next: SubscriptionState): void => {
    if (state === next) return
    state = next
    safely('onStateChange', () => {
      onStateChange?.(next)
    })
  }

  /** A consumer callback must never take the socket down with it (R11). */
  function safely(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      log(`${channel}: ${what} threw: ${messageOf(err)}`)
    }
  }

  const report = (err: ProtectApiError): void => {
    log(`${channel}: ${err.kind}: ${err.message}`)
    safely('onError', () => {
      onError?.(err)
    })
  }

  /** Resolves with `whenStopped` as soon as `stop()` is called, so no await outlives the subscription. */
  const raceStop = <T>(work: Promise<T>, whenStopped: T): Promise<T> =>
    Promise.race([work, untilStopped.then(() => whenStopped)])

  const closeQuietly = (ws: ProtectWebSocketLike, code: number, reason: string): void => {
    if (ws.readyState !== WS_OPEN && ws.readyState !== WS_CONNECTING) return
    try {
      ws.close(code, reason)
    } catch (err) {
      log(`${channel}: closing the socket failed: ${messageOf(err)}`)
    }
  }

  /**
   * Exponential backoff with jitter, floored by a 429's `windowMs`. The cap is applied to the
   * un-jittered delay, so the actual wait stays within ±`jitter` of `maxMs` once capped.
   */
  const nextDelayMs = (penaltyMs: number | null): number => {
    const base = Math.min(backoff.maxMs, backoff.initialMs * Math.pow(backoff.factor, failures))
    const spread = base * backoff.jitter * (random() * 2 - 1)
    return Math.max(0, Math.round(base + spread), penaltyMs ?? 0)
  }

  /** One upgrade, from the permit to the socket being finished with. Never rejects. */
  function connectOnce(key: string): Promise<AttemptOutcome> {
    let ws: ProtectWebSocketLike
    try {
      ws = new webSocketImpl(url, {
        headers: { 'X-API-KEY': key },
        dispatcher: dispatcher(),
      })
    } catch (err) {
      // undici rejects the upgrade by throwing here for some failures (a bad key among them), so
      // this path classifies exactly like the `error` event below.
      const failure = asProtectError(err)
      report(failure)
      return Promise.resolve({
        fatal: isFatal(failure),
        stable: false,
        penaltyMs: failure.retryAfterMs,
      })
    }
    socket = ws
    ws.binaryType = 'arraybuffer'

    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false
      const isSettled = (): boolean => settled
      let openedAt: number | null = null
      let lastFrameAt = now()
      let penaltyMs: number | null = null
      /** We closed this socket ourselves and already said why; the close must not report twice. */
      let selfClosed = false

      const finish = (outcome: Omit<AttemptOutcome, 'stable'>): void => {
        if (settled) return
        settled = true
        if (socket === ws) socket = null
        if (abortAttempt === abort) abortAttempt = null
        const stable = openedAt !== null && now() - openedAt >= stableAfterMs
        resolve({ ...outcome, stable })
      }

      /**
       * NFR-7, from `reconnectNow()`: close this socket ourselves. `selfClosed` first, so the close
       * it causes is neither reported as the console's nor treated as anything but a normal end;
       * the loop reads `reconnectRequested` and skips the backoff.
       */
      const abort = (): void => {
        if (settled) return
        selfClosed = true
        log(`${channel}: closing to reconnect now (woke or the network changed)`)
        closeQuietly(ws, 1000, 'reconnect')
        finish({ fatal: false, penaltyMs: null })
      }
      abortAttempt = abort

      ws.addEventListener('open', () => {
        openedAt = now()
        lastFrameAt = openedAt
        setState('open')
        const reconnect = connectedOnce
        connectedOnce = true
        log(`${channel}: open (${reconnect ? 'reconnect' : 'first connect'})`)
        // Fires even for an upgrade that turns out to be rate limited (it is accepted, then closed
        // with 4500), so that one case costs the caller one inventory re-read. Suppressing it would
        // mean holding `onConnected` back on every connect, and the feeds are silent for minutes at
        // a time, so there is nothing to hold it back *until*.
        safely('onConnected', () => {
          onConnected?.({ reconnect })
        })
      })

      ws.addEventListener('message', (event) => {
        lastFrameAt = now()
        const text = frameText(event.data)
        if (text === null) {
          log(`${channel}: ignored a frame that is not text`)
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          // Logged, not reported: a feed of junk would otherwise flood `onError`, and there is
          // nothing a caller can do about it that reconnecting would not already do.
          log(`${channel}: ignored a non-JSON frame (${String(text.length)} chars)`)
          return
        }
        const windowMs = rateLimitWindowMs(parsed)
        if (windowMs !== null) {
          // The upgrade spent a permit we did not have. Tell the shared limiter immediately, before
          // the REST client spends another one; the 4500 close that follows reports the error.
          penaltyMs = windowMs
          limiter?.penalize(windowMs)
          log(`${channel}: rate limited on connect; holding back ${String(windowMs)} ms`)
        }
        safely('onMessage', () => {
          onMessage?.(parsed)
        })
        safely('handler', () => {
          handle(parsed)
        })
      })

      ws.addEventListener('error', (event) => {
        if (settled) return
        // undici reports a failed upgrade (non-101, including 401/403) as an `error` event and may
        // or may not follow it with a `close`, so this settles the attempt rather than waiting.
        const failure = asProtectError(
          event.error ?? event.message ?? 'the socket reported an error',
        )
        report(failure)
        selfClosed = true
        closeQuietly(ws, 1000, 'error')
        finish({ fatal: isFatal(failure), penaltyMs: failure.retryAfterMs })
      })

      ws.addEventListener('close', (event) => {
        const code = typeof event.code === 'number' ? event.code : 0
        const reason = typeof event.reason === 'string' ? event.reason : ''
        log(`${channel}: closed (code ${String(code)}${reason === '' ? '' : `, "${reason}"`})`)
        if (code === PROTECT_WS_CLOSE_RATE_LIMITED) {
          const windowMs = penaltyMs ?? PROTECT_RATE_WINDOW_MS
          // Only when the 429 frame never arrived: `penalize` never shortens a penalty, but calling
          // it twice for one close would still be a lie about how much budget we spent.
          if (penaltyMs === null) limiter?.penalize(windowMs)
          report(
            new ProtectApiError(
              `The Protect ${channel} subscription was rate limited on connect (close code ` +
                `${String(PROTECT_WS_CLOSE_RATE_LIMITED)}). WebSocket upgrades count against the ` +
                `same budget as requests; retrying in at least ${String(windowMs)} ms.`,
              {
                kind: 'rate-limit',
                apiName: PROTECT_RATE_LIMIT_ERROR_NAME,
                retryAfterMs: windowMs,
                endpoint,
              },
            ),
          )
          finish({ fatal: false, penaltyMs: windowMs })
          return
        }
        if (!isStopped() && !selfClosed) {
          report(
            new ProtectApiError(
              `The Protect ${channel} subscription was closed by the console (code ` +
                `${String(code)}${reason === '' ? '' : `, "${reason}"`}). Reconnecting.`,
              { kind: 'closed', endpoint },
            ),
          )
        }
        finish({ fatal: false, penaltyMs: null })
      })

      if (idleTimeoutMs !== null) {
        void (async () => {
          // `stalls` counts only sleeps that came back without the clock moving — i.e. a fake clock
          // wired up wrongly in a test. Re-parking because a frame arrived and pushed `lastFrameAt`
          // forward is the normal case and must not count: counting it would force-close a
          // perfectly healthy socket after this many frames, and report it as a timeout.
          let stalls = 0
          while (!isSettled() && !isStopped()) {
            const remaining = lastFrameAt + idleTimeoutMs - now()
            if (remaining > 0) {
              const before = now()
              await raceStop(
                startBackoffWait(sleep, remaining, stopController.signal).done,
                undefined,
              )
              stalls = now() > before ? 0 : stalls + 1
              if (stalls < MAX_IDLE_ROUNDS) continue
              // Give up watching rather than spin: the socket is left alone, so a real close still
              // reconnects and only the idle check is lost.
              log(
                `${channel}: idle watcher stopped after ${String(MAX_IDLE_ROUNDS)} sleeps that ` +
                  'did not advance the clock',
              )
              return
            }
            if (isSettled() || isStopped()) return
            selfClosed = true
            report(
              new ProtectApiError(
                `The Protect ${channel} subscription received nothing for ` +
                  `${String(idleTimeoutMs)} ms. The console sends no keepalive pings, so a silent ` +
                  'socket is assumed dead; reconnecting.',
                { kind: 'timeout', endpoint },
              ),
            )
            closeQuietly(ws, 1000, 'idle')
            finish({ fatal: false, penaltyMs: null })
            return
          }
        })()
      }
    })
  }

  /** The key check, the permit and the connection. Never rejects. */
  async function attempt(): Promise<AttemptOutcome> {
    const key = apiKey()
    if (key === null || key === '') {
      // Checked before the permit: a doomed upgrade must not spend budget the REST client needs.
      report(
        new ProtectApiError(
          `The Protect ${channel} subscription has no API key. Add the Integration API key in ` +
            'Settings (UniFi OS → Control Plane → Integrations).',
          { kind: 'auth', endpoint },
        ),
      )
      return { fatal: true, stable: false, penaltyMs: null }
    }
    setState('connecting')
    if (limiter !== undefined) await raceStop(limiter.acquire(), undefined)
    if (isStopped()) return ABORTED
    return await raceStop(connectOnce(key), ABORTED)
  }

  async function run(): Promise<void> {
    while (!isStopped()) {
      let outcome: AttemptOutcome
      try {
        outcome = await attempt()
      } catch (err) {
        // Only a bug here or a mis-wired injected clock reaches this. Reporting and stopping beats
        // a loop that cannot tell whether it is making progress.
        report(
          new ProtectApiError(
            `The Protect ${channel} subscription stopped after an internal error: ` +
              `${messageOf(err)}.`,
            { kind: 'closed', endpoint, cause: err },
          ),
        )
        stopped = true
        releaseStop()
        setState('stopped')
        return
      }
      if (isStopped()) return
      if (outcome.fatal) {
        stopped = true
        releaseStop()
        setState('stopped')
        return
      }
      if (outcome.stable) failures = 0
      if (reconnectRequested) {
        reconnectRequested = false
        // Our own close (NFR-7): not a failure, and no wait — unless the console rate limited the
        // attempt in the meantime, whose floor still applies (the limiter holds it back too).
        failures = 0
        if (outcome.penaltyMs === null) continue
      }
      const delay = nextDelayMs(outcome.penaltyMs)
      penaltyUntil = outcome.penaltyMs === null ? null : now() + outcome.penaltyMs
      failures++
      setState('reconnecting')
      log(`${channel}: reconnecting in ${String(delay)} ms (attempt ${String(failures)})`)
      const wait = startBackoffWait(sleep, delay, stopController.signal)
      backoffWait = wait
      try {
        await raceStop(wait.done, undefined)
      } finally {
        backoffWait = null
      }
      // A wake ended the wait early: the backoff is gone, but a 429's floor is not. One more wait
      // for what is left of it, which no wake can cut short. Once only, so an injected clock that
      // does not move cannot spin here.
      const floor = penaltyUntil
      penaltyUntil = null
      const left = floor === null ? 0 : floor - now()
      if (left > 0 && !isStopped()) {
        log(`${channel}: rate limited; holding the reconnect back ${String(left)} ms more`)
        await raceStop(startBackoffWait(sleep, left, stopController.signal).done, undefined)
      }
    }
  }

  return {
    start() {
      if (started || isStopped()) return
      started = true
      loop = run()
    },
    async stop() {
      stopped = true
      releaseStop()
      setState('stopped')
      const ws = socket
      socket = null
      if (ws !== null) closeQuietly(ws, 1000, 'stopped')
      await loop
    },
    reconnectNow() {
      if (isStopped() || !started) return
      const wait = backoffWait
      if (wait !== null) {
        log(`${channel}: reconnecting now (woke or the network changed)`)
        failures = 0
        wait.wake()
        return
      }
      failures = 0
      const abort = abortAttempt
      if (abort === null) return
      reconnectRequested = true
      abort()
    },
    get state() {
      return state
    },
  }
}

// --- failure classification ---------------------------------------------------------------------

/** The kinds no amount of retrying can fix; both are resolved in Settings (CON-3/4). */
function isFatal(err: ProtectApiError): boolean {
  return err.kind === 'auth' || err.kind === 'pin'
}

/**
 * Classifies a thrown or `error`-event failure of an upgrade.
 *
 * `protectErrorFromThrown` already separates a pin failure from a plain network error and unwraps
 * undici's `cause` chain, so only the auth case is added here. **How a 401/403 surfaces on a
 * WebSocket upgrade is unverified** (P0.3 never pointed a bad key at the sockets): undici fails the
 * connection without exposing the HTTP response, so this looks for a status on the error or for the
 * status in its message, and anything unrecognised stays a retryable network error. Getting this
 * wrong in the lenient direction costs a retry loop that the backoff bounds; getting it wrong in
 * the other direction would stop a healthy subscription.
 */
function asProtectError(raw: unknown): ProtectApiError {
  if (raw instanceof ProtectApiError) return raw
  const status = authStatusOf(raw)
  if (status !== null) {
    return new ProtectApiError(
      `The Protect subscription was refused with HTTP ${String(status)}. Check the API key in ` +
        'Settings (UniFi OS → Control Plane → Integrations).',
      { kind: 'auth', status, cause: raw },
    )
  }
  try {
    protectErrorFromThrown(raw, 'The Protect subscription')
  } catch (err) {
    if (err instanceof ProtectApiError) return err
    throw err
  }
}

/** 401 or 403 if the failure says so anywhere we can read it, else `null`. */
function authStatusOf(raw: unknown): number | null {
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

const decoder = new TextDecoder()

/**
 * The text of a frame. Protect sends text frames only (P0.3 §5), but `binaryType` is set to
 * `arraybuffer` so that a binary one is still readable without an await inside the handler.
 */
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
