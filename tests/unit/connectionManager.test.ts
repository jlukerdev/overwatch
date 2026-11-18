// P1.5: the connection manager (src/main/connection.ts) — CON-1…5, CAM-1/2/3, R9, R11.
//
// Everything here runs on fakes: a services object the test can edit between calls (as Settings
// does at runtime), a devices subscription the test drives by hand, and a recorded `emit` instead of
// a window. So no test opens a socket, waits out a backoff or needs Electron, and the four things
// that are genuinely hard to get right are asserted directly rather than inferred:
//
//  - the **derived** parts of the status (CON-5): `disabled`, `unconfigured`, `pinned` and
//    `hostPort` are recomputed from the live config on every read, so they cannot go stale;
//  - `GET /v1/cameras` is the authority after every connect and every feed change (R11), and a
//    failed re-read must not take the feed down with it;
//  - CAM-3's split: an offline camera is `unavailable`, a bad key is a real error;
//  - **the pin clearing on a host change** (CON-3). That one is a security rule: a fingerprint the
//    user accepted for one console must never be applied to a different machine.
import {
  CameraEventSchema,
  CameraSchema,
  ConsoleConfigSchema,
  type Camera,
  type CameraEvent,
} from '@shared/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createConnectionManager,
  rtspsAvailability,
  type ConnectionServices,
} from '../../src/main/connection'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'
import { accessEndpoint, protectEndpoint } from '../../src/main/console/endpoints'
import { createRateLimiter } from '../../src/main/net/rateLimiter'
import { ProtectApiError } from '../../src/main/protect/errors'
import type {
  ProtectSubscription,
  ProtectSubscriptionOptions,
  SubscriptionState,
  createDevicesSubscription,
  createEventsSubscription,
} from '../../src/main/protect/subscriptions'
import { PinRequiredError, hostPortKey } from '../../src/main/tls/pinning'
import { createUnlockLog, type UnlockAttempt } from '../../src/main/access/unlockLog'
import { createAccessClient } from '../../src/main/access/client'
import { createAccessMock } from '../../scripts/mock-access/app.ts'
import { SEED_DOORS } from '../../scripts/mock-access/doors.ts'
import { Request as UndiciRequest, Response as UndiciResponse } from 'undici'
import { IPC_EVENTS } from '@shared/ipc'

/** A sanitized, made-up RTSPS URL (no real host or alias). Secret-shaped: it must never get out. */
const RTSPS_URL = 'rtsps://192.0.2.10:7441/AAAAAAAAAAAAAAAA?enableSrtp'

const FP =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'

const API_KEY = 'vp-test-api-key-NEVER-LOG-THIS'
const ACCESS_TOKEN = 'vp-test-access-token-NEVER-LOG-THIS'

function camera(id: string, extra: Partial<Camera> = {}): Camera {
  return CameraSchema.parse({ id, ...extra })
}

/** A feed (devices or events) as a hand-driven fake: nothing is sent and nothing is scheduled. */
type DevicesOptions = Parameters<typeof createDevicesSubscription>[0]
type EventsOptions = Parameters<typeof createEventsSubscription>[0]

interface FeedHandle<Options = DevicesOptions> {
  readonly options: Options
  starts: number
  stops: number
  /** Pushes a `SubscriptionState` as the real subscription would. */
  emitState(next: SubscriptionState): void
}

function createFeedFactory<Options extends ProtectSubscriptionOptions = DevicesOptions>(): {
  factory: (options: Options) => ProtectSubscription
  feeds: FeedHandle<Options>[]
  last(): FeedHandle<Options>
} {
  const feeds: FeedHandle<Options>[] = []
  const factory = (options: Options): ProtectSubscription => {
    let state: SubscriptionState = 'idle'
    const handle: FeedHandle<Options> = {
      options,
      starts: 0,
      stops: 0,
      emitState(next) {
        state = next
        options.onStateChange?.(next)
      },
    }
    const subscription: ProtectSubscription = {
      start() {
        handle.starts += 1
        handle.emitState('connecting')
      },
      stop() {
        handle.stops += 1
        handle.emitState('stopped')
        return Promise.resolve()
      },
      get state() {
        return state
      },
    }
    feeds.push(handle)
    return subscription
  }
  const last = (): FeedHandle<Options> => {
    const feed = feeds.at(-1)
    if (feed === undefined) throw new Error('no subscription has been created')
    return feed
  }
  return { factory, feeds, last }
}

interface SetupOptions {
  readonly host?: string
  readonly accessEnabled?: boolean
  readonly accessBaseUrl?: string | null
  readonly certFingerprint?: string | null
  readonly accessCertFingerprint?: string | null
  readonly apiKey?: string | null
  readonly accessToken?: string | null
  /** `host:port` keys that have an accepted certificate. */
  readonly pinned?: readonly string[]
  readonly cameras?: readonly Camera[]
  /** CON-4's stored launch flag. */
  readonly connectOnLaunch?: boolean
  /** DOOR-2's saved camera → door map. */
  readonly doorLinks?: Record<string, string>
  /** DOOR-5: what the manager appends unlock attempts to. */
  readonly unlockLog?: { append: (attempt: UnlockAttempt) => Promise<void> }
}

function setup(options: SetupOptions = {}) {
  const consoleConfig = ConsoleConfigSchema.parse({
    host: options.host ?? '192.0.2.10',
    accessEnabled: options.accessEnabled ?? false,
    accessBaseUrl: options.accessBaseUrl ?? null,
    certFingerprint: options.certFingerprint ?? null,
    accessCertFingerprint: options.accessCertFingerprint ?? null,
    connectOnLaunch: options.connectOnLaunch ?? false,
  })
  let current: Config = ConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    console: consoleConfig,
    doorLinks: options.doorLinks ?? {},
  })
  const pinned = new Set(options.pinned ?? [])
  let inventory: Camera[] = [...(options.cameras ?? [camera('cam-1'), camera('cam-2')])]

  const emitted: { channel: string; payload: unknown }[] = []
  const logged: string[] = []

  const protect = {
    metaInfo: vi.fn(() => Promise.resolve({ applicationVersion: '7.3.74' })),
    cameras: vi.fn(() => Promise.resolve([...inventory])),
    snapshot: vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }),
    ),
    // Shaped like the real answer, URLs and all, so the QUAL-7 tests can check none get out.
    rtspsStreams: vi.fn(() =>
      Promise.resolve({
        high: RTSPS_URL,
        medium: null,
        low: `${RTSPS_URL}-low`,
      }),
    ),
  }
  const access = {
    doors: vi.fn(() => Promise.resolve([])),
    // DOOR-3: resolves = the console accepted the unlock.
    unlock: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
  }
  const pins = {
    pinnedFingerprint: vi.fn((host: string, port: number) =>
      pinned.has(hostPortKey(host, port)) ? FP : null,
    ),
    agentFor: vi.fn((host: string, port: number) => {
      if (!pinned.has(hostPortKey(host, port))) throw new PinRequiredError(hostPortKey(host, port))
      return {} as never
    }),
    invalidate: vi.fn(),
    closeAll: vi.fn(() => Promise.resolve()),
  }
  // The config store over an in-memory "disk": `update` applies the mutator to what was last
  // written and validates, as the real one does inside its write queue.
  let stored: Config = current
  const update = vi.fn((mutate: (latest: Config) => Config) => {
    stored = ConfigSchema.parse(mutate(structuredClone(stored)))
    return Promise.resolve(stored)
  })

  const services: ConnectionServices = {
    config: { update },
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    credentials: {
      ...(options.apiKey === null ? {} : { protectApiKey: options.apiKey ?? API_KEY }),
      ...(options.accessToken === null ? {} : { accessToken: options.accessToken ?? ACCESS_TOKEN }),
    },
    pins,
    limiter: createRateLimiter(),
    protect: () => protect,
    access: () => access,
  }

  const feeds = createFeedFactory()
  // Always injected: the default is the real events subscription, which would open a socket.
  const events = createFeedFactory<EventsOptions>()
  let clock = 1000
  const manager = createConnectionManager({
    services,
    emit: (channel, payload) => {
      emitted.push({ channel, payload })
    },
    createDevices: feeds.factory,
    createEvents: events.factory,
    now: () => {
      clock += 1
      return clock
    },
    log: (line) => {
      logged.push(line)
    },
    ...(options.unlockLog === undefined ? {} : { unlockLog: options.unlockLog }),
  })

  return {
    manager,
    services,
    protect,
    access,
    pins,
    update,
    /** What the fake store last wrote. */
    get disk() {
      return stored
    },
    feeds,
    events,
    emitted,
    logged,
    /** What the console answers to the next `GET /v1/cameras`. */
    setInventory(next: readonly Camera[]) {
      inventory = [...next]
    },
    payloads(channel: string): unknown[] {
      return emitted.filter((event) => event.channel === channel).map((event) => event.payload)
    },
    get console() {
      return current.console
    },
  }
}

type Harness = ReturnType<typeof setup>

/** Lets the manager's fire-and-forget re-reads (R11) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let h: Harness

beforeEach(() => {
  h = setup()
})

describe('status derivation (CON-5)', () => {
  const cases: {
    name: string
    options: SetupOptions
    protectPhase: string
    accessPhase: string
  }[] = [
    {
      name: 'no console address yet (CON-1)',
      options: { host: '' },
      protectPhase: 'unconfigured',
      accessPhase: 'disabled',
    },
    {
      name: 'an address that cannot be parsed at all',
      options: { host: 'http://192.0.2.10' },
      protectPhase: 'unconfigured',
      accessPhase: 'disabled',
    },
    {
      name: 'an address but no API key (CON-1)',
      options: { apiKey: null },
      protectPhase: 'unconfigured',
      accessPhase: 'disabled',
    },
    {
      name: 'configured and idle: nothing connects at startup (CON-4, R9)',
      options: {},
      protectPhase: 'idle',
      accessPhase: 'disabled',
    },
    {
      name: 'Access on with a token',
      options: { accessEnabled: true },
      protectPhase: 'idle',
      accessPhase: 'idle',
    },
    {
      name: 'Access on without a token',
      options: { accessEnabled: true, accessToken: null },
      protectPhase: 'idle',
      accessPhase: 'unconfigured',
    },
    {
      name: 'Access off, which wins over everything else (DOOR-0)',
      options: { accessEnabled: false, accessToken: ACCESS_TOKEN },
      protectPhase: 'idle',
      accessPhase: 'disabled',
    },
  ]

  for (const { name, options, protectPhase, accessPhase } of cases) {
    it(`reports ${protectPhase}/${accessPhase} for ${name}`, () => {
      const status = setup(options).manager.status()
      expect(status.protect.phase).toBe(protectPhase)
      expect(status.access.phase).toBe(accessPhase)
    })
  }

  it('derives hostPort for both endpoints and null while the address is unusable', () => {
    const ready = setup({ host: 'udm.local:8443', accessEnabled: true }).manager.status()
    expect(ready.protect.hostPort).toBe('udm.local:8443')
    // The Access developer API has its own port, whatever `host` says (SPEC §6).
    expect(ready.access.hostPort).toBe('udm.local:12445')

    const unset = setup({ host: '' }).manager.status()
    expect(unset.protect.hostPort).toBeNull()
    expect(unset.access.hostPort).toBeNull()
  })

  it('reads `pinned` per host:port, not per host (CON-3, P0.4 §4)', () => {
    const status = setup({ accessEnabled: true, pinned: ['192.0.2.10:443'] }).manager.status()
    expect(status.protect.pinned).toBe(true)
    expect(status.access.pinned).toBe(false)
  })

  it('reports credentialStored without ever carrying the value (CON-2, NFR-9)', () => {
    const status = setup({ accessEnabled: true }).manager.status()
    expect(status.protect.credentialStored).toBe(true)
    expect(status.access.credentialStored).toBe(true)
    expect(JSON.stringify(status)).not.toContain(API_KEY)
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN)
  })

  it('follows the live config rather than a snapshot taken at construction', () => {
    expect(h.manager.status().protect.hostPort).toBe('192.0.2.10:443')
    h.services.current = ConfigSchema.parse({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      console: { host: 'udm.local' },
    })
    expect(h.manager.status().protect.hostPort).toBe('udm.local:443')
  })
})

describe('connect (CAM-1/2)', () => {
  it('reads the inventory, emits it, and opens exactly one feed', async () => {
    await h.manager.connect()
    expect(h.protect.cameras).toHaveBeenCalledTimes(1)
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toEqual([[camera('cam-1'), camera('cam-2')]])
    expect(h.feeds.feeds).toHaveLength(1)
    expect(h.feeds.last().starts).toBe(1)
    expect(h.manager.status().protect.phase).toBe('connecting')
    expect(h.manager.cachedCameras()).toEqual([camera('cam-1'), camera('cam-2')])
  })

  it('subscribes to the devices channel of the configured console', async () => {
    await h.manager.connect()
    expect(h.feeds.last().options.url).toBe(
      'wss://192.0.2.10/proxy/protect/integration/v1/subscribe/devices',
    )
  })

  it('is idempotent: a second connect re-reads the inventory instead of opening a socket', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    await h.manager.connect()
    expect(h.protect.cameras).toHaveBeenCalledTimes(2)
    expect(h.feeds.feeds).toHaveLength(1)
    expect(h.manager.status().protect.phase).toBe('connected')
  })

  it('refuses with a not-configured failure while there is no address (CON-1)', async () => {
    const unset = setup({ host: '' })
    await expect(unset.manager.connect()).rejects.toThrow(/No console address/)
    expect(unset.feeds.feeds).toHaveLength(0)
  })

  it('refuses with an auth failure while there is no API key (CON-4)', async () => {
    const noKey = setup({ apiKey: null })
    const err: unknown = await noKey.manager.connect().then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(ProtectApiError)
    expect((err as ProtectApiError).kind).toBe('auth')
    // Nothing was sent: a doomed connect must not spend a permit (R9).
    expect(noKey.protect.cameras).not.toHaveBeenCalled()
  })

  it('reports a failed first read as the status error and opens no feed', async () => {
    h.protect.cameras.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/cameras failed with HTTP 401.', {
        kind: 'auth',
        endpoint: '192.0.2.10:443',
      }),
    )
    await expect(h.manager.connect()).rejects.toThrow(/401/)
    const status = h.manager.status()
    expect(status.protect.phase).toBe('error')
    expect(status.protect.error?.kind).toBe('auth')
    expect(h.feeds.feeds).toHaveLength(0)
  })
})

describe('the devices feed (CAM-2, R11)', () => {
  beforeEach(async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
  })

  it('pushes a camera state change and updates the cached camera', () => {
    h.feeds.last().options.onCameraState({ cameraId: 'cam-2', state: 'DISCONNECTED' })
    expect(h.payloads(IPC_EVENTS.cameraState.channel)).toEqual([
      { cameraId: 'cam-2', state: 'DISCONNECTED' },
    ])
    expect(h.manager.cachedCameras()).toEqual([
      camera('cam-1'),
      camera('cam-2', { state: 'DISCONNECTED' }),
    ])
  })

  it('re-reads GET /v1/cameras when a camera is added or removed', async () => {
    h.setInventory([camera('cam-1')])
    h.feeds.last().options.onInventoryChanged('remove')
    await flush()
    expect(h.protect.cameras).toHaveBeenCalledTimes(2)
    expect(h.manager.cachedCameras()).toEqual([camera('cam-1')])
  })

  it('re-reads GET /v1/cameras after every connect, because the feed sends no initial state', async () => {
    h.feeds.last().options.onConnected?.({ reconnect: true })
    await flush()
    expect(h.protect.cameras).toHaveBeenCalledTimes(2)
    expect(h.payloads(IPC_EVENTS.cameras.channel)).toHaveLength(2)
  })

  it('keeps the subscription alive when a re-read fails, and reports it in the status', async () => {
    h.protect.cameras.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/cameras failed: the console did not answer in time.', {
        kind: 'timeout',
        endpoint: '192.0.2.10:443',
      }),
    )
    h.feeds.last().options.onConnected?.({ reconnect: true })
    await flush()
    const status = h.manager.status()
    expect(status.protect.error?.kind).toBe('timeout')
    // The socket is the only live signal there is: a failed GET must not cost it.
    expect(h.feeds.last().stops).toBe(0)
    expect(status.protect.phase).toBe('connected')
    // And the previous inventory is still there, rather than emptied (CAM-1).
    expect(h.manager.cachedCameras()).toHaveLength(2)
  })

  it('maps the feed states onto the CON-5 phases and emits each one', () => {
    const feed = h.feeds.last()
    feed.emitState('reconnecting')
    expect(h.manager.status().protect.phase).toBe('reconnecting')
    feed.emitState('connecting')
    expect(h.manager.status().protect.phase).toBe('connecting')
    feed.emitState('open')
    expect(h.manager.status().protect.phase).toBe('connected')
    expect(h.payloads(IPC_EVENTS.connection.channel).length).toBeGreaterThanOrEqual(3)
  })

  it('becomes `error` when the feed stops of its own accord after a failure', () => {
    const feed = h.feeds.last()
    feed.options.onError?.(
      new ProtectApiError('The Protect subscription was refused with HTTP 401.', {
        kind: 'auth',
        endpoint: '192.0.2.10:443',
      }),
    )
    feed.emitState('stopped')
    const status = h.manager.status()
    expect(status.protect.phase).toBe('error')
    expect(status.protect.error?.kind).toBe('auth')
  })

  it('forgets a stopped subscription, so the next connect opens a new one', async () => {
    h.feeds.last().emitState('stopped')
    await h.manager.connect()
    expect(h.feeds.feeds).toHaveLength(2)
  })
})

describe('a cleared credential (CON-1/2)', () => {
  it('closes the feed, empties the inventory and reports what the config now derives', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    // What the `clearSecret` handler does before telling the manager: the clients read this object
    // synchronously, so the key is gone by the time anything is emitted.
    delete h.services.credentials.protectApiKey
    await h.manager.credentialCleared()

    expect(h.feeds.last().stops).toBe(1)
    const status = h.manager.status()
    expect(status.protect.phase).toBe('unconfigured')
    expect(status.protect.credentialStored).toBe(false)
    expect(status.protect.version).toBeNull()
    expect(h.manager.cachedCameras()).toEqual([])
    expect(h.payloads(IPC_EVENTS.cameras.channel).at(-1)).toEqual([])
  })

  it('lets a later connect open a new feed once a key is entered again', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    await h.manager.credentialCleared()
    await h.manager.connect()
    expect(h.feeds.feeds).toHaveLength(2)
  })
})

describe('serialization (one at a time)', () => {
  it('opens exactly one feed for two overlapping connects', async () => {
    // Both calls would otherwise read `subscription === null` before either had opened its socket,
    // and the first WebSocket would leak for the life of the process — doubling the events and the
    // inventory re-reads against the R9 budget.
    await Promise.all([h.manager.connect(), h.manager.connect()])
    expect(h.feeds.feeds).toHaveLength(1)
    expect(h.feeds.last().starts).toBe(1)
  })

  it('leaves no feed on the old address when a console change interleaves with a connect', async () => {
    const changing = setup({ certFingerprint: FP, pinned: ['192.0.2.10:443'] })
    const next = { ...changing.console, host: '198.51.100.7' }
    await Promise.all([
      changing.manager.connect(),
      changing.manager.applyConsoleChange(next),
      // A connect that slipped through here used to start a feed against the *pre-save* endpoint,
      // which the save then re-labelled `idle` while `subscription !== null` kept anything from
      // ever replacing it.
    ])
    for (const feed of changing.feeds.feeds) {
      if (feed.options.url.includes('192.0.2.10')) expect(feed.stops).toBe(1)
    }
    expect(changing.services.current.console.host).toBe('198.51.100.7')
    expect(changing.manager.status().protect.phase).toBe('idle')
  })

  it('keeps each caller`s own result when one of them fails', async () => {
    h.protect.cameras.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/cameras failed with HTTP 401.', { kind: 'auth' }),
    )
    const settled = await Promise.allSettled([h.manager.connect(), h.manager.connect()])
    // A failed call must not poison the queue for the one behind it.
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled'])
  })
})

describe('testConnection (CON-4)', () => {
  it('probes both halves and records Protect`s version', async () => {
    const enabled = setup({ accessEnabled: true, cameras: [] })
    enabled.access.doors.mockResolvedValueOnce([])
    const result = await enabled.manager.testConnection()
    expect(result.protect).toEqual({ state: 'ok', applicationVersion: '7.3.74' })
    expect(result.access).toEqual({ state: 'ok', doorCount: 0 })
    expect(result.connection.protect.version).toBe('7.3.74')
  })

  it('makes no Access call at all while Access is off (DOOR-0)', async () => {
    const result = await h.manager.testConnection()
    expect(result.access).toEqual({ state: 'disabled' })
    expect(h.access.doors).not.toHaveBeenCalled()
  })

  it('reports each half independently: a good key with a bad token is a normal answer', async () => {
    const enabled = setup({ accessEnabled: true })
    const { AccessApiError } = await import('../../src/main/access/client')
    enabled.access.doors.mockRejectedValueOnce(
      new AccessApiError('GET /doors failed with HTTP 401 CODE_AUTH_FAILED.', {
        kind: 'auth',
        status: 401,
        endpoint: '192.0.2.10:12445',
      }),
    )
    const result = await enabled.manager.testConnection()
    expect(result.protect.state).toBe('ok')
    expect(result.access).toMatchObject({ state: 'error', error: { kind: 'auth' } })
    expect(result.connection.access.phase).toBe('error')
    // The Protect half is untouched by the Access failure.
    expect(result.connection.protect.phase).toBe('idle')
  })

  it('does not overwrite a live feed phase with a failed probe', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    h.protect.metaInfo.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/meta/info failed: connect ECONNREFUSED.', {
        kind: 'network',
        endpoint: '192.0.2.10:443',
      }),
    )
    const result = await h.manager.testConnection()
    expect(result.protect.state).toBe('error')
    expect(result.connection.protect.phase).toBe('connected')
  })
})

describe('doors (DOOR-1, P5.3)', () => {
  const door = {
    id: 'door-1',
    name: 'Front Door',
    fullName: 'Ground Floor - Front Door',
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay: 'lock' as const,
    position: null,
  }

  it('makes no Access call at all while Access is off, and says disabled (DOOR-0)', async () => {
    const access = vi.fn(() => h.access)
    h.services.access = access
    const result = await h.manager.doors()
    expect(result).toMatchObject({ ok: false, error: { kind: 'disabled' } })
    // Not even the client is resolved, let alone asked.
    expect(access).not.toHaveBeenCalled()
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.manager.status().access.phase).toBe('disabled')
  })

  it('answers the doors and marks Access connected, as the probe does', async () => {
    const enabled = setup({ accessEnabled: true })
    enabled.access.doors.mockResolvedValueOnce([door] as never)
    await expect(enabled.manager.doors()).resolves.toEqual({ ok: true, value: [door] })
    expect(enabled.access.doors).toHaveBeenCalledTimes(1)
    expect(enabled.manager.status().access).toMatchObject({ phase: 'connected', error: null })
    // The indicator learns of it at once, without waiting for an unrelated push.
    const pushed = enabled.payloads(IPC_EVENTS.connection.channel).at(-1)
    expect(pushed).toMatchObject({ access: { phase: 'connected' } })
  })

  it('answers the same mapped error it records in the status, endpoint included', async () => {
    const enabled = setup({ accessEnabled: true })
    const { AccessApiError } = await import('../../src/main/access/client')
    enabled.access.doors.mockRejectedValueOnce(
      new AccessApiError('GET /doors failed with HTTP 401 CODE_AUTH_FAILED.', {
        kind: 'auth',
        status: 401,
      }),
    )
    const result = await enabled.manager.doors()
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'auth', endpoint: '192.0.2.10:12445' },
    })
    const status = enabled.manager.status().access
    expect(status.phase).toBe('error')
    expect(!result.ok && result.error).toEqual(status.error)
    const pushed = enabled.payloads(IPC_EVENTS.connection.channel).at(-1)
    expect(pushed).toMatchObject({ access: { phase: 'error' } })
  })

  // Each failure family, mapped to the kind the door-link card gives its hint for.
  const cases: { why: string; kind: string; err: () => Promise<unknown> }[] = [
    {
      why: 'an unpinned Access endpoint',
      kind: 'pin-required',
      err: async () => {
        const { AccessApiError } = await import('../../src/main/access/client')
        return new AccessApiError('pin', {
          kind: 'pin',
          cause: new PinRequiredError('192.0.2.10:12445'),
        })
      },
    },
    {
      why: 'a token without the door scopes',
      kind: 'auth',
      err: async () => {
        const { AccessApiError } = await import('../../src/main/access/client')
        return new AccessApiError('GET /doors failed with HTTP 403.', { kind: 'forbidden' })
      },
    },
    {
      why: 'a console that is down',
      kind: 'network',
      err: async () => {
        const { AccessApiError } = await import('../../src/main/access/client')
        return new AccessApiError('GET /doors failed: ECONNREFUSED.', { kind: 'network' })
      },
    },
  ]
  for (const { why, kind, err } of cases) {
    it(`maps ${why} to ${kind}`, async () => {
      const enabled = setup({ accessEnabled: true })
      enabled.access.doors.mockRejectedValueOnce(await err())
      const result = await enabled.manager.doors()
      expect(result).toMatchObject({ ok: false, error: { kind } })
    })
  }

  it('maps an address that does not resolve to not-configured', async () => {
    const enabled = setup({ accessEnabled: true })
    const { ConsoleEndpointError } = await import('../../src/main/console/endpoints')
    enabled.services.access = () => {
      throw new ConsoleEndpointError('No console address is set yet.')
    }
    const result = await enabled.manager.doors()
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-configured' } })
    expect(enabled.manager.status().access.error).toMatchObject({ kind: 'not-configured' })
  })

  it('leaves the status alone when the console changes while the read is in flight', async () => {
    const enabled = setup({ accessEnabled: true })
    const { AccessApiError } = await import('../../src/main/access/client')
    let fail = (): void => undefined
    enabled.access.doors.mockImplementationOnce(
      () =>
        new Promise<never[]>((_resolve, reject) => {
          fail = () => {
            reject(new AccessApiError('GET /doors failed with HTTP 401.', { kind: 'auth' }))
          }
        }),
    )
    const pending = enabled.manager.doors()
    await enabled.manager.applyConsoleChange({ ...enabled.console, host: '192.0.2.20' })
    fail()
    // The caller still hears how its read went…
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'auth' } })
    // …but the new console's indicator does not inherit the old one's failure.
    expect(enabled.manager.status().access).toMatchObject({ phase: 'idle', error: null })
  })

  it('drops a stale success the same way, and so does Test connection', async () => {
    const enabled = setup({ accessEnabled: true })
    let answer = (): void => undefined
    enabled.access.doors.mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          answer = () => {
            resolve([])
          }
        }),
    )
    const pending = enabled.manager.testConnection()
    // Let the Protect half finish so the Access read is the one in flight.
    await flush()
    await enabled.manager.applyConsoleChange({
      ...enabled.console,
      accessBaseUrl: null,
      host: 'udm.local',
    })
    answer()
    const result = await pending
    expect(result.access).toEqual({ state: 'ok', doorCount: 0 })
    expect(enabled.manager.status().access.phase).toBe('idle')
  })
})

describe('snapshot (CAM-3, R11)', () => {
  beforeEach(async () => {
    h = setup({
      cameras: [
        camera('hd', { supportsFullHdSnapshot: true }),
        camera('sd'),
        camera('bell', { hasPackageCamera: true }),
        camera('hdbell', { hasPackageCamera: true, supportsFullHdSnapshot: true }),
      ],
    })
    await h.manager.cameras()
  })

  it('returns the bytes as they arrived, with no data URL and no stream URL', async () => {
    const result = await h.manager.snapshot({ cameraId: 'sd', highQuality: false })
    expect(result).toMatchObject({ state: 'ok', mimeType: 'image/jpeg' })
    expect(result.state === 'ok' && result.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sends highQuality only for a camera whose flag is set (SPEC §5.1)', async () => {
    await h.manager.snapshot({ cameraId: 'hd', highQuality: true })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('hd', { highQuality: true })
  })

  it('drops highQuality for a camera without the flag, and says so in the log', async () => {
    await h.manager.snapshot({ cameraId: 'sd', highQuality: true })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('sd', {})
    expect(h.logged.join('\n')).toMatch(/dropped highQuality/)
  })

  const unavailable: { name: string; error: ProtectApiError }[] = [
    {
      name: 'the documented 503 for an offline camera',
      error: new ProtectApiError('GET /v1/cameras/{id}/snapshot failed with HTTP 503.', {
        kind: 'unavailable',
      }),
    },
    {
      name: 'anything else at all, because the 503 path is unverified (R11)',
      error: new ProtectApiError('GET /v1/cameras/{id}/snapshot failed: socket hang up.', {
        kind: 'network',
      }),
    },
    {
      name: 'a 404 for a camera that has been removed',
      error: new ProtectApiError('GET /v1/cameras/{id}/snapshot failed with HTTP 404.', {
        kind: 'not-found',
      }),
    },
  ]

  for (const { name, error } of unavailable) {
    it(`reports ${name} as unavailable, not as an error`, async () => {
      h.protect.snapshot.mockRejectedValueOnce(error)
      const result = await h.manager.snapshot({ cameraId: 'sd', highQuality: false })
      expect(result).toEqual({ state: 'unavailable', reason: error.message })
    })
  }

  const reported: { name: string; error: Error }[] = [
    {
      name: 'an expired key',
      error: new ProtectApiError('GET /v1/cameras/{id}/snapshot failed with HTTP 401.', {
        kind: 'auth',
      }),
    },
    {
      name: 'a console whose certificate has not been accepted',
      error: new PinRequiredError('192.0.2.10:443'),
    },
    {
      name: 'the rate limit, which is about the app and not the camera (R9)',
      error: new ProtectApiError('GET /v1/cameras/{id}/snapshot failed with HTTP 429.', {
        kind: 'rate-limit',
      }),
    },
  ]

  for (const { name, error } of reported) {
    it(`reports ${name} as a real error, because that is Settings' business`, async () => {
      h.protect.snapshot.mockRejectedValueOnce(error)
      await expect(h.manager.snapshot({ cameraId: 'sd', highQuality: false })).rejects.toBe(error)
    })
  }

  it('asks for no highQuality for a camera the inventory does not know yet', async () => {
    await h.manager.snapshot({ cameraId: 'unknown', highQuality: true })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('unknown', {})
  })

  it('sends channel=package only for a camera with a package camera (CAM-4)', async () => {
    await h.manager.snapshot({ cameraId: 'bell', highQuality: false, channel: 'package' })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('bell', { channel: 'package' })
  })

  it('answers unavailable for channel=package on a camera without one, fetching nothing', async () => {
    const result = await h.manager.snapshot({
      cameraId: 'sd',
      highQuality: false,
      channel: 'package',
    })
    expect(result).toEqual({ state: 'unavailable', reason: expect.any(String) as string })
    // Not the main channel's image under a package label.
    expect(h.protect.snapshot).not.toHaveBeenCalled()
    expect(h.logged.join('\n')).toMatch(/refused channel=package/)
  })

  it('answers unavailable for channel=package on a camera the inventory does not know', async () => {
    const result = await h.manager.snapshot({
      cameraId: 'unknown',
      highQuality: false,
      channel: 'package',
    })
    expect(result.state).toBe('unavailable')
    expect(h.protect.snapshot).not.toHaveBeenCalled()
  })

  it('never sends the main channel explicitly: it is the default', async () => {
    await h.manager.snapshot({ cameraId: 'bell', highQuality: false, channel: 'main' })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('bell', {})
  })

  it('judges highQuality and the package channel separately', async () => {
    await h.manager.snapshot({ cameraId: 'bell', highQuality: true, channel: 'package' })
    // `bell` has no supportsFullHdSnapshot, so only the channel goes.
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('bell', { channel: 'package' })
    await h.manager.snapshot({ cameraId: 'hdbell', highQuality: true, channel: 'package' })
    expect(h.protect.snapshot).toHaveBeenLastCalledWith('hdbell', {
      highQuality: true,
      channel: 'package',
    })
  })
})

describe('streamQualities (QUAL-7)', () => {
  it('answers which qualities exist as booleans, and nothing that carries a URL (CON-2)', async () => {
    const result = await h.manager.streamQualities('cam-1')
    expect(result).toEqual({ high: true, medium: false, low: true, package: false })
    expect(JSON.stringify(result)).not.toContain('rtsps')
    expect(h.protect.rtspsStreams).toHaveBeenCalledWith('cam-1')
  })

  it('rejects with the client failure, for the handler to turn into a value', async () => {
    const error = new ProtectApiError('GET /v1/cameras/{id}/rtsps-stream failed with HTTP 401.', {
      kind: 'auth',
    })
    h.protect.rtspsStreams.mockRejectedValueOnce(error)
    await expect(h.manager.streamQualities('cam-1')).rejects.toBe(error)
  })
})

describe('rtspsAvailability (QUAL-7)', () => {
  it('counts a URL as present and null, a missing key or junk as absent (R8)', () => {
    expect(
      rtspsAvailability({ high: RTSPS_URL, medium: null, package: `${RTSPS_URL}-pkg` }),
    ).toEqual({ high: true, medium: false, low: false, package: true })
  })
})

describe('applyConsoleChange (CON-1/3, DOOR-0)', () => {
  function nextConsole(h: Harness, patch: Partial<ReturnType<typeof ConsoleConfigSchema.parse>>) {
    return { ...h.console, ...patch }
  }

  beforeEach(() => {
    h = setup({
      accessEnabled: true,
      certFingerprint: FP,
      accessCertFingerprint: FP,
      pinned: ['192.0.2.10:443', '192.0.2.10:12445'],
    })
  })

  it('clears both pins when the console host changes (CON-3)', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { host: '198.51.100.7' }))
    // The security rule: a fingerprint accepted for one console must not be applied to another.
    expect(h.console.certFingerprint).toBeNull()
    expect(h.console.accessCertFingerprint).toBeNull()
    expect(h.console.host).toBe('198.51.100.7')
  })

  it('keeps both pins when nothing about either endpoint moved', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { accessEnabled: false }))
    expect(h.console.certFingerprint).toBe(FP)
    expect(h.console.accessCertFingerprint).toBe(FP)
  })

  it('clears only the Access pin when only the Access endpoint moved', async () => {
    await h.manager.applyConsoleChange(
      nextConsole(h, { accessBaseUrl: 'https://192.0.2.10/proxy/access/api/v1/developer' }),
    )
    expect(h.console.certFingerprint).toBe(FP)
    expect(h.console.accessCertFingerprint).toBeNull()
  })

  it('clears the Protect pin when only its port changed, because a pin is per host:port', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { host: '192.0.2.10:8443' }))
    expect(h.console.certFingerprint).toBeNull()
    // Access keeps its own: `accessBaseUrl` is null, so it still resolves to 12445 on the same host.
    expect(h.console.accessCertFingerprint).toBe(FP)
  })

  it('clears a pin when the address becomes unusable, so the next one cannot inherit it', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { host: '' }))
    expect(h.console.certFingerprint).toBeNull()
    expect(h.console.accessCertFingerprint).toBeNull()
  })

  it('closes the feed and invalidates the old pinned Agents before switching', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    const before = {
      protect: protectEndpoint(h.console),
      access: accessEndpoint(h.console),
    }
    await h.manager.applyConsoleChange(nextConsole(h, { host: '198.51.100.7' }))
    expect(h.feeds.last().stops).toBe(1)
    expect(h.pins.invalidate).toHaveBeenCalledWith(before.protect.host, before.protect.port)
    expect(h.pins.invalidate).toHaveBeenCalledWith(before.access.host, before.access.port)
    // Back to idle for the new console: nothing has been asked of it yet (CON-4).
    expect(h.manager.status().protect.phase).toBe('idle')
    expect(h.manager.status().protect.pinned).toBe(false)
  })

  it('empties the inventory when the Protect endpoint moved', async () => {
    await h.manager.connect()
    expect(h.manager.cachedCameras()).toHaveLength(2)
    await h.manager.applyConsoleChange(nextConsole(h, { host: '198.51.100.7' }))
    // The ids belong to the console that has just been left: a snapshot taken from a stale list
    // would send one of them to the new host.
    expect(h.manager.cachedCameras()).toEqual([])
    expect(h.payloads(IPC_EVENTS.cameras.channel).at(-1)).toEqual([])
  })

  it('keeps the inventory when only the Access endpoint moved', async () => {
    await h.manager.connect()
    await h.manager.applyConsoleChange(
      nextConsole(h, { accessBaseUrl: 'https://192.0.2.10/proxy/access/api/v1/developer' }),
    )
    // The inventory comes from Protect alone, so every id is still valid.
    expect(h.manager.cachedCameras()).toHaveLength(2)
  })

  it('persists the change and makes it the live config', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { host: 'udm.local' }))
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.disk.console.host).toBe('udm.local')
    expect(h.services.current.console.host).toBe('udm.local')
    expect(h.manager.status().protect.hostPort).toBe('udm.local:443')
  })

  it('emits the new status, so the indicator updates from the save', async () => {
    await h.manager.applyConsoleChange(nextConsole(h, { host: 'udm.local' }))
    expect(h.payloads(IPC_EVENTS.connection.channel).length).toBeGreaterThan(0)
  })
})

describe('the connect-on-launch flag (CON-4)', () => {
  /** Opens the devices feed, as a connect that worked does. */
  async function connectAndOpen(harness: Harness): Promise<void> {
    await harness.manager.connect()
    harness.feeds.last().emitState('open')
    await flush()
  }

  /** How many config writes there were. Nothing else in these tests writes the config. */
  function flagWrites(harness: Harness): number {
    return harness.update.mock.calls.length
  }

  it('is set once the devices feed opens, in memory and on disk', async () => {
    await h.manager.connect()
    // A connect that has only read the inventory has not shown the socket works yet.
    expect(h.console.connectOnLaunch).toBe(false)
    h.feeds.last().emitState('open')
    await flush()
    expect(h.console.connectOnLaunch).toBe(true)
    expect(h.disk.console.connectOnLaunch).toBe(true)
    expect(flagWrites(h)).toBe(1)
  })

  it('is written once, not on every reconnect', async () => {
    await connectAndOpen(h)
    const feed = h.feeds.last()
    for (let i = 0; i < 3; i++) {
      feed.emitState('reconnecting')
      feed.emitState('open')
    }
    await h.manager.connect()
    await flush()
    expect(flagWrites(h)).toBe(1)
    expect(h.disk.console.connectOnLaunch).toBe(true)
  })

  it('leaves the rest of the stored config alone', async () => {
    h = setup({ certFingerprint: FP, pinned: ['192.0.2.10:443'] })
    await connectAndOpen(h)
    expect(h.disk.console.certFingerprint).toBe(FP)
    expect(h.disk.console.host).toBe('192.0.2.10')
  })

  it('writes nothing on a key change when it was already off', async () => {
    await h.manager.credentialReplaced()
    await flush()
    expect(flagWrites(h)).toBe(0)
  })

  it('is cleared when the Protect key is cleared', async () => {
    await connectAndOpen(h)
    delete h.services.credentials.protectApiKey
    await h.manager.credentialCleared()
    await flush()
    expect(h.disk.console.connectOnLaunch).toBe(false)
  })

  it('is cleared when the Protect endpoint moves, in the same write as the pin', async () => {
    h = setup({ connectOnLaunch: true, certFingerprint: FP, pinned: ['192.0.2.10:443'] })
    await h.manager.applyConsoleChange({ ...h.console, host: '198.51.100.7' })
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.disk.console.connectOnLaunch).toBe(false)
    expect(h.console.connectOnLaunch).toBe(false)
  })

  it('survives an Access-only change', async () => {
    h = setup({ connectOnLaunch: true, accessEnabled: true })
    await h.manager.applyConsoleChange({
      ...h.console,
      accessBaseUrl: 'https://192.0.2.10/proxy/access/api/v1/developer',
    })
    expect(h.disk.console.connectOnLaunch).toBe(true)
    expect(h.console.connectOnLaunch).toBe(true)
  })

  it('survives a feed error, a reconnect and the feed stopping by itself', async () => {
    await connectAndOpen(h)
    const feed = h.feeds.last()
    feed.options.onError?.(
      new ProtectApiError('WebSocket upgrade failed with HTTP 401.', {
        kind: 'auth',
        endpoint: '192.0.2.10:443',
      }),
    )
    feed.emitState('reconnecting')
    feed.emitState('stopped')
    await flush()
    expect(h.disk.console.connectOnLaunch).toBe(true)
    expect(flagWrites(h)).toBe(1)
  })

  it('survives a failed connect', async () => {
    h = setup({ connectOnLaunch: true })
    h.protect.cameras.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(h.manager.connect()).rejects.toThrow()
    await flush()
    expect(h.console.connectOnLaunch).toBe(true)
    expect(flagWrites(h)).toBe(0)
  })

  it('survives shutdown: quitting does not clear it', async () => {
    await connectAndOpen(h)
    await h.manager.shutdown()
    await flush()
    expect(h.disk.console.connectOnLaunch).toBe(true)
    expect(flagWrites(h)).toBe(1)
  })

  it('logs a failed write and keeps the session going', async () => {
    h.update.mockRejectedValueOnce(new Error('EACCES'))
    await connectAndOpen(h)
    expect(h.manager.status().protect.phase).toBe('connected')
    expect(h.logged.some((line) => line.includes('could not save'))).toBe(true)
  })

  it('puts memory back after a failed write, so the next change retries it', async () => {
    await connectAndOpen(h)
    h.update.mockRejectedValueOnce(new Error('EACCES'))
    await h.manager.credentialReplaced()
    await flush()
    // The disk still says true, so memory must too — or the next key change would skip the write.
    expect(h.console.connectOnLaunch).toBe(true)
    await h.manager.credentialReplaced()
    await flush()
    expect(h.disk.console.connectOnLaunch).toBe(false)
  })

  it('is cleared when a different Protect key is stored, and set again once it opens', async () => {
    await connectAndOpen(h)
    await h.manager.credentialReplaced()
    await flush()
    expect(h.disk.console.connectOnLaunch).toBe(false)
    await connectAndOpen(h)
    expect(h.disk.console.connectOnLaunch).toBe(true)
  })

  it('ignores an `open` from a feed that is no longer the live one', async () => {
    await h.manager.connect()
    const stale = h.feeds.last()
    delete h.services.credentials.protectApiKey
    await h.manager.credentialCleared()
    stale.emitState('open')
    await flush()
    expect(h.console.connectOnLaunch).toBe(false)
    expect(flagWrites(h)).toBe(0)
  })
})

describe('connectOnLaunch (CON-4)', () => {
  const READY = { connectOnLaunch: true, certFingerprint: FP, pinned: ['192.0.2.10:443'] }

  it('connects when the flag, the key, the pin and the endpoint are all there', async () => {
    h = setup(READY)
    await h.manager.connectOnLaunch()
    expect(h.protect.cameras).toHaveBeenCalledTimes(1)
    expect(h.feeds.feeds).toHaveLength(1)
    expect(h.events.feeds).toHaveLength(1)
    expect(h.manager.status().protect.phase).toBe('connecting')
  })

  const skips: { name: string; options: SetupOptions }[] = [
    { name: 'the flag is off', options: { ...READY, connectOnLaunch: false } },
    { name: 'there is no console address', options: { ...READY, host: '' } },
    { name: 'the address cannot be parsed', options: { ...READY, host: 'http://192.0.2.10' } },
    { name: 'no Protect key is stored', options: { ...READY, apiKey: null } },
    { name: 'the Protect endpoint is not pinned', options: { ...READY, pinned: [] } },
  ]
  for (const { name, options } of skips) {
    it(`sends nothing when ${name}`, async () => {
      h = setup(options)
      await h.manager.connectOnLaunch()
      expect(h.protect.cameras).not.toHaveBeenCalled()
      expect(h.feeds.feeds).toHaveLength(0)
      expect(h.events.feeds).toHaveLength(0)
      expect(h.payloads(IPC_EVENTS.connection.channel)).toEqual([])
    })
  }

  it('swallows a failure and leaves it in the status like a failed connect', async () => {
    h = setup(READY)
    h.protect.cameras.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/cameras failed with HTTP 401.', {
        kind: 'auth',
        endpoint: '192.0.2.10:443',
      }),
    )
    await expect(h.manager.connectOnLaunch()).resolves.toBeUndefined()
    const status = h.manager.status()
    expect(status.protect.phase).toBe('error')
    expect(status.protect.error?.kind).toBe('auth')
    expect(h.feeds.feeds).toHaveLength(0)
    // An outage at launch is not the user saying stop.
    expect(h.console.connectOnLaunch).toBe(true)
    // Safe lines only (CON-2, NFR-9).
    for (const line of h.logged) expect(line).not.toContain(API_KEY)
    expect(h.logged.some((line) => line.startsWith('connect on launch: failed (auth)'))).toBe(true)
  })

  it('is serialized with the other operations: no second socket from an overlapping connect', async () => {
    h = setup(READY)
    await Promise.all([h.manager.connectOnLaunch(), h.manager.connect()])
    expect(h.feeds.feeds).toHaveLength(1)
    expect(h.events.feeds).toHaveLength(1)
  })
})

describe('shutdown', () => {
  it('stops the feed and closes every pinned Agent', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    await h.manager.shutdown()
    expect(h.feeds.last().stops).toBe(1)
    expect(h.pins.closeAll).toHaveBeenCalledTimes(1)
  })
})

describe('the events feed (CELL-2, P4.2)', () => {
  const EVENT: CameraEvent = CameraEventSchema.parse({
    id: 'evt-1',
    cameraId: 'cam-1',
    trigger: 'smartDetect',
    protectType: 'smartDetectZone',
    start: 1_700_000_000_000,
    smartDetectTypes: ['person'],
  })

  const authFailure = (): ProtectApiError =>
    new ProtectApiError('The Protect subscription was refused with HTTP 401.', {
      kind: 'auth',
      endpoint: '192.0.2.10:443',
    })

  it('opens alongside the devices feed, on the events channel of the same console', async () => {
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(1)
    expect(h.events.last().starts).toBe(1)
    expect(h.events.last().options.url).toBe(
      'wss://192.0.2.10/proxy/protect/integration/v1/subscribe/events',
    )
    // The same shared limiter as the REST client and the devices feed (R9).
    expect(h.events.last().options.limiter).toBe(h.services.limiter)
    // The key is read per upgrade, never captured (CON-1).
    expect(h.events.last().options.apiKey()).toBe(API_KEY)
  })

  it('opens nothing when the first inventory read fails', async () => {
    h.protect.cameras.mockRejectedValueOnce(authFailure())
    await expect(h.manager.connect()).rejects.toThrow(/401/)
    expect(h.events.feeds).toHaveLength(0)
  })

  it('pushes every mapped event, repeats included, and logs none of them', async () => {
    await h.manager.connect()
    const linesBefore = h.logged.length
    const closing = { ...EVENT, end: 1_700_000_005_000 }
    h.events.last().options.onEvent(EVENT)
    h.events.last().options.onEvent(closing)
    // The closing update is repeated by the console; the scheduler dedupes on (id, end).
    h.events.last().options.onEvent(closing)
    expect(h.payloads(IPC_EVENTS.cameraEvent.channel)).toEqual([EVENT, closing, closing])
    for (const payload of h.payloads(IPC_EVENTS.cameraEvent.channel)) {
      expect(IPC_EVENTS.cameraEvent.payload.safeParse(payload).success).toBe(true)
    }
    expect(h.logged.length).toBe(linesBefore)
  })

  it('never changes the Protect status, whatever the events feed does', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    const before = h.manager.status().protect
    const statusEvents = h.payloads(IPC_EVENTS.connection.channel).length

    const feed = h.events.last()
    feed.emitState('reconnecting')
    feed.options.onError?.(authFailure())
    feed.emitState('stopped')

    const after = h.manager.status().protect
    expect(after.phase).toBe('connected')
    expect(after.error).toBeNull()
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(h.payloads(IPC_EVENTS.connection.channel)).toHaveLength(statusEvents)
    // The devices feed is left alone too.
    expect(h.feeds.last().stops).toBe(0)
  })

  it('reopens an events feed that stopped by itself on a repeated connect', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    h.events.last().emitState('stopped')
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(2)
    expect(h.events.last().starts).toBe(1)
    // The devices feed was up throughout, so it is not reopened.
    expect(h.feeds.feeds).toHaveLength(1)
  })

  it('opens no second events socket on a repeated connect while it is up', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    h.events.last().emitState('open')
    await h.manager.connect()
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(1)
    expect(h.events.last().starts).toBe(1)
  })

  it('opens one events feed for two overlapping connects', async () => {
    await Promise.all([h.manager.connect(), h.manager.connect()])
    expect(h.events.feeds).toHaveLength(1)
  })

  it('is stopped with the devices feed when that stops by itself, and a connect opens both fresh', async () => {
    await h.manager.connect()
    h.events.last().emitState('open')
    // A rejected key or pin: the devices feed stops for good on its own.
    h.feeds.last().options.onError?.(authFailure())
    h.feeds.last().emitState('stopped')
    expect(h.events.last().stops).toBe(1)
    expect(h.manager.status().protect.phase).toBe('error')

    await h.manager.connect()
    expect(h.feeds.feeds).toHaveLength(2)
    expect(h.events.feeds).toHaveLength(2)
    expect(h.events.last().starts).toBe(1)
    expect(h.events.last().stops).toBe(0)
  })

  it('a late `stopped` from the events feed stopped with the devices feed spares a newer one', async () => {
    await h.manager.connect()
    const first = h.events.last()
    h.feeds.last().emitState('stopped')
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(2)
    // The old socket reports `stopped` again, late: the new handle must survive it.
    first.emitState('stopped')
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(2)
    expect(h.events.last().stops).toBe(0)
  })

  it('reopens a stopped events feed on a repeated connect even when the re-read fails', async () => {
    await h.manager.connect()
    h.feeds.last().emitState('open')
    h.events.last().emitState('stopped')
    h.protect.cameras.mockRejectedValueOnce(authFailure())
    await expect(h.manager.connect()).rejects.toThrow(/401/)
    // The devices socket is up, so the console is reachable: the events feed comes back anyway.
    expect(h.events.feeds).toHaveLength(2)
    expect(h.events.last().starts).toBe(1)
    expect(h.feeds.feeds).toHaveLength(1)
    // The failure is still reported, without taking the live phase down.
    expect(h.manager.status().protect.phase).toBe('connected')
    expect(h.manager.status().protect.error?.kind).toBe('auth')
  })

  const stoppers: { name: string; run: (harness: Harness) => Promise<void> }[] = [
    {
      name: 'credentialCleared',
      run: async (harness) => {
        delete harness.services.credentials.protectApiKey
        await harness.manager.credentialCleared()
      },
    },
    {
      name: 'applyConsoleChange',
      run: (harness) =>
        harness.manager.applyConsoleChange({ ...harness.console, host: '198.51.100.7' }),
    },
    { name: 'shutdown', run: (harness) => harness.manager.shutdown() },
  ]

  for (const { name, run } of stoppers) {
    it(`is stopped by ${name}, and a later connect opens a fresh one`, async () => {
      await h.manager.connect()
      h.events.last().emitState('open')
      await run(h)
      expect(h.events.last().stops).toBe(1)
      if (name === 'shutdown') return
      if (name === 'credentialCleared') h.services.credentials.protectApiKey = API_KEY
      await h.manager.connect()
      expect(h.events.feeds).toHaveLength(2)
      expect(h.events.feeds[0]?.stops).toBe(1)
    })
  }

  it('a stop we asked for does not forget a feed opened after it', async () => {
    await h.manager.connect()
    const first = h.events.last()
    delete h.services.credentials.protectApiKey
    await h.manager.credentialCleared()
    h.services.credentials.protectApiKey = API_KEY
    await h.manager.connect()
    // A late `stopped` from the old socket must not drop the new handle.
    first.emitState('stopped')
    await h.manager.connect()
    expect(h.events.feeds).toHaveLength(2)
  })
})

describe('unlockDoor (DOOR-3/4/5, P5.4)', () => {
  const FRONT_DOOR_ID = 'door-front'

  /** A harness with Access on, the doorbell `cam-bell` linked, and the unlock log recorded. */
  function unlockSetup(options: SetupOptions = {}) {
    const attempts: UnlockAttempt[] = []
    const harness = setup({
      accessEnabled: true,
      cameras: [
        camera('cam-bell', { name: 'Front Doorbell', hasPackageCamera: true }),
        camera('cam-2'),
      ],
      doorLinks: { 'cam-bell': FRONT_DOOR_ID },
      unlockLog: {
        append: (attempt) => {
          attempts.push(attempt)
          return Promise.resolve()
        },
      },
      ...options,
    })
    return { ...harness, attempts }
  }

  it('makes exactly one PUT for the linked door, answers the camera name and logs success', async () => {
    const u = unlockSetup()
    await u.manager.cameras() // the inventory the name comes from
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: FRONT_DOOR_ID,
        cameraName: 'Front Doorbell',
        outcome: 'unlocked',
        reason: null,
      },
    })
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
    expect(u.access.unlock).toHaveBeenCalledWith(FRONT_DOOR_ID)
    expect(u.attempts).toEqual([
      {
        cameraRef: 'cam-bell',
        cameraName: 'Front Doorbell',
        doorId: FRONT_DOOR_ID,
        result: 'success',
        errorKind: null,
        message: null,
      },
    ])
    expect(u.manager.status().access).toMatchObject({ phase: 'connected', error: null })
    expect(u.payloads(IPC_EVENTS.connection.channel).at(-1)).toMatchObject({
      access: { phase: 'connected' },
    })
  })

  it("resolves a doorbell's package ref through the doorbell's link (DOOR-2)", async () => {
    const u = unlockSetup()
    await u.manager.cameras()
    const result = await u.manager.unlockDoor('cam-bell:package')
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: FRONT_DOOR_ID,
        cameraName: 'Front Doorbell',
        outcome: 'unlocked',
        reason: null,
      },
    })
    expect(u.access.unlock).toHaveBeenCalledExactlyOnceWith(FRONT_DOOR_ID)
    expect(u.attempts[0]).toMatchObject({ cameraRef: 'cam-bell:package', doorId: FRONT_DOOR_ID })
  })

  it('falls back to the camera id for the name when the inventory does not have it', async () => {
    const u = unlockSetup()
    // No `cameras()` read: main's inventory is still empty.
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toEqual({
      ok: true,
      value: { doorId: FRONT_DOOR_ID, cameraName: 'cam-bell', outcome: 'unlocked', reason: null },
    })
  })

  it('answers not-found for an unlinked camera, with no Access call, and logs it', async () => {
    const u = unlockSetup()
    const access = vi.fn(() => u.access)
    u.services.access = access
    const result = await u.manager.unlockDoor('cam-2')
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
    expect(access).not.toHaveBeenCalled()
    expect(u.access.unlock).not.toHaveBeenCalled()
    expect(u.attempts).toEqual([
      expect.objectContaining({
        cameraRef: 'cam-2',
        doorId: null,
        result: 'failure',
        errorKind: 'not-found',
      }),
    ])
    // A missing link says nothing about the endpoint.
    expect(u.manager.status().access.phase).toBe('idle')
  })

  it('never takes a door id from anywhere but the saved links', async () => {
    const u = unlockSetup()
    // A ref that *is* a door id is still just an unlinked camera ref.
    const result = await u.manager.unlockDoor(FRONT_DOOR_ID)
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(u.access.unlock).not.toHaveBeenCalled()
  })

  it('answers disabled while Access is off, with no Access call, and logs it (DOOR-0)', async () => {
    const u = unlockSetup({ accessEnabled: false })
    const access = vi.fn(() => u.access)
    u.services.access = access
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toMatchObject({ ok: false, error: { kind: 'disabled', retryable: false } })
    expect(access).not.toHaveBeenCalled()
    expect(u.access.unlock).not.toHaveBeenCalled()
    expect(u.attempts).toEqual([
      expect.objectContaining({ doorId: FRONT_DOOR_ID, result: 'failure', errorKind: 'disabled' }),
    ])
    expect(u.manager.status().access.phase).toBe('disabled')
  })

  /** An `AccessApiError` as the client builds it for a thrown connection failure (`cause` kept). */
  async function connectError(kind: 'network' | 'timeout', message: string, code?: string) {
    const { AccessApiError } = await import('../../src/main/access/client')
    const root = Object.assign(new Error(message), code === undefined ? {} : { code })
    const fetchFailed = new TypeError('fetch failed', { cause: root })
    return new AccessApiError(`PUT /doors/door-front/unlock failed: ${message}.`, {
      kind,
      endpoint: '192.0.2.10:12445',
      cause: fetchFailed,
    })
  }

  it('reports a never-connected failure (ECONNREFUSED) as a failure, not retryable, one PUT', async () => {
    const u = unlockSetup()
    const err = await connectError('network', 'connect ECONNREFUSED', 'ECONNREFUSED')
    // The client itself would call this retryable — for the reads.
    expect(err.retryable).toBe(true)
    u.access.unlock.mockRejectedValueOnce(err)
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'network', retryable: false, endpoint: '192.0.2.10:12445' },
    })
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
    expect(u.attempts).toEqual([
      expect.objectContaining({
        result: 'failure',
        errorKind: 'network',
        message: 'PUT /doors/door-front/unlock failed: connect ECONNREFUSED.',
      }),
    ])
    // An endpoint failure: the badge says so, as `doors()` would.
    expect(u.manager.status().access.phase).toBe('error')
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'treats %s as never sent: a plain failure',
    async (code) => {
      const u = unlockSetup()
      u.access.unlock.mockRejectedValueOnce(await connectError('network', `oops ${code}`, code))
      const result = await u.manager.unlockDoor('cam-bell')
      expect(result).toMatchObject({ ok: false, error: { kind: 'network', retryable: false } })
      expect(u.attempts[0]).toMatchObject({ result: 'failure' })
    },
  )

  it('answers ok with outcome unknown on a timeout, logs unknown, one PUT (user decision 2026-11-18)', async () => {
    const u = unlockSetup()
    await u.manager.cameras()
    const err = await connectError('timeout', 'the Access API did not answer in time')
    u.access.unlock.mockRejectedValueOnce(err)
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: FRONT_DOOR_ID,
        cameraName: 'Front Doorbell',
        outcome: 'unknown',
        reason: err.message,
      },
    })
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
    expect(u.attempts).toEqual([
      {
        cameraRef: 'cam-bell',
        cameraName: 'Front Doorbell',
        doorId: FRONT_DOOR_ID,
        result: 'unknown',
        errorKind: 'timeout',
        message: err.message,
      },
    ])
    // The status reads as it would for that failure kind.
    expect(u.manager.status().access).toMatchObject({ phase: 'error', error: { kind: 'timeout' } })
    await flush()
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
  })

  it('answers outcome unknown for a connection lost after connecting (ECONNRESET)', async () => {
    const u = unlockSetup()
    u.access.unlock.mockRejectedValueOnce(
      await connectError('network', 'read ECONNRESET', 'ECONNRESET'),
    )
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toMatchObject({ ok: true, value: { outcome: 'unknown' } })
    expect(u.attempts[0]).toMatchObject({ result: 'unknown', errorKind: 'network' })
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'finds no door for the ref %s (own links only), with no Access call',
    async (ref) => {
      const u = unlockSetup()
      const access = vi.fn(() => u.access)
      u.services.access = access
      const result = await u.manager.unlockDoor(ref)
      expect(result).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
      expect(access).not.toHaveBeenCalled()
      expect(u.access.unlock).not.toHaveBeenCalled()
      expect(u.attempts[0]).toMatchObject({ doorId: null, errorKind: 'not-found' })
    },
  )

  it('answers disabled while Access is off even for an unlinked camera (DOOR-0 first)', async () => {
    const u = unlockSetup({ accessEnabled: false })
    const access = vi.fn(() => u.access)
    u.services.access = access
    const result = await u.manager.unlockDoor('cam-2')
    expect(result).toMatchObject({ ok: false, error: { kind: 'disabled', retryable: false } })
    expect(access).not.toHaveBeenCalled()
    expect(u.attempts).toEqual([
      expect.objectContaining({ doorId: null, result: 'failure', errorKind: 'disabled' }),
    ])
  })

  it('splits a package ref with the shared camera-ref grammar (`:package` alone is no camera)', async () => {
    const u = unlockSetup({ doorLinks: { ':package': FRONT_DOOR_ID } })
    // `parseCameraRef(':package')` is the plain id `:package`, as in the renderer.
    const result = await u.manager.unlockDoor(':package')
    expect(result).toMatchObject({ ok: true, value: { doorId: FRONT_DOOR_ID } })
    expect(u.attempts[0]).toMatchObject({ cameraRef: ':package', cameraName: ':package' })
  })

  it('answers without waiting for the log write, and logs in the order attempts ended (DOOR-5)', async () => {
    const lines: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const unlockLog = createUnlockLog({
      dir: '/nonexistent/logs',
      fs: {
        mkdir: () => gate.then(() => undefined),
        stat: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
        rename: () => Promise.resolve(),
        appendFile: (_path, data) => {
          lines.push(data)
          return Promise.resolve()
        },
      },
    })
    const u = unlockSetup({ unlockLog })
    // A stalled disk: neither answer waits for it.
    await expect(u.manager.unlockDoor('cam-bell')).resolves.toMatchObject({ ok: true })
    await expect(u.manager.unlockDoor('cam-2')).resolves.toMatchObject({ ok: false })
    expect(lines).toEqual([])
    release()
    await unlockLog.flushed()
    expect(lines.map((line) => (JSON.parse(line) as { cameraRef: string }).cameraRef)).toEqual([
      'cam-bell',
      'cam-2',
    ])
  })

  it('maps a missing endpoint address to not-configured without throwing', async () => {
    const u = unlockSetup()
    const { ConsoleEndpointError } = await import('../../src/main/console/endpoints')
    u.services.access = () => {
      throw new ConsoleEndpointError('No console address is set yet.')
    }
    const result = await u.manager.unlockDoor('cam-bell')
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-configured', retryable: false } })
    expect(u.attempts[0]).toMatchObject({ result: 'failure', errorKind: 'not-configured' })
  })

  it('keeps the unlock answer when the log write fails, and reports the write (DOOR-5)', async () => {
    // The real log over an fs whose every append fails: the door did open, so the answer must
    // still say so — a reported failure would invite a second press, a second door release.
    const reported: string[] = []
    const unlockLog = createUnlockLog({
      dir: '/nonexistent/logs',
      fs: {
        mkdir: () => Promise.resolve(undefined),
        stat: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
        rename: () => Promise.resolve(),
        appendFile: () => Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
      },
      onError: (message) => {
        reported.push(message)
      },
    })
    const u = unlockSetup({ unlockLog })
    await expect(u.manager.unlockDoor('cam-bell')).resolves.toEqual({
      ok: true,
      value: { doorId: FRONT_DOOR_ID, cameraName: 'cam-bell', outcome: 'unlocked', reason: null },
    })
    expect(u.access.unlock).toHaveBeenCalledTimes(1)
    // The answer did not wait for the write; the failure is reported once the queue drains.
    await unlockLog.flushed()
    expect(reported).toEqual([expect.stringContaining('ENOSPC')])
  })

  it('leaves a replaced endpoint’s status alone when the unlock finishes after the change', async () => {
    const u = unlockSetup()
    let release!: () => void
    u.access.unlock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const pending = u.manager.unlockDoor('cam-bell')
    await u.manager.applyConsoleChange({ ...u.console, host: '192.0.2.20' })
    release()
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(u.manager.status().access.phase).toBe('idle')
    expect(u.attempts).toHaveLength(1)
  })

  // Through the real client and the P0.4 mock, so the PUT, the envelope and the error mapping are
  // the ones the app would see (no sockets: the mock is reached through an injected fetch).
  describe('against the Access mock', () => {
    const TOKEN = 'vp-test-access-token-NEVER-LOG-THIS'
    const FRONT = SEED_DOORS.find((d) => d.name === 'Front Door')
    const STORAGE = SEED_DOORS.find((d) => d.name === 'Storage Room')
    if (FRONT === undefined || STORAGE === undefined || STORAGE.is_bind_hub) {
      throw new Error('the P0.4 seed doors changed; update this test')
    }

    function mocked(doorId: string) {
      const mock = createAccessMock({ token: TOKEN })
      const sent: string[] = []
      const fetchImpl = vi.fn(async (input: unknown, init: unknown) => {
        const request = new UndiciRequest(input as string, init as never)
        const url = new URL(request.url)
        sent.push(`${request.method} ${url.pathname}`)
        const headers: Record<string, string | undefined> = {}
        for (const [name, value] of request.headers) headers[name] = value
        const res = mock.handle({
          method: request.method,
          url: `${url.pathname}${url.search}`,
          headers,
          body: await request.text(),
        })
        return new UndiciResponse(JSON.stringify(res.body), {
          status: res.status,
          headers: { 'content-type': 'application/json', ...res.headers },
        })
      })
      const u = unlockSetup({ doorLinks: { 'cam-bell': doorId }, accessToken: TOKEN })
      const client = createAccessClient({
        endpoint: accessEndpoint(u.services.current.console),
        enabled: () => u.services.current.console.accessEnabled,
        token: () => u.services.credentials.accessToken ?? null,
        dispatcher: () => ({}) as never,
        fetchImpl,
      })
      u.services.access = () => client
      return { ...u, mock, sent }
    }

    it('unlocks a hub-bound door with one PUT and the relay goes to unlock', async () => {
      const m = mocked(FRONT.id)
      try {
        const result = await m.manager.unlockDoor('cam-bell')
        expect(result).toEqual({
          ok: true,
          value: { doorId: FRONT.id, cameraName: 'cam-bell', outcome: 'unlocked', reason: null },
        })
        expect(m.sent).toEqual([`PUT /api/v1/developer/doors/${FRONT.id}/unlock`])
        expect(m.mock.store.get(FRONT.id)?.door_lock_relay_status).toBe('unlock')
        expect(m.attempts[0]).toMatchObject({ result: 'success', doorId: FRONT.id })
      } finally {
        m.mock.store.dispose()
      }
    })

    it('reports a door without a hub as a failure, not retryable, logged, with no second PUT', async () => {
      const m = mocked(STORAGE.id)
      try {
        const result = await m.manager.unlockDoor('cam-bell')
        // `forbidden` → the contract's `auth` (src/main/ipc/errors.ts); the message names the hub.
        expect(result).toMatchObject({ ok: false, error: { kind: 'auth', retryable: false } })
        expect(!result.ok && result.error.message).toMatch(/Door Hub/)
        expect(m.sent).toEqual([`PUT /api/v1/developer/doors/${STORAGE.id}/unlock`])
        expect(m.mock.store.get(STORAGE.id)?.door_lock_relay_status).toBe('lock')
        expect(m.attempts).toEqual([
          expect.objectContaining({ result: 'failure', errorKind: 'auth', doorId: STORAGE.id }),
        ])
        // The console answered: a refusal of this one door leaves the endpoint connected.
        expect(m.manager.status().access).toMatchObject({ phase: 'connected', error: null })
        // Nothing scheduled a retry behind the answer either.
        await flush()
        expect(m.sent).toHaveLength(1)
        // The token never reaches the log line.
        expect(JSON.stringify(m.attempts)).not.toContain(TOKEN)
      } finally {
        m.mock.store.dispose()
      }
    })
  })
})
