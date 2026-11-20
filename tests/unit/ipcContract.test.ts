// P1.5: the IPC contract itself (src/shared/ipc.ts) — the channel table, the `{ ok }` envelope and
// the request schemas both ends validate against.
//
// The point of testing a file of schemas is the invariants that no type can state: that no channel
// string is used twice, that the secret-key list has not drifted from main's own, that a request
// schema really does trim and default what the preload promises it does, and above all that
// **nothing shaped like a secret can appear in `AppState`** (CON-2, NFR-9) — the one rule in this
// file whose violation would be a security bug rather than a bug.
import {
  AppStateSchema,
  CameraIdInputSchema,
  DOOR_ACTIONS,
  DOOR_ACTIONS_SENT,
  DoorActionInputSchema,
  DoorActionResultSchema,
  DoorEmergencyInputSchema,
  DoorsScreenStateSchema,
  MAX_DOOR_CUSTOM_MINUTES,
  MAX_DOOR_ID_LENGTH,
  SetAccessPollingInputSchema,
  emptyDoorsScreenState,
  ConsoleInputSchema,
  AcceptCertInputSchema,
  EndpointInputSchema,
  EnsureStreamInputSchema,
  IPC,
  IPC_ERROR_KINDS,
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_EVENTS,
  ipcFail,
  ipcOk,
  ipcResultSchema,
  SECRET_KEYS,
  SecretInputSchema,
  RtspsAvailabilitySchema,
  SetDoorLinksInputSchema,
  SetLastViewInputSchema,
  SetModeInputSchema,
  SetStreamsInputSchema,
  SetViewsInputSchema,
  SnapshotInputSchema,
  SnapshotResultSchema,
  type AppState,
} from '@shared/ipc'
import {
  ACCESS_POLLING_BOUNDS,
  ACCESS_POLLING_FIELDS,
  defaultAccessPolling,
  type AccessPollingField,
} from '@shared/models'
import { QUALITIES, STREAM_QUALITIES } from '@shared/quality'
import { streamHandle } from '@shared/streams'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SECRET_KEYS as MAIN_SECRET_KEYS } from '../../src/main/secrets/secrets'

/** A fully populated state, so the walker below sees every key the schema can produce. */
function sampleState(): AppState {
  return AppStateSchema.parse({
    version: '0.1.0',
    settings: {
      console: {
        host: 'udm.local:8443',
        certFingerprint: 'AA:BB',
        accessEnabled: true,
        accessBaseUrl: 'https://udm.local:12445/api/v1/developer',
        accessCertFingerprint: 'CC:DD',
      },
      doorLinks: { 'cam-1': 'door-1' },
      views: [],
      lastViewId: null,
      streams: {},
      ui: {},
      mode: 'rtsp',
      rtsp: {
        streams: [{ id: 'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b', name: 'Garden' }],
      },
    },
    keystoreAvailable: true,
    secretsStored: {
      protectApiKey: true,
      accessToken: true,
      rtspUrls: {
        'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b': { high: true, medium: false, low: true },
      },
    },
    connection: {
      protect: { endpoint: 'protect', phase: 'connected', updatedAt: 1 },
      access: { endpoint: 'access', phase: 'disabled', updatedAt: 1 },
    },
    cameras: [{ id: 'cam-1', name: 'Driveway' }],
  })
}

describe('the channel table', () => {
  it('uses each channel string once', () => {
    const all = [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS]
    expect(new Set(all).size).toBe(all.length)
  })

  it('namespaces every channel, so nothing can collide with Electron or a dependency', () => {
    for (const channel of [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS]) {
      expect(channel.startsWith('vp:')).toBe(true)
    }
  })

  it('covers every call and event in the exported tables', () => {
    expect(IPC_CHANNELS).toHaveLength(Object.keys(IPC).length)
    expect(IPC_EVENT_CHANNELS).toHaveLength(Object.keys(IPC_EVENTS).length)
  })
})

describe('the secret-key list', () => {
  // src/shared may not import from src/main, so the two lists are written out twice. This is the
  // only thing holding them together: a key added to the keystore and not to the contract would be
  // unreachable from Settings, and the reverse would be an `invalid-request` at runtime.
  it('matches the keystore keys in src/main/secrets', () => {
    expect([...SECRET_KEYS].sort()).toEqual([...MAIN_SECRET_KEYS].sort())
  })
})

describe('the result envelope', () => {
  const schema = ipcResultSchema(z.object({ answer: z.number() }))

  it('accepts a success and a failure', () => {
    expect(schema.parse(ipcOk({ answer: 42 }))).toEqual({ ok: true, value: { answer: 42 } })
    expect(schema.parse(ipcFail('auth', 'The API key was rejected.'))).toEqual({
      ok: false,
      error: {
        kind: 'auth',
        message: 'The API key was rejected.',
        endpoint: null,
        retryable: false,
      },
    })
  })

  it('rejects a success with no value and a failure with an unknown kind', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false)
    expect(schema.safeParse({ ok: false, error: { kind: 'nope', message: 'x' } }).success).toBe(
      false,
    )
  })

  it('defaults the two optional error fields, so the renderer never reads undefined', () => {
    const failure = ipcFail('timeout', 'The console did not answer.', {
      endpoint: 'udm.local:443',
      retryable: true,
    })
    expect(failure).toEqual({
      ok: false,
      error: {
        kind: 'timeout',
        message: 'The console did not answer.',
        endpoint: 'udm.local:443',
        retryable: true,
      },
    })
  })
})

describe('request schemas', () => {
  it('trims the host but leaves its syntax to main (CON-1, SPEC §6)', () => {
    const parsed = ConsoleInputSchema.parse({
      host: '  udm.local:8443  ',
      accessEnabled: false,
      accessBaseUrl: null,
    })
    expect(parsed.host).toBe('udm.local:8443')
    // `parseConsoleHost` is the authority, so a scheme is not rejected here — main's message is.
    expect(
      ConsoleInputSchema.safeParse({
        host: 'http://udm.local',
        accessEnabled: false,
        accessBaseUrl: null,
      }).success,
    ).toBe(true)
  })

  it('allows an empty host (not configured yet) but not an empty Access base URL', () => {
    expect(
      ConsoleInputSchema.parse({ host: '', accessEnabled: false, accessBaseUrl: null }),
    ).toEqual({ host: '', accessEnabled: false, accessBaseUrl: null })
    // An emptied field is sent as `null`. `ConsoleConfigSchema` has no empty-string arm, so
    // accepting one here would pass IPC validation and then be unstorable.
    expect(
      ConsoleInputSchema.safeParse({ host: '', accessEnabled: false, accessBaseUrl: '' }).success,
    ).toBe(false)
  })

  it('rejects an Access base URL that is not an https URL (CON-2, R5)', () => {
    for (const accessBaseUrl of [
      // `new URL()` reads this as the scheme `udm.local:` plus a path, so `z.url()` alone passes it.
      'udm.local:12445',
      'http://udm.local:12445/api/v1/developer',
      'not a url',
    ]) {
      expect(
        ConsoleInputSchema.safeParse({ host: 'udm.local', accessEnabled: true, accessBaseUrl })
          .success,
        accessBaseUrl,
      ).toBe(false)
    }
    expect(
      ConsoleInputSchema.safeParse({
        host: 'udm.local',
        accessEnabled: true,
        accessBaseUrl: 'https://udm.local:12445/api/v1/developer',
      }).success,
    ).toBe(true)
  })

  it('trims a pasted credential and refuses one that is only whitespace', () => {
    // A key copied out of the console UI usually carries a trailing newline.
    expect(SecretInputSchema.parse({ key: 'protectApiKey', value: ' abc123\n' })).toEqual({
      key: 'protectApiKey',
      value: 'abc123',
    })
    expect(SecretInputSchema.safeParse({ key: 'protectApiKey', value: '   ' }).success).toBe(false)
  })

  it('rejects a credential for a key the keystore does not have', () => {
    expect(SecretInputSchema.safeParse({ key: 'rtspsUrl', value: 'x' }).success).toBe(false)
  })

  it('defaults snapshots to the small image (SPEC §5.1: highQuality=true is a 400 elsewhere)', () => {
    expect(SnapshotInputSchema.parse({ cameraId: 'cam-1' })).toEqual({
      cameraId: 'cam-1',
      highQuality: false,
    })
  })

  it('requires a fingerprint on accept, because the user accepts what they were shown (CON-3)', () => {
    expect(
      AcceptCertInputSchema.safeParse({ endpoint: 'protect', fingerprint256: '' }).success,
    ).toBe(false)
    expect(EndpointInputSchema.safeParse({ endpoint: 'nvr' }).success).toBe(false)
  })

  it('takes a camera and a stream quality for ensureStream (QUAL-8, CAM-4)', () => {
    for (const quality of STREAM_QUALITIES) {
      expect(EnsureStreamInputSchema.parse({ cameraId: 'cam-1', quality })).toEqual({
        cameraId: 'cam-1',
        quality,
      })
    }
    // A `StreamQuality`, so a doorbell's package channel is addressable — but nothing else: an
    // unvalidated quality would reach `<cameraId>_<quality>` and register a stream Protect has no
    // alias for (ARCHITECTURE §2 rule 3).
    for (const bad of [
      { cameraId: '', quality: 'low' },
      { cameraId: 'cam-1', quality: 'ultra' },
      { cameraId: 'cam-1' },
    ]) {
      expect(EnsureStreamInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('validates every View in setViews, tiling included (P3.1, SPEC §6)', () => {
    const view = (id: string, cells: unknown[]) => ({ id, name: id, cols: 2, rows: 1, cells })
    const good = view('v1', [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
    ])
    const parsed = SetViewsInputSchema.parse({ views: [good], lastViewId: 'v1', mode: 'protect' })
    // Defaults are filled in here, so main stores exactly what the contract produced.
    expect(parsed.views[0]).toMatchObject({ aspect: { w: 16, h: 9 }, gap: 0, fit: 'contain' })
    expect(
      SetViewsInputSchema.parse({ views: [], lastViewId: null, mode: 'protect' }).views,
    ).toEqual([])

    const holey = SetViewsInputSchema.safeParse({
      views: [view('v1', [{ col: 0, row: 0 }])],
      lastViewId: null,
      mode: 'protect',
    })
    expect(holey.success).toBe(false)
    const spanned = SetViewsInputSchema.safeParse({
      views: [view('v1', [{ col: 0, row: 0, colSpan: 2 }])],
      lastViewId: null,
      mode: 'protect',
    })
    expect(spanned.success).toBe(true)
  })

  it('refuses duplicate View ids, and a lastViewId that names none of them', () => {
    const view = (id: string) => ({ id, name: id, cols: 1, rows: 1, cells: [{ col: 0, row: 0 }] })
    const dup = SetViewsInputSchema.safeParse({
      views: [view('a'), view('b'), view('a')],
      lastViewId: 'a',
      mode: 'protect',
    })
    expect(dup.success).toBe(false)
    if (!dup.success) {
      expect(dup.error.issues).toHaveLength(1)
      expect(dup.error.issues[0]?.path).toEqual(['views', 2, 'id'])
      expect(dup.error.issues[0]?.message).toContain('views[0]')
    }
    const dangling = SetViewsInputSchema.safeParse({
      views: [view('a')],
      lastViewId: 'b',
      mode: 'protect',
    })
    expect(dangling.success).toBe(false)
    if (!dangling.success) expect(dangling.error.issues[0]?.path).toEqual(['lastViewId'])
    expect(
      SetViewsInputSchema.safeParse({ views: [view('a')], lastViewId: '', mode: 'protect' })
        .success,
    ).toBe(false)
    // MODE-4: the mode whose list was edited is required, and must be one of the two.
    expect(SetViewsInputSchema.safeParse({ views: [], lastViewId: null }).success).toBe(false)
    expect(
      SetViewsInputSchema.safeParse({ views: [], lastViewId: null, mode: 'nvr' }).success,
    ).toBe(false)
  })

  it('takes a View id or null for setLastView', () => {
    expect(SetLastViewInputSchema.parse({ viewId: 'v1', mode: 'protect' })).toEqual({
      viewId: 'v1',
      mode: 'protect',
    })
    expect(SetLastViewInputSchema.parse({ viewId: null, mode: 'rtsp' })).toEqual({
      viewId: null,
      mode: 'rtsp',
    })
    expect(SetLastViewInputSchema.safeParse({ viewId: '', mode: 'protect' }).success).toBe(false)
    expect(SetLastViewInputSchema.safeParse({}).success).toBe(false)
    // MODE-4: the mode the id was picked in is required.
    expect(SetLastViewInputSchema.safeParse({ viewId: 'v1' }).success).toBe(false)
  })

  it('takes one of the two app modes for setMode, and nothing else (MODE-1/4)', () => {
    expect(IPC.setMode.channel).toBe('vp:app/mode')
    expect(IPC.setMode.request).toBe(SetModeInputSchema)
    // Answers the whole state: the Views the renderer shows change with the mode.
    expect(IPC.setMode.value).toBe(AppStateSchema)
    for (const mode of ['protect', 'rtsp'] as const) {
      expect(SetModeInputSchema.parse({ mode })).toEqual({ mode })
    }
    // Strict, unlike config.json's lenient fallback to Protect: a request names a real mode.
    for (const bad of [
      { mode: 'RTSP' },
      { mode: 'unifi' },
      { mode: '' },
      { mode: null },
      {},
      'rtsp',
    ]) {
      expect(SetModeInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('takes both QUAL-1 defaults as qualities, and never defaults a missing one', () => {
    for (const quality of QUALITIES) {
      const input = { defaultGridQuality: quality, defaultFillQuality: quality }
      expect(SetStreamsInputSchema.parse(input)).toEqual(input)
    }
    for (const bad of [
      // The package channel is a source, not a quality anyone can pick (src/shared/quality.ts).
      { defaultGridQuality: 'package', defaultFillQuality: 'high' },
      // The persisted schema would fill this in; the request must not, or it resets the other one.
      { defaultGridQuality: 'low' },
      {},
    ]) {
      expect(SetStreamsInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('takes a camera id for cameraStreamQualities (QUAL-7)', () => {
    expect(CameraIdInputSchema.parse({ cameraId: 'cam-1' })).toEqual({ cameraId: 'cam-1' })
    expect(CameraIdInputSchema.safeParse({ cameraId: '' }).success).toBe(false)
  })

  it('takes the whole door-link map, and never defaults a missing one (DOOR-2)', () => {
    const links = { 'cam-1': 'door-1', 'cam-2': 'door-1' }
    expect(SetDoorLinksInputSchema.parse({ links })).toEqual({ links })
    expect(SetDoorLinksInputSchema.parse({ links: {} })).toEqual({ links: {} })
    for (const bad of [
      // The persisted schema would fill in `{}`; the request must not, or it erases every link.
      {},
      { links: null },
      { links: { 'cam-1': '' } },
      { links: { '': 'door-1' } },
      { links: { 'cam-1': 1 } },
    ]) {
      expect(SetDoorLinksInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('has no one-shot door list call: the Doors screen is the only reader (DOOR-1, P5.6)', () => {
    // `vp:doors/list` went with Settings' Door links card (user decision 2026-11-18): the list
    // reaches the renderer through `watchDoorsScreen` and its push, and nowhere else.
    expect(Object.keys(IPC)).not.toContain('listDoors')
    expect(Object.values(IPC).map((spec) => spec.channel)).not.toContain('vp:doors/list')
    const door = {
      id: 'door-1',
      name: 'Front Door',
      fullName: 'Ground Floor - Front Door',
      floorId: 'floor-1',
      type: 'door',
      boundToHub: false,
      relay: 'lock',
      position: null,
    }
    const listed = { ...emptyDoorsScreenState(), doors: [door] }
    expect(IPC.watchDoorsScreen.value.parse(listed)).toEqual(listed)
    // `is_bind_hub`'s string form is normalized in main (SPEC §5.2): only a boolean crosses.
    expect(
      IPC.watchDoorsScreen.value.safeParse({
        ...listed,
        doors: [{ ...door, boundToHub: 'false' }],
      }).success,
    ).toBe(false)
  })

  it('takes one boolean for watchDoors and answers the door-state map (DOOR-6)', () => {
    expect(IPC.watchDoors.channel).toBe('vp:doors/watch')
    expect(IPC.watchDoors.request.parse({ watching: true })).toEqual({ watching: true })
    // No door id crosses: main watches the doors in the saved links, and an extra key is dropped.
    expect(IPC.watchDoors.request.parse({ watching: false, doorIds: ['door-1'] })).toEqual({
      watching: false,
    })
    for (const bad of [undefined, {}, { watching: 'true' }, { watching: null }]) {
      expect(IPC.watchDoors.request.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    const states = {
      'door-1': { relay: 'unlock', position: 'open' },
      'door-2': { relay: 'lock', position: null },
    }
    expect(IPC.watchDoors.value.parse(states)).toEqual(states)
    expect(IPC.watchDoors.value.parse({})).toEqual({})
  })

  it('takes one boolean for watchDoorsScreen and answers the whole screen state (P5.6)', () => {
    expect(IPC.watchDoorsScreen.channel).toBe('vp:doors/screen')
    expect(IPC.watchDoorsScreen.request.parse({ open: true })).toEqual({ open: true })
    // No door id crosses here either: an unknown key is stripped.
    expect(IPC.watchDoorsScreen.request.parse({ open: false, doorIds: ['d'] })).toEqual({
      open: false,
    })
    for (const bad of [undefined, {}, { open: 'yes' }, { open: null }, { watching: true }]) {
      expect(IPC.watchDoorsScreen.request.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(IPC.watchDoorsScreen.value).toBe(DoorsScreenStateSchema)
  })

  it('takes a door id, an action and minutes only for custom, for doorAction (DOOR-3/4, P5.6)', () => {
    expect(IPC.doorAction.channel).toBe('vp:doors/action')
    expect(IPC.doorAction.request).toBe(DoorActionInputSchema)
    expect([...DOOR_ACTIONS]).toEqual([
      'unlock',
      'lock',
      'keep_unlock',
      'keep_lock',
      'custom',
      'reset',
    ])
    for (const action of DOOR_ACTIONS) {
      const input =
        action === 'custom' ? { doorId: 'd', action, minutes: 30 } : { doorId: 'd', action }
      expect(DoorActionInputSchema.parse(input)).toEqual(input)
    }
    // `minutes` iff `custom`: missing where required, present where not allowed.
    expect(DoorActionInputSchema.safeParse({ doorId: 'd', action: 'custom' }).success).toBe(false)
    for (const action of DOOR_ACTIONS.filter((entry) => entry !== 'custom')) {
      const withMinutes = { doorId: 'd', action, minutes: 5 }
      expect(DoorActionInputSchema.safeParse(withMinutes).success, action).toBe(false)
    }
    // Whole minutes from 1 to a day.
    expect(MAX_DOOR_CUSTOM_MINUTES).toBe(1440)
    for (const minutes of [1, 60, 1440]) {
      expect(
        DoorActionInputSchema.safeParse({ doorId: 'd', action: 'custom', minutes }).success,
      ).toBe(true)
    }
    for (const minutes of [0, -5, 1441, 2.5, '30', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        DoorActionInputSchema.safeParse({ doorId: 'd', action: 'custom', minutes }).success,
        String(minutes),
      ).toBe(false)
    }
    for (const bad of [
      undefined,
      {},
      { doorId: '', action: 'unlock' },
      { doorId: 7, action: 'unlock' },
      { doorId: 'd' },
      // The wire rule is main's to send (`lock` → `lock_now`, always).
      { doorId: 'd', action: 'lock_now' },
      { doorId: 'd', action: 'lock_early' },
      { doorId: 'd', action: 'emergency' },
      { doorId: 'd', action: 'UNLOCK' },
    ]) {
      expect(DoorActionInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    // The id is bounded: a refused one is written whole to unlock.log (DOOR-5).
    expect(MAX_DOOR_ID_LENGTH).toBe(200)
    const longest = 'd'.repeat(MAX_DOOR_ID_LENGTH)
    expect(DoorActionInputSchema.safeParse({ doorId: longest, action: 'unlock' }).success).toBe(
      true,
    )
    expect(
      DoorActionInputSchema.safeParse({ doorId: `${longest}d`, action: 'unlock' }).success,
    ).toBe(false)
    // Nothing else rides along: no camera ref, no rule, no repeat count.
    expect(
      DoorActionInputSchema.parse({ doorId: 'd', action: 'lock', sent: 'keep_unlock', times: 3 }),
    ).toEqual({ doorId: 'd', action: 'lock' })
  })

  it('answers doorAction with what was sent and whether the outcome is known (P5.6)', () => {
    expect(IPC.doorAction.value).toBe(DoorActionResultSchema)
    expect([...DOOR_ACTIONS_SENT]).toEqual([
      'unlock',
      'lock_now',
      'reset',
      'keep_lock',
      'keep_unlock',
      'custom',
    ])
    const result = {
      doorId: 'd',
      doorName: 'Front Door',
      action: 'lock',
      sent: 'lock_now',
      minutes: null,
      outcome: 'done',
      reason: null,
    }
    expect(DoorActionResultSchema.parse(result)).toEqual(result)
    // Lock is always `lock_now` (user decision 2026-11-18): the app never sends `lock_early`.
    expect(DoorActionResultSchema.safeParse({ ...result, sent: 'lock_early' }).success).toBe(false)
    expect(
      DoorActionResultSchema.parse({ ...result, outcome: 'unknown', reason: 'No answer.' }).outcome,
    ).toBe('unknown')
    // `lock` is a request, never something that was sent; `failed` is an error, not an outcome.
    expect(DoorActionResultSchema.safeParse({ ...result, sent: 'lock' }).success).toBe(false)
    expect(DoorActionResultSchema.safeParse({ ...result, outcome: 'failed' }).success).toBe(false)
  })

  it('takes both emergency flags and refuses both on (DOOR-3, P5.6)', () => {
    expect(IPC.setDoorEmergency.channel).toBe('vp:doors/emergency')
    expect(IPC.setDoorEmergency.request).toBe(DoorEmergencyInputSchema)
    for (const ok of [
      { lockdown: true, evacuation: false },
      { lockdown: false, evacuation: true },
      { lockdown: false, evacuation: false },
    ]) {
      expect(DoorEmergencyInputSchema.parse(ok)).toEqual(ok)
    }
    for (const bad of [
      { lockdown: true, evacuation: true },
      { lockdown: true },
      { evacuation: false },
      {},
      undefined,
      // A truthy string must never put every door into lockdown.
      { lockdown: 'true', evacuation: false },
      { lockdown: 1, evacuation: 0 },
      { lockdown: null, evacuation: false },
    ]) {
      expect(DoorEmergencyInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    const answer = { lockdown: false, evacuation: true, outcome: 'done', reason: null }
    expect(IPC.setDoorEmergency.value.parse(answer)).toEqual(answer)
  })

  it('takes all four polling intervals inside their bounds, and never defaults one (DOOR-6, P5.6)', () => {
    expect(IPC.setAccessPolling.channel).toBe('vp:doors/polling')
    expect(IPC.setAccessPolling.request).toBe(SetAccessPollingInputSchema)
    // Answers the whole state, like every other setting save.
    expect(IPC.setAccessPolling.value).toBe(AppStateSchema)
    expect(ACCESS_POLLING_BOUNDS).toEqual({
      withSocketSec: { min: 2, max: 60, default: 5 },
      withoutSocketSec: { min: 1, max: 30, default: 2 },
      unlockedSec: { min: 1, max: 10, default: 1 },
      detailsSec: { min: 10, max: 600, default: 30 },
    })
    expect(ACCESS_POLLING_FIELDS).toEqual([
      'withSocketSec',
      'withoutSocketSec',
      'unlockedSec',
      'detailsSec',
    ])
    const defaults = defaultAccessPolling()
    expect(SetAccessPollingInputSchema.parse(defaults)).toEqual(defaults)
    const at = (edge: 'min' | 'max'): Record<AccessPollingField, number> => ({
      withSocketSec: ACCESS_POLLING_BOUNDS.withSocketSec[edge],
      withoutSocketSec: ACCESS_POLLING_BOUNDS.withoutSocketSec[edge],
      unlockedSec: ACCESS_POLLING_BOUNDS.unlockedSec[edge],
      detailsSec: ACCESS_POLLING_BOUNDS.detailsSec[edge],
    })
    expect(SetAccessPollingInputSchema.safeParse(at('min')).success).toBe(true)
    expect(SetAccessPollingInputSchema.safeParse(at('max')).success).toBe(true)
    for (const field of ACCESS_POLLING_FIELDS) {
      const { min, max } = ACCESS_POLLING_BOUNDS[field]
      for (const value of [min - 1, max + 1, min + 0.5, String(min), null]) {
        expect(
          SetAccessPollingInputSchema.safeParse({ ...defaults, [field]: value }).success,
          `${field}=${String(value)}`,
        ).toBe(false)
      }
      // A missing field is the renderer's bug: defaulting it would reset a setting unasked.
      const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => key !== field))
      expect(SetAccessPollingInputSchema.safeParse(missing).success, `no ${field}`).toBe(false)
    }
  })

  it('accepts undefined for the calls that take no payload', () => {
    for (const spec of [IPC.getState, IPC.testConnection, IPC.connect, IPC.listCameras]) {
      expect(spec.request.safeParse(undefined).success).toBe(true)
      expect(spec.request.safeParse({ sneaky: true }).success).toBe(false)
    }
  })
})

describe('SnapshotResultSchema', () => {
  it('takes bytes, not a string', () => {
    const ok = SnapshotResultSchema.safeParse({
      state: 'ok',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8]),
      capturedAt: 1,
    })
    expect(ok.success).toBe(true)
    // A data URL would put a megabyte of base64 on the string heap for every thumbnail.
    expect(
      SnapshotResultSchema.safeParse({
        state: 'ok',
        mimeType: 'image/jpeg',
        bytes: 'data:image/jpeg;base64,/9j/',
        capturedAt: 1,
      }).success,
    ).toBe(false)
  })

  it('carries CAM-3’s offline case as a state, not as an error', () => {
    expect(
      SnapshotResultSchema.parse({ state: 'unavailable', reason: 'The camera is offline.' }),
    ).toEqual({ state: 'unavailable', reason: 'The camera is offline.' })
  })
})

describe('event payloads', () => {
  it('parses a camera state change and refuses an empty id', () => {
    expect(
      IPC_EVENTS.cameraState.payload.parse({ cameraId: 'cam-1', state: 'DISCONNECTED' }),
    ).toEqual({ cameraId: 'cam-1', state: 'DISCONNECTED' })
    expect(
      IPC_EVENTS.cameraState.payload.safeParse({ cameraId: '', state: 'CONNECTED' }).success,
    ).toBe(false)
  })

  it('parses a camera event and defaults a missing `end` to null (CELL-2, SPEC §5.1)', () => {
    const opening = {
      id: 'evt-1',
      cameraId: 'cam-1',
      trigger: 'smartDetect',
      protectType: 'smartDetectZone',
      start: 1_700_000_000_000,
      smartDetectTypes: ['person'],
    }
    // The opening `add` omits `end` entirely; it reads as "still running".
    expect(IPC_EVENTS.cameraEvent.payload.parse(opening)).toEqual({ ...opening, end: null })
    expect(IPC_EVENTS.cameraEvent.payload.parse({ ...opening, end: 1_700_000_005_000 }).end).toBe(
      1_700_000_005_000,
    )
    // A plain motion event carries no smart types.
    expect(
      IPC_EVENTS.cameraEvent.payload.parse({
        id: 'evt-2',
        cameraId: 'cam-1',
        trigger: 'motion',
        protectType: 'motion',
        start: 1,
      }).smartDetectTypes,
    ).toEqual([])
  })

  it('refuses a camera event with an empty id', () => {
    expect(
      IPC_EVENTS.cameraEvent.payload.safeParse({
        id: '',
        cameraId: 'cam-1',
        trigger: 'motion',
        protectType: 'motion',
        start: 1,
      }).success,
    ).toBe(false)
  })

  it('parses the whole inventory, since GET /v1/cameras stays the authority (R11)', () => {
    expect(IPC_EVENTS.cameras.payload.parse([{ id: 'cam-1' }])).toHaveLength(1)
  })

  it('parses the whole door-state map, and refuses a state it cannot draw (DOOR-6)', () => {
    const { channel, payload } = IPC_EVENTS.doorStates
    expect(channel).toBe('vp:event/doorStates')
    expect(IPC_EVENT_CHANNELS).toContain(channel)
    // `{}` is a real payload: every linked door is unknown (the monitor stopped, or reads fail).
    expect(payload.parse({})).toEqual({})
    const states = { 'door-1': { relay: 'lock', position: 'close' } }
    expect(payload.parse(states)).toEqual(states)
    for (const bad of [
      { 'door-1': { relay: 'ajar', position: null } },
      // A missing position must not be read as "no sensor".
      { 'door-1': { relay: 'lock' } },
      { 'door-1': null },
      { '': { relay: 'lock', position: null } },
      [],
    ]) {
      expect(payload.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    // The same shape as the call's answer, so the renderer has one thing to hold.
    expect(payload).toBe(IPC.watchDoors.value)
  })

  it('parses the whole Doors screen state, the same shape the call answers (P5.6)', () => {
    const { channel, payload } = IPC_EVENTS.doorsScreen
    expect(channel).toBe('vp:event/doorsScreen')
    expect(payload).toBe(IPC.watchDoorsScreen.value)
    const empty = emptyDoorsScreenState()
    expect(empty).toEqual({ doors: null, stale: false, rules: {}, emergency: null, error: null })
    expect(payload.parse(empty)).toEqual(empty)
    // A fresh object per call: a caller that fills one in must not change the next one.
    expect(emptyDoorsScreenState()).not.toBe(empty)
    const door = {
      id: 'door-1',
      name: 'Front Door',
      fullName: 'House - 1F - Front Door',
      floorId: 'floor-1',
      type: 'door',
      boundToHub: true,
      relay: 'unlock',
      position: 'close',
    }
    const full = {
      doors: [door, { ...door, id: 'door-2', boundToHub: false, relay: 'lock', position: null }],
      stale: true,
      rules: {
        'door-1': { type: 'schedule', endedTime: 1795000000 },
        // No rule, and a type the reference does not list: both must get through (leniency).
        'door-2': { type: '', endedTime: null },
        'door-3': { type: 'something_new', endedTime: 0 },
      },
      emergency: { lockdown: false, evacuation: true },
      error: {
        kind: 'timeout',
        message: 'No answer.',
        endpoint: 'udm.local:12445',
        retryable: true,
      },
    }
    expect(payload.parse(full)).toEqual(full)
    for (const bad of [
      { ...empty, doors: undefined },
      { ...empty, stale: 'no' },
      { ...empty, doors: [{ ...door, relay: 'ajar' }] },
      { ...empty, doors: [{ ...door, id: '' }] },
      { ...empty, rules: { 'door-1': { type: 7, endedTime: null } } },
      { ...empty, rules: { 'door-1': { type: 'custom' } } },
      { ...empty, rules: { '': { type: 'custom', endedTime: null } } },
      { ...empty, emergency: { lockdown: true } },
      { ...empty, error: { kind: 'made-up', message: 'x' } },
    ]) {
      expect(payload.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('tells a new go2rtc port apart from no go2rtc at all (P2.1/P2.2, gate G2)', () => {
    const payload = IPC_EVENTS.streamRuntime.payload
    expect(payload.parse({ state: 'up', port: 45678, epoch: 2 })).toEqual({
      state: 'up',
      port: 45678,
      epoch: 2,
    })
    expect(payload.parse({ state: 'down' })).toEqual({ state: 'down' })
    // No nullable port: the renderer reads which case happened instead of inferring it.
    expect(payload.safeParse({ state: 'up', port: null, epoch: 2 }).success).toBe(false)
  })
})

describe('the stream contract (CON-2, NFR-9)', () => {
  it('answers ensureStream with a loopback handle and nothing else', () => {
    const handle = streamHandle({ cameraId: 'cam-1', quality: 'low', port: 45678, epoch: 1 })
    expect(IPC.ensureStream.value.parse(handle)).toEqual(handle)
    expect(handle.wsUrl.startsWith('ws://127.0.0.1:')).toBe(true)
    // The same rule the `AppState` walker below enforces, for the one payload that is about
    // streaming: an RTSPS URL or a go2rtc credential reaching the renderer is the CON-2 violation
    // the whole main/renderer split exists to prevent.
    const forbidden = /api[-_]?key|token|secret|password|credential|rtsps?|stream[-_]?url/i
    for (const [key, value] of Object.entries(handle)) {
      expect(forbidden.test(key), key).toBe(false)
      expect(forbidden.test(String(value)), `${key}=${String(value)}`).toBe(false)
    }
  })

  it('answers cameraStreamQualities with one boolean per stream quality, never a URL (QUAL-7)', () => {
    const all = { high: true, medium: false, low: true, package: false }
    expect(RtspsAvailabilitySchema.parse(all)).toEqual(all)
    expect(IPC.cameraStreamQualities.value).toBe(RtspsAvailabilitySchema)
    // Exhaustive: a missing quality is a shape error, not "absent".
    expect(RtspsAvailabilitySchema.safeParse({ high: true, medium: true, low: true }).success).toBe(
      false,
    )
    // And the values are booleans only: the URL that main read must not fit here.
    expect(
      RtspsAvailabilitySchema.safeParse({
        ...all,
        high: 'rtsps://192.0.2.10:7441/AAAAAAAAAAAAAAAA?enableSrtp',
      }).success,
    ).toBe(false)
  })

  it('has no release call: the player’s closed socket is the release (ARCHITECTURE §2 rule 3)', () => {
    // go2rtc opens the upstream RTSPS session only while a consumer is attached, so a release call
    // would be a second lifecycle for the renderer to get wrong — and the app never DELETEs a
    // Protect stream (QUAL-8: they may be shared with other integrations).
    for (const name of Object.keys(IPC)) {
      expect(/release|delete|destroy|stop.*stream/i.test(name), name).toBe(false)
    }
  })

  it('has a kind for the gateway being down, distinct from a camera being offline', () => {
    // Added in P2.2. A cell has to show "video unavailable, retrying" rather than CAM-3's offline
    // camera or a Settings problem; `unavailable` means the *console* said no.
    expect(IPC_ERROR_KINDS).toContain('gateway-down')
    expect(
      ipcFail('gateway-down', 'The video gateway is restarting.', { retryable: true }).ok,
    ).toBe(false)
  })
})

describe('AppState (CON-2, NFR-9)', () => {
  /** Every key path in a parsed state, so a field added with a default cannot slip through. */
  function keyPaths(value: unknown, prefix = '', depth = 0): string[] {
    if (depth > 8 || value === null || typeof value !== 'object') return []
    if (Array.isArray(value))
      return value.flatMap((item) => keyPaths(item, `${prefix}[]`, depth + 1))
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`
      return [path, ...keyPaths(child, path, depth + 1)]
    })
  }

  it('holds nothing that looks like a secret or a stream URL', () => {
    // The renderer gets booleans for "is a credential stored" and loopback go2rtc names for video
    // (P2.2). An API key, an Access token or an RTSPS URL reaching this object would be the CON-2
    // violation the whole split exists to prevent, so the guard is on the names as well as the
    // values: `secretsStored.protectApiKey` is a boolean and is allowed, a string would not be.
    const forbidden = /api[-_]?key|token|secret|password|credential|rtsps?|stream[-_]?url/i
    const state = sampleState()
    const flat: Record<string, unknown> = {}
    const collect = (value: unknown, prefix: string, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== 'object') {
        flat[prefix] = value
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          collect(item, `${prefix}[${String(i)}]`, depth + 1)
        })
        return
      }
      for (const [key, child] of Object.entries(value)) {
        collect(child, prefix === '' ? key : `${prefix}.${key}`, depth + 1)
      }
    }
    collect(state, '', 0)

    for (const [path, value] of Object.entries(flat)) {
      const leaf = path.split('.').at(-1) ?? path
      if (!forbidden.test(leaf)) continue
      // A key by one of these names is allowed only as a **boolean** — "a credential is stored",
      // "audio is available". The moment one holds a string it is carrying the thing itself.
      expect(typeof value, `${path} must be a boolean, not a value`).toBe('boolean')
    }
  })

  it('refuses a stream URL in place of a "stored" boolean (RTSP-2)', () => {
    const state = { ...sampleState() } as Record<string, unknown>
    state.secretsStored = {
      protectApiKey: true,
      accessToken: true,
      rtspUrls: {
        'rtsp-x': { high: 'rtsp://user:pass@cam.local/live', medium: false, low: false },
      },
    }
    expect(AppStateSchema.safeParse(state).success).toBe(false)
  })

  it('exposes the two certificate fingerprints, which are public values, not secrets (SPEC §6)', () => {
    const paths = keyPaths(sampleState())
    expect(paths).toContain('settings.console.certFingerprint')
    expect(paths).toContain('settings.console.accessCertFingerprint')
  })

  it('does not carry the schemaVersion storage envelope', () => {
    expect(keyPaths(sampleState())).not.toContain('settings.schemaVersion')
  })
})
