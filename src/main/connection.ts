// The connection manager (P1.5): the single piece of state behind CON-5's indicator and CAM-1's
// camera list. It owns four things and nothing else — the per-endpoint `ConnectionStatus`, the
// camera inventory, the devices subscription that keeps the inventory current (CAM-2), and the
// events subscription that feeds the cell scheduler (CELL-2, P4.2) — and it pushes every change to
// the renderer through `IPC_EVENTS`.
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
//     itself until the user disconnects, clears the Protect key or moves the Protect endpoint — each
//     of which writes it back to `false`. An outage, a reconnect or a failed connect leaves it alone:
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
// **No Electron import, by construction.** The services, the event sink, the two subscription
// factories and the clock are all injected (`src/main/index.ts` wires the real ones), so the unit
// tests drive every phase, the feed and the pin-clearing in plain Node with no window and no socket.
import {
  IPC_EVENTS,
  type AccessProbe,
  type ConnectionPhase,
  type ConnectionStatus,
  type EndpointName,
  type EndpointStatus,
  type IpcError,
  type ProtectProbe,
  type RtspsAvailability,
  type SnapshotInput,
  type SnapshotResult,
  type TestConnection,
} from '@shared/ipc'
import type { Camera, ConsoleConfig } from '@shared/models'
import { STREAM_QUALITIES } from '@shared/quality'
import type { AccessClient } from './access/client'
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
  access(): Pick<AccessClient, 'doors'>
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
}

export interface ConnectionManager {
  /** CON-5, recomputed on every call: the derived parts can change without anything happening. */
  status(): ConnectionStatus
  /** The inventory as main last read it (CAM-1). Empty before the first successful read. */
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
   * Closes both feeds and goes back to `idle`. The cached inventory is kept. A user's disconnect
   * also clears `console.connectOnLaunch` (CON-4): they said stop, so the next launch does not
   * reconnect behind their back.
   */
  disconnect(): Promise<void>
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
   * App shutdown: close the feed and every pinned Agent. Leaves `console.connectOnLaunch` as it is —
   * quitting is not disconnecting, and the next launch is exactly when it is meant to apply.
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

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const { services, emit } = options
  const createDevices = options.createDevices ?? createDevicesSubscription
  const createEvents = options.createEvents ?? createEventsSubscription
  const now = options.now ?? Date.now
  const log = options.log ?? ((): void => undefined)

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
   * **One at a time.** `connect`, `disconnect`, `applyConsoleChange` and `shutdown` all move the
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

  /** A copy: the cached array is replaced on every change, but a listener must not alias it. */
  function emitCameras(): void {
    emit(IPC_EVENTS.cameras.channel, [...inventory])
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
   * the write rather than after so two calls in a row (an `open`, then a disconnect) compare against
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
          // and a disconnect whose `false` never landed would reconnect at the next launch.
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
    const cameras = await services.protect().cameras()
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
    void refreshInventory(reason).catch((err: unknown) => {
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
        // A subscription stops for good either because we asked (disconnect, shutdown) or because
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

  // --- the operations ---------------------------------------------------------------------------

  async function connect(): Promise<void> {
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

  async function disconnect(): Promise<void> {
    await stopFeed()
    // The user said stop (CON-4): the next launch respects that rather than reconnecting.
    persistConnectOnLaunch(false)
    const slot = state.protect
    slot.phase = 'idle'
    // An idle endpoint has no last failure to show; the contract keeps `error` for `error` and for
    // a reconnect in progress.
    slot.error = null
    slot.updatedAt = now()
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
    try {
      const info = await services.protect().metaInfo()
      const slot = state.protect
      slot.version = info.applicationVersion
      slot.error = null
      slot.updatedAt = now()
      return { state: 'ok', applicationVersion: info.applicationVersion }
    } catch (err) {
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
    const hostPort = endpointOf('access')?.hostPort ?? null
    try {
      const doors = await services.access().doors()
      slot.phase = 'connected'
      slot.error = null
      slot.updatedAt = now()
      return { state: 'ok', doorCount: doors.length }
    } catch (err) {
      const error = recordError('access', err, hostPort)
      slot.phase = 'error'
      return { state: 'error', error }
    }
  }

  async function testConnection(): Promise<TestConnection> {
    // Sequentially, not in parallel: both halves may share the console's rate-limit budget when
    // Access answers behind the proxy on 443 (SPEC §5.2), and nothing here is time-critical.
    const protect = await probeProtect()
    const access = await probeAccess()
    emitStatus()
    return { protect, access, connection: status() }
  }

  async function snapshot(input: SnapshotInput): Promise<SnapshotResult> {
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
  async function applyConsoleChange(next: ConsoleConfig): Promise<void> {
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

  async function connectOnLaunch(): Promise<void> {
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

  async function shutdown(): Promise<void> {
    await stopFeed()
    await services.pins.closeAll()
  }

  // The six that move the subscriptions go through the queue; `testConnection`, `cameras`,
  // `snapshot` and `streamQualities` are plain requests that touch none of that state, so serializing them would only
  // make the UI wait for a reconnect's backoff.
  return {
    status,
    cachedCameras: () => [...inventory],
    connect: () => serialize(connect),
    disconnect: () => serialize(disconnect),
    connectOnLaunch: () => serialize(connectOnLaunch),
    testConnection,
    cameras: () => refreshInventory('a camera list request'),
    snapshot,
    streamQualities,
    credentialCleared: () => serialize(credentialCleared),
    credentialReplaced: () =>
      serialize(() => {
        persistConnectOnLaunch(false)
        return Promise.resolve()
      }),
    applyConsoleChange: (next) => serialize(() => applyConsoleChange(next)),
    shutdown: () => serialize(shutdown),
  }
}
