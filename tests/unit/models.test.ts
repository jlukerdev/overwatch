// P1.3/P1.4: the runtime half of the shared domain model — what the API clients produce and what
// crosses IPC (P1.5). These schemas are deliberately **lenient**: a console upgrade that adds a
// camera state or a smart-detect type must not empty the camera list (CAM-1, SPEC R8/R11), and an
// event that arrives mid-flight has no `end` yet (SPEC §5.1 event lifecycle).
import {
  CAMERA_STATES,
  CameraEventSchema,
  CameraSchema,
  CameraStateChangeSchema,
  DoorSchema,
  isCameraOnline,
} from '@shared/models'
import { describe, expect, it } from 'vitest'

describe('CameraSchema', () => {
  it('needs only an id, and defaults the rest (CAM-1)', () => {
    // A camera with a surprising payload still has to appear in the list, offline if need be.
    expect(CameraSchema.parse({ id: 'cam-1' })).toEqual({
      id: 'cam-1',
      name: null,
      model: '',
      state: '',
      hasMic: false,
      micEnabled: false,
      hasSpeaker: false,
      smartDetectTypes: [],
      supportsFullHdSnapshot: false,
      hasPackageCamera: false,
    })
  })

  it('rejects a camera with no usable id', () => {
    // Without an id there is nothing to stream, link to a cell or snapshot.
    expect(CameraSchema.safeParse({ id: '' }).success).toBe(false)
    expect(CameraSchema.safeParse({}).success).toBe(false)
  })

  it('keeps a state Protect has not documented yet', () => {
    // An enum here would turn a console upgrade into a dropped camera.
    expect(CameraSchema.parse({ id: 'cam-1', state: 'REBOOTING' }).state).toBe('REBOOTING')
  })

  it('keeps a smart-detect type Protect has not documented yet', () => {
    expect(
      CameraSchema.parse({ id: 'cam-1', smartDetectTypes: ['person', 'bicycle'] }).smartDetectTypes,
    ).toEqual(['person', 'bicycle'])
  })

  it('gives each parse its own arrays', () => {
    const a = CameraSchema.parse({ id: 'a' })
    const b = CameraSchema.parse({ id: 'b' })
    a.smartDetectTypes.push('person')
    expect(b.smartDetectTypes).toEqual([])
  })
})

describe('isCameraOnline (CAM-3)', () => {
  it('is true only for CONNECTED', () => {
    expect(CAMERA_STATES).toEqual(['CONNECTED', 'CONNECTING', 'DISCONNECTED'])
    expect(isCameraOnline('CONNECTED')).toBe(true)
    // CONNECTING is not yet streaming, and an unknown state is not a reason to show a live cell.
    expect(isCameraOnline('CONNECTING')).toBe(false)
    expect(isCameraOnline('DISCONNECTED')).toBe(false)
    expect(isCameraOnline('connected')).toBe(false)
    expect(isCameraOnline('')).toBe(false)
  })
})

describe('CameraEventSchema (CELL-2)', () => {
  it('defaults end to null, because the opening add omits it', () => {
    const event = CameraEventSchema.parse({
      id: 'evt-1',
      cameraId: 'cam-1',
      trigger: 'motion',
      protectType: 'motion',
      start: 1_762_000_000_000,
    })
    expect(event.end).toBeNull()
    expect(event.smartDetectTypes).toEqual([])
  })

  it('carries the end timestamp the closing update sets', () => {
    // CELL-2 measures motionHoldSec from this timestamp, not from when the message arrived.
    expect(
      CameraEventSchema.parse({
        id: 'evt-1',
        cameraId: 'cam-1',
        trigger: 'smartDetect',
        protectType: 'smartDetectLoiterZone',
        start: 1_762_000_000_000,
        end: 1_762_000_016_600,
        smartDetectTypes: ['person'],
      }).end,
    ).toBe(1_762_000_016_600)
  })

  it('only accepts the three cell triggers', () => {
    const base = { id: 'e', cameraId: 'c', protectType: 'motion', start: 0 }
    expect(CameraEventSchema.safeParse({ ...base, trigger: 'motion' }).success).toBe(true)
    expect(CameraEventSchema.safeParse({ ...base, trigger: 'smartDetect' }).success).toBe(true)
    expect(CameraEventSchema.safeParse({ ...base, trigger: 'ring' }).success).toBe(true)
    // Mapping Protect's own types onto these belongs to the subscription, not to the cell logic.
    expect(CameraEventSchema.safeParse({ ...base, trigger: 'smartDetectZone' }).success).toBe(false)
  })

  it('needs a camera id: an event no cell can own is useless', () => {
    expect(
      CameraEventSchema.safeParse({
        id: 'e',
        cameraId: '',
        trigger: 'motion',
        protectType: 'motion',
        start: 0,
      }).success,
    ).toBe(false)
  })
})

describe('CameraStateChangeSchema (CAM-2/3)', () => {
  it('takes any state string, like the camera itself', () => {
    expect(CameraStateChangeSchema.parse({ cameraId: 'cam-1', state: 'DISCONNECTED' })).toEqual({
      cameraId: 'cam-1',
      state: 'DISCONNECTED',
    })
    expect(CameraStateChangeSchema.safeParse({ cameraId: 'cam-1', state: '' }).success).toBe(false)
  })
})

describe('DoorSchema (DOOR-1/2)', () => {
  const door = {
    id: 'door-1',
    name: 'Front Door',
    fullName: 'Ground Floor - Front Door',
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay: 'lock',
    position: 'close',
  }

  it('is the trimmed, camelCase form of the Access door', () => {
    expect(DoorSchema.parse(door)).toEqual(door)
  })

  it('accepts a door with no position sensor', () => {
    // The console sends `null` or `''` for a door without a sensor; `''` becomes null in main.
    expect(DoorSchema.parse({ ...door, position: null }).position).toBeNull()
    expect(DoorSchema.safeParse({ ...door, position: '' }).success).toBe(false)
  })

  it('rejects a relay or position value the wire schemas would already have refused', () => {
    expect(DoorSchema.safeParse({ ...door, relay: 'unlocked' }).success).toBe(false)
    expect(DoorSchema.safeParse({ ...door, position: 'ajar' }).success).toBe(false)
  })

  it('needs an id, since that is what unlock addresses', () => {
    expect(DoorSchema.safeParse({ ...door, id: '' }).success).toBe(false)
  })
})
