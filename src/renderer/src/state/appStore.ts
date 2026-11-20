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
  emptyDoorsScreenState,
  ipcFail,
  type AcceptCertInput,
  type AppState,
  type Camera,
  type CameraStateChange,
  type ConnectionStatus,
  type ConsoleInput,
  type DoorActionInput,
  type DoorActionResult,
  type DoorEmergencyInput,
  type DoorEmergencyResult,
  type DoorStates,
  type DoorsScreenState,
  type IpcError,
  type IpcResult,
  type PinCheck,
  type RtspsAvailability,
  type SaveRtspStreamInput,
  type SecretInput,
  type SecretKeyInput,
  type SecretsStored,
  type SetAccessPollingInput,
  type SetDoorLinksInput,
  type SetStreamsInput,
  type SetViewsInput,
  type Settings,
  type SnapshotInput,
  type SnapshotResult,
  type TestConnection,
  type UnlockDoorInput,
  type UnlockResult,
} from '@shared/ipc'
import type { AppMode } from '@shared/models'

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
  /**
   * DOOR-6: the lock state of the linked doors main currently knows, by Access door id. A linked
   * door that is missing is **unknown** and is drawn neutral (features/door/doorState.ts). Always
   * `{}` while the Live screen is not watching ({@link AppStoreState.watchDoors}).
   */
  doorStates: DoorStates
  /**
   * P5.6: everything the Doors screen draws that comes from the console (the door list, their
   * rules, the emergency status, why the list cannot be read), as main last sent it. Everything
   * unknown (`emptyDoorsScreenState()`) while the screen is not open
   * ({@link AppStoreState.watchDoorsScreen}).
   */
  doorsScreen: DoorsScreenState

  /** Load (or reload) everything. Safe to call again; the UI calls it once on mount. */
  load: () => Promise<void>
  /**
   * Subscribes to main's pushes (status, inventory, camera state, door states, the Doors screen's
   * state). Returns the unsubscribe, so the
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
  /**
   * VIEW-4/6: switch the active View. `mode` is the app mode of the list `viewId` was picked from
   * (MODE-4), refused by main once it is no longer the stored mode.
   */
  setLastView: (viewId: string | null, mode: AppMode) => Promise<IpcResult<AppState>>
  /** DOOR-2: persist the whole camera → door map. */
  setDoorLinks: (input: SetDoorLinksInput) => Promise<IpcResult<AppState>>
  /**
   * DOOR-3: unlock the door linked to a camera ref, once — only from the unlock control's
   * press-and-hold, never from a timer, a shortcut alone or a retry (DOOR-4). Not folded into the
   * store: the result is the toast's, and the Access status it moves arrives as the usual
   * `connection` push.
   */
  unlockDoor: (input: UnlockDoorInput) => Promise<IpcResult<UnlockResult>>
  /**
   * DOOR-6: tell main whether the Live screen is showing at least one unlock control
   * (features/door/useDoorWatch.ts is the only caller). `true` starts main's door monitor and folds
   * what it knows now into `doorStates`; later changes arrive as `doorStates` pushes. `false` stops
   * it. `doorStates` is emptied at once when stopping and when a call fails, and pushes are dropped
   * while not watching, so a stale "unlocked" can never stay on screen. Only the **latest** call's
   * answer is folded in: a `true` answered after a later `false` changes nothing. A read only: it
   * never unlocks anything (DOOR-4).
   */
  watchDoors: (watching: boolean) => Promise<IpcResult<DoorStates>>
  /**
   * P5.6: tell main whether the Doors screen is open (features/doors/useDoorsScreenWatch.ts is the
   * only caller). `true` makes main read every door, their rules and the emergency status, and
   * folds what it knows now into `doorsScreen`; later changes arrive as `doorsScreen` pushes.
   * `false` ends that. The same guards as {@link AppStoreState.watchDoors}: `doorsScreen` is
   * emptied at once when closing and when a call fails, pushes are dropped while closed, only the
   * **latest** call's answer is folded in, and an answer a push overtook does not undo the push.
   * A read only: it never changes a door (DOOR-4).
   */
  watchDoorsScreen: (open: boolean) => Promise<IpcResult<DoorsScreenState>>
  /**
   * DOOR-3 (P5.6): one action on one door, once — only from the Doors screen after its confirm
   * dialog, never from a timer, a shortcut alone or a retry (DOOR-4). Not folded into the store:
   * the result is the toast's, and the door's new state arrives as a `doorsScreen` push.
   */
  doorAction: (input: DoorActionInput) => Promise<IpcResult<DoorActionResult>>
  /** DOOR-3 (P5.6): lockdown / evacuation of every door, once, under the same rules. */
  setDoorEmergency: (input: DoorEmergencyInput) => Promise<IpcResult<DoorEmergencyResult>>
  /** DOOR-6 (P5.6): persist the Access read intervals; main applies them without a restart. */
  setAccessPolling: (input: SetAccessPollingInput) => Promise<IpcResult<AppState>>
  /**
   * MODE-2/4: switch the app mode. Main saves it, tears down or restores the Protect side and
   * answers with the new mode's `AppState` (its Views, inventory and status), folded in as usual.
   */
  setMode: (mode: AppMode) => Promise<IpcResult<AppState>>
  /** RTSP-1/2: create or edit a stream. URLs are write-only; the answer carries booleans only. */
  saveRtspStream: (input: SaveRtspStreamInput) => Promise<IpcResult<AppState>>
  /** RTSP-1: delete a stream and its URLs. */
  deleteRtspStream: (id: string) => Promise<IpcResult<AppState>>
}

const NO_SECRETS: SecretsStored = { protectApiKey: false, accessToken: false, rtspUrls: {} }

/** One object for "no door state known", so emptying an empty map re-renders nothing. */
const NO_DOOR_STATES: DoorStates = {}

/** One object for "the Doors screen knows nothing", for the same reason. */
const NO_DOORS_SCREEN: DoorsScreenState = emptyDoorsScreenState()

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

  // DOOR-6 (`watchDoors`). `doorWatching` is what the Live screen last asked for; `doorWatchCalls`
  // numbers the calls, so only the latest one's answer counts; `doorPushes` counts the pushes
  // applied, so an answer that a push overtook (the push is newer) does not undo it.
  let doorWatching = false
  let doorWatchCalls = 0
  let doorPushes = 0

  // P5.6 (`watchDoorsScreen`): the same three, for the Doors screen's state.
  let doorsScreenOpen = false
  let doorsScreenCalls = 0
  let doorsScreenPushes = 0

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
    doorStates: NO_DOOR_STATES,
    doorsScreen: NO_DOORS_SCREEN,

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
      // DOOR-6: always the whole map, so it replaces ours. Not counted in `pushes`: door states
      // are not part of the `AppState` snapshot `load()` protects. Dropped while not watching: a
      // push main sent before it handled our stop must not bring a state back.
      const offDoorStates = bridge().onDoorStates((doorStates: DoorStates) => {
        if (!doorWatching) return
        doorPushes += 1
        set({ doorStates })
      })
      // P5.6: always the whole state, so it replaces ours; dropped while the screen is closed, as
      // above. Like the door states it is no part of the `AppState` snapshot.
      const offDoorsScreen = bridge().onDoorsScreen((doorsScreen: DoorsScreenState) => {
        if (!doorsScreenOpen) return
        doorsScreenPushes += 1
        set({ doorsScreen })
      })
      return () => {
        offConnection()
        offCameras()
        offCameraState()
        offDoorStates()
        offDoorsScreen()
      }
    },

    setConsole: async (input) => fold(await bridge().setConsole(input)),
    setSecret: async (input) => fold(await bridge().setSecret(input)),
    clearSecret: async (input) => fold(await bridge().clearSecret(input)),
    checkCertificate: async (endpoint) => bridge().checkCertificate({ endpoint }),
    acceptCertificate: async (input) => fold(await bridge().acceptCertificate(input)),
    repinCertificate: async (input) => fold(await bridge().repinCertificate(input)),
    connect: async () => fold(await bridge().connect()),

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
    setLastView: async (viewId, mode) => fold(await bridge().setLastView({ viewId, mode })),
    setDoorLinks: async (input) => fold(await bridge().setDoorLinks(input)),
    unlockDoor: async (input) => bridge().unlockDoor(input),

    watchDoors: async (watching) => {
      doorWatchCalls += 1
      const call = doorWatchCalls
      const pushesBefore = doorPushes
      doorWatching = watching
      // Stopping: nothing is known from here on, whatever main answers and whenever.
      if (!watching) set({ doorStates: NO_DOOR_STATES })
      let result: IpcResult<DoorStates>
      try {
        result = await bridge().watchDoors({ watching })
      } catch {
        // The bridge itself failed (not an `IpcResult`): the same as a failed call.
        result = ipcFail('internal', 'The app could not ask for the door states.')
      }
      // A later call owns the map now.
      if (call !== doorWatchCalls) return result
      if (!watching || !result.ok) set({ doorStates: NO_DOOR_STATES })
      // A push that landed while the call was out is newer than its answer.
      else if (doorPushes === pushesBefore) set({ doorStates: result.value })
      return result
    },

    watchDoorsScreen: async (open) => {
      doorsScreenCalls += 1
      const call = doorsScreenCalls
      const pushesBefore = doorsScreenPushes
      doorsScreenOpen = open
      // Closing: nothing is known from here on, whatever main answers and whenever.
      if (!open) set({ doorsScreen: NO_DOORS_SCREEN })
      let result: IpcResult<DoorsScreenState>
      try {
        result = await bridge().watchDoorsScreen({ open })
      } catch {
        // The bridge itself failed (not an `IpcResult`): the same as a failed call.
        result = ipcFail('internal', 'The app could not ask for the doors.')
      }
      // A later call owns the state now.
      if (call !== doorsScreenCalls) return result
      if (!open || !result.ok) set({ doorsScreen: NO_DOORS_SCREEN })
      // A push that landed while the call was out is newer than its answer.
      else if (doorsScreenPushes === pushesBefore) set({ doorsScreen: result.value })
      return result
    },

    // DOOR-3/4: passed straight through. Nothing here repeats, queues or times either call.
    doorAction: async (input) => bridge().doorAction(input),
    setDoorEmergency: async (input) => bridge().setDoorEmergency(input),
    setAccessPolling: async (input) => fold(await bridge().setAccessPolling(input)),
    setMode: async (mode) => fold(await bridge().setMode({ mode })),
    saveRtspStream: async (input) => fold(await bridge().saveRtspStream(input)),
    deleteRtspStream: async (id) => fold(await bridge().deleteRtspStream({ id })),
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
