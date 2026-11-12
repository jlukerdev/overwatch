// P0.3b: the app-facing Protect types (src/main/protect/types.ts) against the vendored contract
// and the sanitized P0.3 fixtures.
//
// Two layers, because JSON imports widen string literals (`modelKey: string`, `state: string`,
// `type: string`), so fixtures that carry enums can't be checked with `satisfies` at compile time:
//   1. Runtime: every fixture is validated against the contract with Ajv (scripts/lib/
//      contract.ts) through `conforms<T>()`, which then hands it back typed as the app type.
//      Known drift (P0.3 §6) is asserted exactly, so a contract fix or new drift fails the test.
//   2. Compile time: fixtures without enum fields use `satisfies`; everything else uses
//      `expectTypeOf` on hand-written minimal samples copied from the observed shapes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { components } from '../../src/main/protect/generated'
import type {
  CameraFeatureFlags,
  CameraState,
  CameraTriggerEvent,
  CameraTriggerEventType,
  DeviceMessage,
  ProtectCamera,
  ProtectErrorBody,
  ProtectEvent,
  ProtectEventMessage,
  ProtectEventType,
  ProtectMetaInfo,
  RtspsQuality,
  RtspsStreams,
  RtspsStreamsCreated,
  RtspsStreamsRequest,
  SmartDetectObjectType,
  TalkbackSession,
} from '../../src/main/protect/types'
import { Contract, pointerToken, responsePointer } from '../../scripts/lib/contract.ts'
import cameras from '../fixtures/protect/cameras.json'
import eventsWs from '../fixtures/protect/events-ws.motion.json'
import metaInfo from '../fixtures/protect/meta-info.json'
import rtspsGet from '../fixtures/protect/rtsps-stream.get.json'
import rtspsPost from '../fixtures/protect/rtsps-stream.post.json'
import snapshotMeta from '../fixtures/protect/snapshot.meta.json'

const ROOT = resolve(import.meta.dirname, '..', '..')
const contract = new Contract(
  JSON.parse(
    readFileSync(resolve(ROOT, 'docs/reference/protect-openapi-v7.3.74.json'), 'utf8'),
  ) as unknown,
)

const RTSPS_PATH = '/v1/cameras/{id}/rtsps-stream'
const GENERIC_ERROR = '/components/schemas/genericError'
const CAMERA_SCHEMA = '/components/schemas/camera'
const RTSPS_REQUEST = ['', 'paths', RTSPS_PATH, 'post', 'requestBody', 'content']
  .concat(['application/json', 'schema'])
  .map((t, i) => (i === 0 ? t : pointerToken(t)))
  .join('/')

/**
 * The sanitizer replaces each RTSPS alias with `<redacted-quality>`, and `<`/`>` are not valid in
 * a URI, so Ajv's `format: uri` would reject the placeholders (the spike validated the raw
 * responses before sanitizing). Strip the brackets to get a URI-shaped stand-in.
 */
function unredact<T extends Record<string, string | null>>(streams: T): T {
  return Object.fromEntries(
    Object.entries(streams).map(([k, v]) => [k, v?.replace(/<(redacted-[a-z]+)>/g, '$1') ?? null]),
  ) as T
}

/** Asserts `data` is valid against the contract schema at `pointer` and returns it as `T`. */
// T is deliberately return-only: it is the typed view of data that Ajv has just validated.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function conforms<T>(pointer: string, data: unknown): T {
  const result = contract.validate(pointer, data)
  expect(result.errors).toEqual([])
  expect(result.extraProperties).toEqual([])
  expect(result.valid).toBe(true)
  return data as T
}

describe('fixtures conform to the contract and the app types', () => {
  it('GET /v1/meta/info', () => {
    const meta = conforms<ProtectMetaInfo>(responsePointer('/v1/meta/info', 'get'), metaInfo)
    expect(meta.applicationVersion).toBe('7.3.74')
  })

  it('GET /v1/cameras: valid except the documented lcdMessage drift (P0.3 §6)', () => {
    const result = contract.validate(responsePointer('/v1/cameras', 'get'), cameras)
    // DRIFT: the contract requires lcdMessage; cameras without a display omit it. If this starts
    // failing because the contract was fixed, drop the override in types.ts.
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(["/[]: must have required property 'lcdMessage'"])
    expect(result.extraProperties).toEqual([])
    expect(cameras.length).toBeGreaterThan(0)
    for (const raw of cameras) expect(raw).not.toHaveProperty('lcdMessage')

    // With the drift accounted for, each camera is exactly a contract camera.
    const typed = cameras.map((raw) =>
      conforms<ProtectCamera>(CAMERA_SCHEMA, { ...raw, lcdMessage: {} }),
    )
    const states: CameraState[] = ['CONNECTED', 'CONNECTING', 'DISCONNECTED']
    for (const camera of typed) {
      expect(camera.modelKey).toBe('camera')
      expect(states).toContain(camera.state)
      expect(typeof camera.featureFlags.supportFullHdSnapshot).toBe('boolean')
    }
  })

  it('GET /v1/cameras/{id}/rtsps-stream', () => {
    const streams = conforms<RtspsStreams>(responsePointer(RTSPS_PATH, 'get'), unredact(rtspsGet))
    expect(streams.package).toBeNull()
  })

  it('POST /v1/cameras/{id}/rtsps-stream (request and response)', () => {
    const request = conforms<RtspsStreamsRequest>(RTSPS_REQUEST, rtspsPost.request)
    const created = conforms<RtspsStreamsCreated>(
      responsePointer(RTSPS_PATH, 'post'),
      unredact(rtspsPost.response),
    )
    // POST returns only the requested qualities (P0.3 §9 item 3).
    expect(Object.keys(created).sort()).toEqual([...request.qualities].sort())
  })

  it('WS /v1/subscribe/events: motion and smartDetect sequences', () => {
    const pointer = responsePointer('/v1/subscribe/events', 'get')
    const { motion } = eventsWs
    expect(motion).not.toBeNull()
    const messages = [motion.add, ...motion.updates, ...eventsWs.smartDetect].map((m) =>
      conforms<ProtectEventMessage>(pointer, m),
    )
    expect(messages.length).toBeGreaterThan(2)

    const add = messages[0]
    expect(add?.type).toBe('add')
    expect(add?.item.type).toBe('motion')
    expect(add?.item).not.toHaveProperty('end') // `add` omits `end` (P0.3 §5)
    const last = messages.at(motion.updates.length)
    expect(last?.type).toBe('update')
    expect(last && 'end' in last.item ? typeof last.item.end : undefined).toBe('number')

    const smart = messages.find((m) => m.item.type === 'smartDetectZone')?.item
    if (smart?.type !== 'smartDetectZone') throw new Error('no smartDetectZone fixture')
    expectTypeOf(smart.smartDetectTypes).toEqualTypeOf<SmartDetectObjectType[] | null>()
    expect(smart.smartDetectTypes).toContain('person')
  })

  it('error bodies: 400 snapshot and 429 rate limit (P0.3 §6)', () => {
    const bodies = snapshotMeta.flatMap((s) => ('body' in s ? [s.body] : []))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) conforms<ProtectErrorBody>(GENERIC_ERROR, body)

    // DRIFT: the 429 body observed in P0.3 §5/§7 carries undeclared windowMs/limit.
    const rateLimited = {
      error: 'Too many requests',
      name: 'TOO_MANY_REQUESTS_ERROR',
      windowMs: 1000,
      limit: 10,
    } satisfies ProtectErrorBody
    const result = contract.validate(GENERIC_ERROR, rateLimited)
    expect(result.valid).toBe(true)
    expect(result.extraProperties).toEqual(['/limit', '/windowMs'])
  })
})

describe('compile-time shape of the exported types', () => {
  it('fixtures without enum fields satisfy their types directly', () => {
    expectTypeOf(metaInfo).toExtend<ProtectMetaInfo>()
    expectTypeOf(rtspsGet).toExtend<RtspsStreams>()
    expectTypeOf(rtspsPost.response).toExtend<RtspsStreamsCreated>()
  })

  it('ProtectCamera: lcdMessage is optional (override) but required in the contract', () => {
    type ContractCamera = components['schemas']['camera']
    expectTypeOf<
      undefined extends ProtectCamera['lcdMessage'] ? true : false
    >().toEqualTypeOf<true>()
    expectTypeOf<Pick<ProtectCamera, 'lcdMessage'>>().toEqualTypeOf<{
      lcdMessage?: ContractCamera['lcdMessage']
    }>()
    expectTypeOf<{ lcdMessage: ContractCamera['lcdMessage'] }>().toExtend<
      Pick<ContractCamera, 'lcdMessage'>
    >()
    expectTypeOf<object>().not.toExtend<Pick<ContractCamera, 'lcdMessage'>>()
    // Every other property is unchanged.
    expectTypeOf<Omit<ProtectCamera, 'lcdMessage'>>().toEqualTypeOf<
      Omit<ContractCamera, 'lcdMessage'>
    >()
  })

  it('camera enums and flags', () => {
    expectTypeOf<CameraState>().toEqualTypeOf<'CONNECTED' | 'CONNECTING' | 'DISCONNECTED'>()
    expectTypeOf<SmartDetectObjectType>().toEqualTypeOf<
      'person' | 'vehicle' | 'package' | 'licensePlate' | 'face' | 'animal'
    >()
    expectTypeOf<CameraFeatureFlags['hasSpeaker']>().toEqualTypeOf<boolean>()
    expectTypeOf<CameraFeatureFlags['supportFullHdSnapshot']>().toEqualTypeOf<boolean>()
  })

  it('RTSPS streams', () => {
    expectTypeOf<RtspsQuality>().toEqualTypeOf<'high' | 'medium' | 'low' | 'package'>()
    expectTypeOf<RtspsStreamsRequest>().toEqualTypeOf<{ qualities: RtspsQuality[] }>()
    expectTypeOf<RtspsStreams['high']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<RtspsStreamsCreated['low']>().toEqualTypeOf<string | undefined>()
    expectTypeOf({
      high: 'rtsps://h',
      medium: null,
      low: null,
      package: null,
    }).toExtend<RtspsStreams>()
  })

  it('ProtectErrorBody allows the 429 extras', () => {
    expectTypeOf({ error: 'x', name: 'BAD_REQUEST' }).toExtend<ProtectErrorBody>()
    expectTypeOf<ProtectErrorBody['windowMs']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<ProtectErrorBody['limit']>().toEqualTypeOf<number | undefined>()
  })

  it('event messages and items', () => {
    // Shapes observed in P0.3 §5: `add` without `end`, `update` with the full event and `end`.
    const add = {
      type: 'add',
      item: { id: 'evt-1', modelKey: 'event', type: 'motion', start: 1, device: 'cam-1' },
    } satisfies ProtectEventMessage
    const update = {
      type: 'update',
      item: {
        id: 'evt-2',
        modelKey: 'event',
        type: 'smartDetectZone',
        start: 1,
        end: 2,
        device: 'cam-1',
        smartDetectTypes: ['person'],
      },
    } satisfies ProtectEventMessage
    expectTypeOf(add).toExtend<ProtectEventMessage>()
    expectTypeOf(update).toExtend<ProtectEventMessage>()
    expectTypeOf({ ...add, type: 'remove' as const }).not.toExtend<ProtectEventMessage>()

    expectTypeOf<ProtectEventMessage['type']>().toEqualTypeOf<'add' | 'update'>()
    expectTypeOf<ProtectEventMessage['item']>().toEqualTypeOf<ProtectEvent>()
    expectTypeOf<CameraTriggerEventType>().toEqualTypeOf<
      'motion' | 'smartDetectZone' | 'smartDetectLine' | 'smartDetectLoiterZone' | 'ring'
    >()
    expectTypeOf<'nfcCardScanned' | 'fingerprintIdentified'>().toExtend<ProtectEventType>()
    expectTypeOf<CameraTriggerEvent['device']>().toEqualTypeOf<string>()
    expectTypeOf<Extract<ProtectEvent, { type: 'motion' }>['end']>().toEqualTypeOf<
      number | null | undefined
    >()
  })

  it('DeviceMessage: camera add items without lcdMessage (override), others unchanged', () => {
    type ContractDeviceMessage = components['schemas']['deviceEvent']
    type ContractCamera = components['schemas']['camera']
    interface IsCamera {
      modelKey: 'camera'
    }
    type AddItem<M extends { type: string; item: unknown }> = Extract<M, { type: 'add' }>['item']

    // A single `add` camera item is exactly ProtectCamera, so lcdMessage can be left out...
    type CameraAdd = Extract<AddItem<DeviceMessage>, IsCamera & { id: string }>
    expectTypeOf<CameraAdd>().toEqualTypeOf<ProtectCamera>()
    const noLcd = { type: 'add', item: {} as Omit<ContractCamera, 'lcdMessage'> } as const
    expectTypeOf(noLcd).toExtend<DeviceMessage>()
    // ...which the contract alone would reject.
    expectTypeOf(noLcd).not.toExtend<ContractDeviceMessage>()

    // The bulk `add` camera item (id: string | string[]) gets the same relaxation.
    type BulkCameraAdd = Extract<AddItem<DeviceMessage>, IsCamera & { id: string | string[] }>
    type ContractBulkCameraAdd = Extract<
      components['schemas']['deviceBulk'],
      IsCamera & { id: string | string[] }
    >
    expectTypeOf<
      undefined extends BulkCameraAdd['lcdMessage'] ? true : false
    >().toEqualTypeOf<true>()
    expectTypeOf<Omit<BulkCameraAdd, 'lcdMessage'>>().toEqualTypeOf<
      Omit<ContractBulkCameraAdd, 'lcdMessage'>
    >()

    // Non-camera items and camera update/remove items are the contract types unchanged.
    expectTypeOf<Exclude<DeviceMessage['item'], IsCamera>>().toEqualTypeOf<
      Exclude<ContractDeviceMessage['item'], IsCamera>
    >()
    expectTypeOf<
      Extract<Extract<DeviceMessage, { type: 'update' | 'remove' }>['item'], IsCamera>
    >().toEqualTypeOf<
      Extract<Extract<ContractDeviceMessage, { type: 'update' | 'remove' }>['item'], IsCamera>
    >()
  })

  it('device messages and talkback', () => {
    expectTypeOf<DeviceMessage['type']>().toEqualTypeOf<'add' | 'update' | 'remove'>()
    expectTypeOf<'camera'>().toExtend<DeviceMessage['item']['modelKey']>()
    expectTypeOf<TalkbackSession>().toEqualTypeOf<{
      url: string
      codec: string
      samplingRate: number
      bitsPerSample: number
    }>()
  })
})
