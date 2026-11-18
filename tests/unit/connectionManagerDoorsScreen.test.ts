// P5.6: the connection manager's Doors screen half (src/main/connection.ts) — `watchDoorsScreen`,
// `doorAction`, `setDoorEmergency`, `accessPollingChanged` and what clears the door list.
//
// `doorAction` and `setDoorEmergency` change physical doors, so the tests are written as the rules
// in their doc comments, one by one (DOOR-0, DOOR-3/4/5): what is refused with **no Access call**,
// that exactly one PUT is sent and never a second, what each action maps to on the wire, and what
// is written to the unlock log. Fakes throughout, on vitest's fake clock; the last block runs the
// same manager against the real Access client and the mock console (gate G5's additions).
import {
  IPC_EVENTS,
  emptyDoorsScreenState,
  type DoorAction,
  type DoorsScreenState,
  type IpcResult,
} from '@shared/ipc'
import { ConsoleConfigSchema, type Door } from '@shared/models'
import { Request as UndiciRequest, Response as UndiciResponse } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessApiError, createAccessClient } from '../../src/main/access/client'
import {
  BURST_POLL_MS,
  DETAILS_POLL_MS,
  FAILURE_BACKOFF_MAX_MS,
  POLL_WITHOUT_SOCKET_MS,
  TRIGGER_COALESCE_MS,
} from '../../src/main/access/doorStateMonitor'
import type { UnlockAttempt } from '../../src/main/access/unlockLog'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'
import {
  DOOR_MONITOR_AUTH_RETRY_MS,
  createConnectionManager,
  type ConnectionServices,
} from '../../src/main/connection'
import { accessEndpoint } from '../../src/main/console/endpoints'
import { createRateLimiter } from '../../src/main/net/rateLimiter'
import { PinRequiredError, hostPortKey } from '../../src/main/tls/pinning'
import { createAccessMock } from '../../scripts/mock-access/app.ts'
import { SEED_DOORS } from '../../scripts/mock-access/doors.ts'

const FP =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'
const ACCESS_TOKEN = 'vp-test-access-token-NEVER-LOG-THIS'
const ACCESS_HOST_PORT = '192.0.2.10:12445'

const FRONT = 'door-front'
const BACK = 'door-back'
const SHED = 'door-shed'

function door(id: string, extra: Partial<Door> = {}): Door {
  return {
    id,
    name: id,
    fullName: `House - 1F - ${id}`,
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay: 'lock',
    position: null,
    ...extra,
  }
}

const NORMAL = { lockdown: false, evacuation: false }
const NO_RULE = { type: '', endedTime: null }
interface Rule {
  type: string
  endedTime: number | null
}

interface SetupOptions {
  readonly host?: string
  readonly accessEnabled?: boolean
  readonly accessToken?: string | null
  readonly doorLinks?: Record<string, string>
  readonly accessPolling?: Partial<Config['accessPolling']>
  /** `host:port` keys with an accepted certificate. Default: the Access endpoint. */
  readonly pinned?: readonly string[]
}

function setup(options: SetupOptions = {}) {
  let current: Config = ConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    console: ConsoleConfigSchema.parse({
      host: options.host ?? '192.0.2.10',
      accessEnabled: options.accessEnabled ?? true,
    }),
    doorLinks: options.doorLinks ?? {},
    accessPolling: options.accessPolling ?? {},
  })
  const pinned = new Set(options.pinned ?? [ACCESS_HOST_PORT])

  // The console's side: what the next reads answer.
  let doors: Door[] = [door(FRONT), door(BACK), door(SHED, { boundToHub: false })]
  let emergency: { lockdown: boolean; evacuation: boolean } = NORMAL
  const rules = new Map<string, Rule | Error>()

  const access = {
    doors: vi.fn<() => Promise<Door[]>>(() => Promise.resolve(doors.map((d) => ({ ...d })))),
    unlock: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    lockRule: vi.fn<(id: string, options?: { quiet?: boolean }) => Promise<Rule>>((id) => {
      const rule = rules.get(id) ?? NO_RULE
      return rule instanceof Error ? Promise.reject(rule) : Promise.resolve(rule)
    }),
    setLockRule: vi.fn<
      (id: string, rule: { type: string; intervalMinutes?: number }) => Promise<void>
    >(() => Promise.resolve()),
    emergencyStatus: vi.fn<
      (options?: { quiet?: boolean }) => Promise<{ lockdown: boolean; evacuation: boolean }>
    >(() => Promise.resolve(emergency)),
    setEmergencyStatus: vi.fn<
      (status: { lockdown: boolean; evacuation: boolean }) => Promise<void>
    >(() => Promise.resolve()),
  }
  /** Spied, so "the client was not even resolved" can be asserted (DOOR-0). */
  const resolveAccess = vi.fn(() => access)

  let stored: Config = current
  const update = vi.fn((mutate: (latest: Config) => Config) => {
    stored = ConfigSchema.parse(mutate(structuredClone(stored)))
    return Promise.resolve(stored)
  })
  const unused = (name: string) => () =>
    Promise.reject(new Error(`${name} is not part of this test`))
  const services: ConnectionServices = {
    config: { update },
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    credentials: {
      protectApiKey: 'vp-test-api-key-NEVER-LOG-THIS',
      ...(options.accessToken === null ? {} : { accessToken: options.accessToken ?? ACCESS_TOKEN }),
    },
    pins: {
      pinnedFingerprint: (host, port) => (pinned.has(hostPortKey(host, port)) ? FP : null),
      agentFor: (host, port) => {
        if (!pinned.has(hostPortKey(host, port)))
          throw new PinRequiredError(hostPortKey(host, port))
        return {} as never
      },
      invalidate: () => undefined,
      closeAll: () => Promise.resolve(),
    },
    limiter: createRateLimiter(),
    protect: () => ({
      metaInfo: unused('metaInfo'),
      cameras: () => Promise.resolve([]),
      snapshot: unused('snapshot'),
      rtspsStreams: unused('rtspsStreams'),
    }),
    access: resolveAccess,
  }

  const emitted: { channel: string; payload: unknown }[] = []
  const logged: string[] = []
  const attempts: UnlockAttempt[] = []
  const openDoorNotifications = vi.fn(() => ({ stop: () => undefined }))
  const noFeed = (): never => {
    throw new Error('no Protect feed is opened in this test')
  }
  const manager = createConnectionManager({
    services,
    emit: (channel, payload) => {
      emitted.push({ channel, payload })
    },
    createDevices: noFeed,
    createEvents: noFeed,
    log: (line) => {
      logged.push(line)
    },
    unlockLog: {
      append: (attempt) => {
        attempts.push(attempt)
        return Promise.resolve()
      },
    },
    openDoorNotifications,
  })

  const payloads = (channel: string): unknown[] =>
    emitted.filter((event) => event.channel === channel).map((event) => event.payload)

  return {
    manager,
    services,
    access,
    resolveAccess,
    openDoorNotifications,
    emitted,
    logged,
    attempts,
    update,
    payloads,
    screens: (): DoorsScreenState[] =>
      payloads(IPC_EVENTS.doorsScreen.channel) as DoorsScreenState[],
    doorStates: (): unknown[] => payloads(IPC_EVENTS.doorStates.channel),
    statusPushes: (): number => payloads(IPC_EVENTS.connection.channel).length,
    /** How many PUTs of any kind have been sent. The number every action test ends on. */
    puts: (): number =>
      access.unlock.mock.calls.length +
      access.setLockRule.mock.calls.length +
      access.setEmergencyStatus.mock.calls.length,
    setDoors(next: Door[]) {
      doors = next
    },
    setRule(id: string, rule: Rule | Error) {
      rules.set(id, rule)
    },
    setEmergency(next: { lockdown: boolean; evacuation: boolean }) {
      emergency = next
    },
    setPolling(next: Config['accessPolling']) {
      current = { ...current, accessPolling: next }
    },
    setLinks(doorLinks: Record<string, string>) {
      current = { ...current, doorLinks }
    },
    pin(hostPort: string) {
      pinned.add(hostPort)
    },
    clearReads() {
      access.doors.mockClear()
      access.lockRule.mockClear()
      access.emergencyStatus.mockClear()
    },
  }
}

type Harness = ReturnType<typeof setup>

const tick = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)

/** Opens the Doors screen and lets the first door read and the first details round answer. */
async function opened(options: SetupOptions = {}): Promise<Harness> {
  const h = setup(options)
  h.manager.watchDoorsScreen(true)
  await tick()
  return h
}

function value<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

function network(): AccessApiError {
  return new AccessApiError('The console did not answer.', { kind: 'network' })
}

/** An `AccessApiError` as the client builds it for a thrown connection failure (`cause` kept). */
function connectError(kind: 'network' | 'timeout', message: string, code?: string): AccessApiError {
  const root = Object.assign(new Error(message), code === undefined ? {} : { code })
  return new AccessApiError(`PUT failed: ${message}.`, {
    kind,
    endpoint: ACCESS_HOST_PORT,
    cause: new TypeError('fetch failed', { cause: root }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('watchDoorsScreen: when nothing may be read', () => {
  it('makes no Access call while Access is off, and says so in the state (DOOR-0)', async () => {
    const h = setup({ accessEnabled: false })
    const answer = value(h.manager.watchDoorsScreen(true))
    expect(answer).toEqual({
      ...emptyDoorsScreenState(),
      error: expect.objectContaining({ kind: 'disabled', retryable: false }) as unknown,
    })
    h.manager.accessInputsChanged('the door links were saved')
    h.manager.accessPollingChanged()
    await tick(FAILURE_BACKOFF_MAX_MS * 4)
    // Not a request that fails: the client is never even resolved, and no socket is opened.
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.openDoorNotifications).not.toHaveBeenCalled()
    expect(h.screens()).toEqual([])
    expect(h.manager.status().access.phase).toBe('disabled')
  })

  it('says a token is missing, with no Access call', async () => {
    const h = setup({ accessToken: null })
    const answer = value(h.manager.watchDoorsScreen(true))
    expect(answer.doors).toBeNull()
    expect(answer.error).toMatchObject({ kind: 'auth', endpoint: ACCESS_HOST_PORT })
    expect(answer.error?.message).toMatch(/No Access API token is saved/)
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.resolveAccess).not.toHaveBeenCalled()
  })

  it('says the address is missing, with no Access call', async () => {
    const h = setup({ host: '' })
    const answer = value(h.manager.watchDoorsScreen(true))
    expect(answer.error).toMatchObject({ kind: 'not-configured' })
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.resolveAccess).not.toHaveBeenCalled()
  })

  it('checks DOOR-0 before anything else', () => {
    const h = setup({ accessEnabled: false, accessToken: null, host: '' })
    expect(value(h.manager.watchDoorsScreen(true)).error?.kind).toBe('disabled')
  })

  it('answers the empty state, with no error, when the screen closes', () => {
    const h = setup({ accessEnabled: false })
    h.manager.watchDoorsScreen(true)
    expect(value(h.manager.watchDoorsScreen(false))).toEqual(emptyDoorsScreenState())
    expect(h.screens()).toEqual([])
  })

  it('never puts the token in a state or a log line', async () => {
    const h = await opened()
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    await tick(DETAILS_POLL_MS)
    const everything = JSON.stringify([h.emitted, h.logged, h.attempts])
    expect(everything).not.toContain(ACCESS_TOKEN)
  })
})

describe('watchDoorsScreen: every door, live', () => {
  it('needs no door link: it lists every door, with rules and emergency status', async () => {
    const h = setup({ doorLinks: {} })
    h.setRule(BACK, { type: 'schedule', endedTime: 1795000000 })
    // The first answer is usually empty: the read has only just been started.
    expect(value(h.manager.watchDoorsScreen(true))).toEqual(emptyDoorsScreenState())
    await tick()
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    // Quiet reads: a poll and a round must not write a log line per request.
    expect(h.access.doors).toHaveBeenCalledWith({ quiet: true })
    expect(h.access.emergencyStatus).toHaveBeenCalledWith({ quiet: true })
    expect(h.access.lockRule).toHaveBeenCalledWith(FRONT, { quiet: true })
    expect(h.screens().at(-1)).toEqual({
      doors: [door(FRONT), door(BACK), door(SHED, { boundToHub: false })],
      stale: false,
      rules: {
        [FRONT]: NO_RULE,
        [BACK]: { type: 'schedule', endedTime: 1795000000 },
        [SHED]: NO_RULE,
      },
      emergency: NORMAL,
      error: null,
    })
    // Live's push is unchanged: linked doors only, and there are none.
    expect(h.doorStates()).toEqual([])
    expect(h.manager.status().access.phase).toBe('connected')
  })

  it('reads the details one request at a time: emergency, then each door', async () => {
    const h = await opened()
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
    expect(h.access.lockRule.mock.calls.map((call) => call[0])).toEqual([FRONT, BACK, SHED])
    const order = [
      h.access.emergencyStatus.mock.invocationCallOrder[0],
      ...h.access.lockRule.mock.invocationCallOrder,
    ]
    expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)))
  })

  it('pushes only on a change, and only while the screen is open', async () => {
    const h = await opened()
    const sent = h.screens().length
    await tick(DETAILS_POLL_MS * 2)
    expect(h.access.doors.mock.calls.length).toBeGreaterThan(5)
    expect(h.screens()).toHaveLength(sent)

    h.setDoors([door(FRONT, { relay: 'unlock' }), door(BACK), door(SHED, { boundToHub: false })])
    await tick(DETAILS_POLL_MS)
    expect(h.screens().length).toBeGreaterThan(sent)
    expect(h.screens().at(-1)?.doors?.[0]).toMatchObject({ id: FRONT, relay: 'unlock' })

    const closed = h.screens().length
    expect(value(h.manager.watchDoorsScreen(false))).toEqual(emptyDoorsScreenState())
    h.setDoors([door(FRONT)])
    await tick(DETAILS_POLL_MS * 2)
    // Closing sent nothing (its answer is the reset), and nothing follows.
    expect(h.screens()).toHaveLength(closed)
  })

  it('does not push the state it has just answered with', async () => {
    const h = await opened()
    h.manager.watchDoorsScreen(false)
    const sent = h.screens().length
    // Reopened: the answer is "nothing yet", and that same state is not pushed after it.
    expect(value(h.manager.watchDoorsScreen(true))).toEqual(emptyDoorsScreenState())
    expect(h.screens()).toHaveLength(sent)
    await tick(TRIGGER_COALESCE_MS)
    expect(h.screens().at(-1)?.doors).toHaveLength(3)
  })

  it('is idempotent: opening twice starts one monitor and one read loop', async () => {
    const h = setup()
    h.manager.watchDoorsScreen(true)
    h.manager.watchDoorsScreen(true)
    await tick()
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
    expect(h.openDoorNotifications).toHaveBeenCalledTimes(1)
  })

  it('never lets a details failure move the Access status or push it', async () => {
    const h = setup()
    const old = new AccessApiError('no such endpoint', { kind: 'not-found' })
    h.access.emergencyStatus.mockRejectedValue(old)
    h.access.lockRule.mockRejectedValue(old)
    h.manager.watchDoorsScreen(true)
    await tick()
    const pushes = h.statusPushes()
    await tick(DETAILS_POLL_MS * 4)
    // An older console (no lock-rule or emergency endpoint) is "unknown", not an outage.
    expect(h.manager.status().access).toMatchObject({ phase: 'connected', error: null })
    expect(h.statusPushes()).toBe(pushes)
    expect(h.screens().at(-1)).toMatchObject({ rules: {}, emergency: null, error: null })
    expect(h.screens().at(-1)?.doors).toHaveLength(3)
    // And no faster than the round cadence: five rounds, four requests each.
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(5)
    expect(h.access.lockRule).toHaveBeenCalledTimes(15)
  })

  it('shows why the list cannot be read once reads fail, and recovers', async () => {
    const h = await opened()
    h.access.doors.mockRejectedValue(network())
    await tick(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.screens().at(-1)).toMatchObject({
      stale: true,
      error: { kind: 'network', endpoint: ACCESS_HOST_PORT },
      rules: {},
      emergency: null,
    })
    // The names are kept.
    expect(h.screens().at(-1)?.doors).toHaveLength(3)
    h.access.doors.mockImplementation(() => Promise.resolve([door(FRONT)]))
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.screens().at(-1)).toMatchObject({ stale: false, error: null, emergency: NORMAL })
  })
})

describe('watchDoorsScreen: two independent watchers', () => {
  const linked = { doorLinks: { 'cam-bell': FRONT } }

  it('runs for the Doors screen alone, although Live watching with no link does not', async () => {
    const h = setup({ doorLinks: {} })
    h.manager.watchDoors(true)
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.resolveAccess).not.toHaveBeenCalled()
    h.manager.watchDoorsScreen(true)
    await tick()
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    // Closing it stops everything again: Live still has nothing to watch.
    h.manager.watchDoorsScreen(false)
    h.clearReads()
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one monitor with Live: one read loop, one socket, both pushes', async () => {
    const h = setup(linked)
    h.manager.watchDoors(true)
    await tick()
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    expect(h.doorStates()).toEqual([{ [FRONT]: { relay: 'lock', position: null } }])
    // No details while only Live watches.
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()

    h.manager.watchDoorsScreen(true)
    await tick(TRIGGER_COALESCE_MS)
    expect(h.openDoorNotifications).toHaveBeenCalledTimes(1)
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
    expect(h.screens().at(-1)?.doors).toHaveLength(3)
    // Live's states are still the linked door only.
    expect(value(h.manager.watchDoors(true))).toEqual({
      [FRONT]: { relay: 'lock', position: null },
    })
  })

  it('keeps reading for Live when the Doors screen closes, without the details', async () => {
    const h = setup(linked)
    h.manager.watchDoors(true)
    h.manager.watchDoorsScreen(true)
    await tick(TRIGGER_COALESCE_MS)
    h.manager.watchDoorsScreen(false)
    h.clearReads()
    await tick(DETAILS_POLL_MS * 2)
    expect(h.access.doors.mock.calls.length).toBeGreaterThan(0)
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
    expect(h.access.lockRule).not.toHaveBeenCalled()
    expect(value(h.manager.watchDoors(true))).toEqual({
      [FRONT]: { relay: 'lock', position: null },
    })
  })

  it('keeps reading for the Doors screen when Live stops watching, in either order', async () => {
    const h = setup(linked)
    h.manager.watchDoorsScreen(true)
    h.manager.watchDoors(true)
    await tick(TRIGGER_COALESCE_MS)
    h.manager.watchDoors(false)
    h.clearReads()
    await tick(DETAILS_POLL_MS)
    expect(h.access.doors.mock.calls.length).toBeGreaterThan(0)
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
    // The last watcher leaving stops it, and Live is told its states are gone.
    h.manager.watchDoorsScreen(false)
    h.clearReads()
    await tick(DETAILS_POLL_MS * 2)
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.doorStates().at(-1)).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls every door while the screen is open: an unlinked unlocked door holds the burst', async () => {
    const h = setup(linked)
    h.setDoors([door(FRONT), door(BACK, { relay: 'unlock' })])
    h.manager.watchDoorsScreen(true)
    await tick()
    h.clearReads()
    await tick(BURST_POLL_MS * 5)
    expect(h.access.doors).toHaveBeenCalledTimes(5)
  })

  it('shutdown clears both watchers', async () => {
    const h = setup(linked)
    h.manager.watchDoors(true)
    h.manager.watchDoorsScreen(true)
    await tick(TRIGGER_COALESCE_MS)
    await h.manager.shutdown()
    h.clearReads()
    await tick(DETAILS_POLL_MS * 2)
    expect(h.access.doors).not.toHaveBeenCalled()
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
    // And the door list went with them.
    expect(await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    })
    expect(h.puts()).toBe(0)
  })
})

describe('watchDoorsScreen: a monitor that stops by itself', () => {
  it('reports a rejected token as the state: no list, the reason, and retries every minute', async () => {
    const h = setup()
    h.access.doors.mockRejectedValue(
      new AccessApiError('The Access API token was rejected.', { kind: 'auth' }),
    )
    h.manager.watchDoorsScreen(true)
    await tick()
    expect(h.screens()).toEqual([
      {
        ...emptyDoorsScreenState(),
        error: expect.objectContaining({ kind: 'auth', endpoint: ACCESS_HOST_PORT }) as unknown,
      },
    ])
    expect(h.manager.status().access.phase).toBe('error')
    // The retry fails the same way: nothing new to push.
    await tick(DOOR_MONITOR_AUTH_RETRY_MS)
    expect(h.access.doors).toHaveBeenCalledTimes(2)
    expect(h.screens()).toHaveLength(1)
    // No details were ever read on a token the console rejects.
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
  })

  it('reports a certificate that is not accepted as pin-required, and starts once it is', async () => {
    const h = setup({ pinned: [] })
    h.access.doors.mockImplementation(() =>
      Promise.reject(
        new AccessApiError('The certificate has not been accepted.', {
          kind: 'pin',
          cause: new PinRequiredError(ACCESS_HOST_PORT),
        }),
      ),
    )
    h.manager.watchDoorsScreen(true)
    await tick()
    expect(h.screens().at(-1)).toMatchObject({ doors: null, error: { kind: 'pin-required' } })
    // Never retried on a timer (CON-3).
    await tick(DOOR_MONITOR_AUTH_RETRY_MS * 2)
    expect(h.access.doors).toHaveBeenCalledTimes(1)

    h.pin(ACCESS_HOST_PORT)
    h.access.doors.mockImplementation(() => Promise.resolve([door(FRONT)]))
    h.manager.accessInputsChanged('a certificate was accepted', { trustChanged: true })
    await tick()
    expect(h.screens().at(-1)).toMatchObject({ error: null, doors: [door(FRONT)] })
  })

  it('says so when Access is switched off under an open screen, and reads nothing more', async () => {
    const h = await opened()
    await h.manager.applyConsoleChange({ ...h.services.current.console, accessEnabled: false })
    expect(h.screens().at(-1)).toEqual({
      ...emptyDoorsScreenState(),
      error: expect.objectContaining({ kind: 'disabled' }) as unknown,
    })
    h.clearReads()
    h.resolveAccess.mockClear()
    await tick(DETAILS_POLL_MS * 2)
    expect(h.resolveAccess).not.toHaveBeenCalled()
  })

  it('says so when the token is cleared under an open screen', async () => {
    const h = await opened()
    delete h.services.credentials.accessToken
    h.manager.accessInputsChanged('the Access token was cleared', { trustChanged: true })
    expect(h.screens().at(-1)).toEqual({
      ...emptyDoorsScreenState(),
      error: expect.objectContaining({ kind: 'auth' }) as unknown,
    })
    h.clearReads()
    await tick(DETAILS_POLL_MS * 2)
    expect(h.access.doors).not.toHaveBeenCalled()
  })
})

describe('the door list main keeps, and what clears it', () => {
  const unlockFront = (h: Harness) => h.manager.doorAction({ doorId: FRONT, action: 'unlock' })

  it('is cleared when the console block is saved, before the new endpoint is read', async () => {
    const h = await opened()
    expect((await unlockFront(h)).ok).toBe(true)
    h.access.unlock.mockClear()

    // The new console has a door with the same id; main has not read it from there yet.
    let release: (doors: Door[]) => void = () => undefined
    h.access.doors.mockImplementation(
      () =>
        new Promise<Door[]>((resolve) => {
          release = resolve
        }),
    )
    h.pin('192.0.2.20:12445')
    await h.manager.applyConsoleChange({ ...h.services.current.console, host: '192.0.2.20' })
    expect(h.screens().at(-1)).toEqual(emptyDoorsScreenState())
    const refused = await unlockFront(h)
    expect(refused).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
    expect(h.access.unlock).not.toHaveBeenCalled()

    // Once the new endpoint has listed it, it is a known door again.
    release([door(FRONT)])
    await tick()
    expect((await unlockFront(h)).ok).toBe(true)
    expect(h.access.unlock).toHaveBeenCalledTimes(1)
  })

  it('is cleared at once when the token or a certificate changes, and read again', async () => {
    const h = await opened()
    let release: (doors: Door[]) => void = () => undefined
    h.access.doors.mockImplementation(
      () =>
        new Promise<Door[]>((resolve) => {
          release = resolve
        }),
    )
    h.manager.accessInputsChanged('the Access token was saved', { trustChanged: true })
    expect(h.screens().at(-1)).toEqual(emptyDoorsScreenState())
    expect(await unlockFront(h)).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.puts()).toBe(0)
    await tick(TRIGGER_COALESCE_MS)
    release([door(FRONT)])
    await tick()
    expect((await unlockFront(h)).ok).toBe(true)
  })

  it('is kept through a door-link save: links are not a matter of trust', async () => {
    const h = await opened()
    const sent = h.screens().length
    h.setLinks({ 'cam-bell': FRONT })
    h.manager.accessInputsChanged('the door links were saved')
    expect((await unlockFront(h)).ok).toBe(true)
    expect(
      h
        .screens()
        .slice(sent)
        .every((state) => state.doors !== null),
    ).toBe(true)
  })

  it('is cleared when the screen closes, even while Live keeps the monitor running', async () => {
    const h = setup({ doorLinks: { 'cam-bell': FRONT } })
    h.manager.watchDoors(true)
    h.manager.watchDoorsScreen(true)
    await tick(TRIGGER_COALESCE_MS)
    expect((await unlockFront(h)).ok).toBe(true)
    h.manager.watchDoorsScreen(false)
    h.access.unlock.mockClear()
    // The monitor is still reading every door for Live's benefit; that is not the screen's list.
    await tick(POLL_WITHOUT_SOCKET_MS * 2)
    expect(await unlockFront(h)).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.access.unlock).not.toHaveBeenCalled()
  })

  it('is cleared when the monitor halts', async () => {
    const h = await opened()
    h.access.doors.mockRejectedValue(new AccessApiError('rejected', { kind: 'auth' }))
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(await unlockFront(h)).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.puts()).toBe(0)
  })

  it('follows the console: a door it stops listing is no longer accepted', async () => {
    const h = await opened()
    h.setDoors([door(BACK)])
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(await unlockFront(h)).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.puts()).toBe(0)
  })
})

describe('doorAction: refusals that send nothing (DOOR-0, DOOR-3/4)', () => {
  it('answers disabled while Access is off, for any door and action, with no Access call', async () => {
    const h = setup({ accessEnabled: false })
    h.manager.watchDoorsScreen(true)
    for (const action of ['unlock', 'lock', 'keep_unlock', 'keep_lock', 'reset'] as const) {
      const result = await h.manager.doorAction({ doorId: FRONT, action })
      expect(result).toMatchObject({ ok: false, error: { kind: 'disabled', retryable: false } })
    }
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.puts()).toBe(0)
    // Each was a person confirming a door action in this app: all five are in the log, with what
    // was asked (nothing was sent, so there is no wire action).
    expect(h.attempts.map((attempt) => attempt.action)).toEqual([
      'unlock',
      'lock',
      'keep_unlock',
      'keep_lock',
      'reset',
    ])
    expect(h.attempts[0]).toEqual({
      action: 'unlock',
      cameraRef: null,
      cameraName: null,
      doorId: FRONT,
      doorName: null,
      minutes: null,
      result: 'failure',
      errorKind: 'disabled',
      message: expect.stringContaining('UniFi Access is turned off') as unknown,
    })
    expect(h.manager.status().access.phase).toBe('disabled')
  })

  it('refuses a door id while the Doors screen is not open, with no Access call', async () => {
    const h = setup()
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.attempts).toEqual([
      expect.objectContaining({
        action: 'unlock',
        doorId: FRONT,
        doorName: null,
        result: 'failure',
        errorKind: 'not-found',
      }),
    ])
    // Nothing about the endpoint was learned.
    expect(h.manager.status().access.phase).toBe('idle')
    expect(h.statusPushes()).toBe(0)
  })

  it('refuses a door id before the first read has answered', async () => {
    const h = setup()
    h.manager.watchDoorsScreen(true)
    // The read is in flight; main has not seen a list yet.
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.puts()).toBe(0)
  })

  it.each([
    'door-9',
    'DOOR-FRONT',
    ' door-front',
    'door-front ',
    'door-front/../door-back',
    'door-front?x=1',
    'settings',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ])(
    'refuses the id %j, which main did not read from the console, with no Access call',
    async (doorId) => {
      const h = await opened()
      h.resolveAccess.mockClear()
      for (const action of ['unlock', 'lock', 'keep_unlock'] as const) {
        const result = await h.manager.doorAction({ doorId, action })
        expect(result).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
      }
      expect(h.resolveAccess).not.toHaveBeenCalled()
      expect(h.puts()).toBe(0)
      // Logged with the id exactly as received, and no door name: main knows no such door.
      expect(h.attempts).toHaveLength(3)
      expect(h.attempts[0]).toMatchObject({ doorId, doorName: null, errorKind: 'not-found' })
    },
  )

  it('refuses a door only Live has read: watching linked doors is not the screen being open', async () => {
    const h = setup({ doorLinks: { 'cam-bell': FRONT } })
    h.manager.watchDoors(true)
    await tick()
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(h.puts()).toBe(0)
  })

  it.each(['unlock', 'lock', 'keep_unlock', 'keep_lock', 'reset'] as const)(
    'refuses %s on a door with no hub, with no Access call',
    async (action) => {
      const h = await opened()
      h.resolveAccess.mockClear()
      const result = await h.manager.doorAction({ doorId: SHED, action })
      expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request', retryable: false } })
      expect(!result.ok && result.error.message).toMatch(/has no door hub/)
      expect(h.resolveAccess).not.toHaveBeenCalled()
      expect(h.puts()).toBe(0)
      expect(h.attempts).toEqual([
        {
          action,
          cameraRef: null,
          cameraName: null,
          doorId: SHED,
          doorName: `House - 1F - ${SHED}`,
          minutes: null,
          result: 'failure',
          errorKind: 'bad-request',
          message: expect.stringContaining('has no door hub') as unknown,
        },
      ])
    },
  )

  it('refuses custom on a door with no hub too, and logs the minutes asked for', async () => {
    const h = await opened()
    const result = await h.manager.doorAction({ doorId: SHED, action: 'custom', minutes: 20 })
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
    expect(h.puts()).toBe(0)
    expect(h.attempts[0]).toMatchObject({ action: 'custom', minutes: 20 })
  })

  it('keeps an id it has not read out of the console log, and writes it to the unlock log as data', async () => {
    const h = await opened()
    const hostile = 'door-9\n[connection] unlock: success (door door-front)'
    await h.manager.doorAction({ doorId: hostile, action: 'unlock' })
    expect(h.logged.join('\n')).not.toContain('door-9')
    expect(h.logged.at(-1)).toBe(
      'door action: unlock failure (a door id main has not read, not-found)',
    )
    // The audit log has it exactly as received (a JSON string there, so still one line).
    expect(h.attempts[0]?.doorId).toBe(hostile)
    // A door main did read is named by its id.
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(h.logged).toContain(`door action: unlock success (door ${FRONT})`)
    await h.manager.setDoorEmergency({ lockdown: false, evacuation: false })
    expect(h.logged).toContain('door action: emergency success (every door)')
  })

  it('leaves the Access status alone for every refusal', async () => {
    const h = await opened()
    const pushes = h.statusPushes()
    await h.manager.doorAction({ doorId: 'door-9', action: 'unlock' })
    await h.manager.doorAction({ doorId: SHED, action: 'unlock' })
    expect(h.statusPushes()).toBe(pushes)
    expect(h.manager.status().access.phase).toBe('connected')
  })
})

describe('doorAction: the mapping (DOOR-3)', () => {
  it('unlock is one PUT …/unlock for the door main read', async () => {
    const h = await opened()
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: FRONT,
        doorName: `House - 1F - ${FRONT}`,
        action: 'unlock',
        sent: 'unlock',
        minutes: null,
        outcome: 'done',
        reason: null,
      },
    })
    expect(h.access.unlock.mock.calls).toEqual([[FRONT]])
    expect(h.access.setLockRule).not.toHaveBeenCalled()
    expect(h.access.setEmergencyStatus).not.toHaveBeenCalled()
  })

  it.each(['keep_unlock', 'keep_lock', 'reset'] as const)(
    '%s is one PUT …/lock_rule with that type and no interval',
    async (action) => {
      const h = await opened()
      const result = await h.manager.doorAction({ doorId: BACK, action })
      expect(value(result)).toMatchObject({ doorId: BACK, action, sent: action, minutes: null })
      expect(h.access.setLockRule.mock.calls).toEqual([[BACK, { type: action }]])
      expect(h.access.unlock).not.toHaveBeenCalled()
    },
  )

  it('custom is one PUT …/lock_rule with the minutes as its interval', async () => {
    const h = await opened()
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'custom', minutes: 45 })
    expect(value(result)).toMatchObject({ action: 'custom', sent: 'custom', minutes: 45 })
    expect(h.access.setLockRule.mock.calls).toEqual([
      [FRONT, { type: 'custom', intervalMinutes: 45 }],
    ])
  })

  it('custom without minutes (which the schema refuses) still sends no interval of its own', async () => {
    const h = await opened()
    // The real client refuses this body before sending (AccessLockRuleRequestSchema); the manager
    // must not invent a duration to make it pass.
    await h.manager.doorAction({ doorId: FRONT, action: 'custom' })
    expect(h.access.setLockRule.mock.calls).toEqual([[FRONT, { type: 'custom' }]])
  })

  it('ignores minutes on an action that takes none (which the schema also refuses)', async () => {
    const h = await opened()
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'keep_unlock', minutes: 5 })
    expect(value(result).minutes).toBeNull()
    expect(h.access.setLockRule.mock.calls).toEqual([[FRONT, { type: 'keep_unlock' }]])
  })

  // User decision 2026-11-18: Lock is `lock_now` whatever the door's rule is. Choosing `reset` or
  // `lock_early` from the rule main last read could be a silent no-op when that rule was out of
  // date (a door that went onto its schedule since the last details round).
  const LOCK_RULES: readonly (readonly [string, Rule | Error | null])[] = [
    ['on an unlock schedule', { type: 'schedule', endedTime: 1795000000 }],
    ['on a custom unlock', { type: 'custom', endedTime: 1795000000 }],
    ['kept unlocked', { type: 'keep_unlock', endedTime: 3602128562 }],
    ['with no rule', { type: '', endedTime: 0 }],
    ['with no rule read yet (the default)', null],
    ['kept locked', { type: 'keep_lock', endedTime: 3602128562 }],
    ['whose schedule was ended early', { type: 'lock_early', endedTime: 1795000000 }],
    ['with a rule type the reference does not list', { type: 'holiday', endedTime: null }],
    [
      'whose rule could not be read (unknown)',
      new AccessApiError('no such endpoint', { kind: 'not-found' }),
    ],
  ]
  it.each(LOCK_RULES)('lock on a door %s sends lock_now', async (_name, rule) => {
    const h = setup()
    if (rule !== null) h.setRule(FRONT, rule)
    h.manager.watchDoorsScreen(true)
    await tick()
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'lock' })
    expect(value(result)).toMatchObject({ action: 'lock', sent: 'lock_now', outcome: 'done' })
    expect(h.access.setLockRule.mock.calls).toEqual([[FRONT, { type: 'lock_now' }]])
    expect(h.access.unlock).not.toHaveBeenCalled()
    // The log has what was sent, not what was asked.
    expect(h.attempts).toEqual([expect.objectContaining({ action: 'lock_now', result: 'success' })])
  })

  it('reset is sent only for the explicit "Back to normal" action', async () => {
    const h = setup()
    h.setRule(FRONT, { type: 'custom', endedTime: 2 })
    h.manager.watchDoorsScreen(true)
    await tick()
    await h.manager.doorAction({ doorId: FRONT, action: 'lock' })
    await h.manager.doorAction({ doorId: FRONT, action: 'reset' })
    expect(h.access.setLockRule.mock.calls).toEqual([
      [FRONT, { type: 'lock_now' }],
      [FRONT, { type: 'reset' }],
    ])
  })

  it('refuses every action while the door list is stale, with no Access call, and logs it (DOOR-4)', async () => {
    const h = await opened()
    h.access.doors.mockRejectedValue(network())
    // One failed read: the list is still good, and so is an action on it.
    await tick(POLL_WITHOUT_SOCKET_MS)
    expect(h.screens().at(-1)?.stale ?? false).toBe(false)
    expect((await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })).ok).toBe(true)
    expect(h.puts()).toBe(1)

    // Two in a row: every state is unknown, and main refuses whatever the renderer's buttons do.
    await tick(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.screens().at(-1)).toMatchObject({ stale: true })
    h.attempts.length = 0
    for (const input of [
      { doorId: FRONT, action: 'unlock' },
      { doorId: FRONT, action: 'lock' },
      { doorId: BACK, action: 'keep_unlock' },
      { doorId: BACK, action: 'custom', minutes: 5 },
      { doorId: FRONT, action: 'reset' },
    ] as const) {
      const result = await h.manager.doorAction(input)
      expect(result, input.action).toMatchObject({
        ok: false,
        error: { kind: 'unavailable', retryable: false },
      })
      expect(!result.ok && result.error.message).toBe(
        "The door's state is not known right now, so nothing was sent. Try again once the " +
          'doors can be read.',
      )
    }
    expect(h.puts()).toBe(1)
    expect(h.attempts).toHaveLength(5)
    expect(h.attempts[0]).toMatchObject({
      action: 'unlock',
      doorId: FRONT,
      result: 'failure',
      errorKind: 'unavailable',
    })
    // `lock` is logged as asked: nothing was sent.
    expect(h.attempts[1]).toMatchObject({ action: 'lock', result: 'failure' })

    // And again once a read works.
    h.access.doors.mockImplementation(() => Promise.resolve([door(FRONT), door(BACK)]))
    await tick(FAILURE_BACKOFF_MAX_MS)
    expect(h.screens().at(-1)).toMatchObject({ stale: false })
    expect((await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })).ok).toBe(true)
    expect(h.puts()).toBe(2)
  })

  it('an emergency change is not held back by a stale list: it names no door', async () => {
    const h = await opened()
    h.access.doors.mockRejectedValue(network())
    await tick(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.screens().at(-1)).toMatchObject({ stale: true })
    const result = await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    expect(result.ok).toBe(true)
    expect(h.access.setEmergencyStatus).toHaveBeenCalledTimes(1)
  })

  it('names the door by its full name, then its name, then its id', async () => {
    const h = setup()
    h.setDoors([
      door(FRONT, { fullName: '  ', name: 'Front' }),
      door(BACK, { fullName: '', name: ' ' }),
    ])
    h.manager.watchDoorsScreen(true)
    await tick()
    expect(value(await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })).doorName).toBe(
      'Front',
    )
    expect(value(await h.manager.doorAction({ doorId: BACK, action: 'unlock' })).doorName).toBe(
      BACK,
    )
  })
})

describe('doorAction: exactly one PUT (DOOR-3/4)', () => {
  const ACTIONS: readonly { action: DoorAction; minutes?: number }[] = [
    { action: 'unlock' },
    { action: 'lock' },
    { action: 'keep_unlock' },
    { action: 'keep_lock' },
    { action: 'custom', minutes: 10 },
    { action: 'reset' },
  ]

  it.each(ACTIONS)(
    'sends one PUT for $action and nothing after it, however long we wait',
    async (input) => {
      const h = await opened()
      await h.manager.doorAction({ doorId: FRONT, ...input })
      expect(h.puts()).toBe(1)
      // Polling, the details rounds and the burst all run on; none of them may send a PUT.
      await tick(DETAILS_POLL_MS * 10)
      expect(h.puts()).toBe(1)
    },
  )

  it.each(ACTIONS)(
    'never retries $action when the console fails it, and is never retryable',
    async (input) => {
      const h = await opened()
      // `server` is a kind the client itself calls retryable; that is about reads.
      const failure = new AccessApiError('The console failed.', { kind: 'server', status: 500 })
      expect(failure.retryable).toBe(true)
      h.access.unlock.mockRejectedValue(failure)
      h.access.setLockRule.mockRejectedValue(failure)
      const result = await h.manager.doorAction({ doorId: FRONT, ...input })
      expect(result).toMatchObject({ ok: false, error: { kind: 'server', retryable: false } })
      expect(h.puts()).toBe(1)
      await tick(DETAILS_POLL_MS * 10)
      expect(h.puts()).toBe(1)
    },
  )

  it('two actions are two PUTs, in order, and never merged', async () => {
    const h = await opened()
    await Promise.all([
      h.manager.doorAction({ doorId: FRONT, action: 'unlock' }),
      h.manager.doorAction({ doorId: BACK, action: 'keep_lock' }),
    ])
    expect(h.access.unlock.mock.calls).toEqual([[FRONT]])
    expect(h.access.setLockRule.mock.calls).toEqual([[BACK, { type: 'keep_lock' }]])
  })

  it('sends nothing by itself: opening the screen, polling and saving settings send no PUT', async () => {
    const h = await opened({ doorLinks: { 'cam-bell': FRONT } })
    h.manager.watchDoors(true)
    h.setDoors([door(FRONT, { relay: 'unlock' }), door(BACK)])
    h.manager.accessInputsChanged('the door links were saved')
    h.manager.accessInputsChanged('the Access token was saved', { trustChanged: true })
    h.manager.accessPollingChanged()
    await tick(DETAILS_POLL_MS * 10)
    h.manager.watchDoorsScreen(false)
    h.manager.watchDoorsScreen(true)
    await tick(DETAILS_POLL_MS * 10)
    expect(h.puts()).toBe(0)
  })

  it('answers outcome unknown on a timeout: the door may have moved, and it is not sent again', async () => {
    const h = await opened()
    h.access.setLockRule.mockRejectedValueOnce(connectError('timeout', 'no answer in time'))
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'keep_unlock' })
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: FRONT,
        doorName: `House - 1F - ${FRONT}`,
        action: 'keep_unlock',
        sent: 'keep_unlock',
        minutes: null,
        outcome: 'unknown',
        reason: 'PUT failed: no answer in time.',
      },
    })
    expect(h.attempts).toEqual([
      {
        action: 'keep_unlock',
        cameraRef: null,
        cameraName: null,
        doorId: FRONT,
        doorName: `House - 1F - ${FRONT}`,
        minutes: null,
        result: 'unknown',
        errorKind: 'timeout',
        message: 'PUT failed: no answer in time.',
      },
    ])
    await tick(DETAILS_POLL_MS * 4)
    expect(h.puts()).toBe(1)
  })

  it('answers outcome unknown for a connection lost after connecting (ECONNRESET)', async () => {
    const h = await opened()
    h.access.unlock.mockRejectedValueOnce(connectError('network', 'read ECONNRESET', 'ECONNRESET'))
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(value(result).outcome).toBe('unknown')
    expect(h.puts()).toBe(1)
  })

  it('reports a connection that was never made (ECONNREFUSED) as a plain failure', async () => {
    const h = await opened()
    h.access.unlock.mockRejectedValueOnce(
      connectError('network', 'connect ECONNREFUSED', 'ECONNREFUSED'),
    )
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'network', retryable: false } })
    expect(h.attempts[0]).toMatchObject({ result: 'failure', errorKind: 'network' })
    expect(h.puts()).toBe(1)
  })

  it('never rejects, even when the client throws instead of rejecting', async () => {
    const h = await opened()
    h.access.unlock.mockImplementationOnce(() => {
      throw new Error('a bug in the client')
    })
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'internal', retryable: false } })
    expect(h.attempts[0]).toMatchObject({ result: 'failure', errorKind: 'internal' })
  })
})

describe('doorAction: the log and the status (DOOR-5, CON-5)', () => {
  it('logs a success with the door, its name, what was sent and the minutes', async () => {
    const h = await opened()
    await h.manager.doorAction({ doorId: FRONT, action: 'custom', minutes: 30 })
    expect(h.attempts).toEqual([
      {
        action: 'custom',
        cameraRef: null,
        cameraName: null,
        doorId: FRONT,
        doorName: `House - 1F - ${FRONT}`,
        minutes: 30,
        result: 'success',
        errorKind: null,
        message: null,
      },
    ])
  })

  it('logs a failure the console answered with its kind and message', async () => {
    const h = await opened()
    h.access.setLockRule.mockRejectedValueOnce(
      new AccessApiError('The console refused the lock rule.', { kind: 'forbidden', status: 403 }),
    )
    const result = await h.manager.doorAction({ doorId: FRONT, action: 'lock' })
    // `forbidden` is the contract's `auth` (src/main/ipc/errors.ts).
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', retryable: false } })
    expect(h.attempts).toEqual([
      expect.objectContaining({
        action: 'lock_now',
        result: 'failure',
        errorKind: 'auth',
        message: 'The console refused the lock rule.',
      }),
    ])
  })

  it('does not wait for the log write to answer', async () => {
    const h = await opened()
    let wrote = false
    // A second manager over the same services, with a log that never finishes writing.
    const manager = createConnectionManager({
      services: h.services,
      emit: () => undefined,
      unlockLog: {
        append: () =>
          new Promise<void>(() => {
            wrote = true
          }),
      },
    })
    manager.watchDoorsScreen(true)
    await tick()
    const result = await manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(result.ok).toBe(true)
    expect(wrote).toBe(true)
    manager.watchDoorsScreen(false)
  })

  it('reads connected after a success, and after a refusal that is about the door', async () => {
    const h = await opened()
    h.access.unlock.mockRejectedValueOnce(
      new AccessApiError('The console failed.', { kind: 'server', status: 500 }),
    )
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(h.manager.status().access.phase).toBe('error')
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(h.manager.status().access).toMatchObject({ phase: 'connected', error: null })

    for (const kind of ['forbidden', 'not-found', 'bad-request'] as const) {
      h.access.unlock.mockRejectedValueOnce(new AccessApiError('about the door', { kind }))
      await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
      expect(h.manager.status().access, kind).toMatchObject({ phase: 'connected', error: null })
    }
  })

  it('reads error after an endpoint failure, an unknown outcome included', async () => {
    const h = await opened()
    h.access.unlock.mockRejectedValueOnce(connectError('timeout', 'no answer in time'))
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(h.manager.status().access).toMatchObject({
      phase: 'error',
      error: { kind: 'timeout', retryable: false },
    })
    expect(h.payloads(IPC_EVENTS.connection.channel).at(-1)).toMatchObject({
      access: { phase: 'error' },
    })
  })

  it('reads error for a console that refuses the whole API, although its kind is forbidden', async () => {
    const h = await opened()
    h.access.unlock.mockRejectedValueOnce(
      new AccessApiError('The API is not available.', {
        kind: 'forbidden',
        code: 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED',
      }),
    )
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    expect(h.manager.status().access.phase).toBe('error')
  })

  it("leaves the new endpoint's status alone when the console changed while the PUT was out", async () => {
    const h = await opened()
    let fail: (error: unknown) => void = () => undefined
    h.access.unlock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        }),
    )
    const pending = h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    await tick()
    h.pin('192.0.2.20:12445')
    h.access.doors.mockImplementation(() => new Promise<Door[]>(() => undefined))
    await h.manager.applyConsoleChange({ ...h.services.current.console, host: '192.0.2.20' })
    fail(new AccessApiError('The console failed.', { kind: 'server', status: 500 }))
    const result = await pending
    // The caller still gets its answer, and the log its line.
    expect(result).toMatchObject({ ok: false, error: { kind: 'server' } })
    expect(h.attempts).toHaveLength(1)
    expect(h.manager.status().access).toMatchObject({ phase: 'idle', error: null })
    expect(h.logged.join('\n')).toContain('finished after the endpoint changed')
  })

  it('reads the doors and the details at once after the answer, with reads only', async () => {
    const h = await opened()
    // Well clear of the first read, so the follow-up is not coalesced away.
    await tick(TRIGGER_COALESCE_MS)
    h.clearReads()
    h.setRule(FRONT, { type: 'keep_unlock', endedTime: 3602128562 })
    h.setDoors([door(FRONT, { relay: 'unlock' }), door(BACK), door(SHED, { boundToHub: false })])
    await h.manager.doorAction({ doorId: FRONT, action: 'keep_unlock' })
    await tick()
    expect(h.access.doors.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(h.access.emergencyStatus.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(h.screens().at(-1)).toMatchObject({
      rules: { [FRONT]: { type: 'keep_unlock', endedTime: 3602128562 } },
    })
    expect(h.screens().at(-1)?.doors?.[0]).toMatchObject({ relay: 'unlock' })
    expect(h.puts()).toBe(1)
  })

  it("re-reads only that door's rule (and the emergency status), not every door's", async () => {
    const h = await opened()
    await tick(TRIGGER_COALESCE_MS)
    h.clearReads()
    h.setRule(FRONT, { type: 'keep_unlock', endedTime: 3602128562 })
    h.setDoors([door(FRONT, { relay: 'unlock' }), door(BACK), door(SHED, { boundToHub: false })])
    await h.manager.doorAction({ doorId: FRONT, action: 'keep_unlock' })
    // The answer, the poked door read (which sees the relay move) and what both ask for.
    await tick(TRIGGER_COALESCE_MS)
    const asked = h.access.lockRule.mock.calls.map((call) => call[0])
    expect(asked.length).toBeGreaterThanOrEqual(1)
    // Once for the action and once for the relay it moved: never a round of every door.
    expect(asked.length).toBeLessThanOrEqual(2)
    expect(new Set(asked)).toEqual(new Set([FRONT]))
    // The emergency status rides along with each (one request).
    expect(h.access.emergencyStatus.mock.calls.length).toBeLessThanOrEqual(2)
    expect(h.puts()).toBe(1)
  })

  it('reads again after a failed action too: the door may have moved all the same', async () => {
    const h = await opened()
    await tick(TRIGGER_COALESCE_MS)
    h.clearReads()
    h.access.unlock.mockRejectedValueOnce(connectError('timeout', 'no answer in time'))
    await h.manager.doorAction({ doorId: FRONT, action: 'unlock' })
    await tick()
    expect(h.access.doors.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(h.access.emergencyStatus.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('setDoorEmergency (DOOR-0, DOOR-3/4/5)', () => {
  it('answers disabled while Access is off, with no Access call, and logs it', async () => {
    const h = setup({ accessEnabled: false })
    const result = await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    expect(result).toMatchObject({ ok: false, error: { kind: 'disabled', retryable: false } })
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.attempts).toEqual([
      {
        action: 'emergency',
        cameraRef: null,
        cameraName: null,
        doorId: null,
        lockdown: true,
        evacuation: false,
        result: 'failure',
        errorKind: 'disabled',
        message: expect.stringContaining('UniFi Access is turned off') as unknown,
      },
    ])
  })

  it.each([
    { lockdown: true, evacuation: false },
    { lockdown: false, evacuation: true },
    { lockdown: false, evacuation: false },
  ])('sends exactly one PUT with $lockdown / $evacuation, both flags explicit', async (flags) => {
    const h = await opened()
    const result = await h.manager.setDoorEmergency(flags)
    expect(result).toEqual({ ok: true, value: { ...flags, outcome: 'done', reason: null } })
    expect(h.access.setEmergencyStatus.mock.calls).toEqual([[flags]])
    expect(h.puts()).toBe(1)
    expect(h.attempts).toEqual([
      {
        action: 'emergency',
        cameraRef: null,
        cameraName: null,
        doorId: null,
        ...flags,
        result: 'success',
        errorKind: null,
        message: null,
      },
    ])
    await tick(DETAILS_POLL_MS * 10)
    expect(h.puts()).toBe(1)
  })

  it('needs no door list: it works with the Doors screen closed', async () => {
    const h = setup()
    const result = await h.manager.setDoorEmergency({ lockdown: false, evacuation: false })
    expect(result.ok).toBe(true)
    expect(h.access.setEmergencyStatus).toHaveBeenCalledTimes(1)
    // And it starts no monitor by itself: nobody is watching.
    await tick(DETAILS_POLL_MS)
    expect(h.access.doors).not.toHaveBeenCalled()
  })

  it('refuses both flags on with no Access call, although the schema already does', async () => {
    const h = await opened()
    h.resolveAccess.mockClear()
    const result = await h.manager.setDoorEmergency({ lockdown: true, evacuation: true })
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request', retryable: false } })
    expect(h.resolveAccess).not.toHaveBeenCalled()
    expect(h.puts()).toBe(0)
    expect(h.attempts[0]).toMatchObject({ action: 'emergency', errorKind: 'bad-request' })
  })

  it('never retries a failure, and is never retryable', async () => {
    const h = await opened()
    h.access.setEmergencyStatus.mockRejectedValue(
      new AccessApiError('The console failed.', { kind: 'server', status: 500 }),
    )
    const result = await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    expect(result).toMatchObject({ ok: false, error: { kind: 'server', retryable: false } })
    expect(h.manager.status().access.phase).toBe('error')
    await tick(DETAILS_POLL_MS * 10)
    expect(h.access.setEmergencyStatus).toHaveBeenCalledTimes(1)
    expect(h.attempts[0]).toMatchObject({ result: 'failure', errorKind: 'server', lockdown: true })
  })

  it('answers outcome unknown on a timeout: every door may have changed, and it is not sent again', async () => {
    const h = await opened()
    h.access.setEmergencyStatus.mockRejectedValueOnce(connectError('timeout', 'no answer in time'))
    const result = await h.manager.setDoorEmergency({ lockdown: false, evacuation: true })
    expect(result).toEqual({
      ok: true,
      value: {
        lockdown: false,
        evacuation: true,
        outcome: 'unknown',
        reason: 'PUT failed: no answer in time.',
      },
    })
    expect(h.attempts[0]).toMatchObject({ result: 'unknown', errorKind: 'timeout' })
    await tick(DETAILS_POLL_MS * 4)
    expect(h.access.setEmergencyStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps the status connected for an older console that has no such endpoint', async () => {
    const h = await opened()
    h.access.setEmergencyStatus.mockRejectedValueOnce(
      new AccessApiError('not found', { kind: 'not-found', status: 404 }),
    )
    const result = await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found', retryable: false } })
    expect(h.manager.status().access.phase).toBe('connected')
  })

  it('reads the emergency status and the doors at once afterwards', async () => {
    const h = await opened()
    await tick(TRIGGER_COALESCE_MS)
    h.clearReads()
    h.setEmergency({ lockdown: false, evacuation: true })
    h.setDoors([door(FRONT, { relay: 'unlock' }), door(BACK, { relay: 'unlock' })])
    await h.manager.setDoorEmergency({ lockdown: false, evacuation: true })
    await tick()
    expect(h.screens().at(-1)).toMatchObject({ emergency: { lockdown: false, evacuation: true } })
    expect(
      h
        .screens()
        .at(-1)
        ?.doors?.map((entry) => entry.relay),
    ).toEqual(['unlock', 'unlock'])
    expect(h.puts()).toBe(1)
  })
})

describe('accessPolling: the saved intervals, applied without a restart (DOOR-6)', () => {
  it('reads at the saved intervals from the start', async () => {
    const h = setup({ accessPolling: { withoutSocketSec: 7, detailsSec: 90 } })
    h.manager.watchDoorsScreen(true)
    await tick()
    h.clearReads()
    // The fake socket never opens, so this is the no-socket baseline.
    await tick(7_000 * 4)
    expect(h.access.doors).toHaveBeenCalledTimes(4)
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
    await tick(90_000 - 28_000)
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
  })

  it('uses the unlocked interval while a door is unlocked', async () => {
    const h = setup({ accessPolling: { withoutSocketSec: 10, unlockedSec: 3 } })
    h.setDoors([door(FRONT, { relay: 'unlock' })])
    h.manager.watchDoorsScreen(true)
    await tick()
    h.clearReads()
    await tick(3_000 * 5)
    expect(h.access.doors).toHaveBeenCalledTimes(5)
  })

  it('applies a shorter interval now, not after the old one has run out', async () => {
    const h = setup({ accessPolling: { withoutSocketSec: 30, detailsSec: 600 } })
    h.manager.watchDoorsScreen(true)
    await tick()
    h.clearReads()
    await tick(10_000)
    expect(h.access.doors).not.toHaveBeenCalled()
    // What the `setAccessPolling` handler does: the new values are live, then the manager is told.
    h.setPolling({ withSocketSec: 5, withoutSocketSec: 12, unlockedSec: 1, detailsSec: 20 })
    h.manager.accessPollingChanged()
    // 10 s into a 30 s wait with 12 s saved: the read is 2 s away; the details round (10 s of a
    // 20 s wait gone) is 10 s away.
    await tick(1_999)
    expect(h.access.doors).not.toHaveBeenCalled()
    await tick(1)
    expect(h.access.doors).toHaveBeenCalledTimes(1)
    expect(h.access.emergencyStatus).not.toHaveBeenCalled()
    await tick(8_000)
    expect(h.access.emergencyStatus).toHaveBeenCalledTimes(1)
  })

  it('sends nothing by itself, and is harmless before any monitor exists', async () => {
    const h = setup()
    h.manager.accessPollingChanged()
    await tick(DETAILS_POLL_MS)
    expect(h.resolveAccess).not.toHaveBeenCalled()
    const off = setup({ accessEnabled: false })
    off.manager.watchDoorsScreen(true)
    off.manager.accessPollingChanged()
    await tick(DETAILS_POLL_MS)
    expect(off.resolveAccess).not.toHaveBeenCalled()
  })
})

// The same manager over the real Access client and the mock console, reached through an injected
// fetch (no sockets). These are gate G5's additions as far as main goes: every door listed with its
// lock state, the right door unlocked and locked, a door's rule or schedule shown, lockdown and
// evacuation set and cleared, each action logged.
describe('against the Access mock (gate G5 additions)', () => {
  const TOKEN = 'vp-test-access-token-NEVER-LOG-THIS'
  const seed = (name: string) => {
    const found = SEED_DOORS.find((entry) => entry.name === name)
    if (found === undefined) throw new Error(`the seed door ${name} changed; update this test`)
    return found
  }
  const FRONT_DOOR = seed('Front Door')
  const OFFICE = seed('Office')
  const STORAGE = seed('Storage Room')

  async function mocked() {
    const mock = createAccessMock({ token: TOKEN })
    /** Every request the app made, as `METHOD path`. */
    const sent: string[] = []
    const fetchImpl = vi.fn(async (input: unknown, init: unknown) => {
      const request = new UndiciRequest(input as string, init as never)
      const url = new URL(request.url)
      sent.push(`${request.method} ${url.pathname.replace('/api/v1/developer', '')}`)
      const headers: Record<string, string | undefined> = {}
      for (const [name, header] of request.headers) headers[name] = header
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
    const h = setup({ accessToken: TOKEN })
    const client = createAccessClient({
      endpoint: accessEndpoint(h.services.current.console),
      enabled: () => h.services.current.console.accessEnabled,
      token: () => h.services.credentials.accessToken ?? null,
      dispatcher: () => ({}) as never,
      fetchImpl,
    })
    h.services.access = () => client
    h.manager.watchDoorsScreen(true)
    await tick(50)
    const puts = (): string[] => sent.filter((line) => line.startsWith('PUT'))
    const screen = (): DoorsScreenState => {
      const last = h.screens().at(-1)
      if (last === undefined) throw new Error('no screen state yet')
      return last
    }
    const relayOf = (id: string): string | undefined =>
      screen().doors?.find((entry) => entry.id === id)?.relay
    return { ...h, mock, sent, puts, screen, relayOf }
  }

  let m: Awaited<ReturnType<typeof mocked>>
  beforeEach(async () => {
    m = await mocked()
  })
  afterEach(() => {
    m.manager.watchDoorsScreen(false)
    m.mock.store.dispose()
  })

  it('lists every door with its lock state, position, rule and the emergency status', () => {
    expect(m.screen().doors?.map((entry) => entry.name)).toEqual(
      SEED_DOORS.map((entry) => entry.name),
    )
    expect(m.screen().doors?.every((entry) => entry.relay === 'lock')).toBe(true)
    expect(m.screen().doors?.find((entry) => entry.id === STORAGE.id)).toMatchObject({
      boundToHub: false,
      position: null,
    })
    // The mock answers `{ type: '', ended_time: 0 }` for a door with no rule.
    expect(m.screen().rules).toEqual(
      Object.fromEntries(SEED_DOORS.map((entry) => [entry.id, { type: '', endedTime: 0 }])),
    )
    expect(m.screen().emergency).toEqual({ lockdown: false, evacuation: false })
    expect(m.screen().error).toBeNull()
    // Reads only so far.
    expect(m.puts()).toEqual([])
  })

  it('unlocks the right door, and only that one', async () => {
    const result = await m.manager.doorAction({ doorId: OFFICE.id, action: 'unlock' })
    expect(value(result)).toMatchObject({ doorName: OFFICE.full_name, sent: 'unlock' })
    expect(m.puts()).toEqual([`PUT /doors/${OFFICE.id}/unlock`])
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(OFFICE.id)).toBe('unlock')
    expect(m.relayOf(FRONT_DOOR.id)).toBe('lock')
    expect(m.attempts).toEqual([
      expect.objectContaining({ action: 'unlock', doorId: OFFICE.id, result: 'success' }),
    ])
  })

  it('keeps a door unlocked, shows the rule, and Lock (lock_now) ends it', async () => {
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'keep_unlock' })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(FRONT_DOOR.id)).toBe('unlock')
    expect(m.screen().rules[FRONT_DOOR.id]?.type).toBe('keep_unlock')

    const locked = await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'lock' })
    expect(value(locked).sent).toBe('lock_now')
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(FRONT_DOOR.id)).toBe('lock')
    expect(m.screen().rules[FRONT_DOOR.id]).toEqual({ type: '', endedTime: 0 })
    expect(m.puts()).toEqual([
      `PUT /doors/${FRONT_DOOR.id}/lock_rule`,
      `PUT /doors/${FRONT_DOOR.id}/lock_rule`,
    ])
  })

  it('unlocks for N minutes, shows when it ends, and Lock (lock_now) ends it', async () => {
    const now = Math.floor(Date.now() / 1000)
    await m.manager.doorAction({ doorId: OFFICE.id, action: 'custom', minutes: 30 })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().rules[OFFICE.id]?.type).toBe('custom')
    expect(m.screen().rules[OFFICE.id]?.endedTime).toBeGreaterThanOrEqual(now + 30 * 60)
    expect(m.screen().rules[OFFICE.id]?.endedTime).toBeLessThan(now + 31 * 60)
    expect(value(await m.manager.doorAction({ doorId: OFFICE.id, action: 'lock' })).sent).toBe(
      'lock_now',
    )
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(OFFICE.id)).toBe('lock')
  })

  it('shows a door on an unlock schedule, and Lock (lock_now) locks it', async () => {
    // Mock-only: the schedule starts "at the door" (POST /__mock/doors/{id}/schedule).
    m.mock.store.startSchedule(OFFICE.id, 120)
    await tick(DETAILS_POLL_MS)
    expect(m.relayOf(OFFICE.id)).toBe('unlock')
    const scheduled = m.screen().rules[OFFICE.id]
    expect(scheduled?.type).toBe('schedule')

    const locked = await m.manager.doorAction({ doorId: OFFICE.id, action: 'lock' })
    expect(value(locked).sent).toBe('lock_now')
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(OFFICE.id)).toBe('lock')
    // The mock's reading of `lock_now` ("terminates both the unlock schedule and any temporary
    // unlock at once"): no rule is left. What a real console does to the rest of the day's
    // schedule is for OS-1.
    expect(m.screen().rules[OFFICE.id]?.type).toBe('')
  })

  it('keeps a door locked, and reset restores it', async () => {
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'keep_lock' })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().rules[FRONT_DOOR.id]?.type).toBe('keep_lock')
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'reset' })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().rules[FRONT_DOOR.id]).toEqual({ type: '', endedTime: 0 })
  })

  it('locks a plain momentary unlock with lock_now', async () => {
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'unlock' })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(FRONT_DOOR.id)).toBe('unlock')
    expect(value(await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'lock' })).sent).toBe(
      'lock_now',
    )
    await tick(TRIGGER_COALESCE_MS)
    expect(m.relayOf(FRONT_DOOR.id)).toBe('lock')
  })

  it('sets and clears evacuation and lockdown, for every door', async () => {
    expect((await m.manager.setDoorEmergency({ lockdown: false, evacuation: true })).ok).toBe(true)
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().emergency).toEqual({ lockdown: false, evacuation: true })
    expect(m.screen().doors?.every((entry) => entry.relay === 'unlock')).toBe(true)

    await m.manager.setDoorEmergency({ lockdown: false, evacuation: false })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().emergency).toEqual({ lockdown: false, evacuation: false })
    expect(m.screen().doors?.every((entry) => entry.relay === 'lock')).toBe(true)

    await m.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    await tick(TRIGGER_COALESCE_MS)
    expect(m.screen().emergency).toEqual({ lockdown: true, evacuation: false })
    // Under lockdown the console refuses an unlock: reported, never retried, status connected.
    const refused = await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'unlock' })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'auth', retryable: false } })
    expect(m.manager.status().access.phase).toBe('connected')

    await m.manager.setDoorEmergency({ lockdown: false, evacuation: false })
    expect(m.puts().filter((line) => line === 'PUT /doors/settings/emergency')).toHaveLength(4)
    expect(m.attempts.filter((attempt) => attempt.action === 'emergency')).toEqual([
      expect.objectContaining({ lockdown: false, evacuation: true, result: 'success' }),
      expect.objectContaining({ lockdown: false, evacuation: false, result: 'success' }),
      expect.objectContaining({ lockdown: true, evacuation: false, result: 'success' }),
      expect.objectContaining({ lockdown: false, evacuation: false, result: 'success' }),
    ])
  })

  it('refuses the door with no hub itself: the console is never asked', async () => {
    const result = await m.manager.doorAction({ doorId: STORAGE.id, action: 'unlock' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
    expect(m.puts()).toEqual([])
  })

  it('refuses a door id the mock console does not list: the console is never asked', async () => {
    const before = m.sent.length
    const result = await m.manager.doorAction({
      doorId: '00000000-0000-4000-8000-000000000000',
      action: 'unlock',
    })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(m.sent).toHaveLength(before)
  })

  it('logs every action, and never the token', async () => {
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'unlock' })
    await m.manager.doorAction({ doorId: FRONT_DOOR.id, action: 'lock' })
    await m.manager.doorAction({ doorId: STORAGE.id, action: 'lock' })
    await m.manager.setDoorEmergency({ lockdown: false, evacuation: false })
    expect(m.attempts.map((attempt) => [attempt.action, attempt.result])).toEqual([
      ['unlock', 'success'],
      ['lock_now', 'success'],
      // Refused before a rule was chosen: what was asked.
      ['lock', 'failure'],
      ['emergency', 'success'],
    ])
    expect(JSON.stringify([m.attempts, m.logged, m.emitted])).not.toContain(TOKEN)
  })

  it('changes the read cadence without a restart', async () => {
    const reads = (): number => m.sent.filter((line) => line === 'GET /doors').length
    // Clear of the reads the first second causes.
    await tick(POLL_WITHOUT_SOCKET_MS * 2)
    let before = reads()
    await tick(POLL_WITHOUT_SOCKET_MS * 5)
    expect(reads() - before).toBe(5)
    m.setPolling({ withSocketSec: 5, withoutSocketSec: 10, unlockedSec: 1, detailsSec: 600 })
    m.manager.accessPollingChanged()
    await tick(10_000)
    before = reads()
    await tick(10_000 * 3)
    expect(reads() - before).toBe(3)
  })
})

describe('the details round after an emergency change (P5.6)', () => {
  it("re-reads everything: every door's rule may have moved with it", async () => {
    const h = await opened()
    await tick(TRIGGER_COALESCE_MS)
    h.clearReads()
    h.setEmergency({ lockdown: true, evacuation: false })
    await h.manager.setDoorEmergency({ lockdown: true, evacuation: false })
    await tick(TRIGGER_COALESCE_MS)
    expect(h.access.emergencyStatus.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(new Set(h.access.lockRule.mock.calls.map((call) => call[0]))).toEqual(
      new Set([FRONT, BACK, SHED]),
    )
    expect(h.screens().at(-1)).toMatchObject({ emergency: { lockdown: true, evacuation: false } })
    expect(h.puts()).toBe(1)
  })
})
