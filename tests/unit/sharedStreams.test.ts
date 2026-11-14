// P2.2: the renderer-facing stream contract (src/shared/streams.ts).
//
// What is worth holding down in a file of schemas is the invariants no type can state:
//  - a handle's parts cannot disagree (a `name` or a `wsUrl` for a different camera, quality or port
//    is how a player ends up showing the wrong camera);
//  - nothing in a handle is a secret or an upstream URL (CON-2, NFR-9) — the renderer gets a
//    loopback name, port and ws URL and nothing else;
//  - `<cameraId>_<quality>` round-trips (ARCHITECTURE §2 rule 3), so main can map a go2rtc stream
//    back to a camera without a second index;
//  - "down" and "up on a new port" are distinguishable without guessing (gate G2's recovery).
import { isSafeStreamName } from '../../src/main/streams/go2rtcConfig'
import {
  GO2RTC_WS_PATH,
  go2rtcWsUrl,
  isHandleCurrent,
  isStreamName,
  LOOPBACK_HOST,
  parseStreamName,
  STREAM_RUNTIME_DOWN,
  StreamHandleSchema,
  streamHandle,
  streamName,
  StreamNameSchema,
  StreamRuntimeSchema,
  type StreamHandle,
} from '@shared/streams'
import { STREAM_QUALITIES } from '@shared/quality'
import { describe, expect, it } from 'vitest'

const CAM = '66f1a2b3c4d5e6f708192a3b'

describe('stream names (ARCHITECTURE §2 rule 3)', () => {
  it('is `<cameraId>_<quality>` for every stream source, package included (CAM-4, QUAL-8)', () => {
    for (const quality of STREAM_QUALITIES) {
      const name = streamName(CAM, quality)
      expect(name).toBe(`${CAM}_${quality}`)
      expect(isStreamName(name)).toBe(true)
      expect(StreamNameSchema.parse(name)).toBe(name)
      expect(parseStreamName(name)).toEqual({ cameraId: CAM, quality })
    }
  })

  it('refuses anything that is not that shape', () => {
    for (const bad of [
      '',
      CAM, // no quality
      `${CAM}_ultra`, // not a stream source
      `${CAM}_HIGH`, // go2rtc keys are case-sensitive
      `${CAM}-high`, // wrong separator
      `${CAM}_high_low`,
      // A camera id may not contain the separator, or `<cameraId>_<quality>` could not be split
      // back unambiguously.
      `cam_1_high`,
      // Nothing that needs escaping in the `?src=` query, and no path traversal into go2rtc's API.
      `${CAM}/x_high`,
      `../${CAM}_high`,
      `${CAM} _high`,
      `cam?${CAM}_high`,
    ]) {
      expect(isStreamName(bad), bad).toBe(false)
      expect(parseStreamName(bad), bad).toBeNull()
      expect(StreamNameSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})

describe('the ws URL', () => {
  it('is loopback-only and points at go2rtc’s MSE endpoint (SPEC §5.3)', () => {
    const url = go2rtcWsUrl(31234, streamName(CAM, 'low'))
    expect(url).toBe(`ws://127.0.0.1:31234/api/ws?src=${CAM}_low`)
    // Main's `onBeforeSendHeaders` filter only injects go2rtc's credentials for this host and path.
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('ws:')
    expect(parsed.hostname).toBe(LOOPBACK_HOST)
    expect(parsed.pathname).toBe(GO2RTC_WS_PATH)
    expect(parsed.searchParams.get('src')).toBe(`${CAM}_low`)
  })
})

describe('StreamHandle', () => {
  const handle = streamHandle({ cameraId: CAM, quality: 'medium', port: 45678, epoch: 2 })

  it('carries only a loopback name, port, URL and epoch (CON-2, NFR-9)', () => {
    expect(StreamHandleSchema.parse(handle)).toEqual(handle)
    // The exhaustive key list is the point: a field added here is a field the renderer can read, so
    // adding one has to be a deliberate edit to this test as well.
    expect(Object.keys(handle).sort()).toEqual([
      'cameraId',
      'epoch',
      'name',
      'port',
      'quality',
      'wsUrl',
    ])
    // No RTSPS URL, no Protect alias, no go2rtc API credentials anywhere in the payload.
    const serialized = JSON.stringify(handle)
    for (const forbidden of ['rtsp', 'rtspx', 'enableSrtp', '7441', 'Basic ', 'password']) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })

  it('refuses a handle whose parts disagree', () => {
    // Each of these is a player attached to something other than what it thinks it is playing.
    const broken: StreamHandle[] = [
      { ...handle, name: streamName(CAM, 'high') }, // name from another quality
      { ...handle, name: streamName('other-cam', 'medium') }, // another camera
      { ...handle, quality: 'high' }, // quality changed, name left behind
      { ...handle, cameraId: 'other-cam' },
      { ...handle, port: 45679 }, // wsUrl left on the old port
      { ...handle, wsUrl: `ws://10.0.0.5:45678${GO2RTC_WS_PATH}?src=${CAM}_medium` },
      { ...handle, wsUrl: `wss://127.0.0.1:45678${GO2RTC_WS_PATH}?src=${CAM}_medium` },
    ]
    for (const value of broken) {
      expect(StreamHandleSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })

  it('refuses an empty camera id, an impossible port and a pre-start epoch', () => {
    expect(StreamHandleSchema.safeParse({ ...handle, cameraId: '' }).success).toBe(false)
    for (const port of [0, -1, 70000, 1.5]) {
      const onBadPort = streamHandle({ cameraId: CAM, quality: 'medium', port, epoch: 1 })
      expect(StreamHandleSchema.safeParse(onBadPort).success, String(port)).toBe(false)
    }
    // The first healthy go2rtc start is epoch 1, so 0 would make a stale handle look current.
    expect(StreamHandleSchema.safeParse({ ...handle, epoch: 0 }).success).toBe(false)
  })
})

describe('StreamRuntime', () => {
  it('tells "up on a port" and "down" apart without a nullable port', () => {
    expect(StreamRuntimeSchema.parse({ state: 'up', port: 45678, epoch: 1 })).toEqual({
      state: 'up',
      port: 45678,
      epoch: 1,
    })
    expect(StreamRuntimeSchema.parse(STREAM_RUNTIME_DOWN)).toEqual({ state: 'down' })
    // `down` says nothing more: why go2rtc stopped is main's log, not something a cell can act on.
    expect(Object.keys(STREAM_RUNTIME_DOWN)).toEqual(['state'])
  })

  it('refuses an up without a runtime and an unknown state', () => {
    expect(StreamRuntimeSchema.safeParse({ state: 'up' }).success).toBe(false)
    expect(StreamRuntimeSchema.safeParse({ state: 'up', port: 45678 }).success).toBe(false)
    expect(StreamRuntimeSchema.safeParse({ state: 'restarting' }).success).toBe(false)
  })
})

describe('isHandleCurrent (gate G2: recovery after go2rtc is killed)', () => {
  const handle = streamHandle({ cameraId: CAM, quality: 'low', port: 45678, epoch: 3 })

  it('is current only for the runtime it was issued under', () => {
    expect(isHandleCurrent(handle, { state: 'up', port: 45678, epoch: 3 })).toBe(true)
    // A restart: new epoch, new port. The handle must be re-fetched, not retried.
    expect(isHandleCurrent(handle, { state: 'up', port: 45679, epoch: 4 })).toBe(false)
    // A recycled port with a new epoch is still stale — that is what the counter is for.
    expect(isHandleCurrent(handle, { state: 'up', port: 45678, epoch: 4 })).toBe(false)
    expect(isHandleCurrent(handle, STREAM_RUNTIME_DOWN)).toBe(false)
  })
})

// The one invariant that spans the two layers, in the style of the SECRET_KEYS check in
// ipcContract.test.ts: `src/shared` may not import from `src/main`, so nothing but a test can hold
// the two stream-name rules together. Main *throws* when the generated go2rtc YAML would carry a
// name `isSafeStreamName` rejects, so any name this contract admits and main refuses would be a
// stream that dies at launch rather than at validation.
describe('stream names main would accept (cross-layer)', () => {
  it('admits only names isSafeStreamName also accepts', () => {
    for (const quality of STREAM_QUALITIES) {
      const name = streamName(CAM, quality)
      expect(isStreamName(name)).toBe(true)
      expect(isSafeStreamName(name)).toBe(true)
    }
  })

  it('refuses the names main would reject, before they reach a handle', () => {
    // A `.` is legal in neither, and a camera id long enough to break main's 64-character cap is
    // refused here too, so the contract can never hand main a name it will throw on.
    for (const cameraId of ['cam.001', 'a'.repeat(64)]) {
      const name = streamName(cameraId, 'low')
      expect(isStreamName(name)).toBe(false)
      expect(isSafeStreamName(name)).toBe(false)
      expect(StreamNameSchema.safeParse(name).success).toBe(false)
    }
  })
})
