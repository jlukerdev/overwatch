// P0.4: the COMMUNITY-SOURCED Access zod schemas (src/main/access/types.ts) against the sanitized
// fixtures written by `npm run spike:access`, and the pure spike helpers
// (scripts/spikes/lib/access.ts). Today the fixtures come from the mock (`_source: "mock"`); after
// OS-1 they come from the site console and these tests check the schemas against reality.
import { describe, expect, it } from 'vitest'
import {
  AccessDoorListResponseSchema,
  AccessDoorSchema,
  AccessErrorEnvelopeSchema,
  AccessUnlockRequestSchema,
  AccessUnlockResponseSchema,
  DoorPositionStatusSchema,
  IsBindHubSchema,
} from '../../src/main/access/types'
import {
  accessPinFileName,
  confirmationMatches,
  describeIssues,
  extraKeys,
  findDoorByName,
  resolveAccessBaseUrl,
  shapeNotes,
  sourceFromHeaders,
  unlockConfirmation,
  urlPort,
  YES_REFUSED,
} from '../../scripts/spikes/lib/access.ts'
import doors from '../fixtures/access/doors.json'
import notExists from '../fixtures/access/error-not-exists.json'
import unauthorized from '../fixtures/access/error-unauthorized.json'
import unlock from '../fixtures/access/unlock.json'

describe('fixtures', () => {
  it.each([
    ['doors.json', doors],
    ['unlock.json', unlock],
    ['error-unauthorized.json', unauthorized],
    ['error-not-exists.json', notExists],
  ])('%s carries a _source marker', (_name, f) => {
    expect(['mock', 'console']).toContain(f._source)
  })

  it('doors.json matches the door list schema', () => {
    const parsed = AccessDoorListResponseSchema.parse(doors.response)
    expect(parsed.data.length).toBeGreaterThan(0)
  })

  it('unlock.json matches the unlock response schema and shows the relay reverting', () => {
    expect(unlock.status).toBe(200)
    AccessUnlockResponseSchema.parse(unlock.response)
    expect(unlock.relayAfterUnlock.map((s) => s.relay)).toEqual(['unlock', 'lock'])
  })

  it.each([
    ['error-unauthorized.json', unauthorized],
    ['error-not-exists.json', notExists],
  ])('%s matches the error envelope', (_name, f) => {
    AccessErrorEnvelopeSchema.parse(f.response)
    expect(f.status).toBeGreaterThanOrEqual(400)
  })

  it('fixtures hold no raw ids or IPs', () => {
    const text = JSON.stringify([doors, unlock, unauthorized, notExists])
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })
})

describe('schemas', () => {
  it('error envelope rejects SUCCESS', () => {
    expect(AccessErrorEnvelopeSchema.safeParse({ code: 'SUCCESS', msg: 'success' }).success).toBe(
      false,
    )
  })

  it('door position accepts open/close/null and the empty string the community example shows', () => {
    for (const v of ['open', 'close', null, '']) expect(DoorPositionStatusSchema.parse(v)).toBe(v)
    expect(DoorPositionStatusSchema.safeParse('ajar').success).toBe(false)
  })

  it('is_bind_hub (UNVERIFIED, lenient): booleans and the strings true/false, as booleans', () => {
    expect(IsBindHubSchema.parse(true)).toBe(true)
    expect(IsBindHubSchema.parse(false)).toBe(false)
    expect(IsBindHubSchema.parse('true')).toBe(true)
    expect(IsBindHubSchema.parse('false')).toBe(false)
    for (const v of ['yes', 'True', '', 1, 0, null, undefined])
      expect(IsBindHubSchema.safeParse(v).success).toBe(false)
    const door = {
      id: 'd',
      name: 'n',
      full_name: 'f',
      floor_id: 'fl',
      type: 'door',
      is_bind_hub: 'false',
      door_lock_relay_status: 'lock',
      door_position_status: null,
      surprise: 1,
    }
    const parsed = AccessDoorSchema.parse(door)
    expect(parsed.is_bind_hub).toBe(false)
    expect(parsed).not.toHaveProperty('surprise')
  })

  it('envelope msg is optional (UNVERIFIED, lenient), code still required', () => {
    expect(AccessDoorListResponseSchema.safeParse({ code: 'SUCCESS', data: [] }).success).toBe(true)
    expect(AccessErrorEnvelopeSchema.safeParse({ code: 'CODE_NOT_EXISTS' }).success).toBe(true)
    expect(AccessErrorEnvelopeSchema.safeParse({ msg: 'x' }).success).toBe(false)
    expect(AccessDoorListResponseSchema.safeParse({ msg: 'success', data: [] }).success).toBe(false)
    expect(AccessErrorEnvelopeSchema.safeParse({ code: 'CODE_X', msg: 3 }).success).toBe(false)
    expect(AccessUnlockResponseSchema.safeParse({ code: 'SUCCESS', data: 'success' }).success).toBe(
      true,
    )
  })

  it('unlock request: empty, or actor_id and actor_name together', () => {
    expect(AccessUnlockRequestSchema.safeParse({}).success).toBe(true)
    expect(AccessUnlockRequestSchema.safeParse({ actor_id: 'a', actor_name: 'b' }).success).toBe(
      true,
    )
    expect(AccessUnlockRequestSchema.safeParse({ actor_name: 'b' }).success).toBe(false)
  })
})

describe('spike helpers', () => {
  it('resolveAccessBaseUrl prefers VP_ACCESS_BASE_URL, else builds from VP_CONSOLE_HOST', () => {
    expect(
      resolveAccessBaseUrl({ VP_ACCESS_BASE_URL: 'https://127.0.0.1:12445/api/v1/developer/' })
        .href,
    ).toBe('https://127.0.0.1:12445/api/v1/developer')
    expect(resolveAccessBaseUrl({ VP_CONSOLE_HOST: 'https://console.invalid:443' }).href).toBe(
      'https://console.invalid:12445/api/v1/developer',
    )
    expect(() => resolveAccessBaseUrl({})).toThrow()
  })

  it('the Access API is HTTPS-only: http:// base URLs and ports are rejected', () => {
    expect(() => resolveAccessBaseUrl({ VP_ACCESS_BASE_URL: 'http://x.invalid/' })).toThrow(
      /HTTPS-only.*VP_ACCESS_BASE_URL/,
    )
    expect(() =>
      resolveAccessBaseUrl({ VP_ACCESS_BASE_URL: 'http://127.0.0.1:12445/api/v1/developer' }),
    ).toThrow(/HTTPS-only/)
    expect(() => resolveAccessBaseUrl({ VP_CONSOLE_HOST: 'http://console.invalid' })).toThrow(
      /HTTPS-only.*VP_CONSOLE_HOST/,
    )
    expect(resolveAccessBaseUrl({ VP_CONSOLE_HOST: 'console.invalid' }).href).toBe(
      'https://console.invalid:12445/api/v1/developer',
    )
    expect(urlPort(new URL('https://console.invalid:12445/'))).toBe(12445)
    expect(urlPort(new URL('https://console.invalid/'))).toBe(443)
    expect(() => urlPort(new URL('http://console.invalid/'))).toThrow(/HTTPS-only/)
  })

  it('pin files are keyed by host and port, and never collide with the Protect pin', () => {
    const mock = new URL('https://127.0.0.1:12445/api/v1/developer')
    const site = new URL('https://console.invalid:12445/api/v1/developer')
    const proxy = new URL('https://console.invalid/proxy/access/api/v1/developer')
    const names = [mock, site, proxy].map(accessPinFileName)
    expect(new Set(names).size).toBe(3)
    expect(names).not.toContain('console-pin.json')
    expect(accessPinFileName(new URL('https://[::1]:12445/'))).toMatch(/^access-pin-[\w.-]+\.json$/)
    expect(urlPort(proxy)).toBe(443)
  })

  it('sourceFromHeaders is mock only with the mock header, whatever the host', () => {
    expect(sourceFromHeaders(new Headers({ 'x-view-protect-mock': '1' }))).toBe('mock')
    expect(sourceFromHeaders(new Headers({ 'X-View-Protect-Mock': ' 1 ' }))).toBe('mock')
    expect(sourceFromHeaders(new Headers())).toBe('console')
    expect(sourceFromHeaders(new Headers({ 'x-view-protect-mock': '0' }))).toBe('console')
    expect(sourceFromHeaders(new Headers({ 'x-view-protect-mock': 'true' }))).toBe('console')
  })

  it('unlockConfirmation: --yes only against the mock; the typed name otherwise (DOOR-3/4)', () => {
    expect(() => unlockConfirmation({ source: 'console', yes: true, isTTY: true })).toThrow(
      YES_REFUSED,
    )
    expect(() => unlockConfirmation({ source: 'console', yes: true, isTTY: false })).toThrow(
      YES_REFUSED,
    )
    expect(unlockConfirmation({ source: 'mock', yes: true, isTTY: false })).toBe('skip')
    expect(unlockConfirmation({ source: 'console', yes: false, isTTY: true })).toBe('prompt')
    expect(unlockConfirmation({ source: 'mock', yes: false, isTTY: true })).toBe('prompt')
    expect(() => unlockConfirmation({ source: 'console', yes: false, isTTY: false })).toThrow(
      /interactive terminal/,
    )
    expect(() => unlockConfirmation({ source: 'mock', yes: false, isTTY: false })).toThrow(
      /interactive terminal/,
    )
  })

  it('shapeNotes reports the lenient normalizations on the raw JSON', () => {
    expect(shapeNotes({ code: 'SUCCESS', msg: 'success', data: [{ is_bind_hub: true }] })).toEqual(
      [],
    )
    expect(
      shapeNotes({
        code: 'SUCCESS',
        data: [{ is_bind_hub: 'true' }, { is_bind_hub: 'false' }, { is_bind_hub: 'true' }],
      }),
    ).toEqual([
      '(envelope).msg absent (accepted: msg is optional)',
      'door.is_bind_hub sent as string "false" (normalized to boolean)',
      'door.is_bind_hub sent as string "true" (normalized to boolean)',
    ])
    expect(shapeNotes({ code: 'SUCCESS', msg: 'ok', data: { is_bind_hub: 'false' } })).toEqual([
      'door.is_bind_hub sent as string "false" (normalized to boolean)',
    ])
    expect(shapeNotes(null)).toEqual([])
    expect(doors.response.data.length).toBeGreaterThan(0)
    expect(shapeNotes(doors.response)).toEqual([])
  })

  it('findDoorByName matches case-insensitively and rejects none/several', () => {
    const list = [{ name: 'Front Door' }, { name: 'Office' }, { name: 'office ' }]
    expect(findDoorByName(list, 'front door').name).toBe('Front Door')
    expect(() => findDoorByName(list, 'Back Door')).toThrow(/matches no door/)
    expect(() => findDoorByName(list, 'Office')).toThrow(/several/)
  })

  it('confirmation needs the exact door name', () => {
    expect(confirmationMatches(' Front Door\n', 'Front Door')).toBe(true)
    expect(confirmationMatches('front door', 'Front Door')).toBe(false)
    expect(confirmationMatches('y', 'Front Door')).toBe(false)
    expect(confirmationMatches('', 'Front Door')).toBe(false)
  })

  it('describeIssues and extraKeys report mismatches', () => {
    const r = AccessDoorListResponseSchema.safeParse({
      code: 'SUCCESS',
      msg: 'success',
      data: [{ id: 'x' }],
    })
    expect(r.success).toBe(false)
    if (!r.success)
      expect(describeIssues(r.error)).toContain(
        'data.[].name: Invalid input: expected string, received undefined',
      )
    expect(extraKeys({ code: 1, msg: 2, data: 3, pagination: 4 }, ['code', 'msg', 'data'])).toEqual(
      ['pagination'],
    )
    expect(extraKeys([1], ['a'])).toEqual([])
  })
})
