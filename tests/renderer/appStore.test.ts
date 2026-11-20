// P1.5: the renderer's `AppState` store (src/renderer/src/state/appStore.ts).
//
// Two things are worth holding down here. The first is the contract's rule 3 — every mutating call
// answers with the whole `AppState`, and the store folds it in rather than patching its own copy, so
// Settings and the camera list cannot drift apart. The second is CAM-2/3: a `cameraState` push has
// to reach the right row and change nothing else, because that is the path gate G1 times at ten
// seconds, and a push for a camera the renderer has never heard of must not invent a row.
//
// There is no jsdom here (vitest.config.mts runs the node environment). The store reads
// `window.viewProtect` through a function for exactly this reason, so a fake bridge installed on
// `globalThis` is all it takes — and a fake is better than a DOM anyway: it records the calls.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppState,
  type Camera,
  type CameraStateChange,
  type ConnectionStatus,
  type DoorStates,
  type IpcResult,
  type StreamRuntime,
  type ViewProtectApi,
} from '@shared/ipc'
import { applyCameraState, useAppStore } from '../../src/renderer/src/state/appStore'

function endpointStatus(
  endpoint: 'protect' | 'access',
  phase: ConnectionStatus['protect']['phase'],
): ConnectionStatus['protect'] {
  return {
    endpoint,
    phase,
    hostPort: endpoint === 'protect' ? 'udm.local:443' : 'udm.local:12445',
    pinned: true,
    credentialStored: true,
    version: null,
    error: null,
    updatedAt: 1,
  }
}

function appState(overrides: Partial<AppState> = {}): AppState {
  return {
    version: '0.1.0',
    settings: {
      console: {
        host: 'udm.local',
        certFingerprint: 'AA:BB',
        accessEnabled: false,
        accessBaseUrl: null,
        accessCertFingerprint: null,
        connectOnLaunch: false,
      },
      doorLinks: {},
      views: [],
      lastViewId: null,
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      ui: { overlayAutoHideSec: 3 },
      accessPolling: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 },
      mode: 'protect',
      rtsp: { streams: [], views: [], lastViewId: null },
    },
    keystoreAvailable: true,
    secretsStored: { protectApiKey: true, accessToken: false, rtspUrls: {} },
    connection: {
      protect: endpointStatus('protect', 'idle'),
      access: endpointStatus('access', 'disabled'),
    },
    cameras: [],
    ...overrides,
  }
}

function camera(id: string, state = 'CONNECTED', name: string | null = null): Camera {
  return {
    id,
    name,
    model: 'G4 Bullet',
    state,
    hasMic: true,
    micEnabled: true,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: false,
    hasPackageCamera: false,
  }
}

type Listener<T> = (payload: T) => void

interface FakeBridge {
  api: ViewProtectApi
  /** Pushes a payload the way main would, to whatever the store subscribed. */
  pushConnection: (status: ConnectionStatus) => void
  pushCameras: (cameras: Camera[]) => void
  pushCameraState: (change: CameraStateChange) => void
  pushDoorStates: (states: DoorStates) => void
  offCalls: () => number
}

function fakeBridge(overrides: Partial<ViewProtectApi> = {}): FakeBridge {
  const connectionListeners = new Set<Listener<ConnectionStatus>>()
  const cameraListeners = new Set<Listener<Camera[]>>()
  const stateListeners = new Set<Listener<CameraStateChange>>()
  const runtimeListeners = new Set<Listener<StreamRuntime>>()
  const doorStateListeners = new Set<Listener<DoorStates>>()
  let offs = 0

  const subscribeTo = <T>(set: Set<Listener<T>>, listener: Listener<T>): (() => void) => {
    set.add(listener)
    return () => {
      offs += 1
      set.delete(listener)
    }
  }

  const unimplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} was not expected in this test`))

  const api: ViewProtectApi = {
    version: '0.1.0',
    getState: unimplemented('getState'),
    setConsole: unimplemented('setConsole'),
    setSecret: unimplemented('setSecret'),
    clearSecret: unimplemented('clearSecret'),
    checkCertificate: unimplemented('checkCertificate'),
    acceptCertificate: unimplemented('acceptCertificate'),
    repinCertificate: unimplemented('repinCertificate'),
    testConnection: unimplemented('testConnection'),
    connect: unimplemented('connect'),
    listCameras: unimplemented('listCameras'),
    snapshot: unimplemented('snapshot'),
    // P2.2: on the bridge, so the store's `ViewProtectApi` is complete. The player asks for streams
    // itself (P2.3), so no store test drives these yet.
    ensureStream: unimplemented('ensureStream'),
    // P3.1: driven by viewsStore.test.ts.
    setViews: unimplemented('setViews'),
    setLastView: unimplemented('setLastView'),
    // P3.7 (QUAL-1/7).
    setStreams: unimplemented('setStreams'),
    cameraStreamQualities: unimplemented('cameraStreamQualities'),
    // P5.3 (DOOR-1/2).
    setDoorLinks: unimplemented('setDoorLinks'),
    unlockDoor: unimplemented('unlockDoor'),
    // P5.5 (DOOR-6).
    watchDoors: unimplemented('watchDoors'),
    // P5.6 (the Doors screen): on the bridge so the `ViewProtectApi` is complete; no store test
    // drives them.
    watchDoorsScreen: unimplemented('watchDoorsScreen'),
    doorAction: unimplemented('doorAction'),
    setDoorEmergency: unimplemented('setDoorEmergency'),
    setAccessPolling: unimplemented('setAccessPolling'),
    // F1.0.2-3 (MODE-1/4): on the bridge so the `ViewProtectApi` is complete; the mode picker that
    // calls it is F1.0.2-4.
    setMode: unimplemented('setMode'),
    // P6.2 (NFR-7/8): the wall reports itself (features/power/) and the players hear `onRecover`
    // themselves; no store test drives either.
    setViewVisible: unimplemented('setViewVisible'),
    onRecover: () => () => undefined,
    onDoorsScreen: () => () => undefined,
    onConnection: (listener) => subscribeTo(connectionListeners, listener),
    onCameras: (listener) => subscribeTo(cameraListeners, listener),
    onCameraState: (listener) => subscribeTo(stateListeners, listener),
    onStreamRuntime: (listener) => subscribeTo(runtimeListeners, listener),
    onDoorStates: (listener) => subscribeTo(doorStateListeners, listener),
    // P4.2 (CELL-2): the event bus's source (state/eventBus.ts), not the store's; never pushed here.
    onCameraEvent: () => () => undefined,
    ...overrides,
  }

  Object.defineProperty(globalThis, 'window', {
    value: { viewProtect: api },
    configurable: true,
    writable: true,
  })

  return {
    api,
    pushConnection: (status) => {
      for (const listener of connectionListeners) listener(status)
    },
    pushCameras: (cameras) => {
      for (const listener of cameraListeners) listener(cameras)
    },
    pushCameraState: (change) => {
      for (const listener of stateListeners) listener(change)
    },
    pushDoorStates: (states) => {
      for (const listener of doorStateListeners) listener(states)
    },
    offCalls: () => offs,
  }
}

const initial = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(initial, true)
})

describe('load', () => {
  it('folds the whole AppState in and becomes ready', async () => {
    const state = appState({ cameras: [camera('cam-1')] })
    fakeBridge({ getState: () => Promise.resolve({ ok: true, value: state }) })

    await useAppStore.getState().load()

    const store = useAppStore.getState()
    expect(store.phase).toBe('ready')
    expect(store.version).toBe('0.1.0')
    expect(store.settings?.console.host).toBe('udm.local')
    expect(store.keystoreAvailable).toBe(true)
    expect(store.secretsStored).toEqual({ protectApiKey: true, accessToken: false, rtspUrls: {} })
    expect(store.cameras).toHaveLength(1)
    expect(store.loadError).toBeNull()
  })

  it('does not undo a push that landed while the read was in flight', async () => {
    // The shell subscribes before it loads, and "Try again" can be pressed during a reconnect: the
    // snapshot `getState()` is carrying was taken before that push, so folding it in wholesale
    // would put the stale status back on screen.
    let resolveState: ((result: IpcResult<AppState>) => void) | undefined
    const bridge = fakeBridge({
      getState: () =>
        new Promise<IpcResult<AppState>>((resolve) => {
          resolveState = resolve
        }),
    })
    const unsubscribe = useAppStore.getState().subscribe()

    const loading = useAppStore.getState().load()
    const pushed: ConnectionStatus = {
      protect: endpointStatus('protect', 'reconnecting'),
      access: endpointStatus('access', 'disabled'),
    }
    bridge.pushConnection(pushed)
    bridge.pushCameras([camera('cam-live')])
    resolveState?.({ ok: true, value: appState({ cameras: [camera('cam-stale')] }) })
    await loading

    const store = useAppStore.getState()
    expect(store.phase).toBe('ready')
    // The pushes win for what they own...
    expect(store.connection?.protect.phase).toBe('reconnecting')
    expect(store.cameras.map((c) => c.id)).toEqual(['cam-live'])
    // ...and the snapshot still provides the rest.
    expect(store.version).toBe('0.1.0')
    expect(store.settings?.console.host).toBe('udm.local')
    unsubscribe()
  })

  it('keeps the failure as a value, so the shell can offer a retry', async () => {
    fakeBridge({
      getState: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'not-ready', message: 'Still starting.', endpoint: null, retryable: true },
        }),
    })

    await useAppStore.getState().load()

    expect(useAppStore.getState().phase).toBe('failed')
    expect(useAppStore.getState().loadError?.kind).toBe('not-ready')
    expect(useAppStore.getState().settings).toBeNull()
  })
})

describe('pushes from main', () => {
  it('updates the status, replaces the inventory, and unsubscribes all four', () => {
    const bridge = fakeBridge()
    const unsubscribe = useAppStore.getState().subscribe()

    const connected: ConnectionStatus = {
      protect: endpointStatus('protect', 'connected'),
      access: endpointStatus('access', 'disabled'),
    }
    bridge.pushConnection(connected)
    expect(useAppStore.getState().connection?.protect.phase).toBe('connected')

    bridge.pushCameras([camera('cam-1'), camera('cam-2')])
    expect(useAppStore.getState().cameras.map((c) => c.id)).toEqual(['cam-1', 'cam-2'])

    unsubscribe()
    expect(bridge.offCalls()).toBe(4)
    // After unsubscribing, a late push must not reach the store.
    bridge.pushCameras([])
    expect(useAppStore.getState().cameras).toHaveLength(2)
  })

  it('patches one camera’s state and leaves the others alone (CAM-2, gate G1)', () => {
    const bridge = fakeBridge()
    const unsubscribe = useAppStore.getState().subscribe()
    useAppStore.setState({ cameras: [camera('cam-1'), camera('cam-2')] })

    bridge.pushCameraState({ cameraId: 'cam-2', state: 'DISCONNECTED' })

    const cameras = useAppStore.getState().cameras
    expect(cameras[0]?.state).toBe('CONNECTED')
    expect(cameras[1]?.state).toBe('DISCONNECTED')
    unsubscribe()
  })

  it('ignores a state change for a camera it has never seen (SPEC R11)', () => {
    const bridge = fakeBridge()
    const unsubscribe = useAppStore.getState().subscribe()
    const before = [camera('cam-1')]
    useAppStore.setState({ cameras: before })

    bridge.pushCameraState({ cameraId: 'cam-9', state: 'CONNECTED' })

    // Same array, not just equal: the feed's shapes are unverified, so a row is never invented and
    // nothing re-renders. The authoritative list arrives separately as a `cameras` push.
    expect(useAppStore.getState().cameras).toBe(before)
    unsubscribe()
  })
})

describe('applyCameraState', () => {
  it('returns the same array when nothing changed', () => {
    const cameras = [camera('cam-1', 'CONNECTED')]
    expect(applyCameraState(cameras, { cameraId: 'cam-1', state: 'CONNECTED' })).toBe(cameras)
    expect(applyCameraState(cameras, { cameraId: 'other', state: 'DISCONNECTED' })).toBe(cameras)
  })

  it('carries an unknown state through, because anything but CONNECTED is offline', () => {
    const cameras = [camera('cam-1')]
    const next = applyCameraState(cameras, { cameraId: 'cam-1', state: 'REBOOTING' })
    expect(next[0]?.state).toBe('REBOOTING')
  })
})

describe('mutating actions', () => {
  it('folds a successful reply in', async () => {
    const saved = appState({
      settings: {
        ...appState().settings,
        console: { ...appState().settings.console, host: 'udm2.local' },
      },
    })
    const setConsole = vi.fn<ViewProtectApi['setConsole']>(() =>
      Promise.resolve<IpcResult<AppState>>({ ok: true, value: saved }),
    )
    fakeBridge({ setConsole })

    const result = await useAppStore
      .getState()
      .setConsole({ host: 'udm2.local', accessEnabled: false, accessBaseUrl: null })

    expect(result.ok).toBe(true)
    expect(setConsole).toHaveBeenCalledWith({
      host: 'udm2.local',
      accessEnabled: false,
      accessBaseUrl: null,
    })
    expect(useAppStore.getState().settings?.console.host).toBe('udm2.local')
  })

  it('leaves the store untouched when the call fails, and hands the error back', async () => {
    fakeBridge({
      setSecret: () =>
        Promise.resolve({
          ok: false,
          error: {
            kind: 'internal',
            message: 'The OS keystore is unavailable.',
            endpoint: null,
            retryable: false,
          },
        }),
    })
    useAppStore.setState({
      secretsStored: { protectApiKey: false, accessToken: false, rtspUrls: {} },
    })

    const result = await useAppStore.getState().setSecret({ key: 'protectApiKey', value: 'abc' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('keystore')
    expect(useAppStore.getState().secretsStored.protectApiKey).toBe(false)
  })

  it('takes only the status from a Test connection reply (CON-4/5)', async () => {
    const connection: ConnectionStatus = {
      protect: { ...endpointStatus('protect', 'idle'), version: '7.3.74' },
      access: endpointStatus('access', 'disabled'),
    }
    fakeBridge({
      testConnection: () =>
        Promise.resolve({
          ok: true,
          value: {
            protect: { state: 'ok', applicationVersion: '7.3.74' },
            access: { state: 'disabled' },
            connection,
          },
        }),
    })
    useAppStore.setState({ cameras: [camera('cam-1')] })

    const result = await useAppStore.getState().testConnection()

    expect(result.ok).toBe(true)
    expect(useAppStore.getState().connection?.protect.version).toBe('7.3.74')
    // A probe says nothing about the inventory, so it must not clear it.
    expect(useAppStore.getState().cameras).toHaveLength(1)
  })

  it('refreshes the inventory from listCameras', async () => {
    fakeBridge({ listCameras: () => Promise.resolve({ ok: true, value: [camera('cam-7')] }) })

    await useAppStore.getState().refreshCameras()

    expect(useAppStore.getState().cameras.map((c) => c.id)).toEqual(['cam-7'])
  })

  it('folds the saved QUAL-1 defaults in', async () => {
    const streams = { defaultGridQuality: 'medium', defaultFillQuality: 'low' } as const
    const setStreams = vi.fn<ViewProtectApi['setStreams']>(() =>
      Promise.resolve<IpcResult<AppState>>({
        ok: true,
        value: appState({ settings: { ...appState().settings, streams } }),
      }),
    )
    fakeBridge({ setStreams })

    const result = await useAppStore.getState().setStreams(streams)

    expect(result.ok).toBe(true)
    expect(setStreams).toHaveBeenCalledWith(streams)
    expect(useAppStore.getState().settings?.streams).toEqual(streams)
  })

  it('folds the saved door links in (DOOR-2)', async () => {
    const links = { 'cam-1': 'door-1' }
    const setDoorLinks = vi.fn<ViewProtectApi['setDoorLinks']>(() =>
      Promise.resolve<IpcResult<AppState>>({
        ok: true,
        value: appState({ settings: { ...appState().settings, doorLinks: links } }),
      }),
    )
    fakeBridge({ setDoorLinks })

    const result = await useAppStore.getState().setDoorLinks({ links })

    expect(result.ok).toBe(true)
    expect(setDoorLinks).toHaveBeenCalledWith({ links })
    expect(useAppStore.getState().settings?.doorLinks).toEqual(links)
  })

  it('forwards an unlock once and keeps the answer out of the store (DOOR-3)', async () => {
    const unlockDoor = vi.fn<ViewProtectApi['unlockDoor']>(() =>
      Promise.resolve({
        ok: true,
        value: {
          doorId: 'door-1',
          cameraName: 'Front Doorbell',
          outcome: 'unlocked',
          reason: null,
        },
      }),
    )
    fakeBridge({ unlockDoor })
    const before = useAppStore.getState()

    const result = await useAppStore.getState().unlockDoor({ cameraRef: 'cam-1:package' })

    expect(unlockDoor).toHaveBeenCalledExactlyOnceWith({ cameraRef: 'cam-1:package' })
    expect(result).toEqual({
      ok: true,
      value: { doorId: 'door-1', cameraName: 'Front Doorbell', outcome: 'unlocked', reason: null },
    })
    expect(useAppStore.getState()).toBe(before)
  })

  it('asks for one camera’s RTSPS qualities and keeps them out of the store (QUAL-7)', async () => {
    const available = { high: true, medium: false, low: true, package: false }
    const cameraStreamQualities = vi.fn<ViewProtectApi['cameraStreamQualities']>(() =>
      Promise.resolve({ ok: true, value: available }),
    )
    fakeBridge({ cameraStreamQualities })
    const before = useAppStore.getState()

    const result = await useAppStore.getState().cameraStreamQualities('cam-1')

    expect(cameraStreamQualities).toHaveBeenCalledWith({ cameraId: 'cam-1' })
    expect(result).toEqual({ ok: true, value: available })
    expect(useAppStore.getState()).toBe(before)
  })
})

describe('door states (DOOR-6)', () => {
  const UNLOCKED: DoorStates = { 'door-1': { relay: 'unlock', position: 'close' } }
  const LOCKED: DoorStates = { 'door-1': { relay: 'lock', position: 'close' } }
  const ok = (value: DoorStates): Promise<IpcResult<DoorStates>> =>
    Promise.resolve({ ok: true, value })

  /** A `watchDoors` whose answers the test hands out itself, in whatever order it likes. */
  function deferredWatch(): {
    watchDoors: ReturnType<typeof vi.fn<ViewProtectApi['watchDoors']>>
    answer: (call: number, result: IpcResult<DoorStates>) => void
  } {
    const resolvers: ((result: IpcResult<DoorStates>) => void)[] = []
    const watchDoors = vi.fn<ViewProtectApi['watchDoors']>(
      () =>
        new Promise<IpcResult<DoorStates>>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    return {
      watchDoors,
      answer: (call, result) => {
        resolvers[call]?.(result)
      },
    }
  }

  // The store's watch bookkeeping outlives `setState(initial)`: leave every test not watching.
  beforeEach(async () => {
    fakeBridge({ watchDoors: () => ok({}) })
    await useAppStore.getState().watchDoors(false)
  })

  it('starts with no door state known', () => {
    expect(useAppStore.getState().doorStates).toEqual({})
  })

  it('folds what main knows now when the watch starts', async () => {
    const watchDoors = vi.fn<ViewProtectApi['watchDoors']>(() => ok(UNLOCKED))
    fakeBridge({ watchDoors })

    const result = await useAppStore.getState().watchDoors(true)

    expect(watchDoors).toHaveBeenCalledExactlyOnceWith({ watching: true })
    expect(result).toEqual({ ok: true, value: UNLOCKED })
    expect(useAppStore.getState().doorStates).toEqual(UNLOCKED)
  })

  it('replaces the map wholesale on a push: a door that is gone from it is unknown again', async () => {
    const bridge = fakeBridge({
      watchDoors: () => ok({ ...UNLOCKED, 'door-2': { relay: 'lock', position: null } }),
    })
    const unsubscribe = useAppStore.getState().subscribe()
    await useAppStore.getState().watchDoors(true)

    bridge.pushDoorStates(LOCKED)
    expect(useAppStore.getState().doorStates).toEqual(LOCKED)

    bridge.pushDoorStates({})
    expect(useAppStore.getState().doorStates).toEqual({})
    unsubscribe()
  })

  it('empties the map when the watch stops, before main has answered', async () => {
    const { watchDoors, answer } = deferredWatch()
    fakeBridge({ watchDoors })
    useAppStore.setState({ doorStates: UNLOCKED })

    const stopping = useAppStore.getState().watchDoors(false)
    expect(useAppStore.getState().doorStates).toEqual({})

    // Whatever main answers to a stop, nothing is known.
    answer(0, { ok: true, value: UNLOCKED })
    await stopping
    expect(watchDoors).toHaveBeenCalledExactlyOnceWith({ watching: false })
    expect(useAppStore.getState().doorStates).toEqual({})
  })

  it('empties the map when the call fails', async () => {
    fakeBridge({
      watchDoors: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'internal', message: 'No.', endpoint: null, retryable: false },
        }),
    })
    useAppStore.setState({ doorStates: UNLOCKED })

    const result = await useAppStore.getState().watchDoors(true)

    expect(result.ok).toBe(false)
    expect(useAppStore.getState().doorStates).toEqual({})
  })

  it('treats a bridge that throws as a failed call, not an unhandled rejection', async () => {
    fakeBridge({ watchDoors: () => Promise.reject(new Error('no such channel')) })
    useAppStore.setState({ doorStates: UNLOCKED })

    const result = await useAppStore.getState().watchDoors(true)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).not.toContain('no such channel')
    expect(useAppStore.getState().doorStates).toEqual({})
  })

  it('ignores a start answered after a later stop (out of order)', async () => {
    const { watchDoors, answer } = deferredWatch()
    fakeBridge({ watchDoors })

    const starting = useAppStore.getState().watchDoors(true)
    const stopping = useAppStore.getState().watchDoors(false)
    answer(1, { ok: true, value: {} })
    await stopping
    answer(0, { ok: true, value: UNLOCKED })
    await starting

    expect(useAppStore.getState().doorStates).toEqual({})
  })

  it('takes only the latest start: true, false, true (StrictMode) ends on the last answer', async () => {
    const { watchDoors, answer } = deferredWatch()
    fakeBridge({ watchDoors })

    const first = useAppStore.getState().watchDoors(true)
    const stop = useAppStore.getState().watchDoors(false)
    const second = useAppStore.getState().watchDoors(true)
    answer(2, { ok: true, value: LOCKED })
    answer(1, { ok: true, value: {} })
    answer(0, { ok: true, value: UNLOCKED })
    await Promise.all([first, stop, second])

    expect(watchDoors.mock.calls.map(([input]) => input.watching)).toEqual([true, false, true])
    expect(useAppStore.getState().doorStates).toEqual(LOCKED)
  })

  it('a failed earlier call does not empty what a later one folded', async () => {
    const { watchDoors, answer } = deferredWatch()
    fakeBridge({ watchDoors })

    const first = useAppStore.getState().watchDoors(true)
    const second = useAppStore.getState().watchDoors(true)
    answer(1, { ok: true, value: UNLOCKED })
    await second
    answer(0, {
      ok: false,
      error: { kind: 'internal', message: 'No.', endpoint: null, retryable: false },
    })
    await first

    expect(useAppStore.getState().doorStates).toEqual(UNLOCKED)
  })

  it('keeps a push that overtook the start’s answer: the push is newer', async () => {
    const { watchDoors, answer } = deferredWatch()
    const bridge = fakeBridge({ watchDoors })
    const unsubscribe = useAppStore.getState().subscribe()

    const starting = useAppStore.getState().watchDoors(true)
    bridge.pushDoorStates(UNLOCKED)
    answer(0, { ok: true, value: {} })
    await starting

    expect(useAppStore.getState().doorStates).toEqual(UNLOCKED)
    unsubscribe()
  })

  it('drops a push that arrives while not watching, so no stale state comes back', async () => {
    const bridge = fakeBridge({ watchDoors: () => ok(UNLOCKED) })
    const unsubscribe = useAppStore.getState().subscribe()
    await useAppStore.getState().watchDoors(true)
    await useAppStore.getState().watchDoors(false)

    // Sent by main before it handled the stop.
    bridge.pushDoorStates(UNLOCKED)

    expect(useAppStore.getState().doorStates).toEqual({})
    unsubscribe()
  })

  it('never sends an unlock: a watch and a push only read (DOOR-4)', async () => {
    const unlockDoor = vi.fn<ViewProtectApi['unlockDoor']>()
    const bridge = fakeBridge({ unlockDoor, watchDoors: () => ok(LOCKED) })
    const unsubscribe = useAppStore.getState().subscribe()

    await useAppStore.getState().watchDoors(true)
    bridge.pushDoorStates(UNLOCKED)
    bridge.pushDoorStates(LOCKED)
    await useAppStore.getState().watchDoors(false)

    expect(unlockDoor).not.toHaveBeenCalled()
    unsubscribe()
  })
})
