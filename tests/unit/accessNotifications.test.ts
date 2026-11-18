// P5.5: the UniFi Access notifications WebSocket (src/main/access/notifications.ts).
//
// Same method as tests/unit/protectSubscriptions.test.ts: a **fake socket and a fake clock**.
// `webSocketImpl` is a hand-driven stand-in, `now`/`sleep`/`random` are injected, and `sleep` is
// gated — it parks the caller until the test calls `advance()` — so the backoff is an assertion on
// a list of numbers and no test waits on a real timer, a real console or undici.
//
// The frames are the samples of the official reference (docs/reference/access-endpoints-v4.2.16.md,
// §11.1), with made-up ids. Nothing here has run against hardware (OS-1).
import { Agent, type Dispatcher } from 'undici'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AccessApiError } from '../../src/main/access/client'
import {
  accessNotificationsUrl,
  createAccessNotifications,
  remoteUnlockDoorId,
  type AccessNotifications,
  type AccessNotificationsOptions,
  type AccessNotificationsState,
  type AccessWebSocketCtor,
} from '../../src/main/access/notifications'
import type { AccessNotification } from '../../src/main/access/types'
import { accessEndpoint } from '../../src/main/console/endpoints'
import { PinMismatchError, PinRequiredError } from '../../src/main/tls/pinning'

const URL_NOTIFICATIONS = 'wss://192.0.2.10:12445/api/v1/developer/devices/notifications'
const TOKEN = 'access-notifications-test-token'
const DOOR_ID = '5d600936-8618-4f2d-a1b7-d786865b70ba'

/** One shared dispatcher stand-in: identity is all the subscription does with it. */
const dispatcher = new Agent()
afterAll(async () => {
  await dispatcher.close()
})

/** The §11.1 remote-unlock sample. */
const REMOTE_UNLOCK = {
  event: 'access.data.device.remote_unlock',
  receiver_id: '',
  event_object_id: 'hub-device-1',
  save_to_history: false,
  data: {
    unique_id: DOOR_ID,
    name: 'Door 236b',
    up_id: '913a35bc-66c9-4293-a617-846dd2e285ed',
    timezone: '',
    location_type: 'door',
    extra_type: '',
    full_name: 'Mock Console - 1F - Door 236b',
    level: 0,
    work_time: '[]',
    work_time_id: '',
    extras: { 'uah-input_state_dps': 'off' },
  },
}

/** A doorbell frame: it carries a `token` of its own, which must never reach a log line. */
const DOORBELL_SECRET = 'doorbell-frame-secret'
const DOORBELL = {
  event: 'access.remote_view',
  receiver_id: '',
  event_object_id: 'hub-device-1',
  save_to_history: false,
  data: { request_id: 'req-1', door_name: 'Front Door', channel: 'ch-1', token: DOORBELL_SECRET },
}

// --- the fake socket ----------------------------------------------------------------------------

interface FakeInit {
  headers: Record<string, string>
  dispatcher: Dispatcher
}

/** A WebSocket that does nothing until the test tells it to; `close` records what we did to it. */
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

interface Harness {
  readonly sub: AccessNotifications
  readonly sockets: FakeWebSocket[]
  readonly states: AccessNotificationsState[]
  readonly errors: AccessApiError[]
  readonly notifications: AccessNotification[]
  readonly sleeps: number[]
  readonly sleepSignals: AbortSignal[]
  readonly logs: string[]
  readonly creds: { token: string | null }
  pending(): number
  socket(index: number): FakeWebSocket
  /** Moves the clock without waiting, e.g. to make a connection count as stable. */
  jump(ms: number): void
  /** Flushes, then resolves the oldest gated `sleep`, advancing the clock to its due time. */
  advance(): Promise<void>
}

/** `realSleep` leaves `sleep` out, so the module's own `setTimeout` path runs. */
function makeHarness(over: Partial<AccessNotificationsOptions> = {}, realSleep = false): Harness {
  const sockets: FakeWebSocket[] = []
  const states: AccessNotificationsState[] = []
  const errors: AccessApiError[] = []
  const notifications: AccessNotification[] = []
  const sleeps: number[] = []
  const sleepSignals: AbortSignal[] = []
  const logs: string[] = []
  const creds: { token: string | null } = { token: TOKEN }
  const parked: { dueAt: number; resolve: () => void }[] = []
  let clock = 1_700_000_000_000

  const webSocketImpl: AccessWebSocketCtor = class extends FakeWebSocket {
    constructor(url: string, init: FakeInit) {
      super(url, init)
      sockets.push(this)
    }
  }

  const sub = createAccessNotifications({
    url: URL_NOTIFICATIONS,
    token: () => creds.token,
    dispatcher: () => dispatcher,
    onNotification: (notification) => notifications.push(notification),
    onStateChange: (state) => states.push(state),
    onError: (err) => errors.push(err),
    webSocketImpl,
    log: (line) => logs.push(line),
    now: () => clock,
    ...(realSleep
      ? {}
      : {
          sleep: (ms: number, signal: AbortSignal) =>
            new Promise<void>((resolve) => {
              sleeps.push(ms)
              sleepSignals.push(signal)
              parked.push({ dueAt: clock + ms, resolve })
            }),
        }),
    // The midpoint, so the jitter term is exactly zero and the sequence is assertable.
    random: () => 0.5,
    ...over,
  })

  return {
    sub,
    sockets,
    states,
    errors,
    notifications,
    sleeps,
    sleepSignals,
    logs,
    creds,
    pending: () => parked.length,
    socket(index) {
      const ws = sockets[index]
      if (ws === undefined) throw new Error(`no socket #${String(index)} was created`)
      return ws
    },
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
  }
}

/** Everything a test could have leaked the token into. */
function everythingSaid(h: Harness): string[] {
  return [
    ...h.logs,
    ...h.errors.map((err) => `${err.message}\n${err.stack ?? ''}\n${err.endpoint ?? ''}`),
    ...h.sockets.map((ws) => ws.url),
  ]
}

// --- the pure helpers ---------------------------------------------------------------------------

describe('accessNotificationsUrl', () => {
  const config = {
    host: '192.0.2.10',
    certFingerprint: null,
    accessEnabled: true,
    accessBaseUrl: null,
    accessCertFingerprint: null,
    connectOnLaunch: false,
  }

  it('derives wss://<console>:12445/api/v1/developer/devices/notifications by default', () => {
    expect(accessNotificationsUrl(accessEndpoint(config))).toBe(URL_NOTIFICATIONS)
  })

  it('follows a custom Access API root, whatever its port or path', () => {
    const endpoint = accessEndpoint({
      ...config,
      accessBaseUrl: 'https://udm.example/proxy/access/api/v1/developer/',
    })
    expect(accessNotificationsUrl(endpoint)).toBe(
      'wss://udm.example/proxy/access/api/v1/developer/devices/notifications',
    )
  })
})

describe('remoteUnlockDoorId', () => {
  it('returns data.unique_id of a remote unlock frame', () => {
    expect(remoteUnlockDoorId(REMOTE_UNLOCK)).toBe(DOOR_ID)
  })

  it('is null for any other event, even one that carries a unique_id', () => {
    expect(remoteUnlockDoorId(DOORBELL)).toBeNull()
    expect(
      remoteUnlockDoorId({ event: 'access.remote_view.change', data: { unique_id: DOOR_ID } }),
    ).toBeNull()
  })

  it('is null when the remote unlock frame has no usable door id', () => {
    const event = 'access.data.device.remote_unlock'
    expect(remoteUnlockDoorId({ event })).toBeNull()
    expect(remoteUnlockDoorId({ event, data: null })).toBeNull()
    expect(remoteUnlockDoorId({ event, data: 'success' })).toBeNull()
    expect(remoteUnlockDoorId({ event, data: {} })).toBeNull()
    expect(remoteUnlockDoorId({ event, data: { unique_id: '' } })).toBeNull()
    expect(remoteUnlockDoorId({ event, data: { unique_id: 7 } })).toBeNull()
  })
})

// --- connecting ---------------------------------------------------------------------------------

describe('connecting', () => {
  it('opens with the Bearer header and the pinned dispatcher, and nothing else', async () => {
    const h = makeHarness()
    expect(h.sub.state).toBe('idle')
    h.sub.start()
    await tick()

    expect(h.sockets).toHaveLength(1)
    const ws = h.socket(0)
    expect(ws.url).toBe(URL_NOTIFICATIONS)
    expect(ws.init.headers).toStrictEqual({ authorization: `Bearer ${TOKEN}` })
    expect(ws.init.dispatcher).toBe(dispatcher)
    expect(h.sub.state).toBe('connecting')

    ws.open()
    expect(h.sub.state).toBe('open')
    expect(h.states).toStrictEqual(['connecting', 'open'])
    expect(h.errors).toStrictEqual([])
    h.sub.stop()
  })

  it('is idempotent: a second start() opens no second socket', async () => {
    const h = makeHarness()
    h.sub.start()
    h.sub.start()
    await tick()
    h.socket(0).open()
    h.sub.start()
    await tick()
    expect(h.sockets).toHaveLength(1)
    h.sub.stop()
  })

  it('reads the token and the dispatcher again at every upgrade', async () => {
    const other = new Agent()
    let current: Dispatcher = dispatcher
    const h = makeHarness({ dispatcher: () => current })
    h.sub.start()
    await tick()
    h.creds.token = 'a-newer-token'
    current = other
    h.socket(0).serverClose(1006)
    await h.advance()
    expect(h.socket(1).init.headers).toStrictEqual({ authorization: 'Bearer a-newer-token' })
    expect(h.socket(1).init.dispatcher).toBe(other)
    h.sub.stop()
    await other.close()
  })
})

// --- frames -------------------------------------------------------------------------------------

describe('frames', () => {
  it('delivers each parsed notification, a documented one and an unknown event alike', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    ws.open()

    ws.receiveJson(REMOTE_UNLOCK)
    ws.receiveJson(DOORBELL)
    ws.receiveJson({ event: 'access.something.new', data: { anything: 1 } })
    ws.receiveJson({ event: 'access.no.data' })
    // A binary frame with the same JSON is read too.
    ws.receive(new TextEncoder().encode(JSON.stringify(REMOTE_UNLOCK)))

    expect(h.notifications.map((n) => n.event)).toStrictEqual([
      'access.data.device.remote_unlock',
      'access.remote_view',
      'access.something.new',
      'access.no.data',
      'access.data.device.remote_unlock',
    ])
    const first = h.notifications[0]
    expect(first?.event_object_id).toBe('hub-device-1')
    expect(first === undefined ? null : remoteUnlockDoorId(first)).toBe(DOOR_ID)
    expect(h.errors).toStrictEqual([])
    h.sub.stop()
  })

  it('ignores junk, "Hello" and unknown-shaped frames without closing or reporting', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    ws.open()
    const logsBefore = h.logs.length

    // The keepalive community clients see, and other non-JSON text: quietly, no log line at all.
    ws.receive('Hello')
    ws.receive('"Hello"')
    ws.receive('')
    ws.receive('{not json')
    expect(h.logs).toHaveLength(logsBefore + 1) // only `"Hello"`, which is JSON but not a frame

    // JSON that is not a notification: dropped, and logged by reason only.
    ws.receive('null')
    ws.receive('42')
    ws.receive('[]')
    ws.receiveJson({})
    ws.receiveJson({ event: '' })
    ws.receiveJson({ event: 7, data: { token: DOORBELL_SECRET } })
    ws.receiveJson({ data: { unique_id: DOOR_ID } })
    // Not text at all.
    ws.receive(12345)
    ws.receive(undefined)

    expect(h.notifications).toStrictEqual([])
    expect(h.errors).toStrictEqual([])
    expect(ws.closed).toBe(false)
    expect(ws.closeCalls).toStrictEqual([])
    expect(h.sub.state).toBe('open')
    expect(h.logs.some((line) => line.includes('dropped a frame'))).toBe(true)

    // ...and the socket still works afterwards.
    ws.receiveJson(REMOTE_UNLOCK)
    expect(h.notifications).toHaveLength(1)
    h.sub.stop()
  })

  it('never logs a frame body', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    ws.open()
    ws.receiveJson(DOORBELL)
    ws.receiveJson({ event: 7, data: { token: DOORBELL_SECRET } })
    ws.receive(`not json ${DOORBELL_SECRET}`)
    for (const line of h.logs) {
      expect(line).not.toContain(DOORBELL_SECRET)
      expect(line).not.toContain('Front Door')
    }
    h.sub.stop()
  })

  it('survives a consumer callback that throws', async () => {
    const seen: string[] = []
    const h = makeHarness({
      onNotification: (notification) => {
        seen.push(notification.event)
        throw new Error('consumer bug')
      },
      onStateChange: () => {
        throw new Error('consumer bug')
      },
    })
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    ws.open()
    ws.receiveJson(REMOTE_UNLOCK)
    ws.receiveJson(DOORBELL)
    expect(seen).toHaveLength(2)
    expect(ws.closed).toBe(false)
    expect(h.sub.state).toBe('open')
    h.sub.stop()
  })
})

// --- reconnecting -------------------------------------------------------------------------------

describe('reconnect backoff', () => {
  it('reconnects after a close, reporting it as a retryable error', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).open()
    h.socket(0).serverClose(1006, 'gone')
    await tick()

    expect(h.sub.state).toBe('reconnecting')
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('network')
    expect(h.errors[0]?.retryable).toBe(true)
    expect(h.errors[0]?.message).toContain('1006')
    expect(h.errors[0]?.endpoint).toBe('192.0.2.10:12445')
    expect(h.sleeps).toStrictEqual([1000])

    await h.advance()
    expect(h.sockets).toHaveLength(2)
    h.socket(1).open()
    expect(h.states).toStrictEqual(['connecting', 'open', 'reconnecting', 'connecting', 'open'])
    h.sub.stop()
  })

  it('doubles from 1 s and caps at 60 s', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    for (let i = 0; i < 8; i++) {
      h.socket(i).serverClose(1006)
      await h.advance()
    }
    expect(h.sleeps).toStrictEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
    h.sub.stop()
  })

  it('honours a custom backoff and applies jitter within the configured fraction', async () => {
    const low = makeHarness({
      backoff: { initialMs: 100, maxMs: 400, factor: 3, jitter: 0.5 },
      random: () => 0,
    })
    low.sub.start()
    await tick()
    for (let i = 0; i < 3; i++) {
      low.socket(i).serverClose(1006)
      await low.advance()
    }
    // base 100, 300, 400 (capped), each minus 50 %.
    expect(low.sleeps).toStrictEqual([50, 150, 200])
    low.sub.stop()
  })

  it('forgives the backoff only once a connection has stayed open for stableAfterMs', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()

    // Opens and dies inside 10 s, twice: the backoff keeps growing.
    h.socket(0).open()
    h.jump(9_999)
    h.socket(0).serverClose(1006)
    await h.advance()
    h.socket(1).open()
    h.socket(1).serverClose(1006)
    await h.advance()
    expect(h.sleeps).toStrictEqual([1000, 2000])

    // Stays open for 10 s: back to the initial delay.
    h.socket(2).open()
    h.jump(10_000)
    h.socket(2).serverClose(1006)
    await h.advance()
    expect(h.sleeps).toStrictEqual([1000, 2000, 1000])
    h.sub.stop()
  })

  it('keeps retrying an upgrade failure that is neither auth nor a pin failure', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).failUpgrade(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    )
    await tick()
    expect(h.errors[0]?.kind).toBe('network')
    expect(h.errors[0]?.message).toContain('ECONNREFUSED')
    expect(h.sub.state).toBe('reconnecting')
    await h.advance()
    expect(h.sockets).toHaveLength(2)

    // undici's generic text for a failed upgrade, with no status to read: still retried.
    h.socket(1).failUpgrade('Received network error or non-101 status code.')
    await tick()
    expect(h.errors[1]?.kind).toBe('network')
    expect(h.sub.state).toBe('reconnecting')
    h.sub.stop()
  })
})

// --- stopping for good --------------------------------------------------------------------------

describe('failures that stop it for good', () => {
  it.each([401, 403] as const)('stops on a %i upgrade and never reconnects', async (status) => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).failUpgrade(Object.assign(new Error('upgrade refused'), { status }))
    await tick()

    expect(h.sub.state).toBe('stopped')
    expect(h.states).toStrictEqual(['connecting', 'stopped'])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('auth')
    expect(h.errors[0]?.status).toBe(status)
    expect(h.errors[0]?.message).toContain('API Token')
    expect(h.errors[0]?.message).toContain('view:device')
    expect(h.sleeps).toStrictEqual([])
    expect(h.pending()).toBe(0)
    expect(h.sockets).toHaveLength(1)
  })

  it('reads a 401 or 403 out of the error message when no status is attached', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).failUpgrade(new Error('Unexpected server response: 403'))
    await tick()
    expect(h.sub.state).toBe('stopped')
    expect(h.errors[0]?.kind).toBe('auth')
    expect(h.errors[0]?.status).toBe(403)
  })

  it.each([null, '', '   '])('stops without constructing a socket for token %j', async (token) => {
    const h = makeHarness()
    h.creds.token = token
    h.sub.start()
    await tick()

    expect(h.sockets).toHaveLength(0)
    expect(h.sub.state).toBe('stopped')
    expect(h.states).toStrictEqual(['stopped'])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('auth')
    expect(h.errors[0]?.status).toBeNull()
    expect(h.errors[0]?.message).toContain('no Access API token is saved')
    expect(h.sleeps).toStrictEqual([])
  })

  it('stops when the endpoint has no accepted certificate (the dispatcher throws)', async () => {
    const required = new PinRequiredError('192.0.2.10:12445')
    const h = makeHarness({
      dispatcher: () => {
        throw required
      },
    })
    h.sub.start()
    await tick()

    expect(h.sockets).toHaveLength(0)
    expect(h.sub.state).toBe('stopped')
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('pin')
    expect(h.errors[0]?.message).toBe(required.message)
    expect(h.sleeps).toStrictEqual([])
  })

  it('stops on a pin mismatch during the handshake, keeping its message', async () => {
    const mismatch = new PinMismatchError({
      endpoint: '192.0.2.10:12445',
      expected: `${'AA:'.repeat(31)}AA`,
      actual: `${'BB:'.repeat(31)}BB`,
    })
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).failUpgrade(new TypeError('fetch failed', { cause: mismatch }))
    await tick()

    expect(h.sub.state).toBe('stopped')
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.kind).toBe('pin')
    expect(h.errors[0]?.message).toBe(mismatch.message)
    expect(h.sleeps).toStrictEqual([])
    expect(h.sockets).toHaveLength(1)
  })

  it('begins afresh on start() after an unrecoverable stop', async () => {
    const h = makeHarness()
    h.creds.token = null
    h.sub.start()
    await tick()
    expect(h.sub.state).toBe('stopped')

    // The user pasted a token in Settings; the caller starts it again.
    h.creds.token = TOKEN
    h.sub.start()
    await tick()
    expect(h.sockets).toHaveLength(1)
    h.socket(0).open()
    expect(h.sub.state).toBe('open')
    h.socket(0).receiveJson(REMOTE_UNLOCK)
    expect(h.notifications).toHaveLength(1)
    h.sub.stop()
  })
})

// --- stop() -------------------------------------------------------------------------------------

describe('stop()', () => {
  it('is safe from idle, and is idempotent', () => {
    const h = makeHarness()
    h.sub.stop()
    h.sub.stop()
    expect(h.sub.state).toBe('stopped')
    expect(h.states).toStrictEqual(['stopped'])
    expect(h.sockets).toHaveLength(0)
    expect(h.errors).toStrictEqual([])
  })

  it('while connecting: closes the socket and ignores whatever it does afterwards', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    h.sub.stop()
    expect(ws.closeCalls).toStrictEqual([{ code: 1000, reason: 'stopped' }])
    expect(h.sub.state).toBe('stopped')

    // A late failure of the abandoned upgrade is nobody's business any more.
    ws.failUpgrade(Object.assign(new Error('upgrade refused'), { status: 401 }))
    await tick()
    expect(h.errors).toStrictEqual([])
    expect(h.states).toStrictEqual(['connecting', 'stopped'])
  })

  it('while open: closes with 1000, reports no error and delivers nothing afterwards', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const ws = h.socket(0)
    ws.open()
    ws.receiveJson(REMOTE_UNLOCK)
    h.sub.stop()

    expect(ws.closeCalls).toStrictEqual([{ code: 1000, reason: 'stopped' }])
    expect(h.sub.state).toBe('stopped')
    expect(h.states).toStrictEqual(['connecting', 'open', 'stopped'])

    // A frame that was already in flight, and anything else the dead socket says.
    ws.receiveJson(REMOTE_UNLOCK)
    ws.open()
    ws.serverClose(1006)
    await tick()
    expect(h.notifications).toHaveLength(1)
    expect(h.errors).toStrictEqual([])
    expect(h.states).toStrictEqual(['connecting', 'open', 'stopped'])
    expect(h.sleeps).toStrictEqual([])
    expect(h.sockets).toHaveLength(1)
  })

  it('during backoff: cancels the wait and never reconnects', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).serverClose(1006)
    await tick()
    expect(h.sub.state).toBe('reconnecting')
    expect(h.sleepSignals[0]?.aborted).toBe(false)

    h.sub.stop()
    // The injected sleep is told to give up...
    expect(h.sleepSignals[0]?.aborted).toBe(true)
    expect(h.sub.state).toBe('stopped')
    // ...and even if it resolves later anyway, nothing happens.
    await h.advance()
    expect(h.sockets).toHaveLength(1)
    expect(h.states).toStrictEqual(['connecting', 'reconnecting', 'stopped'])
    expect(h.errors).toHaveLength(1) // the close, reported before the stop
  })

  it('leaves no real timer pending when the default sleep is used', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({}, true)
      h.sub.start()
      await Promise.resolve()
      h.socket(0).serverClose(1006)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.sub.state).toBe('reconnecting')
      expect(vi.getTimerCount()).toBe(1)

      h.sub.stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.sockets).toHaveLength(1)

      // ...and the default sleep does reconnect when it is left alone.
      h.sub.start()
      await vi.advanceTimersByTimeAsync(0)
      h.socket(1).serverClose(1006)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.sockets).toHaveLength(3)
      h.sub.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() after stop() works, with a fresh backoff and no leak from the old run', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    const old = h.socket(0)
    old.serverClose(1006)
    await h.advance()
    h.socket(1).serverClose(1006)
    await tick()
    expect(h.sleeps).toStrictEqual([1000, 2000])
    h.sub.stop()

    h.sub.start()
    await tick()
    expect(h.sockets).toHaveLength(3)
    const fresh = h.socket(2)
    fresh.open()
    expect(h.sub.state).toBe('open')

    // The parked sleep of the old run resolving must not open a second socket.
    await h.advance()
    expect(h.sockets).toHaveLength(3)
    // The old run's sockets cannot deliver into, or close, the new run.
    old.receiveJson(REMOTE_UNLOCK)
    h.socket(1).receiveJson(REMOTE_UNLOCK)
    expect(h.notifications).toStrictEqual([])
    fresh.receiveJson(REMOTE_UNLOCK)
    expect(h.notifications).toHaveLength(1)
    expect(h.sub.state).toBe('open')

    // The backoff starts over.
    fresh.serverClose(1006)
    await tick()
    expect(h.sleeps).toStrictEqual([1000, 2000, 1000])
    h.sub.stop()
  })
})

// --- the token ----------------------------------------------------------------------------------

describe('the token', () => {
  it('never appears in the URL, a log line or an error', async () => {
    const h = makeHarness()
    h.sub.start()
    await tick()
    h.socket(0).open()
    h.socket(0).receiveJson(REMOTE_UNLOCK)
    h.socket(0).receive('Hello')
    h.socket(0).receiveJson({ nope: true })
    h.socket(0).serverClose(1006, 'bye')
    await h.advance()
    h.socket(1).failUpgrade(new Error('socket hang up'))
    await h.advance()
    h.socket(2).failUpgrade(Object.assign(new Error('upgrade refused'), { status: 403 }))
    await tick()
    expect(h.sub.state).toBe('stopped')

    expect(h.errors).toHaveLength(3)
    expect(h.logs.length).toBeGreaterThan(5)
    for (const text of everythingSaid(h)) expect(text).not.toContain(TOKEN)
    // ...and it really was in play: in the Authorization header of every upgrade, and only there.
    for (const ws of h.sockets) {
      expect(ws.init.headers.authorization).toBe(`Bearer ${TOKEN}`)
    }
    for (const err of h.errors) expect(err).toBeInstanceOf(AccessApiError)
  })
})
