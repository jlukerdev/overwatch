// P0.4 / P5.5: the Access zod schemas (src/main/access/types.ts) against the sanitized fixtures in
// tests/fixtures/access/, and the pure spike helpers (scripts/spikes/lib/access.ts). The shapes
// follow the official reference (docs/reference/access-endpoints-v4.2.16.md). Today the fixtures
// come from the mock (`_source: "mock"`) or are transcribed from the reference
// (`_source: "reference"`); after OS-1 they come from the site console and these tests check the
// schemas against reality.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_EVENT_DOORBELL,
  ACCESS_EVENT_DOORBELL_CHANGE,
  ACCESS_EVENT_REMOTE_UNLOCK,
  ACCESS_LOCK_RULE_TYPES,
  AccessDoorListResponseSchema,
  AccessDoorSchema,
  AccessEmergencyRequestSchema,
  AccessEmergencyStatusResponseSchema,
  AccessEmergencyStatusSchema,
  AccessErrorEnvelopeSchema,
  AccessLockRuleRequestSchema,
  AccessLockRuleResponseSchema,
  AccessLockRuleSchema,
  AccessNotificationSchema,
  AccessOkResponseSchema,
  AccessRemoteUnlockDataSchema,
  AccessUnlockRequestSchema,
  AccessUnlockResponseSchema,
  DoorPositionStatusSchema,
  IsBindHubSchema,
} from '../../src/main/access/types'
import { remoteUnlockNotification } from '../../scripts/mock-access/app.ts'
import { SEED_DOORS } from '../../scripts/mock-access/doors.ts'
import {
  accessPinFileName,
  confirmationMatches,
  describeIssues,
  describeNotification,
  extraKeys,
  findDoorByName,
  notificationsUrl,
  resolveAccessBaseUrl,
  shapeNotes,
  sourceFromHeaders,
  unlockConfirmation,
  urlPort,
  YES_REFUSED,
} from '../../scripts/spikes/lib/access.ts'
import doors from '../fixtures/access/doors.json'
import emergency from '../fixtures/access/emergency.json'
import emergencyEvacuation from '../fixtures/access/emergency-evacuation.json'
import emergencySet from '../fixtures/access/emergency-set.json'
import notExists from '../fixtures/access/error-not-exists.json'
import unauthorized from '../fixtures/access/error-unauthorized.json'
import lockRule from '../fixtures/access/lock-rule.json'
import lockRuleCustom from '../fixtures/access/lock-rule-custom.json'
import lockRuleKeepUnlock from '../fixtures/access/lock-rule-keep-unlock.json'
import lockRuleSet from '../fixtures/access/lock-rule-set.json'
import unlock from '../fixtures/access/unlock.json'
import wsDoorbell from '../fixtures/access/ws-doorbell.json'
import wsDoorbellChange from '../fixtures/access/ws-doorbell-change.json'
import wsRemoteUnlock from '../fixtures/access/ws-remote-unlock.json'

const REST_FIXTURES = {
  'doors.json': doors,
  'unlock.json': unlock,
  'error-unauthorized.json': unauthorized,
  'error-not-exists.json': notExists,
  'lock-rule.json': lockRule,
  'lock-rule-custom.json': lockRuleCustom,
  'lock-rule-keep-unlock.json': lockRuleKeepUnlock,
  'lock-rule-set.json': lockRuleSet,
  'emergency.json': emergency,
  'emergency-evacuation.json': emergencyEvacuation,
  'emergency-set.json': emergencySet,
}
const WS_FIXTURES = {
  'ws-remote-unlock.json': wsRemoteUnlock,
  'ws-doorbell.json': wsDoorbell,
  'ws-doorbell-change.json': wsDoorbellChange,
}
const ALL_FIXTURES = { ...REST_FIXTURES, ...WS_FIXTURES }

describe('fixtures', () => {
  it('every JSON file in tests/fixtures/access is covered by this test', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'access')
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(onDisk.sort()).toEqual(Object.keys(ALL_FIXTURES).sort())
  })

  it.each(Object.entries(REST_FIXTURES))('%s carries a _source marker', (_name, f) => {
    expect(['mock', 'console']).toContain(f._source)
    expect(typeof f.status).toBe('number')
  })

  it.each(Object.entries(WS_FIXTURES))('%s is { _source, frame }', (_name, f) => {
    expect(['reference', 'mock', 'console']).toContain(f._source)
    expect(Object.keys(f.frame).sort()).toEqual([
      'data',
      'event',
      'event_object_id',
      'receiver_id',
      'save_to_history',
    ])
    AccessNotificationSchema.parse(f.frame)
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

  it.each([
    ['lock-rule.json', lockRule],
    ['lock-rule-custom.json', lockRuleCustom],
    ['lock-rule-keep-unlock.json', lockRuleKeepUnlock],
  ])('%s matches the lock rule response schema', (_name, f) => {
    expect(f.status).toBe(200)
    const rule = AccessLockRuleResponseSchema.parse(f.response).data
    expect(typeof rule.ended_time).toBe('number')
  })

  it('the lock rule fixtures show a documented type, and the mock\'s guess for "no rule"', () => {
    const documented: readonly string[] = ACCESS_LOCK_RULE_TYPES
    expect(documented).toContain(lockRuleCustom.response.data.type)
    expect(documented).toContain(lockRuleKeepUnlock.response.data.type)
    // Undocumented: what a door without a rule answers. From the mock this is its guess.
    if (lockRule._source === 'mock')
      expect(lockRule.response.data).toEqual({ type: '', ended_time: 0 })
  })

  it('lock-rule-set.json: a valid request body and the "success" response', () => {
    expect(lockRuleSet.request.method).toBe('PUT')
    expect(AccessLockRuleRequestSchema.parse(lockRuleSet.request.body)).toEqual({
      type: 'custom',
      interval: 60,
    })
    expect(AccessOkResponseSchema.parse(lockRuleSet.response).data).toBe('success')
  })

  it.each([
    ['emergency.json', emergency, { lockdown: false, evacuation: false }],
    ['emergency-evacuation.json', emergencyEvacuation, { lockdown: false, evacuation: true }],
  ])('%s matches the emergency status schema', (_name, f, expected) => {
    expect(f.status).toBe(200)
    const data = AccessEmergencyStatusResponseSchema.parse(f.response).data
    if (f._source === 'mock') expect(data).toEqual(expected)
  })

  it('emergency-set.json: a valid request body and the "success" response', () => {
    expect(emergencySet.request.method).toBe('PUT')
    AccessEmergencyRequestSchema.parse(emergencySet.request.body)
    expect(AccessOkResponseSchema.parse(emergencySet.response).data).toBe('success')
  })

  it('ws-remote-unlock.json: data.unique_id is the door id; same fields as the mock pushes', () => {
    const frame = AccessNotificationSchema.parse(wsRemoteUnlock.frame)
    expect(frame.event).toBe(ACCESS_EVENT_REMOTE_UNLOCK)
    expect(AccessRemoteUnlockDataSchema.parse(frame.data)).toEqual({
      unique_id: 'door-001',
      name: 'Door 236b',
      location_type: 'door',
    })
    const seed = SEED_DOORS[0]
    if (seed === undefined) throw new Error('no seed doors')
    const pushed = remoteUnlockNotification(seed)
    expect(Object.keys(pushed.data as object).sort()).toEqual(
      Object.keys(wsRemoteUnlock.frame.data).sort(),
    )
    expect(Object.keys((pushed.data as { extras: object }).extras).sort()).toEqual(
      Object.keys(wsRemoteUnlock.frame.data.extras).sort(),
    )
  })

  it('the doorbell frames carry the documented event names and fields', () => {
    expect(wsDoorbell.frame.event).toBe(ACCESS_EVENT_DOORBELL)
    expect(Object.keys(wsDoorbell.frame.data).sort()).toEqual([
      'channel',
      'connected_uah_id',
      'controller_id',
      'create_time',
      'device_id',
      'device_name',
      'device_type',
      'door_guard_ids',
      'door_name',
      'floor_name',
      'host_device_mac',
      'in_or_out',
      'reason_code',
      'request_id',
      'room_id',
      'token',
    ])
    expect(wsDoorbellChange.frame.event).toBe(ACCESS_EVENT_DOORBELL_CHANGE)
    expect(Object.keys(wsDoorbellChange.frame.data).sort()).toEqual([
      'reason_code',
      'remote_call_request_id',
    ])
  })

  it('fixtures hold no raw ids, IPs, MACs or tokens', () => {
    const text = JSON.stringify(Object.values(ALL_FIXTURES))
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
    expect(text).not.toMatch(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i)
    expect(text).not.toMatch(/\b[0-9a-f]{12}\b/i)
    expect(wsDoorbell.frame.data.token).toBe('<redacted-token>')
    expect(wsDoorbell.frame.data.host_device_mac).toBe('mac-001')
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

describe('schemas (P5.5: lock rule, emergency, notifications)', () => {
  it('lock rule request: custom needs interval, the other types refuse it', () => {
    expect(AccessLockRuleRequestSchema.parse({ type: 'custom', interval: 30 })).toEqual({
      type: 'custom',
      interval: 30,
    })
    expect(AccessLockRuleRequestSchema.safeParse({ type: 'custom' }).success).toBe(false)
    for (const type of ['keep_lock', 'keep_unlock', 'reset', 'lock_early', 'lock_now']) {
      expect(AccessLockRuleRequestSchema.safeParse({ type }).success).toBe(true)
      expect(AccessLockRuleRequestSchema.safeParse({ type, interval: 5 }).success).toBe(false)
    }
  })

  it('lock rule request: interval is a positive integer; unknown types and fields are refused', () => {
    for (const interval of [0, -1, 1.5, '10', null])
      expect(AccessLockRuleRequestSchema.safeParse({ type: 'custom', interval }).success).toBe(
        false,
      )
    expect(AccessLockRuleRequestSchema.safeParse({ type: 'schedule' }).success).toBe(false)
    expect(AccessLockRuleRequestSchema.safeParse({}).success).toBe(false)
    expect(AccessLockRuleRequestSchema.safeParse({ type: 'reset', extra: 1 }).success).toBe(false)
  })

  it('lock rule (lenient): any type string, ended_time optional, extra fields dropped', () => {
    expect(AccessLockRuleSchema.parse({ type: 'custom', ended_time: 1708673342 })).toEqual({
      type: 'custom',
      ended_time: 1708673342,
    })
    expect(AccessLockRuleSchema.parse({ type: '' })).toEqual({ type: '' })
    expect(AccessLockRuleSchema.parse({ type: 'something_new', ended_time: 0, more: 1 })).toEqual({
      type: 'something_new',
      ended_time: 0,
    })
    // A missing `type` reads as "no rule" (undocumented case), as does `data: null`.
    expect(AccessLockRuleSchema.parse({ ended_time: 1 })).toEqual({ type: '', ended_time: 1 })
    expect(
      AccessLockRuleResponseSchema.parse({ code: 'SUCCESS', msg: 'success', data: null }).data,
    ).toEqual({ type: '' })
    expect(AccessLockRuleSchema.safeParse({ type: 'custom', ended_time: '1' }).success).toBe(false)
    expect(
      AccessLockRuleResponseSchema.safeParse({ code: 'SUCCESS', data: { type: 'keep_lock' } })
        .success,
    ).toBe(true)
  })

  it('emergency status: a missing flag reads as false', () => {
    expect(AccessEmergencyStatusSchema.parse({})).toEqual({ lockdown: false, evacuation: false })
    expect(AccessEmergencyStatusSchema.parse({ evacuation: true })).toEqual({
      lockdown: false,
      evacuation: true,
    })
    expect(AccessEmergencyStatusSchema.safeParse({ lockdown: 'true' }).success).toBe(false)
    expect(
      AccessEmergencyStatusResponseSchema.parse({ code: 'SUCCESS', data: { lockdown: true } }).data,
    ).toEqual({ lockdown: true, evacuation: false })
  })

  it('emergency request: both flags, explicitly, and nothing else', () => {
    expect(
      AccessEmergencyRequestSchema.safeParse({ lockdown: true, evacuation: false }).success,
    ).toBe(true)
    expect(AccessEmergencyRequestSchema.safeParse({ lockdown: true }).success).toBe(false)
    expect(
      AccessEmergencyRequestSchema.safeParse({ lockdown: false, evacuation: false, x: 1 }).success,
    ).toBe(false)
  })

  it('ok response: SUCCESS with any data; an error code is not ok', () => {
    expect(AccessOkResponseSchema.safeParse({ code: 'SUCCESS', data: 'success' }).success).toBe(
      true,
    )
    expect(AccessOkResponseSchema.safeParse({ code: 'SUCCESS', data: null }).success).toBe(true)
    expect(AccessOkResponseSchema.safeParse({ code: 'CODE_PARAMS_INVALID' }).success).toBe(false)
  })

  it('notification: only event is required, and an unknown event parses', () => {
    expect(
      AccessNotificationSchema.parse({ event: 'access.something.new', data: { a: 1 }, more: true }),
    ).toEqual({ event: 'access.something.new', data: { a: 1 } })
    expect(AccessNotificationSchema.parse({ event: 'x' })).toEqual({ event: 'x' })
    expect(AccessNotificationSchema.safeParse({ event: '' }).success).toBe(false)
    expect(AccessNotificationSchema.safeParse({ data: {} }).success).toBe(false)
    // Nothing reads `event_object_id`, so an unexpected type there must not drop the frame.
    for (const id of [5, null, { nested: true }]) {
      expect(AccessNotificationSchema.safeParse({ event: 'x', event_object_id: id }).success).toBe(
        true,
      )
    }
    expect(AccessNotificationSchema.safeParse('hello').success).toBe(false)
  })

  it('remote unlock data: unique_id (the door id) is required, the rest optional', () => {
    expect(AccessRemoteUnlockDataSchema.parse({ unique_id: 'd1' })).toEqual({ unique_id: 'd1' })
    expect(
      AccessRemoteUnlockDataSchema.parse({
        unique_id: 'd1',
        name: 'Door',
        location_type: 'door',
        level: 0,
      }),
    ).toEqual({ unique_id: 'd1', name: 'Door', location_type: 'door' })
    expect(AccessRemoteUnlockDataSchema.safeParse({ unique_id: '' }).success).toBe(false)
    expect(AccessRemoteUnlockDataSchema.safeParse({ name: 'Door' }).success).toBe(false)
    expect(AccessRemoteUnlockDataSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('spike helpers', () => {
  it('notificationsUrl: wss on the same host, port and base path', () => {
    expect(notificationsUrl(new URL('https://console.invalid:12445/api/v1/developer'))).toBe(
      'wss://console.invalid:12445/api/v1/developer/devices/notifications',
    )
    expect(
      notificationsUrl(new URL('https://console.invalid/proxy/access/api/v1/developer/')),
    ).toBe('wss://console.invalid/proxy/access/api/v1/developer/devices/notifications')
    expect(() => notificationsUrl(new URL('http://console.invalid/'))).toThrow(/HTTPS-only/)
  })

  it('describeNotification keeps event and field names only, never values', () => {
    const raw = JSON.stringify(wsRemoteUnlock.frame)
    const shape = describeNotification(raw, 'door-001')
    expect(shape).toEqual({
      event: ACCESS_EVENT_REMOTE_UNLOCK,
      keys: ['data', 'event', 'event_object_id', 'receiver_id', 'save_to_history'],
      dataKeys: Object.keys(wsRemoteUnlock.frame.data).sort(),
      schemaOk: true,
      doorIdMatches: true,
    })
    expect(JSON.stringify(shape)).not.toContain('Door 236b')
    expect(describeNotification(raw, 'door-002').doorIdMatches).toBe(false)
    expect(describeNotification(raw)).not.toHaveProperty('doorIdMatches')
    expect(describeNotification(JSON.stringify(wsDoorbell.frame), 'door-001')).toMatchObject({
      event: ACCESS_EVENT_DOORBELL,
      schemaOk: true,
    })
    expect(
      describeNotification(JSON.stringify({ event: ACCESS_EVENT_REMOTE_UNLOCK, data: {} }), 'd'),
    ).toMatchObject({ schemaOk: false, doorIdMatches: false })
    expect(describeNotification('{"hello":1}')).toEqual({
      event: '(no event)',
      keys: ['hello'],
      dataKeys: [],
      schemaOk: false,
    })
    expect(describeNotification('not json').event).toBe('(not JSON)')
    expect(describeNotification('[1]').event).toBe('(not an object)')
  })

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
