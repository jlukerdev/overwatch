// P1.3: the two Protect subscription WebSockets (src/main/protect/subscriptions.ts).
//
// Everything runs on a **fake socket and a fake clock**: `webSocketImpl` is a hand-driven stand-in,
// `now`/`sleep`/`random` are injected, and `sleep` is *gated* — it parks the caller until the test
// calls `advance()`, which moves the clock by exactly the requested amount. That makes the backoff
// sequence an assertion on a list of numbers instead of a wait, and it means no test depends on a
// real timer, a real console or undici.
//
// The event mapping is checked against the real sanitized P0.3 capture
// (tests/fixtures/protect/events-ws.motion.json). The types P0.3 never saw (`smartDetectLine`,
// `smartDetectLoiterZone`, `ring`) and every devices message are hand-built from the contract
// shape, which is all there is for them (R11).
import { Agent, type Dispatcher } from 'undici'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectApiError } from '../../src/main/protect/errors'
import type { RateLimiter } from '../../src/main/net/rateLimiter'
import {
  PROTECT_WS_CLOSE_RATE_LIMITED,
  createDevicesSubscription,
  createEventsSubscription,
  motionTriggerFor,
  toCameraEvent,
  toCameraStateChanges,
  type ProtectSubscriptionOptions,
  type ProtectWebSocketCtor,
  type SubscriptionState,
} from '../../src/main/protect/subscriptions'
import type { CameraEvent, CameraStateChange } from '../../src/shared/models'
import eventsWs from '../fixtures/protect/events-ws.motion.json'

const URL_EVENTS = 'wss://192.0.2.10/proxy/protect/integration/v1/subscribe/events'
const URL_DEVICES = 'wss://192.0.2.10/proxy/protect/integration/v1/subscribe/devices'
const API_KEY = 'test-api-key'

/** One shared dispatcher stand-in: identity is all the subscription does with it. */
const dispatcher = new Agent()
afterAll(async () => {
  await dispatcher.close()
})

// --- the fake socket ----------------------------------------------------------------------------

interface FakeInit {
  headers: Record<string, string>
  dispatcher: Dispatcher
}

/**
 * A WebSocket that does nothing until the test tells it to. `open`, `receive`, `serverClose` and
 * `failUpgrade` are the four things a real socket does to us; `close` records what we did to it.
 */
class FakeWebSocket {
  binaryType: 'arraybuffer' | 'blob' = 'blob'
  readyState = 0
  readonly closeCalls: { code: number | undefined; reason: string | undefined }[] = []
  private readonly listeners = new Map<string, ((event: never) => void)[]>()

  readonly url: string
  readonly init: FakeInit

  constructor(url: string, init: FakeInit) {
    this.url = url
    this.init = init
  }

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
  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type)
    if (existing === undefined) this.listeners.set(type, [listener])
    else existing.push(listener)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' })
  }

  // --- the test's handles ---

  open(): void {
    this.readyState = 1
    this.emit('open', undefined)
  }

  receive(data: unknown): void {
    this.emit('message', { data })
  }

  receiveJson(value: unknown): void {
    this.receive(JSON.stringify(value))
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  /** undici reports a refused upgrade as an `error` event and leaves the socket closed. */
  failUpgrade(error: unknown): void {
    this.readyState = 3
    this.emit('error', { error })
  }

  get closed(): boolean {
    return this.readyState === 3
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      ;(listener as (event: unknown) => void)(event)
    }
  }
}

// --- the harness --------------------------------------------------------------------------------

/** Lets every pending microtask and promise continuation run. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** The options every test starts from: the shared ones plus the `onMessage` recorder. */
type HarnessOptions = ProtectSubscriptionOptions & { onMessage: (message: unknown) => void }

interface Harness {
  readonly options: HarnessOptions
  readonly sockets: FakeWebSocket[]
  readonly states: SubscriptionState[]
  readonly errors: ProtectApiError[]
  readonly connects: { reconnect: boolean }[]
  readonly messages: unknown[]
  readonly sleeps: number[]
  readonly penalties: number[]
  readonly logs: string[]
  acquires(): number
  pending(): number
  socket(index: number): FakeWebSocket
  now(): number
  /** Moves the clock without waiting, e.g. to make a connection count as stable. */
  jump(ms: number): void
  /** Flushes, then resolves the oldest gated `sleep`, advancing the clock by its delay. */
  advance(): Promise<void>
  tick(): Promise<void>
}

/**
 * `realSleep` leaves `sleep` out of the options, so the module's own `setTimeout` path runs — the
 * one place a test needs it, to prove `stop()` leaves no timer pending.
 */
function makeHarness(over: Partial<ProtectSubscriptionOptions> = {}, realSleep = false): Harness {
  const sockets: FakeWebSocket[] = []
  const states: SubscriptionState[] = []
  const errors: ProtectApiError[] = []
  const connects: { reconnect: boolean }[] = []
  const messages: unknown[] = []
  const sleeps: number[] = []
  const penalties: number[] = []
  const logs: string[] = []
  // Each gated sleep remembers the absolute moment it is due, so `advance()` moves the clock *to*
  // that moment rather than adding the delay again on top of whatever `jump()` has done since.
  const parked: { ms: number; dueAt: number; resolve: () => void }[] = []
  let clock = 1_700_000_000_000
  let acquires = 0

  const webSocketImpl: ProtectWebSocketCtor = class extends FakeWebSocket {
    constructor(url: string, init: FakeInit) {
      super(url, init)
      sockets.push(this)
    }
  }

  const limiter: RateLimiter = {
    acquire: () => {
      acquires++
      return Promise.resolve()
    },
    run: (fn) => fn(),
    penalize: (ms) => {
      penalties.push(ms)
    },
    get pending() {
      return 0
    },
  }

  const options: HarnessOptions = {
    url: URL_EVENTS,
    apiKey: () => API_KEY,
    dispatcher: () => dispatcher,
    limiter,
    webSocketImpl,
    onStateChange: (state) => states.push(state),
    onError: (err) => errors.push(err),
    onConnected: (attempt) => connects.push(attempt),
    onMessage: (message) => messages.push(message),
    log: (line) => logs.push(line),
    now: () => clock,
    ...(realSleep
      ? {}
      : {
          sleep: (ms: number) =>
            new Promise<void>((resolve) => {
              sleeps.push(ms)
              parked.push({ ms, dueAt: clock + ms, resolve })
            }),
        }),
    // The midpoint, so the jitter term is exactly zero and the sequence is assertable.
    random: () => 0.5,
    ...over,
  }

  return {
    options,
    sockets,
    states,
    errors,
    connects,
    messages,
    sleeps,
    penalties,
    logs,
    acquires: () => acquires,
    pending: () => parked.length,
    socket(index) {
      const ws = sockets[index]
      if (ws === undefined) throw new Error(`no socket #${String(index)} was created`)
      return ws
    },
    now: () => clock,
    jump(ms) {
      clock += ms
    },
    async advance() {
      await tick()
      const next = parked.shift()
      if (next === undefined) throw new Error('advance(): nothing is waiting on sleep()')
      clock = Math.max(clock, next.dueAt)
      next.resolve()
      await tick()
    },
    tick,
  }
}

/** `onMessage` sees it, `onEvent`/`onCameraState` are what the mapping produced. */
function eventsHarness(over: Partial<ProtectSubscriptionOptions> = {}): {
  h: Harness
  events: CameraEvent[]
  sub: ReturnType<typeof createEventsSubscription>
} {
  const h = makeHarness(over)
  const events: CameraEvent[] = []
  const sub = createEventsSubscription({
    ...h.options,
    onEvent: (event) => events.push(event),
  })
  return { h, events, sub }
}

function devicesHarness(over: Partial<ProtectSubscriptionOptions> = {}): {
  h: Harness
  changes: CameraStateChange[]
  inventory: ('add' | 'remove')[]
  sub: ReturnType<typeof createDevicesSubscription>
} {
  const h = makeHarness({ url: URL_DEVICES, ...over })
  const changes: CameraStateChange[] = []
  const inventory: ('add' | 'remove')[] = []
  const sub = createDevicesSubscription({
    ...h.options,
    onCameraState: (change) => changes.push(change),
    onInventoryChanged: (reason) => inventory.push(reason),
  })
  return { h, changes, inventory, sub }
}

/** `{ type, item }` as the events feed sends it. */
function eventMessage(
  type: 'add' | 'update',
  item: Record<string, unknown>,
): { type: string; item: Record<string, unknown> } {
  return { type, item: { id: 'evt-1', modelKey: 'event', start: 1_700_000_000_000, ...item } }
}

/** `{ type, item }` as the devices feed is documented to send it (unverified: R11). */
function deviceMessage(
  type: 'add' | 'update' | 'remove',
  item: Record<string, unknown>,
): { type: string; item: Record<string, unknown> } {
  return { type, item }
}

/** Indexing a fixture array with `noUncheckedIndexedAccess` on, loudly rather than as `undefined`. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`the fixture has no entry #${String(index)}`)
  return value
}

const MOTION_ADD: unknown = eventsWs.motion.add
const MOTION_END: unknown = at(eventsWs.motion.updates, 0)
const SMART_ADD: unknown = at(eventsWs.smartDetect, 0)

const RATE_LIMIT_BODY = {
  error: 'Too many requests',
  name: 'TOO_MANY_REQUESTS_ERROR',
  windowMs: 5000,
  limit: 10,
}

// --- the mappers (pure) -------------------------------------------------------------------------

describe('motionTriggerFor', () => {
  it('maps the event types SPEC §5.1 lists and ignores everything else', () => {
    expect(motionTriggerFor('motion')).toBe('motion')
    expect(motionTriggerFor('smartDetectZone')).toBe('smartDetect')
    expect(motionTriggerFor('smartDetectLine')).toBe('smartDetect')
    expect(motionTriggerFor('smartDetectLoiterZone')).toBe('smartDetect')
    expect(motionTriggerFor('ring')).toBe('ring')
    for (const ignored of [
      'smartDetectAudio',
      'nfcCardScanned',
      'fingerprintIdentified',
      'sensorOpened',
      'alarmHubMotion',
      '',
    ]) {
      expect(motionTriggerFor(ignored)).toBeNull()
    }
  })
})

describe('toCameraEvent', () => {
  it('maps the real P0.3 motion `add`, which omits `end`, to `end: null`', () => {
    const event = toCameraEvent(MOTION_ADD)
    expect(event).toEqual({
      id: 'evt-002',
      cameraId: 'cam-008',
      trigger: 'motion',
      protectType: 'motion',
      start: 1794512657236,
      end: null,
      smartDetectTypes: [],
    })
  })

  it('maps the closing `update` with `end`, and keeps `smartDetectTypes`', () => {
    expect(toCameraEvent(MOTION_END)?.end).toBe(1794512673875)
    const smart = toCameraEvent(SMART_ADD)
    expect(smart).toMatchObject({
      trigger: 'smartDetect',
      protectType: 'smartDetectZone',
      smartDetectTypes: ['person'],
      end: null,
    })
  })

  it('ignores anything that is not a camera trigger, and anything malformed', () => {
    expect(
      toCameraEvent(eventMessage('add', { type: 'nfcCardScanned', device: 'cam-1' })),
    ).toBeNull()
    expect(toCameraEvent(eventMessage('add', { type: 'motion' }))).toBeNull() // no device
    expect(
      toCameraEvent(eventMessage('add', { type: 'motion', device: 'cam-1', start: 'soon' })),
    ).toBeNull()
    expect(toCameraEvent({ type: 'add' })).toBeNull()
    expect(toCameraEvent({ type: 'add', item: [] })).toBeNull()
    expect(toCameraEvent(null)).toBeNull()
    expect(toCameraEvent(42)).toBeNull()
    expect(toCameraEvent('motion')).toBeNull()
  })

  it('drops junk inside `smartDetectTypes` instead of dropping the event', () => {
    const event = toCameraEvent(
      eventMessage('add', {
        type: 'smartDetectZone',
        device: 'cam-1',
        smartDetectTypes: ['person', 7, '', null, 'vehicle'],
      }),
    )
    expect(event?.smartDetectTypes).toEqual(['person', 'vehicle'])
  })
})

describe('toCameraStateChanges', () => {
  it('maps a camera `update` that carries a new state', () => {
    expect(
      toCameraStateChanges(
        deviceMessage('update', { id: 'cam-1', modelKey: 'camera', state: 'DISCONNECTED' }),
      ),
    ).toEqual([{ cameraId: 'cam-1', state: 'DISCONNECTED' }])
  })

  it('fans a bulk item (`id: string[]`) out to one change per camera, de-duplicated', () => {
    expect(
      toCameraStateChanges(
        deviceMessage('update', {
          id: ['cam-1', 'cam-2', 'cam-1', '', 9],
          modelKey: 'camera',
          state: 'CONNECTED',
        }),
      ),
    ).toEqual([
      { cameraId: 'cam-1', state: 'CONNECTED' },
      { cameraId: 'cam-2', state: 'CONNECTED' },
    ])
  })

  it('ignores non-cameras, items without a state, and malformed messages', () => {
    expect(
      toCameraStateChanges(deviceMessage('update', { id: 'nvr-1', modelKey: 'nvr', state: 'x' })),
    ).toEqual([])
    expect(
      toCameraStateChanges(
        deviceMessage('update', { id: 'cam-1', modelKey: 'camera', name: 'Hi' }),
      ),
    ).toEqual([])
    expect(
      toCameraStateChanges(deviceMessage('remove', { id: 'cam-1', modelKey: 'camera' })),
    ).toEqual([])
    expect(toCameraStateChanges({ item: { id: 'cam-1', modelKey: 'camera', state: 7 } })).toEqual(
      [],
    )
    expect(toCameraStateChanges(undefined)).toEqual([])
    expect(toCameraStateChanges([{ id: 'cam-1' }])).toEqual([])
  })
})

// --- connecting ---------------------------------------------------------------------------------

describe('connecting', () => {
  it('takes a rate-limit permit and passes the key header and the dispatcher', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()

    expect(h.acquires()).toBe(1)
    expect(h.sockets).toHaveLength(1)
    const ws = h.socket(0)
    expect(ws.url).toBe(URL_EVENTS)
    expect(ws.init.headers).toEqual({ 'X-API-KEY': API_KEY })
    expect(ws.init.dispatcher).toBe(dispatcher)
    // The key is nowhere else: not in the URL, not in a log line.
    expect(ws.url).not.toContain(API_KEY)
    expect(h.logs.join('\n')).not.toContain(API_KEY)
    expect(sub.state).toBe('connecting')

    ws.open()
    expect(sub.state).toBe('open')
    await sub.stop()
  })

  it('stops with an auth error and never opens a socket when there is no key', async () => {
    const { h, sub } = eventsHarness({ apiKey: () => null })
    sub.start()
    await h.tick()

    expect(h.sockets).toHaveLength(0)
    expect(h.acquires()).toBe(0)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('auth')
    expect(h.errors[0]?.message).not.toContain(API_KEY)
    expect(sub.state).toBe('stopped')
    expect(h.pending()).toBe(0)
    await sub.stop()
  })

  it('treats an empty key the same way', async () => {
    const { h, sub } = eventsHarness({ apiKey: () => '' })
    sub.start()
    await h.tick()
    expect(h.sockets).toHaveLength(0)
    expect(sub.state).toBe('stopped')
    expect(h.errors[0]?.kind).toBe('auth')
    await sub.stop()
  })

  it('fires onConnected with reconnect false, then true', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    expect(h.connects).toEqual([{ reconnect: false }])

    h.socket(0).serverClose(1006, 'gone')
    await h.advance()
    h.socket(1).open()
    expect(h.connects).toEqual([{ reconnect: false }, { reconnect: true }])
    expect(h.acquires()).toBe(2)
    await sub.stop()
  })

  it('stops for good on a 401 upgrade and never reconnects', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).failUpgrade(Object.assign(new Error('non-101 status code'), { status: 401 }))
    await h.tick()

    expect(h.errors.map((e) => e.kind)).toEqual(['auth'])
    expect(h.errors[0]?.status).toBe(401)
    expect(sub.state).toBe('stopped')
    expect(h.pending()).toBe(0)
    expect(h.sockets).toHaveLength(1)
    await sub.stop()
  })

  it('reads a 403 out of the error message when no status is attached', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).failUpgrade(new Error('Unexpected server response: 403'))
    await h.tick()
    expect(h.errors[0]?.kind).toBe('auth')
    expect(sub.state).toBe('stopped')
    await sub.stop()
  })

  it('keeps retrying an upgrade failure that is not auth', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).failUpgrade(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONN' }))
    await h.advance()
    expect(h.errors[0]?.kind).toBe('network')
    expect(h.sockets).toHaveLength(2)
    expect(sub.state).toBe('connecting')
    await sub.stop()
  })
})

// --- the events feed ----------------------------------------------------------------------------

describe('events subscription', () => {
  it('delivers a motion add as `end: null`, its end update, and a repeated end update', async () => {
    const { h, events, sub } = eventsHarness()
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    ws.receiveJson(MOTION_ADD)
    ws.receiveJson(MOTION_END)
    ws.receiveJson(MOTION_END)

    expect(events.map((e) => e.end)).toEqual([null, 1794512673875, 1794512673875])
    expect(events[0]).toMatchObject({ id: 'evt-002', cameraId: 'cam-008', trigger: 'motion' })
    // P4.1 owns the dedupe: the repeat is passed through, not swallowed.
    expect(events[1]).toEqual(events[2])
    expect(h.messages).toHaveLength(3)
    await sub.stop()
  })

  it('maps every smartDetect type and `ring`, and ignores an unrelated type (which still reaches onMessage)', async () => {
    const { h, events, sub } = eventsHarness()
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    for (const type of ['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone', 'ring']) {
      ws.receiveJson(eventMessage('add', { type, device: 'cam-1' }))
    }
    ws.receiveJson(eventMessage('add', { type: 'nfcCardScanned', device: 'cam-1' }))

    expect(events.map((e) => e.trigger)).toEqual([
      'smartDetect',
      'smartDetect',
      'smartDetect',
      'ring',
    ])
    expect(events.map((e) => e.protectType)).toEqual([
      'smartDetectZone',
      'smartDetectLine',
      'smartDetectLoiterZone',
      'ring',
    ])
    expect(h.messages).toHaveLength(5)
    expect(sub.state).toBe('open')
    await sub.stop()
  })

  it('ignores malformed frames without throwing and without killing the socket', async () => {
    const { h, events, sub } = eventsHarness()
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    ws.receive('not json at all {')
    ws.receive(42)
    ws.receiveJson(7)
    ws.receiveJson([1, 2, 3])
    ws.receiveJson({ type: 'add' })
    ws.receiveJson(eventMessage('add', { type: 'motion' })) // no `device`
    expect(events).toEqual([])
    expect(ws.closed).toBe(false)
    expect(sub.state).toBe('open')

    // Still alive and still mapping.
    ws.receiveJson(MOTION_ADD)
    expect(events).toHaveLength(1)
    // Non-JSON frames are logged, not reported as errors; the JSON ones reach onMessage.
    expect(h.errors).toEqual([])
    expect(h.messages).toHaveLength(5)
    await sub.stop()
  })

  it('survives a consumer callback that throws', async () => {
    const h = makeHarness()
    const sub = createEventsSubscription({
      ...h.options,
      onEvent: () => {
        throw new Error('consumer blew up')
      },
    })
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()
    ws.receiveJson(MOTION_ADD)
    expect(ws.closed).toBe(false)
    expect(sub.state).toBe('open')
    expect(h.logs.some((line) => line.includes('consumer blew up'))).toBe(true)
    await sub.stop()
  })
})

// --- the devices feed ---------------------------------------------------------------------------

describe('devices subscription', () => {
  it('reports camera state changes, bulk items, and inventory changes', async () => {
    const { h, changes, inventory, sub } = devicesHarness()
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    ws.receiveJson(
      deviceMessage('update', { id: 'cam-1', modelKey: 'camera', state: 'CONNECTING' }),
    )
    ws.receiveJson(
      deviceMessage('update', {
        id: ['cam-1', 'cam-2'],
        modelKey: 'camera',
        state: 'DISCONNECTED',
      }),
    )
    ws.receiveJson(deviceMessage('add', { id: 'cam-9', modelKey: 'camera', state: 'CONNECTED' }))
    ws.receiveJson(deviceMessage('remove', { id: 'cam-9', modelKey: 'camera' }))
    ws.receiveJson(deviceMessage('update', { id: 'nvr-1', modelKey: 'nvr', state: 'CONNECTED' }))

    expect(changes).toEqual([
      { cameraId: 'cam-1', state: 'CONNECTING' },
      { cameraId: 'cam-1', state: 'DISCONNECTED' },
      { cameraId: 'cam-2', state: 'DISCONNECTED' },
      // An `add` carries a state too, so it is reported as well as the inventory change.
      { cameraId: 'cam-9', state: 'CONNECTED' },
    ])
    expect(inventory).toEqual(['add', 'remove'])
    expect(h.messages).toHaveLength(5)
    expect(ws.closed).toBe(false)
    await sub.stop()
  })

  it('asks the caller to re-read the inventory after every connect (R11)', async () => {
    const { h, sub } = devicesHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).serverClose(1006)
    await h.advance()
    h.socket(1).open()
    expect(h.connects).toEqual([{ reconnect: false }, { reconnect: true }])
    await sub.stop()
  })
})

// --- backoff ------------------------------------------------------------------------------------

describe('reconnect backoff', () => {
  it('follows the configured sequence and caps it', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    for (let attempt = 0; attempt < 8; attempt++) {
      h.socket(attempt).open()
      h.socket(attempt).serverClose(1006, 'gone')
      await h.advance()
    }
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
    expect(h.sockets).toHaveLength(9)
    expect(h.acquires()).toBe(9)
    await sub.stop()
  })

  it('honours a custom backoff and applies jitter within the configured fraction', async () => {
    const randoms = [0, 1, 0.5]
    let index = 0
    const { h, sub } = eventsHarness({
      backoff: { initialMs: 100, factor: 3, maxMs: 10_000, jitter: 0.5 },
      random: () => randoms[index++ % randoms.length] ?? 0.5,
    })
    sub.start()
    await h.tick()
    for (let attempt = 0; attempt < 3; attempt++) {
      h.socket(attempt).serverClose(1006)
      await h.advance()
    }
    // 100 with jitter -1, 300 with jitter +1, 900 with jitter 0.
    expect(h.sleeps).toEqual([50, 450, 900])
    await sub.stop()
  })

  it('resets the backoff only once a connection has stayed open for stableAfterMs', async () => {
    const { h, sub } = eventsHarness({ stableAfterMs: 10_000 })
    sub.start()
    await h.tick()

    // Attempt 1: open, but dies after 9_999 ms — not stable, so the next delay doubles.
    h.socket(0).open()
    h.jump(9_999)
    h.socket(0).serverClose(1006)
    await h.advance()
    h.socket(1).open()
    h.socket(1).serverClose(1006)
    await h.advance()
    expect(h.sleeps).toEqual([1000, 2000])

    // Attempt 3 stays open long enough, so the fourth starts from `initialMs` again.
    h.socket(2).open()
    h.jump(10_000)
    h.socket(2).serverClose(1006)
    await h.advance()
    expect(h.sleeps).toEqual([1000, 2000, 1000])
    await sub.stop()
  })

  it('reports an unexpected close and keeps the subscription alive', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).serverClose(1006, 'abnormal')
    await h.tick()
    expect(h.errors.map((e) => e.kind)).toEqual(['closed'])
    expect(sub.state).toBe('reconnecting')
    expect(h.states).toEqual(['connecting', 'open', 'reconnecting'])
    await sub.stop()
  })
})

// --- the rate-limited upgrade (close 4500) ------------------------------------------------------

describe('a rate-limited upgrade (close 4500)', () => {
  it('penalizes the shared limiter with the 429 windowMs and waits at least that long', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()
    ws.receiveJson(RATE_LIMIT_BODY)
    ws.serverClose(PROTECT_WS_CLOSE_RATE_LIMITED, 'Too many requests')
    await h.tick()

    expect(h.penalties).toEqual([5000])
    const rateLimited = h.errors.find((err) => err.kind === 'rate-limit')
    expect(rateLimited?.apiName).toBe('TOO_MANY_REQUESTS_ERROR')
    expect(rateLimited?.retryAfterMs).toBe(5000)
    // The un-jittered base delay would be 1000 ms; the window is the floor.
    expect(h.sleeps).toEqual([5000])
    expect(h.sleeps.every((ms) => ms >= 5000)).toBe(true)
    await sub.stop()
  })

  it('falls back to the documented 1 s window when the 429 frame never arrives', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).serverClose(PROTECT_WS_CLOSE_RATE_LIMITED, 'Too many requests')
    await h.tick()
    expect(h.penalties).toEqual([1000])
    expect(h.errors.map((e) => e.kind)).toEqual(['rate-limit'])
    await sub.stop()
  })

  it('does not let a 4500 count as a stable connection', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    for (let attempt = 0; attempt < 2; attempt++) {
      h.socket(attempt).open()
      h.socket(attempt).receiveJson(RATE_LIMIT_BODY)
      h.socket(attempt).serverClose(PROTECT_WS_CLOSE_RATE_LIMITED)
      await h.advance()
    }
    // Base delays 1000 then 2000, both floored by the 5 s window.
    expect(h.sleeps).toEqual([5000, 5000])
    expect(h.penalties).toEqual([5000, 5000])
    await sub.stop()
  })
})

// --- the idle timeout ---------------------------------------------------------------------------

describe('idleTimeoutMs', () => {
  it('is off by default: a silent socket is left alone', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.jump(10 * 60_000)
    await h.tick()
    expect(h.pending()).toBe(0)
    expect(h.sleeps).toEqual([])
    expect(h.socket(0).closed).toBe(false)
    expect(sub.state).toBe('open')
    await sub.stop()
  })

  it('closes and reconnects a silent socket when it is set', async () => {
    const { h, sub } = eventsHarness({ idleTimeoutMs: 30_000 })
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    // A frame 20 s in moves the deadline, so the watcher re-parks instead of closing.
    h.jump(20_000)
    ws.receiveJson(MOTION_ADD)
    await h.advance()
    expect(ws.closed).toBe(false)
    expect(h.sleeps).toEqual([30_000, 20_000])

    // Nothing arrives in the next window, so the socket is assumed dead.
    await h.advance()
    expect(ws.closed).toBe(true)
    expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'idle' }])
    expect(h.errors.map((e) => e.kind)).toEqual(['timeout'])
    await h.advance()
    expect(h.sockets).toHaveLength(2)
    await sub.stop()
  })

  it('keeps a busy socket alive however many frames arrive', async () => {
    // Regression: the watcher's "the clock is not advancing" guard used to count every re-park, so
    // a healthy socket was force-closed after that many frames and reported as a timeout — on a
    // 30 s window, about 50 minutes into a busy evening.
    const { h, sub } = eventsHarness({ idleTimeoutMs: 30_000 })
    sub.start()
    await h.tick()
    const ws = h.socket(0)
    ws.open()

    for (let i = 0; i < 250; i++) {
      h.jump(20_000)
      ws.receiveJson(MOTION_ADD)
      await h.advance()
      expect(ws.closed).toBe(false)
    }
    expect(h.errors).toEqual([])
    expect(h.sockets).toHaveLength(1)
    expect(sub.state).toBe('open')
    await sub.stop()
  })
})

// --- stop() -------------------------------------------------------------------------------------

describe('stop()', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }

  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
    return () => {
      process.off('unhandledRejection', onRejection)
      expect(rejections).toEqual([])
    }
  })

  it('is safe from idle, and is idempotent', async () => {
    const { sub } = eventsHarness()
    await sub.stop()
    await sub.stop()
    expect(sub.state).toBe('stopped')
    // A later start() does not revive it.
    sub.start()
    await tick()
    expect(sub.state).toBe('stopped')
  })

  it('is safe while connecting', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    expect(sub.state).toBe('connecting')
    await sub.stop()
    expect(sub.state).toBe('stopped')
    expect(h.socket(0).closeCalls).toEqual([{ code: 1000, reason: 'stopped' }])
    await h.tick()
    expect(h.sockets).toHaveLength(1)
    expect(h.pending()).toBe(0)
  })

  it('is safe while open and closes with 1000 without reporting an error', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    await sub.stop()
    expect(h.socket(0).closeCalls).toEqual([{ code: 1000, reason: 'stopped' }])
    expect(h.errors).toEqual([])
    await h.tick()
    expect(h.sockets).toHaveLength(1)
  })

  it('is safe while waiting in backoff and leaves no timer behind', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).serverClose(1006)
    await h.tick()
    expect(sub.state).toBe('reconnecting')
    expect(h.pending()).toBe(1)

    await sub.stop()
    expect(sub.state).toBe('stopped')
    await h.tick()
    // The gated sleep is abandoned, not awaited: no further connect happens.
    expect(h.sockets).toHaveLength(1)
  })

  it('does not leave a real timer pending when the default sleep is used', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeHarness({}, true)
      const sub = createEventsSubscription({ ...h.options, onEvent: () => undefined })
      sub.start()
      await h.tick()
      h.socket(0).open()
      h.socket(0).serverClose(1006)
      await h.tick()
      expect(vi.getTimerCount()).toBe(1)
      await sub.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reconnectNow (P6.2, NFR-7)', () => {
  it('while open: closes the socket as its own close and connects again at once', async () => {
    const { h, sub } = devicesHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    sub.reconnectNow()
    expect(h.socket(0).closeCalls).toEqual([{ code: 1000, reason: 'reconnect' }])
    await h.tick()
    // No backoff wait, no error: the close was ours.
    expect(h.sleeps).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.sockets).toHaveLength(2)
    // Still through the shared limiter, like every upgrade (R9).
    expect(h.acquires()).toBe(2)
    expect(h.states).toEqual(['connecting', 'open', 'connecting'])
    // The reconnect fires onConnected, so the caller re-reads the inventory (R11).
    h.socket(1).open()
    expect(h.connects).toEqual([{ reconnect: false }, { reconnect: true }])
    await sub.stop()
  })

  it('resets the backoff: a failure after it waits the initial delay again', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    for (let attempt = 0; attempt < 4; attempt++) {
      h.socket(attempt).serverClose(1006)
      await h.advance()
    }
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000])
    h.socket(4).open()
    sub.reconnectNow()
    await h.tick()
    h.socket(5).serverClose(1006)
    await h.tick()
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 1000])
    await sub.stop()
  })

  it('while connecting: abandons the handshake and starts a fresh one', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    expect(sub.state).toBe('connecting')
    sub.reconnectNow()
    expect(h.socket(0).closed).toBe(true)
    await h.tick()
    expect(h.sockets).toHaveLength(2)
    expect(h.sleeps).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.acquires()).toBe(2)
    await sub.stop()
  })

  it('during the backoff wait: cuts it short, with the backoff reset and a permit taken', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    for (let attempt = 0; attempt < 3; attempt++) {
      h.socket(attempt).serverClose(1006)
      if (attempt < 2) await h.advance()
    }
    await h.tick()
    expect(sub.state).toBe('reconnecting')
    expect(h.sleeps).toEqual([1000, 2000, 4000])
    expect(h.sockets).toHaveLength(3)

    sub.reconnectNow()
    await h.tick()
    expect(h.sockets).toHaveLength(4)
    expect(h.acquires()).toBe(4)
    expect(sub.state).toBe('connecting')
    // The next failure starts the sequence again.
    h.socket(3).serverClose(1006)
    await h.tick()
    expect(h.sleeps).toEqual([1000, 2000, 4000, 1000])
    await sub.stop()
  })

  it('does nothing before start(), after stop(), or after a stop for good on auth', async () => {
    const idle = eventsHarness()
    idle.sub.reconnectNow()
    await idle.h.tick()
    expect(idle.h.sockets).toHaveLength(0)
    expect(idle.sub.state).toBe('idle')

    const stopped = eventsHarness()
    stopped.sub.start()
    await stopped.h.tick()
    stopped.h.socket(0).open()
    await stopped.sub.stop()
    stopped.sub.reconnectNow()
    await stopped.h.tick()
    expect(stopped.h.sockets).toHaveLength(1)
    expect(stopped.sub.state).toBe('stopped')

    const refused = eventsHarness()
    refused.sub.start()
    await refused.h.tick()
    refused.h.socket(0).failUpgrade(Object.assign(new Error('non-101'), { status: 401 }))
    await refused.h.tick()
    expect(refused.sub.state).toBe('stopped')
    refused.sub.reconnectNow()
    await refused.h.tick()
    expect(refused.h.sockets).toHaveLength(1)
    expect(refused.h.acquires()).toBe(1)
  })

  it('waits for a permit like any upgrade: a held-back limiter holds the reconnect back too', async () => {
    let release = (): void => undefined
    let held = false
    const { h, sub } = eventsHarness({
      limiter: {
        acquire: () =>
          held
            ? new Promise<void>((resolve) => {
                release = resolve
              })
            : Promise.resolve(),
        run: (fn) => fn(),
        penalize: () => undefined,
        get pending() {
          return 0
        },
      },
    })
    sub.start()
    await h.tick()
    h.socket(0).open()
    held = true
    sub.reconnectNow()
    await h.tick()
    expect(h.sockets).toHaveLength(1)
    release()
    await h.tick()
    expect(h.sockets).toHaveLength(2)
    await sub.stop()
  })
})

describe('reconnectNow and a rate-limit floor (P6.2, R9)', () => {
  it('cuts the backoff short but holds the reconnect until the 429 window has passed', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).receiveJson(RATE_LIMIT_BODY)
    h.socket(0).serverClose(PROTECT_WS_CLOSE_RATE_LIMITED)
    await h.tick()
    // The 429's windowMs is the floor of this wait.
    expect(h.sleeps).toEqual([5000])
    h.jump(3000)
    sub.reconnectNow()
    await h.tick()
    // Woken, but only down to the floor: 2 s of the window are left, and nothing connects yet.
    expect(h.sleeps).toEqual([5000, 2000])
    expect(h.sockets).toHaveLength(1)
    // A second wake cannot cut the floor either.
    sub.reconnectNow()
    await h.tick()
    expect(h.sockets).toHaveLength(1)
    // The abandoned first wait, then the floor.
    await h.advance()
    await h.advance()
    expect(h.sockets).toHaveLength(2)
    // The backoff was still reset by the wake.
    h.socket(1).serverClose(1006)
    await h.tick()
    expect(h.sleeps.at(-1)).toBe(1000)
    await sub.stop()
  })

  it('with no floor left, a wake reconnects at once', async () => {
    const { h, sub } = eventsHarness()
    sub.start()
    await h.tick()
    h.socket(0).open()
    h.socket(0).receiveJson(RATE_LIMIT_BODY)
    h.socket(0).serverClose(PROTECT_WS_CLOSE_RATE_LIMITED)
    await h.tick()
    h.jump(5000)
    sub.reconnectNow()
    await h.tick()
    expect(h.sleeps).toEqual([5000])
    expect(h.sockets).toHaveLength(2)
    await sub.stop()
  })

  it('a wake clears the default sleep timer, leaving none pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeHarness({}, true)
      const sub = createEventsSubscription({ ...h.options, onEvent: () => undefined })
      sub.start()
      await h.tick()
      h.socket(0).serverClose(1006)
      await h.tick()
      expect(vi.getTimerCount()).toBe(1)
      sub.reconnectNow()
      expect(vi.getTimerCount()).toBe(0)
      await h.tick()
      expect(h.sockets).toHaveLength(2)
      await sub.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
