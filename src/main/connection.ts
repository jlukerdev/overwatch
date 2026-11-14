// The connection manager (P1.5): the single piece of state behind CON-5's indicator and CAM-1's
// camera list. It owns three things and nothing else — the per-endpoint `ConnectionStatus`, the
// camera inventory, and the devices subscription that keeps the inventory current (CAM-2) — and it
// pushes every change to the renderer through the two `IPC_EVENTS` the contract defines.
//
// Why it is a module of its own rather than a few variables in the IPC handlers:
//
//  1. **Nothing connects on its own** (CON-4, R9). `connect()` and `testConnection()` are the only
//     things that send a request, and both exist because the user asked. The status is derived from
//     config and pins, which are offline reads, so the indicator is correct at launch without a
//     single permit spent.
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
// **No Electron import, by construction.** The services, the event sink, the devices-subscription
// factory and the clock are all injected (`src/main/index.ts` wires the real ones), so the unit
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
  type SnapshotInput,
  type SnapshotResult,
  type TestConnection,
} from '@shared/ipc'
import type { Camera, ConsoleConfig } from '@shared/models'
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
import type { ProtectClient } from './protect/client'
import { ProtectApiError } from './protect/errors'
import {
  createDevicesSubscription,
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
  readonly config: Pick<ConfigStore, 'save'>
  current: Config
  /** CON-2: read to answer "is a credential stored", never to send a value anywhere. */
  readonly credentials: Secrets
  readonly pins: Pick<PinRegistry, 'pinnedFingerprint' | 'agentFor' | 'invalidate' | 'closeAll'>
  /** Shared with the REST client: a WebSocket upgrade spends a request permit too (R9). */
  readonly limiter: RateLimiter
  protect(): Pick<ProtectClient, 'metaInfo' | 'cameras' | 'snapshot'>
  access(): Pick<AccessClient, 'doors'>
}

export interface ConnectionManagerOptions {
  readonly services: ConnectionServices
  /** `webContents.send` for the main window, or a recorder in the tests. */
  readonly emit: (channel: string, payload: unknown) => void
  /** Injected so the tests can drive a fake devices feed. */
  readonly createDevices?: typeof createDevicesSubscription
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
   * CAM-1/2: read the inventory and open the devices feed. Idempotent — a second call while the
   * feed is up re-reads the inventory instead of opening another socket, and two overlapping calls
   * are serialized rather than racing. Throws when the console is not configured or the first read
   * fails, so the caller can report *why* (CON-4).
   */
  connect(): Promise<void>
  /** Closes the feed and goes back to `idle`. The cached inventory is kept. */
  disconnect(): Promise<void>
  /** CON-4: both halves probed independently; one failing is a normal, informative answer. */
  testConnection(): Promise<TestConnection>
  /** CAM-1: re-read `GET /v1/cameras` and cache it. */
  cameras(): Promise<Camera[]>
  /** CAM-1/3: one thumbnail, with CAM-3's "any failure means offline" rule applied. */
  snapshot(input: SnapshotInput): Promise<SnapshotResult>
  /**
   * CON-1/2: the Protect API key has just been deleted. Closes the feed and empties the inventory,
   * because nothing may keep running on a credential the user has removed.
   */
  credentialCleared(): Promise<void>
  /** CON-1/3, DOOR-0: persist an edited console block, clearing a pin that no longer applies. */
  applyConsoleChange(next: ConsoleConfig): Promise<void>
  /** App shutdown: close the feed and every pinned Agent. */
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
  const now = options.now ?? Date.now
  const log = options.log ?? ((): void => undefined)

  let inventory: Camera[] = []
  let subscription: ProtectSubscription | null = null
  /** True while the feed is stopping because we asked it to, so its `stopped` reads as `idle`. */
  let stopRequested = false

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
        applyFeedState(next)
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

  async function stopFeed(): Promise<void> {
    stopRequested = true
    const feed = subscription
    subscription = null
    if (feed !== null) await feed.stop()
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
      if (!alreadyUp) state.protect.phase = 'error'
      recordError('protect', err, endpoint.hostPort)
      emitStatus()
      throw err
    }
    if (!alreadyUp) startFeed(endpoint)
    emitStatus()
  }

  async function disconnect(): Promise<void> {
    await stopFeed()
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
    try {
      const shot = await services
        .protect()
        .snapshot(input.cameraId, highQuality ? { highQuality: true } : {})
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

  /**
   * CON-1/3, DOOR-0. **Security-critical.** A pin is accepted for one `host:port` (P0.4 §4), so
   * when the resolved endpoint moves, the fingerprint stored for it must go with it: keeping it
   * would silently apply a certificate the user accepted for one console to a different machine,
   * which is precisely the interception CON-3 exists to catch. The two endpoints are judged
   * separately because they move independently — `accessBaseUrl` can change while `host` does not,
   * and `host` carries Protect's port while Access has its own.
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

    const saved = await services.config.save({
      ...services.current,
      console: {
        ...next,
        certFingerprint: keepProtectPin ? next.certFingerprint : null,
        accessCertFingerprint: keepAccessPin ? next.accessCertFingerprint : null,
      },
    })
    // The clients and the pin store read `current` per call, so this is all it takes for the new
    // address to be the one in use.
    services.current = saved
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

  async function shutdown(): Promise<void> {
    await stopFeed()
    await services.pins.closeAll()
  }

  // The five that move the subscription go through the queue; `testConnection`, `cameras` and
  // `snapshot` are plain requests that touch none of that state, so serializing them would only
  // make the UI wait for a reconnect's backoff.
  return {
    status,
    cachedCameras: () => [...inventory],
    connect: () => serialize(connect),
    disconnect: () => serialize(disconnect),
    testConnection,
    cameras: () => refreshInventory('a camera list request'),
    snapshot,
    credentialCleared: () => serialize(credentialCleared),
    applyConsoleChange: (next) => serialize(() => applyConsoleChange(next)),
    shutdown: () => serialize(shutdown),
  }
}
