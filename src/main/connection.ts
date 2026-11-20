// The connection manager (P1.5): the single piece of state behind CON-5's indicator and CAM-1's
// camera list. It owns five things and nothing else — the per-endpoint `ConnectionStatus`, the
// camera inventory, the devices subscription that keeps the inventory current (CAM-2), the events
// subscription that feeds the cell scheduler (CELL-2, P4.2), and the door-state monitor that keeps
// the Live screen's unlock buttons and the Doors screen truthful (DOOR-6, P5.5/P5.6) — and it
// pushes every change to the renderer through `IPC_EVENTS`. It is also where every request that
// changes a physical door is made: the cell's unlock (P5.4) and the Doors screen's door actions
// and emergency status (P5.6), each exactly one PUT for one confirmed user action (DOOR-3/4).
//
// The two feeds open and close together (same endpoint, same key, same pinned Agent, same R9
// limiter), but **only the devices feed drives the Protect `ConnectionStatus`**. The badge answers
// "is the camera inventory live" (CON-5, CAM-2); the events feed is a second socket to the same
// console whose failures are almost always the devices feed's failures too, and letting both write
// the phase would make it flap between two sockets' retry loops. So an events-feed error is logged
// and nothing more, and a repeated `connect()` reopens an events feed that stopped by itself. The
// reverse is not symmetric on purpose: when the *devices* feed stops by itself (a rejected key or
// pin), the events feed is stopped with it — the badge then says "not connected", and a socket left
// switching cells behind it would contradict the badge; the next `connect()` opens both fresh.
//
// Why it is a module of its own rather than a few variables in the IPC handlers:
//
//  1. **Nothing connects on its own** (CON-4, R9) — with one exception the user opted into by
//     connecting. `connect()` and `testConnection()` are the only things that send a request, and
//     both exist because the user asked. The status is derived from config and pins, which are
//     offline reads, so the indicator is correct at launch without a single permit spent. The
//     exception is `connectOnLaunch()`: once a connect has *worked* (the devices feed reached
//     `open`), `console.connectOnLaunch` is persisted as `true`, and the next launch connects by
//     itself until the user clears or replaces the Protect key or moves the Protect endpoint — each
//     of which writes it back to `false`. (There is no Disconnect any more: the user removed it on
//     2026-11-17, since it closed only these live-update feeds while video kept playing.) An outage, a reconnect or a failed connect leaves it alone:
//     a console that is down when the app starts is not the user saying "stop connecting".
//  2. **`GET /v1/cameras` is the authority, not the feed** (R11, SPEC §5.1). The devices WebSocket
//     sends no initial state and its message shapes are unverified, so every connect, reconnect,
//     add and remove triggers a re-read; the feed only ever supplies a camera's `state`.
//  3. **A pin belongs to one `host:port`** (CON-3, P0.4 §4). `applyConsoleChange` is where that is
//     enforced: a fingerprint accepted for one console must never be applied to another, so
//     changing the address clears the pin for the endpoint whose `host:port` moved.
//  4. **No secret leaves main** (CON-2, NFR-9). The API key and the token are read through the
//     injected services at the moment of use and never put in a status, an event or a log line; the
//     renderer learns only `credentialStored`.
//
// **RTSP streams mode makes no Protect or Access call of any kind** (MODE-4). The mode is read from
// the live config (`services.current.mode`) on every call, never cached, so the IPC handler that
// saves it and this module can never disagree. Every path that can send a request checks it first:
// the user's calls (`connect`, `testConnection`, `snapshot`, `streamQualities`) refuse with an
// `AppModeError` (`bad-request`); the three door-changing calls answer their usual non-retryable
// refusal, logged to the unlock log like DOOR-0's; the watchers answer empty states; and the
// automatic paths (`connectOnLaunch`, `recover`, the door-state monitor and its retry timer, a
// feed's re-read) simply do nothing. `modeChanged()` is what tears the Protect side down on the
// switch. While in RTSP mode the status is derived exactly as for a Protect console that was never
// connected (`idle` / `unconfigured`, Access `disabled` or `idle`), with no error: nothing has been
// tried, so nothing has failed.
//
// **No Electron import, by construction.** The services, the event sink, the two subscription
// factories and the clock are all injected (`src/main/index.ts` wires the real ones), so the unit
// tests drive every phase, the feed and the pin-clearing in plain Node with no window and no socket.
import {
  IPC_EVENTS,
  emptyDoorsScreenState,
  ipcFail,
  ipcOk,
  type AccessProbe,
  type ConnectionPhase,
  type ConnectionStatus,
  type DoorActionInput,
  type DoorActionResult,
  type DoorActionSent,
  type DoorEmergencyInput,
  type DoorEmergencyResult,
  type DoorsScreenState,
  type EndpointName,
  type EndpointStatus,
  type IpcError,
  type IpcResult,
  type ProtectProbe,
  type RecoverReason,
  type RtspsAvailability,
  type SnapshotInput,
  type SnapshotResult,
  type TestConnection,
  type UnlockResult,
} from '@shared/ipc'
import { parseCameraRef } from '@shared/cameraRef'
import { doorDisplayName } from '@shared/doorName'
import type { Camera, ConsoleConfig, Door, DoorStates } from '@shared/models'
import { STREAM_QUALITIES } from '@shared/quality'
import {
  ACCESS_AUTH_ADVICE,
  AccessApiError,
  isAccessApiUnavailable,
  type AccessClient,
  type AccessErrorKind,
} from './access/client'
import type { DoorDetailsScope } from './access/doorDetailsMonitor'
import {
  FAILURES_BEFORE_UNKNOWN,
  createDoorStateMonitor,
  type DoorMonitorHaltReason,
  type DoorMonitorIntervals,
  type DoorNotificationHandlers,
  type DoorNotificationsHandle,
  type DoorReadResult,
  type DoorStateMonitor,
} from './access/doorStateMonitor'
import type { UnlockAttempt, UnlockLog, UnlockLogAction } from './access/unlockLog'
import { AppModeError, RTSP_MODE_MESSAGES, isRtspMode } from './appMode'
import type { Config } from './config/schema'
import type { ConfigStore } from './config/store'
import {
  ConsoleEndpointError,
  accessEndpoint,
  protectEndpoint,
  protectSubscribeUrl,
  type ConsoleEndpoint,
} from './console/endpoints'
import { toIpcError } from './ipc/errors'
import { isNeverConnectedError } from './net/errorCause'
import type { RateLimiter } from './net/rateLimiter'
import type { ProtectClient, SnapshotOptions } from './protect/client'
import { ProtectApiError } from './protect/errors'
import type { RtspsStreams } from './protect/types'
import {
  createDevicesSubscription,
  createEventsSubscription,
  type ProtectSubscription,
  type SubscriptionState,
} from './protect/subscriptions'
import type { Secrets } from './secrets/secrets'
import { rtspInventory } from './streams/rtspStreams'
import type { PinRegistry } from './tls/pinning'

/**
 * The slice of main's `Services` this module uses, declared structurally on purpose: importing
 * `src/main/index.ts` for its `Services` type would pull Electron in at module load (it reads
 * `app`, `safeStorage` and `BrowserWindow`), and this file has to run in a plain Node test.
 *
 * `current` is read on **every** call rather than captured: the user edits the console address and
 * the credentials while the app runs, and the clients and the pin store close over the same live
 * value (see `startServices`).
 */
export interface ConnectionServices {
  readonly config: Pick<ConfigStore, 'update'>
  current: Config
  /** CON-2: read to answer "is a credential stored", never to send a value anywhere. */
  readonly credentials: Secrets
  readonly pins: Pick<PinRegistry, 'pinnedFingerprint' | 'agentFor' | 'invalidate' | 'closeAll'>
  /** Shared with the REST client: a WebSocket upgrade spends a request permit too (R9). */
  readonly limiter: RateLimiter
  protect(): Pick<ProtectClient, 'metaInfo' | 'cameras' | 'snapshot' | 'rtspsStreams'>
  /**
   * `setLockRule` and `setEmergencyStatus` change physical doors: each is called from exactly one
   * place below (`doorAction`, `setDoorEmergency`), once per confirmed user action (DOOR-3/4).
   */
  access(): Pick<
    AccessClient,
    'doors' | 'unlock' | 'lockRule' | 'setLockRule' | 'emergencyStatus' | 'setEmergencyStatus'
  >
}

export interface ConnectionManagerOptions {
  readonly services: ConnectionServices
  /** `webContents.send` for the main window, or a recorder in the tests. */
  readonly emit: (channel: string, payload: unknown) => void
  /** Injected so the tests can drive a fake devices feed. */
  readonly createDevices?: typeof createDevicesSubscription
  /** Injected so the tests can drive a fake events feed (CELL-2). */
  readonly createEvents?: typeof createEventsSubscription
  readonly now?: () => number
  /** Safe lines only — no key, no token, no URL (CON-2, NFR-9). Default: no-op. */
  readonly log?: (line: string) => void
  /**
   * DOOR-5: where every unlock attempt is recorded (`createUnlockLog`, wired in
   * `src/main/index.ts`). Its `append` never rejects. Optional so the tests that never unlock need
   * not build one; without it attempts are only in `log`.
   */
  readonly unlockLog?: Pick<UnlockLog, 'append'>
  /**
   * DOOR-6: opens (and starts) the Access notifications WebSocket for the endpoint configured right
   * now, or answers `null` when it cannot (`src/main/index.ts` wires the real one). Called only when
   * the door-state monitor starts, so never while Access is off (DOOR-0). The socket's own failures
   * are the opener's to log: they never move the Access status, and polling covers for it. Default:
   * no socket, polling only. The handle's `reconnectNow` (P6.2) is what `recover()` calls.
   */
  readonly openDoorNotifications?: (
    handlers: DoorNotificationHandlers,
  ) => DoorNotificationsHandle | null
}

export interface ConnectionManager {
  /** CON-5, recomputed on every call: the derived parts can change without anything happening. */
  status(): ConnectionStatus
  /**
   * The inventory as main last read it (CAM-1). Empty before the first successful read. In RTSP
   * mode, the configured streams instead (RTSP-3, `rtspInventory`), built from the live config on
   * every call with no request.
   */
  cachedCameras(): Camera[]
  /**
   * CAM-1/2, CELL-2: read the inventory and open the devices and events feeds. Idempotent — a
   * second call while the feeds are up re-reads the inventory instead of opening another socket
   * (it only reopens an events feed that stopped by itself — even when that re-read fails), and two
   * overlapping calls are serialized rather than racing. Throws when the console is not configured
   * or the read fails, so the caller can report *why* (CON-4).
   */
  connect(): Promise<void>
  /**
   * CON-4's launch exception, called once by main after start-up. Connects through the same path as
   * `connect()` when — and only when — `console.connectOnLaunch` is set, the Protect endpoint
   * resolves, a Protect key is stored and the endpoint is pinned; otherwise it sends nothing. Never
   * rejects: a failure is logged (safe lines only) and left in the status exactly as a failed
   * `connect()` leaves it, so the badge and Settings show it the usual way.
   */
  connectOnLaunch(): Promise<void>
  /** CON-4: both halves probed independently; one failing is a normal, informative answer. */
  testConnection(): Promise<TestConnection>
  /** CAM-1: re-read `GET /v1/cameras` and cache it. */
  cameras(): Promise<Camera[]>
  /** CAM-1/3: one thumbnail, with CAM-3's "any failure means offline" rule applied. */
  snapshot(input: SnapshotInput): Promise<SnapshotResult>
  /**
   * QUAL-7: which RTSPS qualities already exist for one camera, as booleans. A `GET rtsps-stream`
   * and nothing else — it never POSTs, so looking at the camera list creates no stream on the
   * console (QUAL-8 creates on demand, from `ensureStream` only). Any failure rejects; the camera
   * list shows it as "streams unknown" rather than as an error.
   */
  streamQualities(cameraId: string): Promise<RtspsAvailability>
  /**
   * DOOR-3/4/5 (P5.4): unlock the door linked to a cell's camera ref (`<cameraId>` or
   * `<cameraId>:package`, which uses the doorbell's link — DOOR-2). The door comes from the saved
   * `doorLinks`, never from the renderer. DOOR-0 answers `disabled` (checked first) and no link
   * answers `not-found`, both with no Access call; otherwise exactly **one** `PUT
   * /doors/{id}/unlock` — never retried, never on a timer, and every failure answers
   * `retryable: false` (DOOR-3/4). A PUT that may have reached the console without an answer
   * (timeout, or a connection lost after connecting) answers ok with `outcome: 'unknown'`. Every
   * attempt, refusals included, is appended to the unlock log (DOOR-5) without the answer waiting
   * for the write. Never rejects.
   */
  unlockDoor(cameraRef: string): Promise<IpcResult<UnlockResult>>
  /**
   * DOOR-6 (P5.5): the Live screen says whether it shows an unlock control. Answers what is known
   * right now (`{}` when stopping, before the first read, or while the monitor cannot run); changes
   * follow as `IPC_EVENTS.doorStates`. The door-state monitor runs only while **all** of these
   * hold: the renderer is watching, Access is on (DOOR-0: otherwise no Access call, no socket, and
   * not even the client is resolved), the Access address resolves, a token is stored and at least
   * one door is linked. It only reads (`GET /doors`, the notifications socket); it never unlocks.
   * Never fails: a read that fails shows as doors missing from the map and as the Access status.
   */
  watchDoors(watching: boolean): IpcResult<DoorStates>
  /**
   * P5.6: the Doors screen says whether it is open. A second, independent reason for the door-state
   * monitor to run: it runs while Access is on (DOOR-0), the address resolves, a token is stored
   * and **either** the Live screen watches a linked door **or** the Doors screen is open. While the
   * screen is open the monitor tracks every door the console lists and reads each door's lock rule
   * and the emergency status; all of it is read-only. Answers the state right now (everything
   * unknown when closing); changes follow as `IPC_EVENTS.doorsScreen`. Never fails: why the doors
   * cannot be read — Access off, no address, no token, a rejected token or certificate, the last
   * failed read — is the state's `error`.
   */
  watchDoorsScreen(open: boolean): IpcResult<DoorsScreenState>
  /**
   * DOOR-3/4/5 (P5.6): one action on one door from the Doors screen — **changes a physical door**.
   * In this order: DOOR-0 answers `disabled`; a door id that is not in the list main itself last
   * read from the current console (while the Doors screen is open) answers `not-found`; a door with
   * no hub answers `bad-request` — all three with no Access call. Otherwise exactly **one** PUT
   * (`…/unlock` or `…/lock_rule`), never retried, never on a timer, every failure
   * `retryable: false`; a PUT that may have reached the console without an answer is ok with
   * `outcome: 'unknown'`. Every attempt, the three refusals included, is appended to the unlock log
   * (DOOR-5) without the answer waiting for the write. Never rejects.
   */
  doorAction(input: DoorActionInput): Promise<IpcResult<DoorActionResult>>
  /**
   * DOOR-3/4/5 (P5.6): lockdown / evacuation of **every** door, or back to normal. DOOR-0 answers
   * `disabled` with no call; otherwise exactly **one** `PUT /doors/settings/emergency`, never
   * retried, with the same failure, unknown-outcome, logging and status rules as `doorAction`.
   * Never rejects.
   */
  setDoorEmergency(input: DoorEmergencyInput): Promise<IpcResult<DoorEmergencyResult>>
  /**
   * DOOR-6: something the door-state monitor depends on has just changed outside
   * `applyConsoleChange` — the Access token was stored or cleared, a certificate was accepted or
   * re-accepted, or the door links were saved. Starts or stops the monitor to match, and asks a
   * monitor that keeps running for a read now (which also drops doors that are no longer linked).
   * Sends nothing by itself while the monitor may not run.
   *
   * `trustChanged` (P5.6): the token or a certificate is what changed, so the door list the Doors
   * screen was shown — the list `doorAction` accepts door ids from — may belong to another account
   * or console. A monitor that keeps running drops it and reads it again.
   */
  accessInputsChanged(reason: string, options?: { readonly trustChanged?: boolean }): void
  /**
   * DOOR-6 (P5.6): `accessPolling` has just been saved. The monitor reads the intervals at every
   * scheduling decision; this re-arms its pending timers so a shorter one applies now. Sends
   * nothing by itself.
   */
  accessPollingChanged(): void
  /**
   * NFR-7 (P6.2): the machine woke from sleep (`resume`) or its network changed (`network`), so
   * every socket may be dead without knowing it and every backoff that grew while the network was
   * gone is only a delay now. Cuts them short on whatever is running: both Protect feeds
   * `reconnectNow()` (each still takes a rate-limit permit, R9, and the devices feed's reconnect
   * re-reads the inventory, R11), and a running door-state monitor reads `GET /doors` at once and
   * reconnects its notifications socket (`recoverNow`). Nothing that is not running is started: a
   * feed that stopped for good on its key or pin stays stopped, and so does a door monitor halted
   * on a rejected token (its 60 s retry is untouched). Never sends a door action (DOOR-3/4).
   * Synchronous and never throws.
   */
  recover(reason: RecoverReason): void
  /**
   * CON-1/2: the Protect API key has just been deleted. Closes the feed and empties the inventory,
   * because nothing may keep running on a credential the user has removed. Clears
   * `console.connectOnLaunch` too: there is no key left for a launch to connect with.
   */
  credentialCleared(): Promise<void>
  /**
   * CON-4: a *different* Protect API key has just been stored. Clears `console.connectOnLaunch`,
   * because "it worked" was said of the previous key: the new one has to reach `open` once before a
   * launch connects with it by itself. A running feed is left alone — it reads the key per upgrade.
   */
  credentialReplaced(): Promise<void>
  /** CON-1/3, DOOR-0: persist an edited console block, clearing a pin that no longer applies. */
  applyConsoleChange(next: ConsoleConfig): Promise<void>
  /**
   * MODE-4: `mode` has just been saved (by `vp:app/mode`); the manager reads it from the live
   * config. **Entering RTSP mode** stops both Protect feeds (and with them their reconnect
   * timers), stops the door-state monitor and its retry timer, resets both endpoint statuses to a
   * never-connected `idle`, empties the Protect inventory and pushes the RTSP inventory (RTSP-3),
   * the status and the Doors screen's state. **Back in Protect mode it only pushes the Protect
   * inventory** (empty until the next connect), so the RTSP streams leave the renderer at once;
   * switching back otherwise behaves like a launch, which is the caller's `connectOnLaunch()`
   * (CON-4). The monitor, its retry timer and
   * both feeds are stopped **synchronously, when this is called**, so nothing polls Access or
   * reconnects a feed while the rest waits; the rest (the status reset, the inventory, the pushes)
   * is serialized with `connect` and `applyConsoleChange`, so a connect in progress finishes (it
   * finds RTSP mode and throws `AppModeError`) before it runs, and one queued behind this sees the
   * new mode. Never rejects.
   */
  modeChanged(): Promise<void>
  /**
   * RTSP-3: `rtsp.streams` (or a stream's URLs) has just been saved. In RTSP mode pushes the new
   * RTSP inventory as `cameras`; in Protect mode does nothing (the streams are not the inventory
   * there). Synchronous and never throws.
   */
  rtspStreamsChanged(): void
  /**
   * App shutdown: close the feed and every pinned Agent. Leaves `console.connectOnLaunch` as it is —
   * quitting is not a reason to stop, and the next launch is exactly when it is meant to apply.
   */
  shutdown(): Promise<void>
}

/**
 * The phases the app itself moves through. `disabled` and `unconfigured` are **derived** from the
 * config on every read (see {@link ConnectionManager.status}), so they are deliberately not storable
 * here: a saved `unconfigured` would survive the host being entered.
 */
type LivePhase = Exclude<ConnectionPhase, 'disabled' | 'unconfigured'>

/**
 * CAM-3 plus R11. A snapshot can fail for two very different reasons, and conflating them is the bug
 * this split exists to prevent: an expired key or an unpinned console is **Settings'** business and
 * has to reach the user as a real error, while anything else is reported as the camera being
 * unavailable — the contract's documented 503 for an offline camera has never been observed, so
 * "any other failure" is the only honest test for it.
 */
const SNAPSHOT_REPORTED_KINDS: readonly IpcError['kind'][] = [
  'auth',
  'pin-required',
  'pin-mismatch',
  'rate-limit',
  'not-configured',
]

/**
 * `GET rtsps-stream`'s answer reduced to "is there one" per quality (QUAL-7). **This is where the
 * URLs stop**: the values are the RTSPS URLs, whose alias is the stream's credential (CON-2, NFR-9),
 * so nothing but a boolean per key is copied out. A quality the console did not mention counts as
 * absent, the same lenient reading the client applies (R8).
 */
export function rtspsAvailability(streams: RtspsStreams): RtspsAvailability {
  const out: Partial<RtspsAvailability> = {}
  for (const quality of STREAM_QUALITIES) out[quality] = typeof streams[quality] === 'string'
  return out as RtspsAvailability
}

/** What is remembered per endpoint between calls. Everything else in `EndpointStatus` is derived. */
interface EndpointState {
  phase: LivePhase
  error: IpcError | null
  /** Protect's `applicationVersion` from the last successful `GET /v1/meta/info` (CON-4). */
  version: string | null
  updatedAt: number
}

/**
 * Unlock failures that are about **the door**, not the Access endpoint: the console answered, so the
 * endpoint is reachable and the token accepted — it refused this one door (`forbidden`, e.g. no Door
 * Hub), does not have it any more (`not-found`, a stale link) or rejected the request. These leave
 * the Access status `connected` rather than painting the badge red for a fault that is the door's.
 */
const DOOR_LEVEL_UNLOCK_KINDS: ReadonlySet<AccessErrorKind> = new Set([
  'forbidden',
  'not-found',
  'bad-request',
])

/**
 * DOOR-6: how often a door-state monitor that is still wanted but stopped itself on a rejected
 * token (`auth`) is started again. One 401 during a console restart must not leave a wall display
 * without door state until somebody opens Settings; each retry costs one `GET /doors`. A `pin`
 * halt is **never** retried (CON-3), and neither is `disabled` or an unavailable API: those wait
 * for the setting to change, or for another Access call to work.
 */
export const DOOR_MONITOR_AUTH_RETRY_MS = 60_000

/**
 * DOOR-3 (user decision 2026-11-18): an unlock whose PUT **may have reached the console** but got no
 * answer. A `timeout` always may have — the request was written and the console went quiet. A
 * `network` failure may have too (a reset or a socket closed after the request was sent), unless
 * the cause chain shows the connection was never made at all (refused, no such host, no route:
 * `isNeverConnectedError`). Refusals that never send anything (DOOR-0, no link, no token, a
 * certificate not accepted) are not `AccessApiError`s of these kinds, so they stay plain failures.
 * Such an attempt answers `ok` with `outcome: 'unknown'`: reporting a failure for a door that may
 * have opened would invite a second press, a second door release.
 */
function unlockOutcomeUnknown(err: unknown): boolean {
  if (!(err instanceof AccessApiError)) return false
  if (err.kind === 'timeout') return true
  return err.kind === 'network' && !isNeverConnectedError(err)
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const { services, emit } = options
  const createDevices = options.createDevices ?? createDevicesSubscription
  const createEvents = options.createEvents ?? createEventsSubscription
  const now = options.now ?? Date.now
  const log = options.log ?? ((): void => undefined)
  const unlockLog = options.unlockLog ?? null
  const openDoorNotifications = options.openDoorNotifications ?? ((): null => null)

  let inventory: Camera[] = []
  let subscription: ProtectSubscription | null = null
  /** True while the feed is stopping because we asked it to, so its `stopped` reads as `idle`. */
  let stopRequested = false
  /**
   * The events feed (CELL-2). Separate from `subscription` because it can stop on its own while the
   * devices feed stays up (and the reverse), and neither should take the other down with it.
   */
  let eventsFeed: ProtectSubscription | null = null

  const state: Record<EndpointName, EndpointState> = {
    protect: { phase: 'idle', error: null, version: null, updatedAt: now() },
    access: { phase: 'idle', error: null, version: null, updatedAt: now() },
  }

  /**
   * **One at a time.** `connect`, `credentialCleared`, `applyConsoleChange` and `shutdown` all move the
   * subscription, or the address it is bound to, across an `await` — and Settings drives them from
   * separate busy flags, so two of them overlapping is a normal thing for the UI to do.
   *
   * Without this, both failures are silent and permanent: two connects each read
   * `subscription === null` before either had opened its socket, so the first WebSocket leaked for
   * the life of the process and doubled every event and every inventory re-read against the R9
   * budget; and a connect that interleaved with a console change opened its feed against the
   * *pre-save* endpoint, which the save then re-labelled `idle` while `subscription !== null` kept
   * anything from ever replacing it. One queue is the fix for both, rather than a flag per case.
   */
  let queue: Promise<unknown> = Promise.resolve()
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    // `then(task, task)`: a failed call must not stop the queue, and each caller keeps its own
    // result — a connect that fails is reported to the window that asked for it, and no other.
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  // --- derivation -------------------------------------------------------------------------------

  /** MODE-4: the live config's mode, read per call (the header). */
  function rtspMode(): boolean {
    return isRtspMode(services.current)
  }

  /** The resolved endpoint, or `null` while the address cannot be parsed at all (CON-1). */
  function endpointOf(which: EndpointName): ConsoleEndpoint | null {
    const consoleConfig = services.current.console
    try {
      return which === 'protect' ? protectEndpoint(consoleConfig) : accessEndpoint(consoleConfig)
    } catch (err) {
      if (err instanceof ConsoleEndpointError) return null
      throw err
    }
  }

  /**
   * CON-3. A *stored* pin that is not a fingerprint throws rather than reading as "unpinned"
   * (pinning.ts), and for the indicator that is still "not pinned": the user has to re-accept the
   * certificate either way, and the attempt to use it will say so with the real message.
   */
  function pinnedFor(endpoint: ConsoleEndpoint | null): boolean {
    if (endpoint === null) return false
    try {
      return services.pins.pinnedFingerprint(endpoint.host, endpoint.port) !== null
    } catch {
      return false
    }
  }

  /** CON-1/2: whether the keystore holds this endpoint's credential. Never the value (NFR-9). */
  function credentialStored(which: EndpointName): boolean {
    const held =
      which === 'protect' ? services.credentials.protectApiKey : services.credentials.accessToken
    return held !== undefined && held !== ''
  }

  function endpointStatus(which: EndpointName): EndpointStatus {
    const endpoint = endpointOf(which)
    const stored = credentialStored(which)
    const remembered = state[which]
    const phase: ConnectionPhase =
      // DOOR-0 wins over everything: while Access is off the app makes no Access call at all, so
      // no other phase can be true of it.
      which === 'access' && !services.current.console.accessEnabled
        ? 'disabled'
        : endpoint === null || !stored
          ? 'unconfigured'
          : remembered.phase
    return {
      endpoint: which,
      phase,
      hostPort: endpoint?.hostPort ?? null,
      pinned: pinnedFor(endpoint),
      credentialStored: stored,
      version: remembered.version,
      error: remembered.error,
      updatedAt: remembered.updatedAt,
    }
  }

  function status(): ConnectionStatus {
    return { protect: endpointStatus('protect'), access: endpointStatus('access') }
  }

  // --- pushing to the renderer ------------------------------------------------------------------

  function emitStatus(): void {
    emit(IPC_EVENTS.connection.channel, status())
  }

  /**
   * The inventory of the current mode: the Protect one main read (CAM-1), or in RTSP mode the
   * configured streams (RTSP-3), rebuilt from the live config. Either way a fresh array: the cached
   * one is replaced on every change, but a caller must not alias it.
   */
  function currentCameras(): Camera[] {
    return rtspMode() ? rtspInventory(services.current.rtsp.streams) : [...inventory]
  }

  function emitCameras(): void {
    emit(IPC_EVENTS.cameras.channel, currentCameras())
  }

  function recordError(which: EndpointName, err: unknown, endpoint: string | null): IpcError {
    const error = toIpcError(err, { endpoint })
    const slot = state[which]
    slot.error = error
    slot.updatedAt = now()
    log(`${which}: ${error.kind}: ${error.message}`)
    return error
  }

  // --- CON-4's launch flag ------------------------------------------------------------------------

  /**
   * `console.connectOnLaunch` onto `current` at once and onto the disk through `config.update`, the
   * same two-step `applyConsoleChange` uses, touching that one field so a View or pin write queued
   * ahead of it is not overwritten. **Only when the value changes**: every reconnect reaches `open`
   * again, and a config write per reconnect would be pointless disk churn. `current` is set before
   * the write rather than after so two calls in a row (an `open`, then a key change) compare against
   * the newest value; the config store's own queue keeps the writes in call order. A failed write is
   * logged and swallowed — this is called from feed callbacks, and the session works either way; it
   * is only the next launch that would decide differently.
   */
  function persistConnectOnLaunch(value: boolean): void {
    if (services.current.console.connectOnLaunch === value) return
    services.current = {
      ...services.current,
      console: { ...services.current.console, connectOnLaunch: value },
    }
    void services.config
      .update((latest) => ({ ...latest, console: { ...latest.console, connectOnLaunch: value } }))
      .then(
        () => {
          log(`connect on launch: ${value ? 'on (a connect worked)' : 'off'}`)
        },
        (err: unknown) => {
          // Put memory back to what the disk still says, unless something newer has set it since:
          // otherwise the early return above would stop every later call from retrying the write,
          // and a key change whose `false` never landed would reconnect at the next launch.
          if (services.current.console.connectOnLaunch === value) {
            services.current = {
              ...services.current,
              console: { ...services.current.console, connectOnLaunch: !value },
            }
          }
          log(
            `connect on launch: could not save the setting: ${err instanceof Error ? err.name : 'unknown error'}`,
          )
        },
      )
  }

  // --- the inventory ----------------------------------------------------------------------------

  /**
   * `GET /v1/cameras` into the cache and out to the renderer (CAM-1, R11). Every path that learns
   * the inventory may have changed comes through here, including `listCameras`: emitting there too
   * costs one duplicate event and keeps every listener on the same list as main's cache.
   */
  async function refreshInventory(reason: string): Promise<Camera[]> {
    // MODE-4: no request in RTSP mode — and none of a read that was in flight when the mode
    // switched may refill the inventory `modeChanged` has just emptied.
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    const cameras = await services.protect().cameras()
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    inventory = cameras
    log(`inventory re-read after ${reason}: ${String(cameras.length)} camera(s)`)
    emitCameras()
    return cameras
  }

  /**
   * The feed's own re-read (R11). A failure is reported through the status and **does not stop the
   * subscription**: the socket is still the only live signal there is, the next reconnect re-reads
   * anyway, and tearing the feed down over one failed GET would lose the camera states too.
   */
  function refreshFromFeed(reason: string): void {
    // MODE-4: a feed callback that lands between the mode being saved and `modeChanged` closing the
    // feed. Not a failure of the console, so nothing is recorded in the status.
    if (rtspMode()) return
    void refreshInventory(reason).catch((err: unknown) => {
      if (err instanceof AppModeError) return
      recordError('protect', err, endpointOf('protect')?.hostPort ?? null)
      emitStatus()
    })
  }

  // --- the devices feed -------------------------------------------------------------------------

  function applyFeedState(next: SubscriptionState): void {
    const slot = state.protect
    switch (next) {
      case 'connecting':
        slot.phase = 'connecting'
        break
      case 'open':
        slot.phase = 'connected'
        // The connection is up, so the failure that preceded it is history (CON-5).
        slot.error = null
        break
      case 'reconnecting':
        slot.phase = 'reconnecting'
        break
      case 'stopped':
        // A subscription stops for good either because we asked (a cleared key, a moved console,
        // shutdown) or because
        // the key or the pin is wrong, which no retry can fix (subscriptions.ts rule 4). The second
        // case has already reported through `onError`, so the phase is that failure.
        slot.phase = stopRequested || slot.error === null ? 'idle' : 'error'
        // Dropped so the next `connect()` builds a fresh one rather than reusing a dead socket.
        subscription = null
        break
      case 'idle':
        break
    }
    slot.updatedAt = now()
  }

  function startFeed(endpoint: ConsoleEndpoint): void {
    // MODE-4, last line of defence: every caller has checked the mode already.
    if (rtspMode()) {
      log('devices feed: not opened (RTSP streams mode)')
      return
    }
    stopRequested = false
    const feed = createDevices({
      url: protectSubscribeUrl(endpoint, 'devices'),
      // Read per upgrade, so a key edited in Settings is used by the next reconnect (CON-1).
      apiKey: () => services.credentials.protectApiKey ?? null,
      // Read per upgrade too, so an accepted or replaced pin applies without a new subscription.
      dispatcher: () => services.pins.agentFor(endpoint.host, endpoint.port),
      limiter: services.limiter,
      onCameraState: (change) => {
        // The feed's one trusted field (R11). The camera is replaced rather than mutated so a
        // listener holding the previous array sees a stable value.
        inventory = inventory.map((camera) =>
          camera.id === change.cameraId ? { ...camera, state: change.state } : camera,
        )
        // Sent even for a camera the cache does not know yet: that means our inventory is stale,
        // which the `onInventoryChanged`/`onConnected` re-read is about to fix anyway.
        emit(IPC_EVENTS.cameraState.channel, change)
      },
      onInventoryChanged: (reason) => {
        refreshFromFeed(`a camera was ${reason === 'add' ? 'added' : 'removed'}`)
      },
      onConnected: ({ reconnect }) => {
        // R11: the feed sends no initial state, so the inventory is re-read after **every**
        // connect — whatever changed while the socket was down is recovered here, not by the feed.
        refreshFromFeed(reconnect ? 'a reconnect' : 'the first connect')
      },
      onStateChange: (next) => {
        // Read before `applyFeedState` drops the handle. A stop we asked for has already cleared
        // it, so `current` on a `stopped` means this feed stopped by itself (header).
        const current = subscription === feed
        applyFeedState(next)
        if (next === 'stopped' && current) stopEventsFeed()
        // CON-4: the feed opening is the evidence that this console, key and pin work, so the next
        // launch may connect by itself. Only for the live feed: a stale one has no say. Written once,
        // not per reconnect (see `persistConnectOnLaunch`).
        if (next === 'open' && current) persistConnectOnLaunch(true)
        emitStatus()
      },
      onError: (err) => {
        recordError('protect', err, endpoint.hostPort)
        emitStatus()
      },
      log,
    })
    subscription = feed
    feed.start()
  }

  // --- the events feed (CELL-2) -----------------------------------------------------------------

  /**
   * One push per mapped events-WS message, repeats included: the scheduler is idempotent on
   * `(id, end)` (subscriptions.ts), so deduping here would only hide the lifecycle from it. Nothing
   * is logged per event — a busy driveway is dozens a minute — and nothing here writes `state`:
   * the subscription logs its own errors and reconnects (safe lines, `events:` prefixed), and the
   * status stays the devices feed's alone (see the header).
   */
  function startEventsFeed(endpoint: ConsoleEndpoint): void {
    // MODE-4, last line of defence: every caller has checked the mode already.
    if (rtspMode()) {
      log('events feed: not opened (RTSP streams mode)')
      return
    }
    const feed = createEvents({
      url: protectSubscribeUrl(endpoint, 'events'),
      // The same per-upgrade reads as the devices feed, for the same reasons (CON-1, CON-3).
      apiKey: () => services.credentials.protectApiKey ?? null,
      dispatcher: () => services.pins.agentFor(endpoint.host, endpoint.port),
      limiter: services.limiter,
      onEvent: (event) => {
        emit(IPC_EVENTS.cameraEvent.channel, event)
      },
      onStateChange: (next) => {
        if (next !== 'stopped' || eventsFeed !== feed) return
        // Stopped of its own accord (a wrong key or pin: no retry can fix it). Dropped so the next
        // `connect()` opens a fresh one. A stop we asked for has already cleared the handle, and the
        // identity check keeps a late `stopped` from an old feed from forgetting a newer one.
        eventsFeed = null
        log('events feed stopped and will not retry; the next connect reopens it')
      },
      log,
    })
    eventsFeed = feed
    feed.start()
  }

  /**
   * The events feed alone, from inside the devices feed's `stopped` callback (header): the handle is
   * dropped at once, so a `connect()` queued behind it opens a fresh one, and the stop is not awaited
   * (a callback cannot). Its own late `stopped` then fails the `eventsFeed === feed` check and so
   * cannot forget a newer feed.
   */
  function stopEventsFeed(): void {
    const events = eventsFeed
    if (events === null) return
    eventsFeed = null
    log('events feed stopped with the devices feed; the next connect reopens both')
    void events.stop().catch((err: unknown) => {
      log(`events feed: stop failed: ${err instanceof Error ? err.name : 'unknown error'}`)
    })
  }

  /** Both feeds, together: every path that stops one stops the other (CON-1/2/3, shutdown). */
  async function stopFeed(): Promise<void> {
    stopRequested = true
    const feed = subscription
    const events = eventsFeed
    subscription = null
    eventsFeed = null
    await Promise.all([feed?.stop(), events?.stop()])
  }

  // --- the door-state monitor (DOOR-6, P5.5) ------------------------------------------------------

  /** Whether the renderer has a Live screen with an unlock control up (`watchDoors`). */
  let doorsWatched = false
  /** Built on first use, so a session that never watches builds nothing. One for the manager's life. */
  let doorMonitor: DoorStateMonitor | null = null
  /**
   * The `state.access` slot the monitor's current run started under. `applyConsoleChange` swaps the
   * slot, so a result reported under another one belongs to an endpoint the user has since replaced
   * and must not reach the new one's indicator (the same identity check as `readDoors`).
   */
  let doorMonitorSlot: EndpointState | null = null
  /** True while `applyConsoleChange` is between the old endpoint and the new: nothing may start. */
  let doorMonitorHeld = false
  /** The one pending `DOOR_MONITOR_AUTH_RETRY_MS` restart, or `null`. */
  let doorMonitorRetry: ReturnType<typeof setTimeout> | null = null

  function cancelDoorMonitorRetry(): void {
    if (doorMonitorRetry === null) return
    clearTimeout(doorMonitorRetry)
    doorMonitorRetry = null
  }

  /** Stops the monitor and anything that would start it again by itself. */
  function stopDoorMonitor(): void {
    cancelDoorMonitorRetry()
    doorMonitor?.stop()
  }

  /**
   * The monitor stopped by itself. Only a rejected token is retried on a timer (see
   * `DOOR_MONITOR_AUTH_RETRY_MS`); never more than one timer is pending, and every sync, stop and
   * shutdown clears it. A retry that fails the same way changes nothing the user sees: the status
   * is already that error, so `applyDoorReadResult` neither pushes nor logs it again.
   */
  function doorMonitorHalted(reason: DoorMonitorHaltReason): void {
    if (reason !== 'auth' || doorMonitorRetry !== null) return
    doorMonitorRetry = setTimeout(() => {
      doorMonitorRetry = null
      syncDoorMonitor()
    }, DOOR_MONITOR_AUTH_RETRY_MS)
  }

  function linkedDoorIds(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const id of Object.values(services.current.doorLinks)) {
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
    return ids
  }

  /**
   * P5.6: whether the renderer has the Doors screen open (`watchDoorsScreen`). Independent of
   * `doorsWatched`: the renderer mounts one screen and unmounts the other in either order.
   */
  let doorsScreenOpen = false
  /** `JSON` of the Doors screen state the renderer was last given, so only a change is pushed. */
  let doorsScreenSent = JSON.stringify(emptyDoorsScreenState())
  /**
   * True while `watchDoorsScreen` is working out its answer. What changes during the call (the
   * monitor starting or stopping, the reason nothing is read) is in that answer, so it is not
   * pushed as well: the renderer would get the same state twice, the push first.
   */
  let doorsScreenAnswering = false

  /**
   * Every precondition is an offline read: deciding not to run sends nothing (DOOR-0). Two
   * watchers (P5.6): the Live screen needs a link to have anything to show, the Doors screen lists
   * every door and so needs none.
   */
  function doorMonitorWanted(): boolean {
    return (
      !doorMonitorHeld &&
      // MODE-4: no Access call in RTSP mode. This one check also covers the halted monitor's
      // retry timer, which ends in `syncDoorMonitor`.
      !rtspMode() &&
      services.current.console.accessEnabled &&
      credentialStored('access') &&
      endpointOf('access') !== null &&
      ((doorsWatched && linkedDoorIds().size > 0) || doorsScreenOpen)
    )
  }

  /** The saved `accessPolling` seconds as the monitor's milliseconds, read at every use. */
  function doorMonitorIntervals(): DoorMonitorIntervals {
    const polling = services.current.accessPolling
    return {
      withSocketMs: polling.withSocketSec * 1000,
      withoutSocketMs: polling.withoutSocketSec * 1000,
      unlockedMs: polling.unlockedSec * 1000,
      detailsMs: polling.detailsSec * 1000,
    }
  }

  /**
   * Why the monitor cannot even start for the Doors screen, as the error the screen shows, or
   * `null` when nothing is in the way. The same three offline checks as {@link doorMonitorWanted},
   * in the order the user has to fix them. No Access call (DOOR-0).
   */
  function doorsScreenBlocked(): IpcError | null {
    if (rtspMode()) {
      return {
        kind: 'bad-request',
        message: RTSP_MODE_MESSAGES.doors,
        endpoint: null,
        retryable: false,
      }
    }
    const consoleConfig = services.current.console
    if (!consoleConfig.accessEnabled) {
      return {
        kind: 'disabled',
        message:
          'UniFi Access is turned off, so the doors are not read. Turn on "Enable UniFi ' +
          'Access" in Settings first (DOOR-0).',
        endpoint: endpointOf('access')?.hostPort ?? null,
        retryable: false,
      }
    }
    let endpoint: ConsoleEndpoint
    try {
      endpoint = accessEndpoint(consoleConfig)
    } catch (err) {
      // CON-1: the parser's own message says what is wrong with the address.
      return toIpcError(err, { endpoint: null })
    }
    if (!credentialStored('access')) {
      return {
        kind: 'auth',
        message: `No Access API token is saved, so the doors cannot be read.${ACCESS_AUTH_ADVICE}`,
        endpoint: endpoint.hostPort,
        retryable: false,
      }
    }
    return null
  }

  /**
   * The Doors screen's state right now. The monitor's while it runs — or after it stopped by
   * itself, when its last error is why nothing is listed — and otherwise "nothing known" plus the
   * reason nothing is being read, if there is one.
   */
  function doorsScreenState(): DoorsScreenState {
    if (!doorsScreenOpen) return emptyDoorsScreenState()
    // MODE-4: nothing is read, and nothing the monitor kept from before the switch is shown.
    if (rtspMode()) return { ...emptyDoorsScreenState(), error: doorsScreenBlocked() }
    const monitored = doorMonitor?.screen ?? emptyDoorsScreenState()
    if (doorMonitor?.running === true || monitored.error !== null) return monitored
    // Held: between two endpoints, for the length of a save. Not an error; the list follows.
    if (doorMonitorHeld) return monitored
    return { ...emptyDoorsScreenState(), error: doorsScreenBlocked() }
  }

  /** Pushes the Doors screen's state if it is open and differs from what was last given. */
  function pushDoorsScreen(): void {
    if (doorsScreenAnswering) return
    const next = doorsScreenState()
    const key = JSON.stringify(next)
    if (key === doorsScreenSent) return
    doorsScreenSent = key
    if (doorsScreenOpen) emit(IPC_EVENTS.doorsScreen.channel, next)
  }

  /**
   * The monitor's reads are real answers from the Access endpoint, so the status follows them as it
   * follows `readDoors` — but **only on a transition**: a poll every few seconds must not push the
   * same status, or log the same failure, every few seconds. Compared against the slot itself, so a
   * Test connection or an unlock that moved the status in between is taken into account.
   *
   * One failed poll is not an outage: the monitor keeps its states through it, and the status keeps
   * `connected` by the same rule, turning to `error` only at the failure that makes the states
   * unknown (`FAILURES_BEFORE_UNKNOWN`). A failure that halts the monitor applies at once.
   */
  function applyDoorReadResult(result: DoorReadResult): void {
    const slot = state.access
    if (slot !== doorMonitorSlot) return
    if (result.ok) {
      if (slot.phase === 'connected' && slot.error === null) return
      slot.phase = 'connected'
      slot.error = null
      slot.updatedAt = now()
      log('access: door monitor: connected')
    } else {
      if (!result.fatal && result.failures < FAILURES_BEFORE_UNKNOWN) return
      const error = toIpcError(result.error, { endpoint: endpointOf('access')?.hostPort ?? null })
      if (slot.phase === 'error' && slot.error?.kind === error.kind) return
      slot.phase = 'error'
      slot.error = error
      slot.updatedAt = now()
      log(`access: door monitor: ${error.kind}: ${error.message}`)
    }
    emitStatus()
  }

  function ensureDoorMonitor(): DoorStateMonitor {
    doorMonitor ??= createDoorStateMonitor({
      // Resolved per read: the client is rebuilt when the address changes (see `startServices`).
      // Quiet: a poll every few seconds must not write a log line per request.
      readDoors: () => services.access().doors({ quiet: true }),
      openNotifications: openDoorNotifications,
      linkedDoorIds,
      onStates: (states) => {
        emit(IPC_EVENTS.doorStates.channel, states)
      },
      onReadResult: applyDoorReadResult,
      onHalt: doorMonitorHalted,
      intervals: doorMonitorIntervals,
      screen: {
        open: () => doorsScreenOpen,
        // Both quiet: a round is a request per door, every `detailsSec`, and on a console older
        // than Access 1.24.6 each of them fails for ever. The details monitor logs transitions.
        readEmergency: () => services.access().emergencyStatus({ quiet: true }),
        readLockRule: (doorId) => services.access().lockRule(doorId, { quiet: true }),
        // The manager's own view is what goes out (`doorsScreenState`), so the payload is ignored.
        onState: () => {
          pushDoorsScreen()
        },
        toError: (error) => toIpcError(error, { endpoint: endpointOf('access')?.hostPort ?? null }),
      },
      log: (line) => {
        log(`access: ${line}`)
      },
    })
    return doorMonitor
  }

  /**
   * Starts or stops the monitor to match {@link doorMonitorWanted}. A monitor that stopped by
   * itself (a rejected token, a certificate not accepted) is started again here, which costs one
   * read per change the user made — the way to learn that the change fixed it. Any pending retry
   * is dropped first: this call is that retry, or makes it moot.
   */
  function syncDoorMonitor(): void {
    cancelDoorMonitorRetry()
    if (!doorMonitorWanted()) {
      doorMonitor?.stop()
      // The Doors screen may have just lost its list, or gained a reason nothing is read.
      pushDoorsScreen()
      return
    }
    const monitor = ensureDoorMonitor()
    if (!monitor.running) {
      doorMonitorSlot = state.access
      monitor.start()
    }
    pushDoorsScreen()
  }

  function watchDoors(watching: boolean): IpcResult<DoorStates> {
    // Recorded in either mode: it is the renderer's state, and the monitor's conditions read it.
    doorsWatched = watching
    syncDoorMonitor()
    // MODE-4: no door is read in RTSP mode, so no state is known.
    if (rtspMode()) return ipcOk({})
    return ipcOk(doorMonitor?.states ?? {})
  }

  function watchDoorsScreen(open: boolean): IpcResult<DoorsScreenState> {
    const changed = doorsScreenOpen !== open
    doorsScreenOpen = open
    const wasRunning = doorMonitor?.running === true
    doorsScreenAnswering = true
    try {
      syncDoorMonitor()
      // A monitor that was already running for the Live screen has to hear that its scope
      // changed: every door now (and a read at once), or back to the linked ones. One that has
      // just started reads the flag itself.
      if (changed && wasRunning) doorMonitor?.screenChanged()
    } finally {
      doorsScreenAnswering = false
    }
    // The answer is the reset or the first state, so it is also what the next push is compared
    // with: nothing is pushed for a state the renderer has just been handed.
    const answer = doorsScreenState()
    doorsScreenSent = JSON.stringify(answer)
    return ipcOk(answer)
  }

  function accessInputsChanged(
    reason: string,
    changed: { readonly trustChanged?: boolean } = {},
  ): void {
    const wasRunning = doorMonitor?.running === true
    syncDoorMonitor()
    // A fresh start reads at once by itself; only a monitor that kept running needs telling. In
    // RTSP mode the sync above has stopped it, and nothing may ask it for a read (MODE-4).
    if (!wasRunning || rtspMode()) return
    // P5.6: before the read, so no door action can be checked against a list read with the old
    // token or certificate in the meantime.
    if (changed.trustChanged === true) doorMonitor?.forgetScreen(reason)
    doorMonitor?.poke(reason)
  }

  function accessPollingChanged(): void {
    // MODE-4: the monitor is stopped in RTSP mode; nothing to re-arm.
    if (rtspMode()) return
    doorMonitor?.rearm()
  }

  // --- the operations ---------------------------------------------------------------------------

  async function connect(): Promise<void> {
    // MODE-4 first: in RTSP mode nothing is sent, whatever the console block says.
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    // Both throws are the refusal: CON-1's unusable address and CON-4's missing key. The handler
    // turns them into `not-configured` and `auth`, which is what Settings needs to say.
    const endpoint = protectEndpoint(services.current.console)
    if ((services.credentials.protectApiKey ?? '') === '') {
      throw new ProtectApiError(
        'No Protect Integration API key is set yet. Add one in Settings (UniFi OS → Control ' +
          'Plane → Integrations).',
        { kind: 'auth', endpoint: endpoint.hostPort },
      )
    }

    // Read once and still true after the await below, because every caller of this function comes
    // through `serialize` — two overlapping connects would otherwise each open a socket.
    const alreadyUp = subscription !== null
    if (!alreadyUp) {
      state.protect.phase = 'connecting'
      state.protect.error = null
      state.protect.updatedAt = now()
      emitStatus()
    }
    try {
      // Before the socket on purpose: a wrong key or an unpinned console fails here, with its real
      // kind, instead of disappearing into the feed's retry loop (CON-4).
      await refreshInventory(alreadyUp ? 'a repeated connect' : 'a connect')
    } catch (err) {
      // MODE-4: the mode switched to RTSP while the camera list was read. Not a failure of the
      // console, so nothing is recorded, and above all no feed is (re)opened: `modeChanged` owns
      // the teardown and the status.
      if (err instanceof AppModeError) throw err
      if (alreadyUp) {
        // The devices socket is up, so the console is reachable and pinned: one failed GET is no
        // reason to leave a stopped events feed down (the feed's own re-read fails the same way and
        // keeps the socket too, see `refreshFromFeed`). The error is still reported and thrown.
        if (eventsFeed === null) startEventsFeed(endpoint)
      } else {
        state.protect.phase = 'error'
      }
      recordError('protect', err, endpoint.hostPort)
      emitStatus()
      throw err
    }
    if (!alreadyUp) startFeed(endpoint)
    // Independent of `alreadyUp`: the events feed may have stopped on its own while the devices feed
    // stayed up, and a repeated connect is the user's way of asking for everything again.
    if (eventsFeed === null) startEventsFeed(endpoint)
    emitStatus()
  }

  /**
   * CON-1/2: the stored Protect key is gone, so the socket that authenticates with it goes too.
   *
   * A feed left running on a deleted credential is the worst of both answers: the badge reads
   * `connected` (or, once the derivation sees the missing key, `unconfigured` *over a live socket*)
   * and it all looks fine right up to the next launch, when nothing reconnects. The phase is put
   * back to `idle` so the derivation decides what the user actually sees — `unconfigured`, since the
   * credential has been removed — and the inventory is dropped, because it was read with that key
   * and the user has to connect again to get another one.
   */
  async function credentialCleared(): Promise<void> {
    await stopFeed()
    // Nothing for a launch to connect with any more (CON-4). A key entered later has to be shown to
    // work by a connect before the next launch connects by itself again.
    persistConnectOnLaunch(false)
    state.protect = { phase: 'idle', error: null, version: null, updatedAt: now() }
    inventory = []
    emitCameras()
    emitStatus()
  }

  /**
   * CON-4, Protect half. A **successful** probe records the version and clears the error but leaves
   * the phase alone: the phase belongs to the devices feed (CAM-2), and `GET /v1/meta/info`
   * answering says nothing about whether that socket is open. A **failed** one is exactly the
   * contract's `error` ("the last attempt failed"), so it sets the phase — unless the feed is up,
   * in which case the live connection is the better description of the endpoint than one bad probe.
   */
  async function probeProtect(): Promise<ProtectProbe> {
    const hostPort = endpointOf('protect')?.hostPort ?? null
    // Captured before the await and compared by identity after it, like `readDoors`: a mode switch
    // (`modeChanged`, MODE-4), a cleared key or a console change swaps the slot meanwhile, and this
    // probe's answer belongs to what was just left — it must not land on the fresh slot.
    const slot = state.protect
    try {
      const info = await services.protect().metaInfo()
      if (state.protect !== slot) {
        log('protect: probe finished after the endpoint state was reset; status left alone')
        return { state: 'ok', applicationVersion: info.applicationVersion }
      }
      slot.version = info.applicationVersion
      slot.error = null
      slot.updatedAt = now()
      return { state: 'ok', applicationVersion: info.applicationVersion }
    } catch (err) {
      if (state.protect !== slot) {
        log('protect: probe failed after the endpoint state was reset; status left alone')
        return { state: 'error', error: toIpcError(err, { endpoint: hostPort }) }
      }
      const error = recordError('protect', err, hostPort)
      if (subscription === null) state.protect.phase = 'error'
      return { state: 'error', error }
    }
  }

  /**
   * CON-4, Access half. DOOR-0 first: while Access is off **no call is made at all**, so this
   * answers `disabled` rather than asking the client to refuse. Access has no live feed, so here a
   * successful probe is the whole evidence the endpoint works and the phase follows it.
   */
  async function probeAccess(): Promise<AccessProbe> {
    const slot = state.access
    if (!services.current.console.accessEnabled) {
      slot.error = null
      slot.updatedAt = now()
      return { state: 'disabled' }
    }
    const read = await readDoors()
    return read.ok
      ? { state: 'ok', doorCount: read.value.length }
      : { state: 'error', error: read.error }
  }

  /**
   * One `GET /doors`, with the Access status following it: `connected` on an answer, `error` with
   * the mapped failure otherwise. Test connection's Access probe (CON-4) is its one caller since
   * P5.6 (the one-shot `vp:doors/list` it was shared with is gone: the Doors screen's list comes
   * from the door-state monitor). The caller has already checked DOOR-0. `services.access()` throws `ConsoleEndpointError` for an address that
   * does not resolve, which is mapped like any other failure (`not-configured`).
   *
   * **A read whose endpoint was replaced meanwhile leaves the status alone.** `applyConsoleChange`
   * swaps `state.access` for a fresh slot when the console block is saved, so a read still in flight
   * belongs to the endpoint that was just left; writing its answer (or its error) would put the old
   * console's result on the new one's indicator. The slot captured here is compared by identity
   * after the await, and the caller still gets its answer — only the status update is dropped.
   */
  async function readDoors(): Promise<IpcResult<Door[]>> {
    // MODE-4, last line of defence: its one caller checks the mode first.
    if (rtspMode()) {
      return ipcFail('bad-request', RTSP_MODE_MESSAGES.doors)
    }
    const slot = state.access
    const hostPort = endpointOf('access')?.hostPort ?? null
    let result: IpcResult<Door[]>
    try {
      result = ipcOk(await services.access().doors())
    } catch (err) {
      result = { ok: false, error: toIpcError(err, { endpoint: hostPort }) }
    }
    if (state.access !== slot) {
      log('access: door read finished after the endpoint changed; status left alone')
      return result
    }
    slot.updatedAt = now()
    if (result.ok) {
      slot.phase = 'connected'
      slot.error = null
      // DOOR-6: the endpoint has just answered, so a door-state monitor that is wanted but stopped
      // itself (a token the console rejected a moment ago) starts again. A no-op otherwise.
      syncDoorMonitor()
    } else {
      slot.phase = 'error'
      slot.error = result.error
      log(`access: ${result.error.kind}: ${result.error.message}`)
    }
    return result
  }

  /**
   * DOOR-3/4/5 (P5.4). **Releases a physical door**, so the rules are strict, in this order:
   *
   *  1. **DOOR-0 first → `disabled`.** While Access is off the answer is always `disabled`, linked
   *     or not, with no Access call at all (not even the client is resolved).
   *  2. **The door comes from the saved links**, looked up from the camera ref here (an own,
   *     non-empty string entry only: a ref such as `constructor` finds no prototype member). The
   *     renderer never names a door, so a renderer bug can only ever unlock a door the user linked.
   *     No link → `not-found`, again with no Access call. Both refusals are still logged: each was
   *     a press on an unlock control.
   *  3. **Exactly one `PUT`.** No retry and no timer anywhere on this path (DOOR-3/4): a second PUT
   *     is a second door release, so only the user pressing again repeats one. That is why every
   *     failure answers `retryable: false` whatever its kind — the client's `retryable` is about
   *     the read calls (src/main/access/client.ts).
   *  4. **Outcome unknown is not a failure** (user decision 2026-11-18). When the PUT may have
   *     reached the console but no answer came back (`unlockOutcomeUnknown`), the door may have
   *     opened: the answer is `ok` with `outcome: 'unknown'` and the error's safe message as
   *     `reason`, so the renderer warns rather than inviting a second press.
   *  5. **Logged once the outcome is known** (DOOR-5), after the PUT resolved or rejected — but the
   *     answer never waits for the write: a stalled disk must not leave the button spinning after
   *     the door opened. `append` never rejects (src/main/access/unlockLog.ts) and queues in call
   *     order, so the lines stay in the order the attempts ended.
   *
   * The Access status follows the answer the way Test connection's probe does — `connected` on success, `error`
   * on an endpoint failure (auth, pin, network, timeout, …, an unknown outcome included) — except
   * that a refusal of this one door (`DOOR_LEVEL_UNLOCK_KINDS`) proves the endpoint works, so it
   * reads `connected`. Not serialized: an unlock moves no subscription, and two presses on two
   * doors are two independent requests.
   */
  async function unlockDoor(cameraRef: string): Promise<IpcResult<UnlockResult>> {
    const { cameraId } = parseCameraRef(cameraRef)
    // The camera's name for the toast and the log, from the inventory main already holds — no
    // extra call (user decision 2026-11-18: no Access read for the door name either).
    const shown = inventory.find((entry) => entry.id === cameraId)?.name?.trim() ?? ''
    const cameraName = shown === '' ? cameraId : shown
    const links = services.current.doorLinks
    const linkedId = Object.hasOwn(links, cameraId) ? links[cameraId] : undefined
    const doorId = typeof linkedId === 'string' && linkedId !== '' ? linkedId : null
    const hostPort = (): string | null => endpointOf('access')?.hostPort ?? null

    /** Logs the attempt (rule 5) and hands the answer back. `linked`: the door it was about. */
    const finish = (
      result: IpcResult<UnlockResult>,
      linked: string | null,
      logged: DoorPutLogged,
    ): IpcResult<UnlockResult> => {
      const attempt: UnlockAttempt = {
        action: 'unlock',
        cameraRef,
        cameraName,
        doorId: linked,
        ...logged,
      }
      // Ids and the kind only in the console log: the message can name the address.
      log(
        `unlock: ${attempt.result} (door ${linked ?? 'none'}${
          attempt.errorKind === null ? '' : `, ${attempt.errorKind}`
        })`,
      )
      // Rule 5: not awaited. `append` never rejects, and its queue keeps the lines in call order.
      if (unlockLog !== null) void unlockLog.append(attempt)
      return result
    }
    /** A refusal before anything was sent (rules 1 and 2): logged like any other attempt. */
    const refuse = (
      kind: IpcError['kind'],
      message: string,
      endpoint: string | null,
      linked: string | null,
    ): IpcResult<UnlockResult> =>
      finish(ipcFail(kind, message, { endpoint }), linked, {
        result: 'failure',
        errorKind: kind,
        message,
      })

    // MODE-4, before DOOR-0: in RTSP mode no Access call is made at all. Refused and logged the way
    // DOOR-0's refusal is, since it was still a press on an unlock control.
    if (rtspMode()) return refuse('bad-request', RTSP_MODE_MESSAGES.door, null, doorId)
    // Rule 1, DOOR-0: not a request that fails, one that never happens.
    if (!services.current.console.accessEnabled) {
      return refuse(
        'disabled',
        'UniFi Access is turned off, so the door was not unlocked. Turn on "Enable UniFi ' +
          'Access" in Settings first (DOOR-0).',
        hostPort(),
        doorId,
      )
    }
    if (doorId === null) {
      return refuse(
        'not-found',
        `${cameraName} is not linked to a door, so nothing was unlocked. Link it to a door on ` +
          'the Doors screen.',
        null,
        null,
      )
    }

    // The one PUT (rule 3), and the status that follows its answer: `sendDoorPut`, shared with the
    // Doors screen's actions so the three cannot drift apart.
    const outcome = await sendDoorPut('unlock', async () => {
      await services.access().unlock(doorId)
    })
    // Rule 4 is in `doorPutAnswer`: an unknown outcome is `ok`, with the error's message as reason.
    const { result, logged } = doorPutAnswer<UnlockResult>(outcome, (unknownReason) =>
      unknownReason === null
        ? { doorId, cameraName, outcome: 'unlocked', reason: null }
        : { doorId, cameraName, outcome: 'unknown', reason: unknownReason },
    )
    // DOOR-6: the door may be open now, so the monitor reads at once and the button shows it within
    // about a second (`afterDoorPut`). A read only — the unlock path is still the one PUT above,
    // never repeated — and a no-op while nobody is watching. An unlock the console answered with a
    // failure moved no door, so it asks for nothing; and the cell's unlock is not a Doors screen
    // action, so no details round either.
    afterDoorPut(outcome, 'an unlock was answered', { readAfterFailure: false, details: null })
    return finish(result, doorId, logged)
  }

  // --- the Doors screen's actions (DOOR-3/4/5, P5.6) --------------------------------------------

  /** What one door-changing PUT came to, for the answer, the log line and what follows. */
  interface DoorPutOutcome {
    /** `null`: the console accepted it. Otherwise the failure, already `retryable: false`. */
    readonly error: IpcError | null
    /** With an `error`: the PUT may have reached the console (`unlockOutcomeUnknown`). */
    readonly unknown: boolean
    /** The endpoint the PUT went to is still the configured one. */
    readonly current: boolean
  }

  /**
   * Sends **the one PUT** of a door-changing action — the cell's unlock (`unlockDoor`) and both
   * Doors screen actions — and moves the Access status by its answer (see `unlockDoor` for the
   * reasoning behind each rule):
   *
   *  - `put` is called **once**. There is no retry and no timer on this path (DOOR-3/4): a second
   *    PUT is a second change to a physical door, so only the user confirming again repeats one,
   *    and every failure is `retryable: false` whatever the client says.
   *  - Status: `connected` on success and on a refusal that is about the door or the request
   *    (`DOOR_LEVEL_UNLOCK_KINDS`: the console answered), `error` otherwise — an unknown outcome
   *    included. An answer for an endpoint the user has replaced meanwhile leaves the new
   *    endpoint's status alone.
   *
   * `what` names the request in the one log line this writes when the endpoint changed.
   */
  async function sendDoorPut(what: string, put: () => Promise<void>): Promise<DoorPutOutcome> {
    const slot = state.access
    const where = endpointOf('access')?.hostPort ?? null
    let error: IpcError | null = null
    let unknown = false
    let doorLevel = false
    try {
      // `services.access()` throws `ConsoleEndpointError` for an address that does not resolve,
      // which lands in the catch like any other failure (`not-configured`).
      await put()
    } catch (err) {
      doorLevel =
        err instanceof AccessApiError &&
        DOOR_LEVEL_UNLOCK_KINDS.has(err.kind) &&
        !isAccessApiUnavailable(err)
      error = { ...toIpcError(err, { endpoint: where }), retryable: false }
      unknown = unlockOutcomeUnknown(err)
    }
    const current = state.access === slot
    if (current) {
      slot.updatedAt = now()
      if (error === null || doorLevel) {
        slot.phase = 'connected'
        slot.error = null
      } else {
        slot.phase = 'error'
        slot.error = error
      }
      emitStatus()
    } else {
      log(`access: ${what} finished after the endpoint changed; status left alone`)
    }
    return { error, unknown, current }
  }

  /** How a door-changing PUT ended, as `unlock.log` records it (DOOR-5). */
  type DoorPutLogged = Pick<UnlockAttempt, 'result' | 'errorKind' | 'message'>

  /**
   * The answer to a door-changing PUT and what its log line says — the tail all three callers
   * share:
   *
   *  - accepted → `ok` with `value(null)`, logged `success`;
   *  - outcome unknown (`DoorPutOutcome.unknown`) → **`ok`** with `value(reason)`, the error's safe
   *    message: the door may have changed, and a failure would invite a second try (user decision
   *    2026-11-18). Logged `unknown` with the error's kind;
   *  - anything else → the failure itself (already `retryable: false`), logged `failure`.
   *
   * Pure: the caller writes the log line and tells the monitor, in its own order.
   */
  function doorPutAnswer<T>(
    outcome: DoorPutOutcome,
    value: (unknownReason: string | null) => T,
  ): { readonly result: IpcResult<T>; readonly logged: DoorPutLogged } {
    const { error } = outcome
    if (error === null) {
      return {
        result: ipcOk(value(null)),
        logged: { result: 'success', errorKind: null, message: null },
      }
    }
    if (outcome.unknown) {
      return {
        result: ipcOk(value(error.message)),
        logged: { result: 'unknown', errorKind: error.kind, message: error.message },
      }
    }
    return {
      result: { ok: false, error },
      logged: { result: 'failure', errorKind: error.kind, message: error.message },
    }
  }

  /**
   * After a door-changing PUT was answered: the doors and their rules are probably different now,
   * so the monitor reads them at once (reads only — the PUT above is never repeated). A PUT the
   * console accepted also proves the endpoint works, so a monitor that is wanted but stopped
   * itself is started again first (its start reads at once); any other answer only asks a running
   * monitor — an unknown outcome proves nothing — and a plain failure only when
   * `readAfterFailure` (the Doors screen's actions: the card may be showing a state the console
   * has just contradicted).
   *
   * `details`: what the Doors screen's details round re-reads (`DoorDetailsScope`) — the one
   * door's rule after a door action, everything after an emergency change — or `null` for none.
   */
  function afterDoorPut(
    outcome: DoorPutOutcome,
    reason: string,
    then: { readonly readAfterFailure: boolean; readonly details: DoorDetailsScope | null },
  ): void {
    const failed = outcome.error !== null && !outcome.unknown
    if (outcome.error === null && outcome.current) accessInputsChanged(reason)
    else if (!failed || then.readAfterFailure) doorMonitor?.poke(reason)
    if (then.details !== null) doorMonitor?.refreshDetails(reason, then.details)
  }

  /**
   * The line both Doors screen actions write: console log and unlock log.
   *
   * The console line carries the kind and an id **only for a door main has read itself** (one with
   * a `doorName`): a refused id is whatever the renderer sent, and unvetted text does not belong in
   * a plain-text log. The unlock log does record it — as a JSON string, so it cannot break a line.
   */
  function recordDoorAttempt(attempt: UnlockAttempt): void {
    const which =
      attempt.action === 'emergency'
        ? 'every door'
        : typeof attempt.doorName === 'string' && attempt.doorId !== null
          ? `door ${attempt.doorId}`
          : 'a door id main has not read'
    log(
      `door action: ${attempt.action} ${attempt.result} (${which}${
        attempt.errorKind === null ? '' : `, ${attempt.errorKind}`
      })`,
    )
    // Not awaited: `append` never rejects, and its queue keeps the lines in call order.
    if (unlockLog !== null) void unlockLog.append(attempt)
  }

  /**
   * DOOR-3/4/5 (P5.6). **Changes a physical door**, so the rules are strict, in this order (the
   * same structure as `unlockDoor`, with one difference that matters: here the renderer names the
   * door):
   *
   *  1. **DOOR-0 first → `disabled`.** While Access is off the answer is always `disabled`,
   *     whatever the door, with no Access call at all (not even the client is resolved).
   *  2. **The door id must be one main read itself.** The cell's unlock never takes a door id
   *     (DOOR-4): main resolves the door from the saved links, so a renderer bug can only reach a
   *     door the user linked. A door with no linked camera has no such anchor, so the anchor here
   *     is the door list main last read from the *current* console while the Doors screen is open
   *     (the monitor's `knownDoor`). An id that is not in it — never read, read from an endpoint
   *     or with a token since replaced, the screen not open, the reading stopped — is `not-found`
   *     with **no Access call**. The id is compared, never interpreted.
   *  3. **Not while the list is stale** (`unavailable`, no call; user decision 2026-11-18). Once
   *     two door reads in a row have failed the kept list is only names: the screen draws every
   *     state as unknown and disables its buttons, and main refuses as well — defence in depth,
   *     so a renderer bug cannot act on a door whose state nobody knows.
   *  4. **A door with no hub is refused** (`bad-request`, no call): the console cannot move it
   *     (`is_bind_hub`, reference §7.7), and saying so is better than relaying its refusal.
   *  5. **The mapping.** `unlock` → `PUT /doors/{id}/unlock`. `keep_unlock`, `keep_lock`,
   *     `custom` (with its minutes) and `reset` → `PUT /doors/{id}/lock_rule` with that type.
   *     `lock` → `lock_rule` with `lock_now`, **always** (user decision 2026-11-18): it ends an
   *     unlock schedule and any temporary unlock at once (reference §7.10), whatever the door's
   *     rule is. Nothing is chosen from the rule main last read — a rule that is out of date
   *     would make `reset` a silent no-op on a door that is on a schedule. `sent` in the answer
   *     says what went out.
   *  6. **Exactly one PUT** (`sendDoorPut`): never retried, no timer, every failure
   *     `retryable: false`; a PUT that may have reached the console with no answer is `ok` with
   *     `outcome: 'unknown'`.
   *  7. **Logged once the outcome is known** (DOOR-5), refusals 1–4 included — each was a person
   *     confirming a door action in this app — and the answer never waits for the write.
   *
   * Not serialized, like `unlockDoor`: it moves no subscription.
   */
  async function doorAction(input: DoorActionInput): Promise<IpcResult<DoorActionResult>> {
    const { doorId, action } = input
    const minutes = action === 'custom' ? (input.minutes ?? null) : null

    const refuse = (
      kind: IpcError['kind'],
      message: string,
      doorName: string | null,
    ): IpcResult<DoorActionResult> => {
      recordDoorAttempt({
        // Nothing was sent, so this is what was asked (`lock`, not the `lock_now` it becomes).
        action,
        cameraRef: null,
        cameraName: null,
        doorId,
        doorName,
        minutes,
        result: 'failure',
        errorKind: kind,
        message,
      })
      return ipcFail(kind, message, { endpoint: endpointOf('access')?.hostPort ?? null })
    }

    // MODE-4, before DOOR-0: no Access call in RTSP mode. Logged like DOOR-0's refusal.
    if (rtspMode()) return refuse('bad-request', RTSP_MODE_MESSAGES.door, null)
    // Rule 1, DOOR-0: not a request that fails, one that never happens.
    if (!services.current.console.accessEnabled) {
      return refuse(
        'disabled',
        'UniFi Access is turned off, so nothing was sent to the door. Turn on "Enable UniFi ' +
          'Access" in Settings first (DOOR-0).',
        null,
      )
    }
    // Rule 2: only a door main has itself read from the current console.
    const door = doorMonitor?.knownDoor(doorId) ?? null
    if (door === null) {
      return refuse(
        'not-found',
        'That door is not in the list OverWatch last read from the console, so nothing was ' +
          'sent. Open the Doors screen, wait for the door list and try again.',
        null,
      )
    }
    const doorName = doorDisplayName(door)
    // Rule 3: the list is stale, so this door's state is not known.
    if (doorMonitor?.stale === true) {
      return refuse(
        'unavailable',
        "The door's state is not known right now, so nothing was sent. Try again once the doors " +
          'can be read.',
        doorName,
      )
    }
    // Rule 4.
    if (!door.boundToHub) {
      return refuse(
        'bad-request',
        `${doorName} has no door hub, so it cannot be unlocked or locked from here. Nothing was ` +
          'sent.',
        doorName,
      )
    }

    // Rule 5: Lock is always `lock_now`, whatever rule the door is under.
    const sent: DoorActionSent = action === 'lock' ? 'lock_now' : action
    // Rule 6: the one PUT.
    const outcome = await sendDoorPut(`door action ${sent}`, async () => {
      const client = services.access()
      if (sent === 'unlock') await client.unlock(door.id)
      else if (sent === 'custom') {
        // A `custom` without minutes cannot pass `DoorActionInputSchema`; if one arrives anyway the
        // client refuses the body before sending anything (`AccessLockRuleRequestSchema`).
        await client.setLockRule(door.id, {
          type: sent,
          ...(minutes === null ? {} : { intervalMinutes: minutes }),
        })
      } else await client.setLockRule(door.id, { type: sent })
    })

    // The door may have changed on an unknown outcome: `ok`, not a failure (`doorPutAnswer`).
    const { result, logged } = doorPutAnswer<DoorActionResult>(outcome, (unknownReason) => ({
      doorId: door.id,
      doorName,
      action,
      sent,
      minutes,
      outcome: unknownReason === null ? 'done' : 'unknown',
      reason: unknownReason,
    }))
    recordDoorAttempt({
      action: sent,
      cameraRef: null,
      cameraName: null,
      doorId: door.id,
      doorName,
      minutes,
      ...logged,
    })
    // This door's rule is what the action changed; the emergency status rides along because it is
    // what overrides a rule, and one request. The other doors wait for their own reasons.
    afterDoorPut(outcome, 'a door action was answered', {
      readAfterFailure: true,
      details: { doorIds: [door.id], emergency: true },
    })
    return result
  }

  /**
   * DOOR-3/4/5 (P5.6). **Changes every door at once**: lockdown keeps them all locked, evacuation
   * keeps them all unlocked, both `false` restores normal operation. The same rules as
   * `doorAction` where they apply: DOOR-0 first (`disabled`, no call), then exactly one
   * `PUT /doors/settings/emergency` — never retried, no timer, every failure `retryable: false`,
   * an unanswered PUT is `ok` with `outcome: 'unknown'` — and a line in the unlock log either way.
   * There is no door id to check. Both flags `true` cannot pass `DoorEmergencyInputSchema`; the
   * check is repeated here because this function, not the schema, is what sends the PUT.
   */
  async function setDoorEmergency(
    input: DoorEmergencyInput,
  ): Promise<IpcResult<DoorEmergencyResult>> {
    const { lockdown, evacuation } = input
    const action: UnlockLogAction = 'emergency'
    const logged = { action, cameraRef: null, cameraName: null, doorId: null, lockdown, evacuation }
    const refuse = (kind: IpcError['kind'], message: string): IpcResult<DoorEmergencyResult> => {
      recordDoorAttempt({ ...logged, result: 'failure', errorKind: kind, message })
      return ipcFail(kind, message, { endpoint: endpointOf('access')?.hostPort ?? null })
    }
    // MODE-4, before DOOR-0: no Access call in RTSP mode. Logged like DOOR-0's refusal.
    if (rtspMode()) return refuse('bad-request', RTSP_MODE_MESSAGES.door)
    // DOOR-0: not a request that fails, one that never happens.
    if (!services.current.console.accessEnabled) {
      return refuse(
        'disabled',
        'UniFi Access is turned off, so the emergency status was not changed. Turn on "Enable ' +
          'UniFi Access" in Settings first (DOOR-0).',
      )
    }
    if (lockdown && evacuation) {
      return refuse('bad-request', 'Lockdown and evacuation cannot both be on. Nothing was sent.')
    }

    // The one PUT.
    const outcome = await sendDoorPut('emergency status', () =>
      services.access().setEmergencyStatus({ lockdown, evacuation }),
    )
    const { result, logged: ended } = doorPutAnswer<DoorEmergencyResult>(
      outcome,
      (unknownReason) => ({
        lockdown,
        evacuation,
        outcome: unknownReason === null ? 'done' : 'unknown',
        reason: unknownReason,
      }),
    )
    recordDoorAttempt({ ...logged, ...ended })
    // Every door's rule and relay may have moved with it: a full details round.
    afterDoorPut(outcome, 'the emergency status was changed', {
      readAfterFailure: true,
      details: 'all',
    })
    return result
  }

  async function testConnection(): Promise<TestConnection> {
    // MODE-4: neither half is probed in RTSP mode.
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    // Sequentially, not in parallel: both halves may share the console's rate-limit budget when
    // Access answers behind the proxy on 443 (SPEC §5.2), and nothing here is time-critical.
    const protect = await probeProtect()
    // MODE-4: re-checked after the await. A switch to RTSP mode while the Protect probe was in
    // flight means no Access call now (and `probeProtect` has already left the fresh slot alone).
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    const access = await probeAccess()
    emitStatus()
    return { protect, access, connection: status() }
  }

  async function snapshot(input: SnapshotInput): Promise<SnapshotResult> {
    // MODE-4: a Protect snapshot is a Protect call. Thrown, not CAM-3's `unavailable`: the camera is
    // not offline, the app is in a mode that does not ask.
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    const camera = inventory.find((entry) => entry.id === input.cameraId)
    // SPEC §5.1: `highQuality=true` on a camera without the flag is a 400 and **no** smaller image
    // comes back, so the parameter is dropped rather than passed on and turned into a failure.
    const highQuality = input.highQuality && camera?.supportsFullHdSnapshot === true
    if (input.highQuality && !highQuality) {
      log('snapshot: dropped highQuality for a camera without supportsFullHdSnapshot (SPEC §5.1)')
    }
    // CAM-4: `channel=package` only exists on a camera with `hasPackageCamera`. For any other (or
    // one the inventory does not know) there is no package image to give, so the answer is CAM-3's
    // "unavailable" — not a 400, and not the main channel's image, which would show the wrong
    // camera's view under a package label.
    const packageChannel = input.channel === 'package'
    if (packageChannel && camera?.hasPackageCamera !== true) {
      log('snapshot: refused channel=package for a camera without hasPackageCamera (CAM-4)')
      return { state: 'unavailable', reason: 'This camera has no package camera.' }
    }
    const options: SnapshotOptions = {
      ...(highQuality ? { highQuality: true } : {}),
      ...(packageChannel ? { channel: 'package' } : {}),
    }
    try {
      const shot = await services.protect().snapshot(input.cameraId, options)
      return {
        state: 'ok',
        mimeType: shot.contentType,
        bytes: shot.bytes,
        capturedAt: now(),
      }
    } catch (err) {
      const error = toIpcError(err, { endpoint: endpointOf('protect')?.hostPort ?? null })
      if (SNAPSHOT_REPORTED_KINDS.includes(error.kind)) throw err
      log(`snapshot: unavailable (${error.kind})`)
      return { state: 'unavailable', reason: error.message }
    }
  }

  async function streamQualities(cameraId: string): Promise<RtspsAvailability> {
    if (rtspMode()) throw new AppModeError(RTSP_MODE_MESSAGES.protect)
    // Through the same client, and so the same shared limiter, as `snapshot` (R9): the camera list
    // asks for this alongside each thumbnail, a few cameras at a time.
    return rtspsAvailability(await services.protect().rtspsStreams(cameraId))
  }

  /**
   * CON-1/3, DOOR-0. **Security-critical.** A pin is accepted for one `host:port` (P0.4 §4), so
   * when the resolved endpoint moves, the fingerprint stored for it must go with it: keeping it
   * would silently apply a certificate the user accepted for one console to a different machine,
   * which is precisely the interception CON-3 exists to catch. The two endpoints are judged
   * separately because they move independently — `accessBaseUrl` can change while `host` does not,
   * and `host` carries Protect's port while Access has its own.
   *
   * A moved Protect endpoint also clears `console.connectOnLaunch` (CON-4): "it worked" was said of
   * the console just left, and the new one has to prove itself with a connect first. An Access-only
   * change keeps it — the launch connect is Protect's alone.
   */
  async function replaceConsole(next: ConsoleConfig): Promise<void> {
    const before = { protect: endpointOf('protect'), access: endpointOf('access') }

    // The feed is bound to the old address and the old pinned Agent, so it goes first.
    await stopFeed()
    for (const endpoint of [before.protect, before.access]) {
      if (endpoint !== null) services.pins.invalidate(endpoint.host, endpoint.port)
    }

    const resolve = (config: ConsoleConfig, which: EndpointName): string | null => {
      try {
        return (which === 'protect' ? protectEndpoint(config) : accessEndpoint(config)).hostPort
      } catch (err) {
        if (err instanceof ConsoleEndpointError) return null
        throw err
      }
    }
    // An endpoint that no longer resolves counts as moved: there is nothing left for its pin to
    // belong to, and leaving it would make the next address the user types inherit it.
    const keepProtectPin = before.protect?.hostPort === resolve(next, 'protect')
    const keepAccessPin = before.access?.hostPort === resolve(next, 'access')
    if (!keepProtectPin && next.certFingerprint !== null) {
      log('console changed: cleared the Protect certificate pin (CON-3, the endpoint moved)')
    }
    if (!keepAccessPin && next.accessCertFingerprint !== null) {
      log('console changed: cleared the Access certificate pin (CON-3, the endpoint moved)')
    }

    // This change owns the three Settings fields, plus clearing a pin whose endpoint moved — and,
    // with the Protect pin, the launch flag (CON-4, see above), in the same write. A kept
    // pin is left to the pin store, which writes its own field: copying `next`'s value here could
    // undo a pin accepted while this call was waiting. Applied with `config.update`, so a View or
    // pin write queued ahead of this one is not overwritten with a stale copy (VIEW-6, CON-3).
    const own = (base: ConsoleConfig): ConsoleConfig => ({
      ...base,
      host: next.host,
      accessEnabled: next.accessEnabled,
      accessBaseUrl: next.accessBaseUrl,
      ...(keepProtectPin ? {} : { certFingerprint: null, connectOnLaunch: false }),
      ...(keepAccessPin ? {} : { accessCertFingerprint: null }),
    })
    await services.config.update((latest) => ({ ...latest, console: own(latest.console) }))
    // The same fields onto `current` as it is now, not the whole result: a View write that
    // finished during the await is in `current` already, and so is a pin accepted meanwhile (the
    // pin store sets it in memory before queuing its write). The clients and the pin store read
    // `current` per call, so this is all it takes for the new address to be the one in use.
    services.current = { ...services.current, console: own(services.current.console) }
    state.protect = { phase: 'idle', error: null, version: null, updatedAt: now() }
    state.access = { phase: 'idle', error: null, version: null, updatedAt: now() }
    if (!keepProtectPin) {
      // The cached cameras belong to the console that has just been left: their ids mean nothing on
      // the new one, and a `snapshot` taken from a stale list would send one of them to it. The
      // empty list goes out at once so the UI cannot show the previous console's cameras either.
      // Only the Protect endpoint matters here — the inventory comes from it alone, so an
      // Access-only change leaves every id valid.
      inventory = []
      emitCameras()
    }
    emitStatus()
  }

  /**
   * `replaceConsole` with the door-state monitor (DOOR-6) held still around it. The monitor reads
   * the old Access endpoint, so it is stopped before anything moves and held, so a `watchDoors`
   * arriving during the awaits cannot start it against the address being left; its late answers
   * are dropped by the monitor itself (a stop ends the run they belong to). Afterwards it starts
   * afresh on whatever the endpoint now is, if the renderer is still watching and Access is still
   * usable — also when the save failed, in which case that is the old endpoint again.
   */
  async function applyConsoleChange(next: ConsoleConfig): Promise<void> {
    doorMonitorHeld = true
    stopDoorMonitor()
    try {
      await replaceConsole(next)
    } finally {
      doorMonitorHeld = false
      syncDoorMonitor()
    }
  }

  async function connectOnLaunch(): Promise<void> {
    // MODE-4: no launch connect in RTSP mode. Read when the call runs (it is serialized), so a
    // switch back to Protect followed by this call follows CON-4's rule below as a launch would.
    if (rtspMode()) {
      log('connect on launch: skipped (RTSP streams mode)')
      return
    }
    // Every precondition is an offline read, so a launch that does not qualify spends no permit
    // (R9). The pin is checked here rather than left to the feed: an unpinned console would only
    // turn into a `pin-required` error the user did not ask for this time.
    if (!services.current.console.connectOnLaunch) return
    const endpoint = endpointOf('protect')
    if (endpoint === null || !credentialStored('protect') || !pinnedFor(endpoint)) {
      log('connect on launch: skipped (the console, the key or the pin is missing)')
      return
    }
    log('connect on launch: connecting (a previous session connected)')
    try {
      await connect()
    } catch (err) {
      // `connect()` has already recorded the failure in the status and emitted it, which is how the
      // user learns of it. Only the kind goes in the log: the message can name the address.
      log(`connect on launch: failed (${toIpcError(err, { endpoint: null }).kind})`)
    }
  }

  function recover(reason: RecoverReason): void {
    const why = reason === 'resume' ? 'the machine woke from sleep' : 'the network changed'
    // MODE-4: `modeChanged` closed the feeds and stopped the monitor; nothing may be woken up.
    if (rtspMode()) {
      log(`recover (${why}): nothing to do in RTSP streams mode`)
      return
    }
    // Not through `serialize`: nothing here replaces a feed or the endpoint, and a recover queued
    // behind a connect's backoff would arrive after it was needed. The handles are read now; a feed
    // being replaced by a queued call is either already gone (null) or about to be stopped anyway.
    const feeds = [subscription, eventsFeed].filter(
      (feed): feed is ProtectSubscription => feed !== null,
    )
    const monitor = doorMonitor?.running === true ? doorMonitor : null
    log(
      `recover (${why}): ${String(feeds.length)} Protect feed(s), door monitor ` +
        (monitor === null ? 'not running' : 'running'),
    )
    for (const feed of feeds) {
      try {
        feed.reconnectNow()
      } catch (err) {
        log(`recover: a feed failed to reconnect: ${err instanceof Error ? err.name : 'unknown'}`)
      }
    }
    monitor?.recoverNow(why)
  }

  /**
   * MODE-4, see {@link ConnectionManager.modeChanged}. The queued half: the monitor and the feeds
   * were already stopped when the call was made (`stopProtectSideNow`) and are stopped again here,
   * a no-op unless something started them in between; fresh status slots make any request
   * still in flight (a door PUT, a door read) leave the status alone when it lands — the same
   * identity check `applyConsoleChange` relies on. Nothing is written to config: CON-4's launch
   * flag is kept, so switching back reconnects exactly when a launch would.
   */
  async function modeChanged(stopping: Promise<void>): Promise<void> {
    // The early stop's own promise first, so nothing below overlaps a socket still closing.
    await stopping
    if (!rtspMode()) {
      // RTSP-3/MODE-4: the renderer still holds the RTSP inventory from the last push. The Protect
      // one (empty until the next connect, since entering RTSP dropped it) replaces it now.
      log('mode: UniFi Protect; the RTSP inventory replaced by the Protect one')
      emitCameras()
      return
    }
    stopDoorMonitor()
    await stopFeedQuietly()
    state.protect = { phase: 'idle', error: null, version: null, updatedAt: now() }
    state.access = { phase: 'idle', error: null, version: null, updatedAt: now() }
    inventory = []
    log('mode: RTSP streams; Protect feeds and the door monitor stopped, inventory dropped')
    // RTSP-3: the pushed inventory is the configured streams.
    emitCameras()
    emitStatus()
    pushDoorsScreen()
  }

  /** `stopFeed`, logging rather than rejecting. The handles are dropped either way (`stopFeed`). */
  async function stopFeedQuietly(): Promise<void> {
    try {
      await stopFeed()
    } catch (err) {
      // Nothing will reopen the dropped handles; a socket that would not close cleanly is only
      // worth a line.
      log(
        `mode: a Protect feed failed to stop: ${err instanceof Error ? err.name : 'unknown error'}`,
      )
    }
  }

  /**
   * MODE-4: the part of the switch to RTSP mode that cannot wait in the queue. `modeChanged` is
   * serialized behind any connect in progress (which may sit in a backoff), and until it runs a
   * running door-state monitor would keep polling Access and a feed's own reconnect loop would keep
   * opening Protect sockets — the subscriptions have no mode hook, so stopping them is the gate.
   * Done synchronously when the call is made: the monitor and its retry timer stop, both feed
   * handles are dropped (a connect still in flight then finds RTSP mode at its next check, which
   * throws `AppModeError` rather than opening anything). Nothing in Protect mode.
   */
  function stopProtectSideNow(): Promise<void> {
    if (!rtspMode()) return Promise.resolve()
    stopDoorMonitor()
    return stopFeedQuietly()
  }

  async function shutdown(): Promise<void> {
    doorsWatched = false
    doorsScreenOpen = false
    stopDoorMonitor()
    await stopFeed()
    await services.pins.closeAll()
  }

  // The seven that move the subscriptions go through the queue; `testConnection`, `cameras`,
  // `snapshot`, `streamQualities`, `unlockDoor`, `doorAction` and `setDoorEmergency` are
  // plain requests that touch none of that state, so serializing them would only make the UI wait
  // for a reconnect's backoff. `watchDoors`, `watchDoorsScreen`, `accessPollingChanged` and
  // `accessInputsChanged` are synchronous and move only the door-state monitor, which
  // `applyConsoleChange` holds still while the address is being replaced.
  return {
    status,
    cachedCameras: currentCameras,
    connect: () => serialize(connect),
    connectOnLaunch: () => serialize(connectOnLaunch),
    testConnection,
    // MODE-4/RTSP-3: in RTSP mode the configured streams, with no request.
    cameras: () =>
      rtspMode() ? Promise.resolve(currentCameras()) : refreshInventory('a camera list request'),
    snapshot,
    streamQualities,
    unlockDoor,
    watchDoors,
    watchDoorsScreen,
    doorAction,
    setDoorEmergency,
    accessInputsChanged,
    accessPollingChanged,
    recover,
    credentialCleared: () => serialize(credentialCleared),
    credentialReplaced: () =>
      serialize(() => {
        persistConnectOnLaunch(false)
        return Promise.resolve()
      }),
    applyConsoleChange: (next) => serialize(() => applyConsoleChange(next)),
    modeChanged: () => {
      // Before `serialize`, on purpose (see `stopProtectSideNow`).
      const stopping = stopProtectSideNow()
      return serialize(() => modeChanged(stopping))
    },
    rtspStreamsChanged: () => {
      if (rtspMode()) emitCameras()
    },
    shutdown: () => serialize(shutdown),
  }
}
