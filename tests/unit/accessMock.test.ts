// P0.4: the UniFi Access mock's request handler (scripts/mock-access/app.ts) and door store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccessDoorListResponseSchema,
  AccessDoorResponseSchema,
  AccessErrorEnvelopeSchema,
  AccessUnlockResponseSchema,
} from '../../src/main/access/types'
import {
  MOCK_FAILURE_CODE,
  MOCK_HEADER,
  createAccessMock,
  routePath,
  tokenMatches,
} from '../../scripts/mock-access/app.ts'
import type { AccessMock, MockRequest } from '../../scripts/mock-access/app.ts'
import { DEFAULT_UNLOCK_MS, SEED_DOORS } from '../../scripts/mock-access/doors.ts'

const TOKEN = 'unit-test-token'
const BASE = '/api/v1/developer'
const FRONT = SEED_DOORS.find((d) => d.name === 'Front Door')
const UNBOUND = SEED_DOORS.find((d) => !d.is_bind_hub)
if (FRONT === undefined || UNBOUND === undefined) throw new Error('seed doors changed')

function req(method: string, path: string, init: Partial<MockRequest> = {}): MockRequest {
  return {
    method,
    url: `${BASE}${path}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    body: '',
    ...init,
  }
}

let mock: AccessMock
const relay = (id: string): string | undefined => mock.store.get(id)?.door_lock_relay_status

beforeEach(() => {
  vi.useFakeTimers()
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
