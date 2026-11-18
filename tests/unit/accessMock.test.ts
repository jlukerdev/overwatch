// P0.4 / P5.5: the UniFi Access mock's request handler (scripts/mock-access/app.ts), door store
// (doors.ts), WebSocket codec (ws.ts) and, over real TLS, its server and notifications socket
// (http.ts, notifications.ts).
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'undici'
import {
  ACCESS_EVENT_REMOTE_UNLOCK,
  AccessDoorListResponseSchema,
  AccessDoorResponseSchema,
  AccessEmergencyStatusResponseSchema,
  AccessErrorEnvelopeSchema,
  AccessLockRuleResponseSchema,
  AccessNotificationSchema,
  AccessOkResponseSchema,
  AccessRemoteUnlockDataSchema,
  AccessUnlockResponseSchema,
} from '../../src/main/access/types'
import { createPinnedAgent } from '../../src/main/tls/pinning'
import {
  MOCK_FAILURE_CODE,
  MOCK_HEADER,
  MOCK_HUB_ID,
  NOTIFICATIONS_PATH,
  adminPath,
  createAccessMock,
  remoteUnlockNotification,
  routePath,
  tokenMatches,
} from '../../scripts/mock-access/app.ts'
import type {
  AccessMock,
  MockNotification,
  MockRequest,
  MockResponse,
} from '../../scripts/mock-access/app.ts'
import {
  DEFAULT_UNLOCK_MS,
  FAR_FUTURE_ENDED_TIME,
  NO_LOCK_RULE,
  SEED_DOORS,
  createDoorStore,
} from '../../scripts/mock-access/doors.ts'
import type { DoorChange } from '../../scripts/mock-access/doors.ts'
import { createMockServer } from '../../scripts/mock-access/http.ts'
import type { MockServer } from '../../scripts/mock-access/http.ts'
import {
  WS_OPCODE,
  acceptKey,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  encodeText,
  isValidKey,
} from '../../scripts/mock-access/ws.ts'

const TOKEN = 'unit-test-token'
const BASE = '/api/v1/developer'
const FRONT = SEED_DOORS.find((d) => d.name === 'Front Door')
const OFFICE = SEED_DOORS.find((d) => d.name === 'Office')
const UNBOUND = SEED_DOORS.find((d) => !d.is_bind_hub)
if (FRONT === undefined || OFFICE === undefined || UNBOUND === undefined)
  throw new Error('seed doors changed')
/** A fixed wall clock so `ended_time` values are exact: 2026-11-18T10:00:00Z. */
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0)
const T0_S = T0 / 1000

function req(method: string, path: string, init: Partial<MockRequest> = {}): MockRequest {
  return {
    method,
    url: `${BASE}${path}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    body: '',
    ...init,
  }
}

/** A request to a mock-only control route (outside the API prefix). */
function admin(path: string, init: Partial<MockRequest> = {}): MockRequest {
  return {
    method: 'POST',
    url: `/__mock${path}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    body: '',
    ...init,
  }
}

let mock: AccessMock
const relay = (id: string): string | undefined => mock.store.get(id)?.door_lock_relay_status
const relays = (): string[] => mock.store.list().map((d) => d.door_lock_relay_status)
const putRule = (id: string, body: unknown): MockResponse =>
  mock.handle(req('PUT', `/doors/${id}/lock_rule`, { body: JSON.stringify(body) }))
const getRule = (id: string): { type: string; ended_time?: number | undefined } =>
  AccessLockRuleResponseSchema.parse(mock.handle(req('GET', `/doors/${id}/lock_rule`)).body).data
const putEmergency = (body: unknown): MockResponse =>
  mock.handle(req('PUT', '/doors/settings/emergency', { body: JSON.stringify(body) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  mock = createAccessMock({ token: TOKEN })
})

afterEach(() => {
  mock.store.dispose()
  vi.useRealTimers()
})

describe('mock header', () => {
  it('every response carries x-view-protect-mock: 1 (success, auth error, unknown path)', () => {
    expect(MOCK_HEADER).toBe('x-view-protect-mock')
    const responses = [
      mock.handle(req('GET', '/doors')),
      mock.handle(req('GET', '/doors', { headers: {} })),
      mock.handle(req('GET', '/nope')),
      mock.handle({ method: 'GET', url: '/elsewhere', headers: {}, body: '' }),
      mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`)),
      mock.handle(req('PUT', `/doors/${UNBOUND.id}/unlock`)),
    ]
    for (const r of responses) expect(r.headers[MOCK_HEADER]).toBe('1')
  })
})

describe('helpers', () => {
  it('tokenMatches needs the exact Bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokenMatches('Bearer ', TOKEN)).toBe(false)
    expect(tokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
  })

  it('routePath strips the API prefix, query and trailing slash', () => {
    expect(routePath(`${BASE}/doors`)).toBe('/doors')
    expect(routePath(`${BASE}/doors/?a=1`)).toBe('/doors')
    expect(routePath(BASE)).toBe('/')
    expect(routePath('/api/v1/developerx/doors')).toBeUndefined()
    expect(routePath('/doors')).toBeUndefined()
  })

  it('refuses an empty token', () => {
    expect(() => createAccessMock({ token: '' })).toThrow()
  })
})

describe('auth', () => {
  it.each([
    ['missing', {}],
    ['wrong', { authorization: 'Bearer nope' }],
    ['not Bearer', { authorization: TOKEN }],
  ])('%s token -> 401 error envelope', (_label, headers) => {
    const res = mock.handle(req('GET', '/doors', { headers }))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CODE_ACCESS_TOKEN_INVALID')
    expect(AccessErrorEnvelopeSchema.safeParse(res.body).success).toBe(true)
  })

  it('checks auth before routing, so unknown doors do not leak to anonymous callers', () => {
    const res = mock.handle(req('GET', '/doors/nope', { headers: {} }))
    expect(res.status).toBe(401)
  })

  it('unknown paths outside the API prefix -> 404', () => {
    const res = mock.handle({ ...req('GET', ''), url: '/other' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CODE_RESOURCE_NOT_FOUND')
  })
})

describe('GET /doors and /doors/{id}', () => {
  it('lists the seed doors in the community envelope', () => {
    const res = mock.handle(req('GET', '/doors'))
    expect(res.status).toBe(200)
    const parsed = AccessDoorListResponseSchema.parse(res.body)
    expect(parsed.data.map((d) => d.name)).toEqual(SEED_DOORS.map((d) => d.name))
    expect(parsed.data.every((d) => d.door_lock_relay_status === 'lock')).toBe(true)
  })

  it('gets one door', () => {
    const res = mock.handle(req('GET', `/doors/${FRONT.id}`))
    expect(AccessDoorResponseSchema.parse(res.body).data).toEqual(FRONT)
  })

  it('unknown door id -> CODE_NOT_EXISTS', () => {
    const res = mock.handle(req('GET', '/doors/00000000-0000-4000-8000-000000000000'))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CODE_NOT_EXISTS')
  })

  it('malformed id escape -> CODE_PARAMS_INVALID, not a crash', () => {
    const res = mock.handle(req('GET', '/doors/%E0%A4%A'))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CODE_PARAMS_INVALID')
  })

  it('wrong method -> 405', () => {
    expect(mock.handle(req('POST', '/doors')).status).toBe(405)
    expect(mock.handle(req('GET', `/doors/${FRONT.id}/unlock`)).status).toBe(405)
  })

  it('returned doors are copies: callers cannot mutate the store', () => {
    const res = mock.handle(req('GET', '/doors'))
    const doors = AccessDoorListResponseSchema.parse(res.body).data
    const first = doors[0]
    if (first) first.name = 'changed'
    expect(mock.store.list()[0]?.name).toBe(SEED_DOORS[0]?.name)
  })
})

describe('PUT /doors/{id}/unlock', () => {
  it('unlocks, then reverts the relay to lock after 5 s', () => {
    const res = mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(res.status).toBe(200)
    expect(AccessUnlockResponseSchema.parse(res.body).data).toBe('success')
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS - 1)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(1)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('a second unlock restarts the 5 s window', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    vi.advanceTimersByTime(3000)
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    vi.advanceTimersByTime(3000)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(2000)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('only the unlocked door changes', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    const others = mock.store.list().filter((d) => d.id !== FRONT.id)
    expect(others.every((d) => d.door_lock_relay_status === 'lock')).toBe(true)
  })

  it('honours a custom unlock duration', () => {
    mock.store.dispose()
    mock = createAccessMock({ token: TOKEN, unlockMs: 1000 })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    vi.advanceTimersByTime(1000)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('accepts the optional actor body', () => {
    const body = JSON.stringify({ actor_id: 'vp', actor_name: 'View Protect', extra: { a: 1 } })
    expect(mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`, { body })).status).toBe(200)
  })

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '[1]'],
    ['actor_id without actor_name', JSON.stringify({ actor_id: 'x' })],
    ['unknown field', JSON.stringify({ door: 'x' })],
    ['extra not an object', JSON.stringify({ extra: 'x' })],
  ])('malformed body (%s) -> CODE_PARAMS_INVALID, door stays locked', (_label, body) => {
    const res = mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`, { body }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CODE_PARAMS_INVALID')
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('unknown door -> CODE_NOT_EXISTS', () => {
    const res = mock.handle(req('PUT', '/doors/00000000-0000-4000-8000-000000000000/unlock'))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CODE_NOT_EXISTS')
  })

  it('door not bound to a hub -> CODE_OPERATION_FORBIDDEN, relay unchanged', () => {
    const res = mock.handle(req('PUT', `/doors/${UNBOUND.id}/unlock`))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CODE_OPERATION_FORBIDDEN')
    expect(relay(UNBOUND.id)).toBe('lock')
  })

  it('dispose cancels pending reverts', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    mock.store.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('--fail-rate', () => {
  it('injects 500s for authenticated requests only', () => {
    mock.store.dispose()
    mock = createAccessMock({ token: TOKEN, failRate: 0.5, random: () => 0.1 })
    const res = mock.handle(req('GET', '/doors'))
    expect(res.status).toBe(500)
    expect(res.body.code).toBe(MOCK_FAILURE_CODE)
    expect(mock.handle(req('GET', '/doors', { headers: {} })).status).toBe(401)
    // An injected failure on unlock must not unlock.
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('passes when the draw is above the rate', () => {
    mock.store.dispose()
    mock = createAccessMock({ token: TOKEN, failRate: 0.5, random: () => 0.9 })
    expect(mock.handle(req('GET', '/doors')).status).toBe(200)
  })
})

describe('unlock query parameters (reference §7.9)', () => {
  it('accepts and ignores reader_id, entry_method and control_cmd', () => {
    const res = mock.handle(
      req('PUT', `/doors/${FRONT.id}/unlock?reader_id=r1&entry_method=in&control_cmd=open`),
    )
    expect(res.status).toBe(200)
    expect(relay(FRONT.id)).toBe('unlock')
  })
})

describe("PUT/GET /doors/{id}/lock_rule (interactions are the mock's own choice)", () => {
  it('no rule answers { type: "", ended_time: 0 } (undocumented, mock guess)', () => {
    const res = mock.handle(req('GET', `/doors/${FRONT.id}/lock_rule`))
    expect(res.status).toBe(200)
    expect(AccessLockRuleResponseSchema.parse(res.body).data).toEqual(NO_LOCK_RULE)
  })

  it('keep_unlock holds the relay at unlock until reset', () => {
    const res = putRule(FRONT.id, { type: 'keep_unlock' })
    expect(res.status).toBe(200)
    expect(AccessOkResponseSchema.parse(res.body).data).toBe('success')
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(24 * 3600_000)
    expect(relay(FRONT.id)).toBe('unlock')
    expect(getRule(FRONT.id)).toEqual({ type: 'keep_unlock', ended_time: FAR_FUTURE_ENDED_TIME })
    expect(putRule(FRONT.id, { type: 'reset' }).status).toBe(200)
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    expect(relay(OFFICE.id)).toBe('lock')
  })

  it('an unlock during keep_unlock succeeds and the relay stays unlock afterwards', () => {
    putRule(FRONT.id, { type: 'keep_unlock' })
    expect(mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`)).status).toBe(200)
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS + 1)
    expect(relay(FRONT.id)).toBe('unlock')
  })

  it('keep_lock locks, cancels a running unlock and refuses remote unlock', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(relay(FRONT.id)).toBe('unlock')
    putRule(FRONT.id, { type: 'keep_lock' })
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual({ type: 'keep_lock', ended_time: FAR_FUTURE_ENDED_TIME })
    const res = mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CODE_OPERATION_FORBIDDEN')
    expect(relay(FRONT.id)).toBe('lock')
    putRule(FRONT.id, { type: 'reset' })
    expect(mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`)).status).toBe(200)
  })

  it('custom unlocks for `interval` minutes, then locks and drops the rule', () => {
    expect(putRule(FRONT.id, { type: 'custom', interval: 10 }).status).toBe(200)
    expect(relay(FRONT.id)).toBe('unlock')
    expect(getRule(FRONT.id)).toEqual({ type: 'custom', ended_time: T0_S + 600 })
    vi.advanceTimersByTime(600_000 - 1)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(1)
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
  })

  it('a momentary unlock inside a custom rule falls back to the rule, not to lock', () => {
    putRule(FRONT.id, { type: 'custom', interval: 1 })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS + 1)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(60_000)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('a custom interval longer than one timer can hold still ends on time', () => {
    const minutes = 40 * 24 * 60
    putRule(FRONT.id, { type: 'custom', interval: minutes })
    vi.advanceTimersByTime(1000)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(minutes * 60_000 - 1001)
    expect(relay(FRONT.id)).toBe('unlock')
    vi.advanceTimersByTime(1)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('reset ends custom early; a new rule replaces the old one and its timer', () => {
    putRule(FRONT.id, { type: 'custom', interval: 1 })
    putRule(FRONT.id, { type: 'keep_unlock' })
    vi.advanceTimersByTime(120_000)
    expect(relay(FRONT.id)).toBe('unlock')
    putRule(FRONT.id, { type: 'custom', interval: 5 })
    putRule(FRONT.id, { type: 'reset' })
    expect(relay(FRONT.id)).toBe('lock')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lock_early locks and reads as lock_early until the next UTC midnight; reset leaves it', () => {
    putRule(FRONT.id, { type: 'keep_unlock' })
    expect(putRule(FRONT.id, { type: 'lock_early' }).status).toBe(200)
    expect(relay(FRONT.id)).toBe('lock')
    const midnight = Date.UTC(2026, 10, 19) / 1000
    expect(getRule(FRONT.id)).toEqual({ type: 'lock_early', ended_time: midnight })
    putRule(FRONT.id, { type: 'reset' })
    expect(getRule(FRONT.id).type).toBe('lock_early')
    // A remote unlock still works under lock_early.
    expect(mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`)).status).toBe(200)
    vi.advanceTimersByTime(14 * 3600_000)
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    expect(relay(FRONT.id)).toBe('lock')
  })

  describe('an unlock schedule (P5.6, started by the mock-only control)', () => {
    it('reads as relay unlock and rule schedule until it ends, then no rule', () => {
      mock.store.startSchedule(FRONT.id, 90)
      expect(relay(FRONT.id)).toBe('unlock')
      expect(getRule(FRONT.id)).toEqual({ type: 'schedule', ended_time: T0_S + 90 * 60 })
      // Only that door.
      expect(relay(OFFICE.id)).toBe('lock')
      vi.advanceTimersByTime(90 * 60_000 - 1)
      expect(relay(FRONT.id)).toBe('unlock')
      vi.advanceTimersByTime(1)
      expect(relay(FRONT.id)).toBe('lock')
      expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    })

    it('lock_early ends it now and reads as lock_early until the schedule would have ended', () => {
      mock.store.startSchedule(FRONT.id, 120)
      expect(putRule(FRONT.id, { type: 'lock_early' }).status).toBe(200)
      expect(relay(FRONT.id)).toBe('lock')
      expect(getRule(FRONT.id)).toEqual({ type: 'lock_early', ended_time: T0_S + 120 * 60 })
      vi.advanceTimersByTime(120 * 60_000)
      expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
      expect(relay(FRONT.id)).toBe('lock')
    })

    it('reset leaves it alone: reset is not for schedules (§7.10)', () => {
      mock.store.startSchedule(FRONT.id, 60)
      expect(putRule(FRONT.id, { type: 'reset' }).status).toBe(200)
      expect(relay(FRONT.id)).toBe('unlock')
      expect(getRule(FRONT.id).type).toBe('schedule')
    })

    it('lock_now ends it and locks', () => {
      mock.store.startSchedule(FRONT.id, 60)
      putRule(FRONT.id, { type: 'lock_now' })
      expect(relay(FRONT.id)).toBe('lock')
      expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a rule set through the API replaces it, and a momentary unlock falls back to it', () => {
      mock.store.startSchedule(FRONT.id, 60)
      mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
      vi.advanceTimersByTime(DEFAULT_UNLOCK_MS)
      // The pulse ended; the schedule still holds the door unlocked.
      expect(relay(FRONT.id)).toBe('unlock')
      putRule(FRONT.id, { type: 'keep_lock' })
      expect(relay(FRONT.id)).toBe('lock')
      expect(getRule(FRONT.id).type).toBe('keep_lock')
      // The schedule's own expiry timer went with it.
      vi.advanceTimersByTime(60 * 60_000)
      expect(getRule(FRONT.id).type).toBe('keep_lock')
    })

    it('reads lock under lockdown and comes back when it is lifted', () => {
      mock.store.startSchedule(FRONT.id, 60)
      putEmergency({ lockdown: true, evacuation: false })
      expect(relay(FRONT.id)).toBe('lock')
      expect(getRule(FRONT.id).type).toBe('schedule')
      putEmergency({ lockdown: false, evacuation: false })
      expect(relay(FRONT.id)).toBe('unlock')
    })

    it('reports the rule and the relay change, and pushes nothing (no documented event)', () => {
      const changes: DoorChange[] = []
      const frames: MockNotification[] = []
      mock.store.onChange((change) => changes.push(change))
      mock.onNotification((frame) => frames.push(frame))
      mock.store.startSchedule(FRONT.id, 30)
      expect(changes).toEqual([
        { kind: 'rule', doorId: FRONT.id, rule: { type: 'schedule', ended_time: T0_S + 1800 } },
        { kind: 'relay', doorId: FRONT.id, relay: 'unlock' },
      ])
      expect(frames).toEqual([])
    })

    it('throws for an unknown door', () => {
      expect(() => {
        mock.store.startSchedule('nope', 10)
      }).toThrow()
    })
  })

  it('lock_now ends the rule and a running unlock', () => {
    putRule(FRONT.id, { type: 'lock_early' })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(relay(FRONT.id)).toBe('unlock')
    expect(putRule(FRONT.id, { type: 'lock_now' }).status).toBe(200)
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    expect(vi.getTimerCount()).toBe(0)
    putRule(FRONT.id, { type: 'keep_unlock' })
    putRule(FRONT.id, { type: 'lock_now' })
    expect(relay(FRONT.id)).toBe('lock')
  })

  it.each([
    ['empty body', ''],
    ['not JSON', '{nope'],
    ['unknown type', JSON.stringify({ type: 'open_sesame' })],
    ['custom without interval', JSON.stringify({ type: 'custom' })],
    ['interval on keep_unlock', JSON.stringify({ type: 'keep_unlock', interval: 5 })],
    ['interval not a positive integer', JSON.stringify({ type: 'custom', interval: 0 })],
    ['unknown field', JSON.stringify({ type: 'reset', door: 'x' })],
  ])('invalid body (%s) -> CODE_PARAMS_INVALID, nothing changes', (_label, body) => {
    const res = mock.handle(req('PUT', `/doors/${FRONT.id}/lock_rule`, { body }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CODE_PARAMS_INVALID')
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
  })

  it('unknown door -> CODE_NOT_EXISTS; unbound door -> CODE_OPERATION_FORBIDDEN on PUT only', () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect(mock.handle(req('GET', `/doors/${missing}/lock_rule`)).body.code).toBe('CODE_NOT_EXISTS')
    expect(putRule(missing, { type: 'keep_unlock' }).status).toBe(404)
    const res = putRule(UNBOUND.id, { type: 'keep_unlock' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CODE_OPERATION_FORBIDDEN')
    expect(relay(UNBOUND.id)).toBe('lock')
    expect(mock.handle(req('GET', `/doors/${UNBOUND.id}/lock_rule`)).status).toBe(200)
  })

  it('wrong method -> 405; malformed id -> 400; no token -> 401', () => {
    expect(mock.handle(req('POST', `/doors/${FRONT.id}/lock_rule`)).status).toBe(405)
    expect(mock.handle(req('GET', '/doors/%E0%A4%A/lock_rule')).status).toBe(400)
    expect(mock.handle(req('GET', `/doors/${FRONT.id}/lock_rule`, { headers: {} })).status).toBe(
      401,
    )
  })

  it('a door seeded with relay unlock starts under keep_unlock', () => {
    const store = createDoorStore({ doors: [{ ...FRONT, door_lock_relay_status: 'unlock' }] })
    expect(store.get(FRONT.id)?.door_lock_relay_status).toBe('unlock')
    expect(store.lockRule(FRONT.id).type).toBe('keep_unlock')
    store.lock(FRONT.id)
    expect(store.get(FRONT.id)?.door_lock_relay_status).toBe('lock')
    store.dispose()
  })
})

describe('PUT/GET /doors/settings/emergency', () => {
  it('starts with both flags false', () => {
    const res = mock.handle(req('GET', '/doors/settings/emergency'))
    expect(res.status).toBe(200)
    expect(AccessEmergencyStatusResponseSchema.parse(res.body).data).toEqual({
      lockdown: false,
      evacuation: false,
    })
  })

  it('is not taken for a door called "settings"', () => {
    expect(mock.handle(req('GET', '/doors/settings/emergency/')).status).toBe(200)
    // One segment short, `settings` is just an unknown door id.
    const res = mock.handle(req('GET', '/doors/settings'))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CODE_NOT_EXISTS')
    expect(mock.handle(req('GET', '/doors/settings/lock_rule')).body.code).toBe('CODE_NOT_EXISTS')
    expect(mock.handle(req('GET', '/doors/settings/emergency/x')).body.code).toBe(
      'CODE_RESOURCE_NOT_FOUND',
    )
    expect(mock.handle(req('POST', '/doors/settings/emergency')).status).toBe(405)
    expect(mock.handle(req('GET', '/doors/settings/emergency', { headers: {} })).status).toBe(401)
  })

  it('evacuation: every relay reads unlock; both false: doors return to their own state', () => {
    putRule(OFFICE.id, { type: 'keep_unlock' })
    const res = putEmergency({ lockdown: false, evacuation: true })
    expect(res.status).toBe(200)
    expect(AccessOkResponseSchema.parse(res.body).data).toBe('success')
    expect(relays()).toEqual(['unlock', 'unlock', 'unlock', 'unlock'])
    expect(
      AccessEmergencyStatusResponseSchema.parse(
        mock.handle(req('GET', '/doors/settings/emergency')).body,
      ).data,
    ).toEqual({ lockdown: false, evacuation: true })
    putEmergency({ lockdown: false, evacuation: false })
    expect(relay(FRONT.id)).toBe('lock')
    expect(relay(OFFICE.id)).toBe('unlock')
  })

  it('lockdown: every relay reads lock and unlock is refused, even under keep_unlock', () => {
    putRule(OFFICE.id, { type: 'keep_unlock' })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    putEmergency({ lockdown: true, evacuation: false })
    expect(relays()).toEqual(['lock', 'lock', 'lock', 'lock'])
    const res = mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CODE_OPERATION_FORBIDDEN')
    expect(mock.handle(admin(`/doors/${FRONT.id}/unlock`)).status).toBe(403)
    putEmergency({ lockdown: false, evacuation: false })
    expect(relay(OFFICE.id)).toBe('unlock')
  })

  it('a custom rule keeps running under lockdown and may end there', () => {
    putRule(FRONT.id, { type: 'custom', interval: 1 })
    putEmergency({ lockdown: true, evacuation: false })
    vi.advanceTimersByTime(60_000)
    putEmergency({ lockdown: false, evacuation: false })
    expect(relay(FRONT.id)).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
  })

  it.each([
    ['both true (mock choice)', JSON.stringify({ lockdown: true, evacuation: true })],
    ['a flag missing', JSON.stringify({ lockdown: true })],
    ['not booleans', JSON.stringify({ lockdown: 'yes', evacuation: false })],
    ['unknown field', JSON.stringify({ lockdown: false, evacuation: false, x: 1 })],
    ['empty body', ''],
  ])('invalid body (%s) -> CODE_PARAMS_INVALID, nothing changes', (_label, body) => {
    const res = mock.handle(req('PUT', '/doors/settings/emergency', { body }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CODE_PARAMS_INVALID')
    expect(mock.store.emergency()).toEqual({ lockdown: false, evacuation: false })
  })
})

describe('change hook (store.onChange)', () => {
  it('reports the unlock with its source, then each relay change, timers included', () => {
    const seen: DoorChange[] = []
    const off = mock.store.onChange((c) => seen.push(c))
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(seen).toEqual([
      { kind: 'unlock', doorId: FRONT.id, source: 'remote' },
      { kind: 'relay', doorId: FRONT.id, relay: 'unlock' },
    ])
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS)
    expect(seen[2]).toEqual({ kind: 'relay', doorId: FRONT.id, relay: 'lock' })
    seen.length = 0
    mock.handle(admin(`/doors/${FRONT.id}/unlock`))
    expect(seen[0]).toEqual({ kind: 'unlock', doorId: FRONT.id, source: 'local' })
    off()
    seen.length = 0
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(seen).toEqual([])
  })

  it('reports rule, emergency and position changes; a refused unlock reports nothing', () => {
    const seen: DoorChange[] = []
    mock.store.onChange((c) => seen.push(c))
    putRule(FRONT.id, { type: 'keep_lock' })
    expect(seen).toEqual([
      {
        kind: 'rule',
        doorId: FRONT.id,
        rule: { type: 'keep_lock', ended_time: FAR_FUTURE_ENDED_TIME },
      },
    ])
    seen.length = 0
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(seen).toEqual([])
    putEmergency({ lockdown: false, evacuation: true })
    expect(seen[0]).toEqual({ kind: 'emergency', status: { lockdown: false, evacuation: true } })
    expect(seen.filter((c) => c.kind === 'relay')).toHaveLength(SEED_DOORS.length)
    seen.length = 0
    mock.handle(admin(`/doors/${FRONT.id}/position?status=open`))
    mock.handle(admin(`/doors/${FRONT.id}/position?status=open`))
    expect(seen).toEqual([{ kind: 'position', doorId: FRONT.id, position: 'open' }])
  })
})

describe('notifications (what the WebSocket pushes)', () => {
  let frames: MockNotification[]
  beforeEach(() => {
    frames = []
    mock.onNotification((f) => frames.push(f))
  })

  it('a successful PUT unlock pushes one documented remote_unlock frame', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    expect(Object.keys(frame ?? {}).sort()).toEqual([
      'data',
      'event',
      'event_object_id',
      'receiver_id',
      'save_to_history',
    ])
    const parsed = AccessNotificationSchema.parse(frame)
    expect(parsed.event).toBe(ACCESS_EVENT_REMOTE_UNLOCK)
    expect(parsed.event_object_id).toBe(MOCK_HUB_ID)
    expect(AccessRemoteUnlockDataSchema.parse(parsed.data)).toEqual({
      unique_id: FRONT.id,
      name: 'Front Door',
      location_type: 'door',
    })
    expect(frame).toEqual(remoteUnlockNotification(FRONT))
    expect(Object.keys(frame?.data ?? {}).sort()).toEqual([
      'extra_type',
      'extras',
      'full_name',
      'level',
      'location_type',
      'name',
      'timezone',
      'unique_id',
      'up_id',
      'work_time',
      'work_time_id',
    ])
  })

  it('NOTHING is pushed on relock, nor for rules, emergency, position or refused unlocks', () => {
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    frames.length = 0
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS)
    expect(relay(FRONT.id)).toBe('lock')
    putRule(FRONT.id, { type: 'keep_unlock' })
    putRule(FRONT.id, { type: 'lock_now' })
    putEmergency({ lockdown: false, evacuation: true })
    putEmergency({ lockdown: true, evacuation: false })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    putEmergency({ lockdown: false, evacuation: false })
    mock.handle(req('PUT', `/doors/${UNBOUND.id}/unlock`))
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`, { headers: {} }))
    mock.handle(admin(`/doors/${FRONT.id}/position?status=open`))
    mock.handle(admin(`/doors/${FRONT.id}/lock`))
    expect(frames).toEqual([])
  })

  it('unsubscribing stops the frames', () => {
    const more: MockNotification[] = []
    const off = mock.onNotification((f) => more.push(f))
    off()
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    expect(more).toEqual([])
    expect(frames).toHaveLength(1)
  })
})

describe('mock-only control routes (/__mock)', () => {
  let frames: MockNotification[]
  beforeEach(() => {
    frames = []
    mock.onNotification((f) => frames.push(f))
  })

  it('adminPath only matches the /__mock prefix', () => {
    expect(adminPath('/__mock/doors/x/lock?a=1')).toBe('/doors/x/lock')
    expect(adminPath('/__mockery')).toBeUndefined()
    expect(adminPath(`${BASE}/__mock/doors`)).toBeUndefined()
  })

  it.each([
    ['missing', {}],
    ['wrong', { authorization: 'Bearer nope' }],
  ])('%s token -> 401 with the mock header, nothing happens', (_label, headers) => {
    for (const path of [
      `/doors/${FRONT.id}/unlock`,
      `/doors/${FRONT.id}/lock`,
      `/doors/${FRONT.id}/position?status=open`,
      '/notifications/drop',
      '/nope',
    ]) {
      const res = mock.handle(admin(path, { headers }))
      expect(res.status).toBe(401)
      expect(res.body.code).toBe('CODE_ACCESS_TOKEN_INVALID')
      expect(res.headers[MOCK_HEADER]).toBe('1')
    }
    expect(mock.store.get(FRONT.id)).toEqual(FRONT)
  })

  it('unlock is silent by default: the relay opens and no frame is pushed', () => {
    const res = mock.handle(admin(`/doors/${FRONT.id}/unlock`))
    expect(res.status).toBe(200)
    expect(res.headers[MOCK_HEADER]).toBe('1')
    expect(AccessDoorResponseSchema.parse(res.body).data.door_lock_relay_status).toBe('unlock')
    expect(frames).toEqual([])
    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('unlock?push=1 also pushes the remote_unlock frame', () => {
    mock.handle(admin(`/doors/${FRONT.id}/unlock?push=1`))
    expect(frames.map((f) => f.event)).toEqual([ACCESS_EVENT_REMOTE_UNLOCK])
    expect(relay(FRONT.id)).toBe('unlock')
  })

  it('unlock is refused under keep_lock, and works on a door without a hub', () => {
    putRule(FRONT.id, { type: 'keep_lock' })
    const res = mock.handle(admin(`/doors/${FRONT.id}/unlock?push=1`))
    expect(res.status).toBe(403)
    expect(frames).toEqual([])
    expect(mock.handle(admin(`/doors/${UNBOUND.id}/unlock`)).status).toBe(200)
  })

  it('lock ends a running unlock and any rule', () => {
    putRule(FRONT.id, { type: 'keep_unlock' })
    mock.handle(req('PUT', `/doors/${FRONT.id}/unlock`))
    const res = mock.handle(admin(`/doors/${FRONT.id}/lock`))
    expect(AccessDoorResponseSchema.parse(res.body).data.door_lock_relay_status).toBe('lock')
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedule puts the door inside an unlock schedule, for an hour unless told otherwise (P5.6)', () => {
    const res = mock.handle(admin(`/doors/${FRONT.id}/schedule`))
    expect(res.status).toBe(200)
    expect(res.headers[MOCK_HEADER]).toBe('1')
    expect(AccessDoorResponseSchema.parse(res.body).data.door_lock_relay_status).toBe('unlock')
    expect(getRule(FRONT.id)).toEqual({ type: 'schedule', ended_time: T0_S + 3600 })
    mock.handle(admin(`/doors/${OFFICE.id}/schedule?minutes=5`))
    expect(getRule(OFFICE.id)).toEqual({ type: 'schedule', ended_time: T0_S + 300 })
    // It happens "at the door": no frame, like a card tap.
    expect(frames).toEqual([])
    // And the app's Lock for it (lock_early) is the documented API.
    expect(putRule(FRONT.id, { type: 'lock_early' }).status).toBe(200)
    expect(relay(FRONT.id)).toBe('lock')
  })

  it('schedule needs a whole number of minutes from 1 to 1440', () => {
    for (const q of [
      '?minutes=0',
      '?minutes=-5',
      '?minutes=1441',
      '?minutes=1.5',
      '?minutes=soon',
      '?minutes=',
    ]) {
      const bad = mock.handle(admin(`/doors/${FRONT.id}/schedule${q}`))
      expect(bad.status, q).toBe(400)
      expect(bad.body.code).toBe('CODE_PARAMS_INVALID')
    }
    expect(getRule(FRONT.id)).toEqual(NO_LOCK_RULE)
    expect(mock.handle(admin(`/doors/${FRONT.id}/schedule?minutes=1440`)).status).toBe(200)
    expect(mock.handle(admin(`/doors/${FRONT.id}/schedule`, { method: 'GET' })).status).toBe(405)
    expect(mock.handle(admin(`/doors/${FRONT.id}/schedule`, { headers: {} })).status).toBe(401)
    expect(
      mock.handle(admin('/doors/00000000-0000-4000-8000-000000000000/schedule')).body.code,
    ).toBe('CODE_NOT_EXISTS')
  })

  it('position sets door_position_status and needs open or close', () => {
    const res = mock.handle(admin(`/doors/${FRONT.id}/position?status=open`))
    expect(AccessDoorResponseSchema.parse(res.body).data.door_position_status).toBe('open')
    mock.handle(admin(`/doors/${FRONT.id}/position?status=close`))
    expect(mock.store.get(FRONT.id)?.door_position_status).toBe('close')
    for (const q of ['', '?status=ajar', '?state=open']) {
      const bad = mock.handle(admin(`/doors/${FRONT.id}/position${q}`))
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('CODE_PARAMS_INVALID')
    }
  })

  it('notifications/drop calls the registered handler and reports the count', () => {
    expect(mock.handle(admin('/notifications/drop')).body.data).toEqual({ closed: 0 })
    const off = mock.onDropClients(() => 3)
    expect(mock.handle(admin('/notifications/drop')).body.data).toEqual({ closed: 3 })
    off()
    expect(mock.handle(admin('/notifications/drop')).body.data).toEqual({ closed: 0 })
  })

  it('unknown door -> 404 CODE_NOT_EXISTS; unknown route -> 404; wrong method -> 405', () => {
    const missing = mock.handle(admin('/doors/00000000-0000-4000-8000-000000000000/unlock'))
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('CODE_NOT_EXISTS')
    expect(mock.handle(admin('/doors')).body.code).toBe('CODE_RESOURCE_NOT_FOUND')
    expect(mock.handle(admin(`/doors/${FRONT.id}/explode`)).status).toBe(404)
    expect(mock.handle(admin(`/doors/${FRONT.id}/unlock`, { method: 'GET' })).status).toBe(405)
    expect(mock.handle(admin('/notifications/drop', { method: 'GET' })).status).toBe(405)
    expect(mock.handle(admin('/doors/%E0%A4%A/lock')).status).toBe(400)
  })

  it('is not reachable below the API prefix, and --fail-rate does not hit it', () => {
    expect(mock.handle(req('POST', `/__mock/doors/${FRONT.id}/unlock`)).status).toBe(404)
    mock.store.dispose()
    mock = createAccessMock({ token: TOKEN, failRate: 1, random: () => 0 })
    expect(mock.handle(admin(`/doors/${FRONT.id}/unlock`)).status).toBe(200)
  })
})

describe('WebSocket upgrade decision (authorizeUpgrade)', () => {
  const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
  function upgrade(init: Partial<MockRequest> = {}): MockRequest {
    return {
      method: 'GET',
      url: NOTIFICATIONS_PATH,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': KEY,
        'sec-websocket-version': '13',
      },
      body: '',
      ...init,
    }
  }

  it('accepts the notifications path with the token', () => {
    expect(NOTIFICATIONS_PATH).toBe('/api/v1/developer/devices/notifications')
    expect(mock.authorizeUpgrade(upgrade())).toBeUndefined()
    expect(mock.authorizeUpgrade(upgrade({ url: `${NOTIFICATIONS_PATH}?x=1` }))).toBeUndefined()
  })

  it('a missing or wrong token -> 401 CODE_ACCESS_TOKEN_INVALID with the mock header', () => {
    for (const authorization of [undefined, 'Bearer nope']) {
      const res = mock.authorizeUpgrade(
        upgrade({ headers: { ...upgrade().headers, authorization } }),
      )
      expect(res?.status).toBe(401)
      expect(res?.body.code).toBe('CODE_ACCESS_TOKEN_INVALID')
      expect(res?.headers[MOCK_HEADER]).toBe('1')
    }
  })

  it('another path -> 404; a bad handshake -> 400', () => {
    expect(mock.authorizeUpgrade(upgrade({ url: `${BASE}/doors` }))?.status).toBe(404)
    expect(mock.authorizeUpgrade(upgrade({ url: '/devices/notifications' }))?.status).toBe(404)
    expect(mock.authorizeUpgrade(upgrade({ method: 'POST' }))?.status).toBe(405)
    const h = upgrade().headers
    for (const headers of [
      { ...h, upgrade: 'h2c' },
      { ...h, 'sec-websocket-key': undefined },
      { ...h, 'sec-websocket-key': 'short' },
      { ...h, 'sec-websocket-version': '8' },
    ]) {
      const res = mock.authorizeUpgrade(upgrade({ headers }))
      expect(res?.status).toBe(400)
      expect(res?.body.code).toBe('CODE_PARAMS_INVALID')
    }
  })

  it('a plain GET of the notifications path asks for the upgrade', () => {
    const res = mock.handle(req('GET', '/devices/notifications'))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CODE_PARAMS_INVALID')
  })
})

describe('WebSocket codec (ws.ts)', () => {
  const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d])

  it('acceptKey matches the RFC 6455 §1.3 example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    expect(acceptKey(' dGhlIHNhbXBsZSBub25jZQ== ')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    expect(isValidKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe(true)
    expect(isValidKey(undefined)).toBe(false)
    expect(isValidKey('nope')).toBe(false)
  })

  it('encodes the RFC 6455 §5.7 examples', () => {
    expect(encodeText('Hello')).toEqual(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]))
    expect(encodeFrame(WS_OPCODE.text, Buffer.from('Hello'), MASK)).toEqual(
      Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]),
    )
    expect(encodeFrame(WS_OPCODE.ping, Buffer.from('Hello')).subarray(0, 2)).toEqual(
      Buffer.from([0x89, 0x05]),
    )
    expect(() => encodeFrame(WS_OPCODE.text, Buffer.alloc(1), Buffer.alloc(3))).toThrow()
  })

  it.each([
    [0, 2],
    [125, 2],
    [126, 4],
    [65535, 4],
    [65536, 10],
    [70000, 10],
  ])('a %i-byte payload gets a %i-byte header and round-trips', (size, header) => {
    const payload = Buffer.alloc(size, 0x61)
    const frame = encodeFrame(WS_OPCODE.text, payload)
    expect(frame.length).toBe(header + size)
    expect((frame[1] ?? 0) & 0x80).toBe(0)
    const [decoded, ...rest] = createFrameDecoder().push(frame)
    expect(rest).toEqual([])
    expect(decoded).toMatchObject({ fin: true, opcode: WS_OPCODE.text, masked: false })
    expect(decoded?.payload.equals(payload)).toBe(true)
    const [unmasked] = createFrameDecoder().push(encodeFrame(WS_OPCODE.binary, payload, MASK))
    expect(unmasked?.masked).toBe(true)
    expect(unmasked?.payload.equals(payload)).toBe(true)
  })

  it('close frames carry an optional code and reason', () => {
    expect(encodeClose()).toEqual(Buffer.from([0x88, 0x00]))
    const [f] = createFrameDecoder().push(encodeClose(1000, 'bye'))
    expect(f?.opcode).toBe(WS_OPCODE.close)
    expect(f?.payload.readUInt16BE(0)).toBe(1000)
    expect(f?.payload.subarray(2).toString()).toBe('bye')
  })

  it('decodes frames split across chunks and several frames in one chunk', () => {
    const bytes = Buffer.concat([
      encodeFrame(WS_OPCODE.ping, Buffer.from('p'), MASK),
      encodeFrame(WS_OPCODE.text, Buffer.alloc(300, 0x62), MASK),
      encodeClose(1001),
    ])
    const whole = createFrameDecoder().push(bytes)
    expect(whole.map((f) => f.opcode)).toEqual([WS_OPCODE.ping, WS_OPCODE.text, WS_OPCODE.close])
    const decoder = createFrameDecoder()
    const dripped = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])))
    expect(dripped.map((f) => f.payload.toString('hex'))).toEqual(
      whole.map((f) => f.payload.toString('hex')),
    )
  })

  it('refuses an oversized frame instead of buffering it', () => {
    const decoder = createFrameDecoder(1024)
    expect(() => decoder.push(encodeFrame(WS_OPCODE.text, Buffer.alloc(2000)))).toThrow(/large/)
    const huge = Buffer.alloc(10)
    huge[0] = 0x82
    huge[1] = 127
    huge.writeBigUInt64BE(2n ** 40n, 2)
    expect(() => createFrameDecoder().push(huge)).toThrow(/large/)
  })
})

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The server pieces `npm run mock:access` runs (http.ts + notifications.ts), on an ephemeral
// loopback port with a throwaway certificate, driven by undici's WebSocket through the app's
// pinned Agent: the same client stack the app uses.
describe.skipIf(!hasOpenssl())('over real TLS: REST, WebSocket and mock controls', () => {
  const HOST = '127.0.0.1'
  let certDir = ''
  let cert = ''
  let fingerprint256 = ''
  let running: MockServer
  let live: AccessMock
  let port = 0
  let logs: string[]
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'vp-access-mock-'))
    const certPath = join(certDir, 'cert.pem')
    const keyPath = join(certDir, 'key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=view-protect-access-mock',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    cert = readFileSync(certPath, 'utf8')
    fingerprint256 = new X509Certificate(cert).fingerprint256
    logs = []
    live = createAccessMock({ token: TOKEN, unlockMs: 50 })
    running = createMockServer({
      mock: live,
      cert,
      key: readFileSync(keyPath, 'utf8'),
      log: (line) => logs.push(line),
    })
    await new Promise<void>((resolve) => {
      running.server.listen(0, HOST, () => {
        resolve()
      })
    })
    port = (running.server.address() as AddressInfo).port
  })

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close()
  })

  afterAll(async () => {
    await running.close()
    rmSync(certDir, { recursive: true, force: true })
  })

  const agent = (): ReturnType<typeof createPinnedAgent> =>
    createPinnedAgent(fingerprint256, { endpoint: `${HOST}:${String(port)}` })

  /** Opens the notifications socket with the app's pinned dispatcher; resolves once open. */
  function connect(dispatcher: ReturnType<typeof createPinnedAgent>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${HOST}:${String(port)}${NOTIFICATIONS_PATH}`, {
        dispatcher,
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      sockets.push(ws)
      ws.addEventListener('open', () => {
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        reject(new Error('websocket failed to open'))
      })
    })
  }

  function nextMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve) => {
      ws.addEventListener(
        'message',
        (ev) => {
          resolve(JSON.parse(String(ev.data)))
        },
        { once: true },
      )
    })
  }

  /** A raw upgrade request (verified against the test certificate), to see the HTTP answer. */
  function rawUpgrade(
    path: string,
    authorization: string | undefined,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const r = httpsRequest({
        host: HOST,
        port,
        path,
        ca: cert,
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        },
      })
      r.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      r.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' })
      })
      r.on('error', reject)
      r.end()
    })
  }

  async function call(
    method: 'PUT' | 'POST',
    path: string,
  ): Promise<{ status: number; json: unknown }> {
    const dispatcher = agent()
    try {
      const res = await dispatcher.request({
        origin: `https://${HOST}:${String(port)}`,
        method,
        path,
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      return { status: res.statusCode, json: await res.body.json() }
    } finally {
      await dispatcher.close()
    }
  }

  it('handshake, then a pushed remote_unlock frame on PUT unlock, and nothing on relock', async () => {
    const dispatcher = agent()
    try {
      const ws = await connect(dispatcher)
      expect(running.hub.size()).toBe(1)
      const messages: unknown[] = []
      ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))))
      const first = nextMessage(ws)
      const res = await call('PUT', `${BASE}/doors/${FRONT.id}/unlock`)
      expect(res.status).toBe(200)
      const frame = AccessNotificationSchema.parse(await first)
      expect(frame.event).toBe(ACCESS_EVENT_REMOTE_UNLOCK)
      expect(AccessRemoteUnlockDataSchema.parse(frame.data).unique_id).toBe(FRONT.id)
      // The relay reverts (50 ms here) and the socket stays silent about it.
      await vi.waitFor(() => {
        expect(live.store.get(FRONT.id)?.door_lock_relay_status).toBe('lock')
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(messages).toHaveLength(1)
      expect(logs).toContain(`WS push ${ACCESS_EVENT_REMOTE_UNLOCK} -> 1 clients`)
      expect(logs.join('\n')).not.toContain(TOKEN)
    } finally {
      await dispatcher.close()
    }
  })

  it('the 101 carries the mock header and the right accept key', async () => {
    const res = await rawUpgrade(NOTIFICATIONS_PATH, `Bearer ${TOKEN}`)
    expect(res.status).toBe(101)
    expect(res.headers[MOCK_HEADER]).toBe('1')
    expect(res.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('a bad or missing token fails the upgrade with HTTP 401 and the error envelope', async () => {
    for (const authorization of ['Bearer nope', undefined]) {
      const res = await rawUpgrade(NOTIFICATIONS_PATH, authorization)
      expect(res.status).toBe(401)
      expect(res.headers[MOCK_HEADER]).toBe('1')
      expect(AccessErrorEnvelopeSchema.parse(JSON.parse(res.body)).code).toBe(
        'CODE_ACCESS_TOKEN_INVALID',
      )
    }
    expect(running.hub.size()).toBe(0)
    // undici's WebSocket reports it as a failed connection.
    const dispatcher = agent()
    try {
      const outcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`wss://${HOST}:${String(port)}${NOTIFICATIONS_PATH}`, {
          dispatcher,
          headers: { Authorization: 'Bearer nope' },
        })
        ws.addEventListener('open', () => {
          resolve('open')
        })
        ws.addEventListener('error', () => {
          resolve('error')
        })
      })
      expect(outcome).toBe('error')
    } finally {
      await dispatcher.close()
    }
  })

  it('answers a client ping with a pong and discards masked client data', async () => {
    const mask = Buffer.from([1, 2, 3, 4])
    const frames = await new Promise<{ opcode: number; text: string }[]>((resolve, reject) => {
      const r = httpsRequest({
        host: HOST,
        port,
        path: NOTIFICATIONS_PATH,
        ca: cert,
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          Authorization: `Bearer ${TOKEN}`,
        },
      })
      r.on('upgrade', (_res, socket) => {
        const decoder = createFrameDecoder()
        const got: { opcode: number; text: string }[] = []
        socket.on('data', (chunk: Buffer) => {
          for (const f of decoder.push(chunk))
            got.push({ opcode: f.opcode, text: f.payload.toString('utf8') })
          if (got.some((f) => f.opcode === WS_OPCODE.close)) {
            socket.destroy()
            resolve(got)
          }
        })
        socket.write(
          Buffer.concat([
            encodeFrame(WS_OPCODE.text, Buffer.from('ignored'), mask),
            encodeFrame(WS_OPCODE.ping, Buffer.from('are you there'), mask),
            encodeFrame(WS_OPCODE.close, Buffer.from([0x03, 0xe8]), mask),
          ]),
        )
      })
      r.on('error', reject)
      r.end()
    })
    expect(frames).toEqual([
      { opcode: WS_OPCODE.pong, text: 'are you there' },
      { opcode: WS_OPCODE.close, text: '\u0003\ufffd' },
    ])
    await vi.waitFor(() => {
      expect(running.hub.size()).toBe(0)
    })
  })

  it('an unknown upgrade path -> 404', async () => {
    const res = await rawUpgrade(`${BASE}/devices/elsewhere`, `Bearer ${TOKEN}`)
    expect(res.status).toBe(404)
    expect(res.headers[MOCK_HEADER]).toBe('1')
    expect((await rawUpgrade('/elsewhere', undefined)).status).toBe(404)
  })

  it('the silent card-tap control unlocks without a frame; push=1 sends one', async () => {
    const dispatcher = agent()
    try {
      const ws = await connect(dispatcher)
      const messages: unknown[] = []
      ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))))
      const silent = await call('POST', `/__mock/doors/${OFFICE.id}/unlock`)
      expect(silent.status).toBe(200)
      expect(live.store.get(OFFICE.id)?.door_lock_relay_status).toBe('unlock')
      await new Promise((r) => setTimeout(r, 80))
      expect(messages).toEqual([])
      const pushed = nextMessage(ws)
      await call('POST', `/__mock/doors/${OFFICE.id}/unlock?push=1`)
      expect(AccessNotificationSchema.parse(await pushed).event).toBe(ACCESS_EVENT_REMOTE_UNLOCK)
    } finally {
      await dispatcher.close()
    }
  })

  it('a client close gets a close frame back; notifications/drop cuts clients off', async () => {
    const dispatcher = agent()
    try {
      const ws = await connect(dispatcher)
      const closed = new Promise<{ code: number; wasClean: boolean }>((resolve) => {
        ws.addEventListener('close', (ev) => {
          resolve({ code: ev.code, wasClean: ev.wasClean })
        })
      })
      ws.close(1000)
      expect(await closed).toEqual({ code: 1000, wasClean: true })
      await vi.waitFor(() => {
        expect(running.hub.size()).toBe(0)
      })

      const second = await connect(dispatcher)
      const dropped = new Promise<boolean>((resolve) => {
        second.addEventListener('close', (ev) => {
          resolve(ev.wasClean)
        })
      })
      const res = await call('POST', '/__mock/notifications/drop')
      expect(res.json).toMatchObject({ code: 'SUCCESS', data: { closed: 1 } })
      expect(await dropped).toBe(false)
      expect(running.hub.size()).toBe(0)
      // And a client can come straight back.
      await connect(dispatcher)
      expect(running.hub.size()).toBe(1)
    } finally {
      await dispatcher.close()
    }
  })
})
