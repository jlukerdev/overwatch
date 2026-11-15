// The renderer's single copy of `AppState` (P1.5): one Zustand store that owns everything main sends
// over the bridge, and the only place in the renderer that calls `window.viewProtect`.
//
// Why one store rather than a hook per screen: every mutating channel answers with the whole
// `AppState` (rule 3 in src/shared/ipc.ts), because saving a host, storing a key or accepting a
// certificate changes several things at once. Folding that one object back into one store is what
// keeps Settings and the camera list from drifting apart — neither of them patches its own copy.
//
// The actions hand back the `IpcResult` as well as folding it in, so a component can show the
// failure next to the control the user just used without reading an error out of global state.
import { create } from 'zustand'
import {
  type AcceptCertInput,
  type AppState,
  type Camera,
  type CameraStateChange,
  type ConnectionStatus,
  type ConsoleInput,
  type IpcError,
  type IpcResult,
  type PinCheck,
  type RtspsAvailability,
  type SecretInput,
  type SecretKeyInput,
  type SecretsStored,
  type SetStreamsInput,
  type SetViewsInput,
  type Settings,
  type SnapshotInput,
  type SnapshotResult,
  type TestConnection,
} from '@shared/ipc'

/** Whether the first `getState()` has landed. The UI shows a spinner, the error, or itself. */
export type LoadPhase = 'loading' | 'ready' | 'failed'

export interface AppStoreState {
  phase: LoadPhase
  /** Why the initial load failed. Only set while `phase` is `failed`. */
  loadError: IpcError | null

  version: string
  /** `null` until the first load; every screen waits for `phase === 'ready'`. */
  settings: Settings | null
  keystoreAvailable: boolean
  secretsStored: SecretsStored
  connection: ConnectionStatus | null
  cameras: Camera[]

  /** Load (or reload) everything. Safe to call again; the UI calls it once on mount. */
  load: () => Promise<void>
  /**
   * Subscribes to main's pushes (status, inventory, camera state). Returns the unsubscribe, so the
   * caller is an effect in the app shell — not every screen, or a reconnect would fan out.
   */
  subscribe: () => () => void

  setConsole: (input: ConsoleInput) => Promise<IpcResult<AppState>>
  setSecret: (input: SecretInput) => Promise<IpcResult<AppState>>
  clearSecret: (input: SecretKeyInput) => Promise<IpcResult<AppState>>
  checkCertificate: (endpoint: AcceptCertInput['endpoint']) => Promise<IpcResult<PinCheck>>
  acceptCertificate: (input: AcceptCertInput) => Promise<IpcResult<AppState>>
  repinCertificate: (input: AcceptCertInput) => Promise<IpcResult<AppState>>
  testConnection: () => Promise<IpcResult<TestConnection>>
  connect: () => Promise<IpcResult<AppState>>
  disconnect: () => Promise<IpcResult<AppState>>
  refreshCameras: () => Promise<IpcResult<Camera[]>>
  snapshot: (input: SnapshotInput) => Promise<IpcResult<SnapshotResult>>
  /**
   * QUAL-7: which RTSPS qualities exist for one camera, as booleans. Not folded into the store: like
   * a thumbnail it belongs to the camera list's own cache (camerasStore.ts), not to `AppState`.
   */
  cameraStreamQualities: (cameraId: string) => Promise<IpcResult<RtspsAvailability>>
  /** QUAL-1: persist the app-wide grid and fill quality defaults. */
  setStreams: (input: SetStreamsInput) => Promise<IpcResult<AppState>>
  /**
   * VIEW-3/6: persist a new View list and active View. Called by the View store (viewsStore.ts),
   * which computes the list; this only sends it and folds the answer, like every other mutation.
   */
  setViews: (input: SetViewsInput) => Promise<IpcResult<AppState>>
  /** VIEW-4/6: switch the active View. */
  setLastView: (viewId: string | null) => Promise<IpcResult<AppState>>
}

const NO_SECRETS: SecretsStored = { protectApiKey: false, accessToken: false }

/**
 * The bridge, read per call rather than captured at module load. That is not a style choice: this
 * module is imported by the unit test in a plain Node environment, where there is no `window` until
 * the test installs a fake, and a reference taken while the store is being created would throw
 * before the first assertion. It also means `version` starts empty and arrives with the first
 * `AppState`, rather than being read from the bridge twice.
 */
function bridge(): Window['viewProtect'] {
  return window.viewProtect
}

export const useAppStore = create<AppStoreState>()((set, get) => {
  /**
   * How many pushes from main have been applied. `load()` reads it before and after its own await:
   * a status or inventory push that lands while `getState()` is in flight is **newer** than the
   * snapshot that call is carrying, so folding the snapshot in wholesale would undo it. Reachable
   * through the shell's "Try again" button during a reconnect.
   */
  let pushes = 0

  /** Folds a mutating call's `AppState` into the store and passes the result through unchanged. */
  const fold = (result: IpcResult<AppState>): IpcResult<AppState> => {
    if (result.ok) set(fromAppState(result.value))
    return result
  }

  return {
    phase: 'loading',
    loadError: null,
    version: '',
    settings: null,
    keystoreAvailable: false,
    secretsStored: NO_SECRETS,
    connection: null,
    cameras: [],

    load: async () => {
      const before = pushes
      const result = await bridge().getState()
      if (!result.ok) {
        set({ phase: 'failed', loadError: result.error })
        return
      }
      const snapshot = fromAppState(result.value)
      if (pushes !== before) {
        // Keep what the pushes own — the status and the inventory — and take the rest.
        set({
          phase: 'ready',
          loadError: null,
          version: snapshot.version,
          settings: snapshot.settings,
          keystoreAvailable: snapshot.keystoreAvailable,
          secretsStored: snapshot.secretsStored,
        })
        return
      }
      set({ phase: 'ready', loadError: null, ...snapshot })
    },

    subscribe: () => {
      const offConnection = bridge().onConnection((connection: ConnectionStatus) => {
        pushes += 1
        set({ connection })
      })
      const offCameras = bridge().onCameras((cameras: Camera[]) => {
        pushes += 1
        set({ cameras })
      })
      // CAM-2/3: one camera's state, the path G1 times at 10 seconds. Patched in place rather than
      // triggering a re-read, so an unplugged camera greys out as soon as the feed says so; the
      // authoritative list still arrives separately (R11).
      const offCameraState = bridge().onCameraState((change: CameraStateChange) => {
        pushes += 1
        set({ cameras: applyCameraState(get().cameras, change) })
      })
      return () => {
        offConnection()
        offCameras()
        offCameraState()
      }
    },

    setConsole: async (input) => fold(await bridge().setConsole(input)),
    setSecret: async (input) => fold(await bridge().setSecret(input)),
    clearSecret: async (input) => fold(await bridge().clearSecret(input)),
    checkCertificate: async (endpoint) => bridge().checkCertificate({ endpoint }),
    acceptCertificate: async (input) => fold(await bridge().acceptCertificate(input)),
    repinCertificate: async (input) => fold(await bridge().repinCertificate(input)),
    connect: async () => fold(await bridge().connect()),
    disconnect: async () => fold(await bridge().disconnect()),

    testConnection: async () => {
      const result = await bridge().testConnection()
      // The probe's own status is fresher than anything a later event will carry (CON-4/5).
      if (result.ok) set({ connection: result.value.connection })
      return result
    },

    refreshCameras: async () => {
      const result = await bridge().listCameras()
      if (result.ok) set({ cameras: result.value })
      return result
    },

    snapshot: async (input) => bridge().snapshot(input),
    cameraStreamQualities: async (cameraId) => bridge().cameraStreamQualities({ cameraId }),
    setStreams: async (input) => fold(await bridge().setStreams(input)),
    setViews: async (input) => fold(await bridge().setViews(input)),
    setLastView: async (viewId) => fold(await bridge().setLastView({ viewId })),
  }
})

/** The slice of the store that comes straight from main. Keeps `load` and `fold` in step. */
function fromAppState(
  state: AppState,
): Pick<
  AppStoreState,
  'version' | 'settings' | 'keystoreAvailable' | 'secretsStored' | 'connection' | 'cameras'
> {
  return {
    version: state.version,
    settings: state.settings,
    keystoreAvailable: state.keystoreAvailable,
    secretsStored: state.secretsStored,
    connection: state.connection,
    cameras: state.cameras,
  }
}

/**
 * CAM-2: a `state` change for a camera we know about. A change for an unknown camera id is
 * **ignored** rather than appended: the devices feed's shapes are unverified (SPEC R11) and a
 * half-filled camera row would be worse than waiting for the `GET /v1/cameras` that follows every
 * add (main re-reads it and pushes the whole list).
 *
 * Exported for the unit test; the store is the only caller.
 */
export function applyCameraState(cameras: Camera[], change: CameraStateChange): Camera[] {
  const current = cameras.find((camera) => camera.id === change.cameraId)
  // Same array back when there is nothing to do, so an unknown camera or a repeated state cannot
  // re-render the list. The devices feed repeats itself (SPEC §5.1 on the events feed; the devices
  // feed is unverified, R11), and a 15-row wall is not worth re-rendering for an identical value.
  if (current === undefined || current.state === change.state) return cameras
  return cameras.map((camera) => (camera === current ? { ...camera, state: change.state } : camera))
}
