// MODE-4: **in RTSP mode the app makes no Protect or Access call of any kind** — the connection
// manager's half (src/main/connection.ts). The fakes record every request and every socket, so
// "no call" is asserted directly: with `mode: 'rtsp'` each of the manager's methods leaves the fake
// Protect and Access clients untouched and opens no feed and no door socket, and switching to RTSP
// with everything running stops it all and empties the inventory. Switching back follows CON-4's
// launch rule through `connectOnLaunch()`.
//
// The same shape of harness as connectionManager.test.ts, cut down to what these tests need.
import { IPC_EVENTS, emptyDoorsScreenState, type DoorsScreenState } from '@shared/ipc'
import { CameraSchema, ConsoleConfigSchema, type AppMode, type Camera } from '@shared/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessApiError } from '../../src/main/access/client'
import { POLL_WITHOUT_SOCKET_MS, TRIGGER_COALESCE_MS } from '../../src/main/access/doorStateMonitor'
import type { DoorNotificationHandlers } from '../../src/main/access/doorStateMonitor'
import type { UnlockAttempt } from '../../src/main/access/unlockLog'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'
import {
  DOOR_MONITOR_AUTH_RETRY_MS,
  createConnectionManager,
  type ConnectionServices,
} from '../../src/main/connection'
import { toIpcError } from '../../src/main/ipc/errors'
import { createRateLimiter } from '../../src/main/net/rateLimiter'
import type {
  ProtectSubscription,
  ProtectSubscriptionOptions,
  SubscriptionState,
} from '../../src/main/protect/subscriptions'
import { hostPortKey } from '../../src/main/tls/pinning'

const FP =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'
const PROTECT = '192.0.2.10:443'
const FRONT = 'door-front'

function camera(id: string): Camera {
  return CameraSchema.parse({ id, name: id })
}

const door = (id: string) => ({
  id,
  name: id,
  fullName: id,
  floorId: 'floor-1',
  type: 'door',
  boundToHub: true,
  relay: 'lock',
  position: null,
})

interface Feed {
  readonly onStateChange: ((next: SubscriptionState) => void) | undefined
  starts: number
  stops: number
  reconnects: number
}

/** A hand-driven feed factory: nothing is sent and nothing is scheduled. */
function feedFactory() {
  const feeds: Feed[] = []
  const factory = (options: ProtectSubscriptionOptions): ProtectSubscription => {
    let state: SubscriptionState = 'idle'
    const feed: Feed = { onStateChange: options.onStateChange, starts: 0, stops: 0, reconnects: 0 }
    const move = (next: SubscriptionState): void => {
      state = next
      options.onStateChange?.(next)
    }
    feeds.push(feed)
    return {
      start() {
        feed.starts += 1
        move('connecting')
      },
      stop() {
        feed.stops += 1
        move('stopped')
        return Promise.resolve()
      },
      reconnectNow() {
        feed.reconnects += 1
      },
      get state() {
        return state
      },
    }
  }
  return { factory, feeds }
}

interface SetupOptions {
  readonly mode?: AppMode
  readonly connectOnLaunch?: boolean
  readonly rtspStreams?: readonly { readonly id: string; readonly name: string }[]
}

/** Two RTSP streams, stored out of name order (RTSP-3 sorts them). */
const PORCH = { id: 'rtsp-11111111-1111-4111-8111-111111111111', name: 'porch' }
const GARDEN = { id: 'rtsp-22222222-2222-4222-8222-222222222222', name: 'Garden' }

/**
 * Access on with a token and a linked door, Protect pinned with a key: everything is in place for
 * every path to send something, so only the mode can be what stops it.
 */
function setup(options: SetupOptions = {}) {
  let current: Config = ConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: options.mode ?? 'protect',
    console: ConsoleConfigSchema.parse({
      host: '192.0.2.10',
      accessEnabled: true,
      certFingerprint: FP,
      connectOnLaunch: options.connectOnLaunch ?? false,
    }),
    doorLinks: { 'cam-1': FRONT },
    rtsp: { streams: options.rtspStreams ?? [] },
  })
  const pinned = new Set([PROTECT])

  const protect = {
    metaInfo: vi.fn(() => Promise.resolve({ applicationVersion: '7.3.74' })),
    cameras: vi.fn(() => Promise.resolve([camera('cam-1'), camera('cam-2')])),
    snapshot: vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1]), contentType: 'image/jpeg' }),
    ),
    rtspsStreams: vi.fn(() => Promise.resolve({ high: null, medium: null, low: null })),
  }
  const access = {
    doors: vi.fn(() => Promise.resolve([door(FRONT)] as never)),
    unlock: vi.fn(() => Promise.resolve()),
    lockRule: vi.fn(() => Promise.resolve({ type: '', endedTime: null })),
    setLockRule: vi.fn(() => Promise.resolve()),
    emergencyStatus: vi.fn(() => Promise.resolve({ lockdown: false, evacuation: false })),
    setEmergencyStatus: vi.fn(() => Promise.resolve()),
  }
  const resolveProtect = vi.fn(() => protect)
  const resolveAccess = vi.fn(() => access)

  const services: ConnectionServices = {
    config: {
      update: vi.fn((mutate: (latest: Config) => Config) =>
        Promise.resolve(ConfigSchema.parse(mutate(structuredClone(current)))),
      ),
    },
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    credentials: { protectApiKey: 'vp-test-api-key', accessToken: 'vp-test-access-token' },
    pins: {
      pinnedFingerprint: vi.fn((host: string, port: number) =>
        pinned.has(hostPortKey(host, port)) ? FP : null,
      ),
      agentFor: vi.fn(() => ({}) as never),
      invalidate: vi.fn(),
      closeAll: vi.fn(() => Promise.resolve()),
    },
    limiter: createRateLimiter(),
    protect: resolveProtect,
    access: resolveAccess,
  }

  const doorSockets: { handlers: DoorNotificationHandlers; stops: number }[] = []
  const openDoorNotifications = vi.fn((handlers: DoorNotificationHandlers) => {
    const socket = { handlers, stops: 0 }
    doorSockets.push(socket)
    return {
      stop: () => {
        socket.stops += 1
      },
      reconnectNow: () => undefined,
    }
  })
  const unlockLog = {
    append: vi.fn<(attempt: UnlockAttempt) => Promise<void>>(() => Promise.resolve()),
  }
  const devices = feedFactory()
  const events = feedFactory()
  const emitted: { channel: string; payload: unknown }[] = []

  const manager = createConnectionManager({
    services,
    emit: (channel, payload) => {
      emitted.push({ channel, payload })
    },
    createDevices: devices.factory,
    createEvents: events.factory,
    unlockLog,
    openDoorNotifications,
  })

  /** Every request either client could make, Protect's and Access's. */
  const requests = (): number =>
    [...Object.values(protect), ...Object.values(access)].reduce(
      (sum, fn) => sum + fn.mock.calls.length,
      0,
    )

  return {
    manager,
    services,
    protect,
    access,
    resolveProtect,
    resolveAccess,
    devices,
    events,
    doorSockets,
    openDoorNotifications,
    unlockLog,
    emitted,
    requests,
    setMode(mode: AppMode) {
      current = { ...current, mode }
    },
    setRtspStreams(streams: readonly { readonly id: string; readonly name: string }[]) {
      current = { ...current, rtsp: { ...current.rtsp, streams: [...streams] } }
    },
    payloads(channel: string): unknown[] {
      return emitted.filter((e) => e.channel === channel).map((e) => e.payload)
    },
  }
}

const tick = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)

/** The `kind` a rejected call would reach the renderer with (`toIpcError`, as the handlers do). */
async function rejectionKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return toIpcError(err).kind
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('in RTSP mode, no Protect or Access call of any kind (MODE-4)', () => {
  it('refuses the user`s Protect calls with bad-request and sends nothing', async () => {
    const h = setup({ mode: 'rtsp' })
    expect(await rejectionKind(h.manager.connect())).toBe('bad-request')
    expect(await rejectionKind(h.manager.testConnection())).toBe('bad-request')
    expect(await rejectionKind(h.manager.snapshot({ cameraId: 'cam-1', highQuality: false }))).toBe(
      'bad-request',
    )
    expect(await rejectionKind(h.manager.streamQualities('cam-1'))).toBe('bad-request')
    // The camera list is the configured streams (none here), with no request (RTSP-3).
    await expect(h.manager.cameras()).resolves.toEqual([])
    expect(h.requests()).toBe(0)
    expect(h.resolveProtect).not.toHaveBeenCalled()
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.devices.feeds).toHaveLength(0)
    expect(h.events.feeds).toHaveLength(0)
  })

  it('never connects on launch, even when CON-4`s rule would', async () => {
    const h = setup({ mode: 'rtsp', connectOnLaunch: true })
    await h.manager.connectOnLaunch()
    expect(h.requests()).toBe(0)
    expect(h.devices.feeds).toHaveLength(0)
    expect(h.events.feeds).toHaveLength(0)
  })

  it('refuses every door-changing call without an Access call, and logs each attempt', async () => {
    const h = setup({ mode: 'rtsp' })
    const unlock = await h.manager.unlockDoor('cam-1')
    const action = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    const emergency = await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    for (const result of [unlock, action, emergency]) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.kind).toBe('bad-request')
      expect(result.error.retryable).toBe(false)
      expect(result.error.message).toContain('RTSP streams mode')
    }
    expect(h.requests()).toBe(0)
    expect(h.resolveAccess).not.toHaveBeenCalled()
    // DOOR-5: logged like DOOR-0's refusal — each was a press on a door control.
    expect(h.unlockLog.append).toHaveBeenCalledTimes(3)
    for (const [attempt] of h.unlockLog.append.mock.calls) {
      expect(attempt).toMatchObject({ result: 'failure', errorKind: 'bad-request' })
    }
    // The unlock still names the linked door it was about.
    expect(h.unlockLog.append.mock.calls[0]?.[0]).toMatchObject({
      action: 'unlock',
      doorId: FRONT,
    })
  })

  it('answers the watchers with empty states and never starts the door-state monitor', async () => {
    const h = setup({ mode: 'rtsp' })
    expect(h.manager.watchDoors(true)).toEqual({ ok: true, value: {} })
    const screen = h.manager.watchDoorsScreen(true)
    expect(screen.ok).toBe(true)
    if (!screen.ok) return
    const state: DoorsScreenState = screen.value
    // Nothing known — the empty state — with the reason nothing is read.
    expect({ ...state, error: null }).toEqual(emptyDoorsScreenState())
    expect(state.error).toMatchObject({ kind: 'bad-request', retryable: false })
    // Nothing anyone else can do starts it either.
    h.manager.accessInputsChanged('the door links were saved', { trustChanged: true })
    h.manager.accessPollingChanged()
    h.manager.recover('resume')
    h.manager.recover('network')
    await tick(DOOR_MONITOR_AUTH_RETRY_MS * 2)
    expect(h.requests()).toBe(0)
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.openDoorNotifications).not.toHaveBeenCalled()
    expect(h.devices.feeds).toHaveLength(0)
  })

  it('reports a never-connected status, not an error', () => {
    const h = setup({ mode: 'rtsp' })
    const status = h.manager.status()
    expect(status.protect).toMatchObject({ phase: 'idle', error: null })
    expect(status.access).toMatchObject({ phase: 'idle', error: null })
  })
})

describe('switching to RTSP mode (MODE-4)', () => {
  /** Protect connected with both feeds open, and the door monitor running with its socket. */
  async function running() {
    const h = setup()
    await h.manager.connect()
    h.devices.feeds[0]?.onStateChange?.('open')
    h.manager.watchDoors(true)
    h.manager.watchDoorsScreen(true)
    await tick(TRIGGER_COALESCE_MS)
    expect(h.manager.cachedCameras()).toHaveLength(2)
    expect(h.manager.status().protect.phase).toBe('connected')
    expect(h.doorSockets).toHaveLength(1)
    return h
  }

  it('closes both feeds and the door monitor, and empties the inventory', async () => {
    const h = await running()
    h.emitted.length = 0
    h.setMode('rtsp')
    await h.manager.modeChanged()
    expect(h.devices.feeds[0]?.stops).toBe(1)
    expect(h.events.feeds[0]?.stops).toBe(1)
    expect(h.doorSockets[0]?.stops).toBe(1)
    expect(h.manager.cachedCameras()).toEqual([])
    // The renderer drops the inventory and sees a never-connected status.
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([[]])
    expect(h.payloads(IPC_EVENTS.connection.channel).at(-1)).toMatchObject({
      protect: { phase: 'idle', error: null },
      access: { phase: 'idle', error: null },
    })
    const screen = h.payloads(IPC_EVENTS.doorsScreen.channel).at(-1) as DoorsScreenState
    expect({ ...screen, error: null }).toEqual(emptyDoorsScreenState())
    expect(screen.error?.kind).toBe('bad-request')

    // And nothing is sent afterwards, by any timer.
    const before = h.requests()
    await tick(POLL_WITHOUT_SOCKET_MS * 10)
    h.manager.recover('resume')
    await tick(DOOR_MONITOR_AUTH_RETRY_MS)
    expect(h.requests()).toBe(before)
    expect(h.devices.feeds).toHaveLength(1)
    expect(h.devices.feeds[0]?.reconnects).toBe(0)
    expect(h.doorSockets).toHaveLength(1)
  })

  it('cancels a halted door monitor`s retry timer', async () => {
    const h = setup()
    h.access.doors.mockRejectedValue(new AccessApiError('HTTP 401.', { kind: 'auth' }))
    h.manager.watchDoors(true)
    await tick(0)
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    h.setMode('rtsp')
    await h.manager.modeChanged()
    await tick(DOOR_MONITOR_AUTH_RETRY_MS * 3)
    expect(h.access.doors).toHaveBeenCalledTimes(1)
  })

  it('does not let a camera read in flight refill the inventory', async () => {
    const h = setup()
    let release = (): void => undefined
    h.protect.cameras.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve([camera('cam-1')])
          }
        }),
    )
    const pending = h.manager.cameras()
    h.setMode('rtsp')
    await h.manager.modeChanged()
    release()
    expect(await rejectionKind(pending)).toBe('bad-request')
    expect(h.manager.cachedCameras()).toEqual([])
  })

  it('only pushes the Protect inventory when the mode is Protect (switching back is the caller`s connectOnLaunch)', async () => {
    const h = await running()
    h.emitted.length = 0
    await h.manager.modeChanged()
    expect(h.devices.feeds[0]?.stops).toBe(0)
    expect(h.manager.cachedCameras()).toHaveLength(2)
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([h.manager.cachedCameras()])
    expect(h.payloads(IPC_EVENTS.connection.channel)).toEqual([])
  })

  it('keeps every stored setting: no config write at all', async () => {
    const h = await running()
    const update = vi.mocked(h.services.config.update)
    update.mockClear()
    const before = structuredClone(h.services.current)
    h.setMode('rtsp')
    await h.manager.modeChanged()
    expect(update).not.toHaveBeenCalled()
    expect(h.services.current).toEqual({ ...before, mode: 'rtsp' })
  })
})

describe('the RTSP inventory (RTSP-3)', () => {
  const asCamera = (stream: { id: string; name: string }): Camera => ({
    id: stream.id,
    name: stream.name,
    model: 'RTSP stream',
    state: 'CONNECTED',
    hasMic: false,
    micEnabled: false,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: false,
    hasPackageCamera: false,
  })

  it('is the configured streams in name order, ignoring case, with no request', async () => {
    const h = setup({ mode: 'rtsp', rtspStreams: [PORCH, GARDEN] })
    const expected = [asCamera(GARDEN), asCamera(PORCH)]
    expect(h.manager.cachedCameras()).toEqual(expected)
    await expect(h.manager.cameras()).resolves.toEqual(expected)
    for (const entry of expected) expect(CameraSchema.parse(entry)).toEqual(entry)
    expect(h.requests()).toBe(0)
    expect(h.resolveProtect).not.toHaveBeenCalled()
  })

  it('follows the live config: a stream saved a moment ago is in the next read', () => {
    const h = setup({ mode: 'rtsp', rtspStreams: [PORCH] })
    h.setRtspStreams([PORCH, GARDEN])
    expect(h.manager.cachedCameras().map((c) => c.id)).toEqual([GARDEN.id, PORCH.id])
  })

  it('is pushed by rtspStreamsChanged in RTSP mode, and not at all in Protect mode', () => {
    const h = setup({ mode: 'rtsp', rtspStreams: [PORCH] })
    h.setRtspStreams([PORCH, GARDEN])
    h.manager.rtspStreamsChanged()
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([[asCamera(GARDEN), asCamera(PORCH)]])

    const p = setup({ mode: 'protect', rtspStreams: [PORCH] })
    p.manager.rtspStreamsChanged()
    expect(p.payloads(IPC_EVENTS.cameras.channel)).toEqual([])
    // In Protect mode the streams are not the inventory.
    expect(p.manager.cachedCameras()).toEqual([])
  })

  it('is what a switch to RTSP pushes, in place of the Protect cameras', async () => {
    const h = setup({ rtspStreams: [PORCH, GARDEN] })
    await h.manager.connect()
    expect(h.manager.cachedCameras()).toHaveLength(2)
    h.emitted.length = 0
    h.setMode('rtsp')
    await h.manager.modeChanged()
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([[asCamera(GARDEN), asCamera(PORCH)]])
  })

  it('leaves the renderer at once on a switch back: the Protect inventory (empty) is pushed', async () => {
    const h = setup({ rtspStreams: [PORCH] })
    await h.manager.connect()
    h.setMode('rtsp')
    await h.manager.modeChanged()
    h.emitted.length = 0
    const before = h.requests()
    h.setMode('protect')
    await h.manager.modeChanged()
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([[]])
    expect(h.manager.cachedCameras()).toEqual([])
    // The push is what main holds: nothing is re-read until the next connect.
    expect(h.requests()).toBe(before)
  })
})

describe('switching back to Protect behaves like a launch (MODE-4, CON-4)', () => {
  it('connects when CON-4`s launch rule allows it', async () => {
    const h = setup({ mode: 'rtsp', connectOnLaunch: true })
    await h.manager.connectOnLaunch()
    expect(h.requests()).toBe(0)
    h.setMode('protect')
    await h.manager.modeChanged()
    await h.manager.connectOnLaunch()
    expect(h.protect.cameras).toHaveBeenCalledTimes(1)
    expect(h.devices.feeds).toHaveLength(1)
    expect(h.events.feeds).toHaveLength(1)
    expect(h.manager.cachedCameras()).toHaveLength(2)
  })

  it('sends nothing when the launch rule does not allow it', async () => {
    const h = setup({ mode: 'rtsp', connectOnLaunch: false })
    h.setMode('protect')
    await h.manager.modeChanged()
    await h.manager.connectOnLaunch()
    expect(h.requests()).toBe(0)
    expect(h.devices.feeds).toHaveLength(0)
    // The user's Connect works again.
    await h.manager.connect()
    expect(h.protect.cameras).toHaveBeenCalledTimes(1)
  })
})

describe('a switch to RTSP mode while a request is in flight (MODE-4)', () => {
  /** A Protect read the test answers by hand. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined
    let reject: (err: unknown) => void = () => undefined
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('Test connection makes no Access call and leaves the fresh status alone', async () => {
    const h = setup()
    const meta = deferred<{ applicationVersion: string }>()
    h.protect.metaInfo.mockImplementationOnce(() => meta.promise)
    const pending = h.manager.testConnection()
    h.setMode('rtsp')
    await h.manager.modeChanged()
    // The Protect probe fails after the switch: its error belongs to the mode that was left.
    meta.reject(new Error('socket hang up'))
    expect(await rejectionKind(pending)).toBe('bad-request')
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.manager.status().protect).toMatchObject({ phase: 'idle', error: null, version: null })
    expect(h.manager.status().access).toMatchObject({ phase: 'idle', error: null })
  })

  it('Test connection writes no version onto the fresh status when the probe succeeds late', async () => {
    const h = setup()
    const meta = deferred<{ applicationVersion: string }>()
    h.protect.metaInfo.mockImplementationOnce(() => meta.promise)
    const pending = h.manager.testConnection()
    h.setMode('rtsp')
    await h.manager.modeChanged()
    meta.resolve({ applicationVersion: '7.3.74' })
    expect(await rejectionKind(pending)).toBe('bad-request')
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.manager.status().protect).toMatchObject({ phase: 'idle', version: null })
  })

  it('stops the door monitor and both feeds at once, not after a connect in progress', async () => {
    const h = setup()
    await h.manager.connect()
    h.devices.feeds[0]?.onStateChange?.('open')
    h.manager.watchDoors(true)
    await tick(TRIGGER_COALESCE_MS)
    expect(h.doorSockets).toHaveLength(1)
    // A repeated connect, held in its camera read: `modeChanged` queues behind it.
    const cameras = deferred<Camera[]>()
    h.protect.cameras.mockImplementationOnce(() => cameras.promise)
    const connecting = h.manager.connect()
    await tick(0)
    h.setMode('rtsp')
    const changed = h.manager.modeChanged()
    // Synchronously, before the queue moves.
    expect(h.doorSockets[0]?.stops).toBe(1)
    expect(h.devices.feeds[0]?.stops).toBe(1)
    expect(h.events.feeds[0]?.stops).toBe(1)
    // While the connect still waits, no door is read by any timer.
    const doorReads = h.access.doors.mock.calls.length
    await tick(POLL_WITHOUT_SOCKET_MS * 3)
    await tick(DOOR_MONITOR_AUTH_RETRY_MS)
    expect(h.access.doors.mock.calls.length).toBe(doorReads)
    cameras.resolve([camera('cam-1')])
    expect(await rejectionKind(connecting)).toBe('bad-request')
    await changed
    // Nothing was reopened, and the status is the never-connected one.
    expect(h.devices.feeds).toHaveLength(1)
    expect(h.events.feeds).toHaveLength(1)
    expect(h.manager.cachedCameras()).toEqual([])
    expect(h.manager.status().protect).toMatchObject({ phase: 'idle', error: null })
  })

  it('a connect whose camera read lands after the switch opens no feed and records no error', async () => {
    const h = setup()
    await h.manager.connect()
    h.devices.feeds[0]?.onStateChange?.('open')
    // The events feed stopped by itself (a rejected key): a repeated connect would reopen it.
    h.events.feeds[0]?.onStateChange?.('stopped')
    const cameras = deferred<Camera[]>()
    h.protect.cameras.mockImplementationOnce(() => cameras.promise)
    const connecting = h.manager.connect()
    await tick(0)
    // The mode is saved; `modeChanged` has not been called yet (the gap).
    h.setMode('rtsp')
    cameras.resolve([camera('cam-1')])
    expect(await rejectionKind(connecting)).toBe('bad-request')
    expect(h.events.feeds).toHaveLength(1)
    expect(h.manager.status().protect.error).toBeNull()
  })

  it('a first connect whose camera read lands after the switch is not recorded as a failure', async () => {
    const h = setup()
    const cameras = deferred<Camera[]>()
    h.protect.cameras.mockImplementationOnce(() => cameras.promise)
    const connecting = h.manager.connect()
    await tick(0)
    h.setMode('rtsp')
    cameras.resolve([camera('cam-1')])
    expect(await rejectionKind(connecting)).toBe('bad-request')
    expect(h.devices.feeds).toHaveLength(0)
    expect(h.events.feeds).toHaveLength(0)
    expect(h.manager.status().protect.phase).not.toBe('error')
    expect(h.manager.status().protect.error).toBeNull()
  })
})
