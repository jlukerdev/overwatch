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
      },
      doorLinks: {},
      views: [],
      lastViewId: null,
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      ui: { overlayAutoHideSec: 3 },
    },
    keystoreAvailable: true,
    secretsStored: { protectApiKey: true, accessToken: false },
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
  offCalls: () => number
}

function fakeBridge(overrides: Partial<ViewProtectApi> = {}): FakeBridge {
  const connectionListeners = new Set<Listener<ConnectionStatus>>()
  const cameraListeners = new Set<Listener<Camera[]>>()
  const stateListeners = new Set<Listener<CameraStateChange>>()
  const runtimeListeners = new Set<Listener<StreamRuntime>>()
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
    disconnect: unimplemented('disconnect'),
    listCameras: unimplemented('listCameras'),
    snapshot: unimplemented('snapshot'),
    // P2.2: on the bridge, so the store's `ViewProtectApi` is complete. The player asks for streams
    // itself (P2.3), so no store test drives these yet.
    ensureStream: unimplemented('ensureStream'),
    // P3.1: driven by viewsStore.test.ts.
    setViews: unimplemented('setViews'),
    setLastView: unimplemented('setLastView'),
    onConnection: (listener) => subscribeTo(connectionListeners, listener),
    onCameras: (listener) => subscribeTo(cameraListeners, listener),
    onCameraState: (listener) => subscribeTo(stateListeners, listener),
    onStreamRuntime: (listener) => subscribeTo(runtimeListeners, listener),
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
    expect(store.secretsStored).toEqual({ protectApiKey: true, accessToken: false })
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
  it('updates the status, replaces the inventory, and unsubscribes all three', () => {
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
    expect(bridge.offCalls()).toBe(3)
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
    useAppStore.setState({ secretsStored: { protectApiKey: false, accessToken: false } })

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
})
