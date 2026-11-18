// P5.4, P5.5 (DOOR-0, DOOR-2, DOOR-3, DOOR-6): which door a cell's unlock control opens, when it
// shows, and when the Live screen asks main to watch the doors
// (src/renderer/src/features/door/doorLink.ts).
//
// What these tests protect: nothing while Access is saved as off; a camera's own link; a package
// ref (`<id>:package`) using its doorbell's link; no door for an unlinked camera (or a prototype
// key); the control only for a linked camera that is connected and streaming; and the watch only
// while Access is on and some camera of the active View — anywhere in a cell's list — has a link.
import { describe, expect, it } from 'vitest'
import {
  doorForCell,
  shouldWatchDoors,
  unlockAvailable,
  viewCameraRefs,
} from '../../src/renderer/src/features/door/doorLink'

const LINKS = { cam1: 'door-a', doorbell: 'door-b' }

describe('doorForCell', () => {
  it("finds the camera's door while Access is on", () => {
    expect(doorForCell('cam1', LINKS, true)).toBe('door-a')
  })

  it('has no door while Access is off, even with a link (DOOR-0)', () => {
    expect(doorForCell('cam1', LINKS, false)).toBeNull()
  })

  it("uses the doorbell's link for its package channel (DOOR-2)", () => {
    expect(doorForCell('doorbell:package', LINKS, true)).toBe('door-b')
  })

  it('has no door for an unlinked camera, or a package ref of one', () => {
    expect(doorForCell('cam2', LINKS, true)).toBeNull()
    expect(doorForCell('cam2:package', LINKS, true)).toBeNull()
  })

  it('has no door with no settings loaded', () => {
    expect(doorForCell('cam1', undefined, true)).toBeNull()
    expect(doorForCell('cam1', null, true)).toBeNull()
  })

  it('never reads a prototype member as a link', () => {
    expect(doorForCell('constructor', LINKS, true)).toBeNull()
    expect(doorForCell('toString', {}, true)).toBeNull()
  })
})

describe('unlockAvailable', () => {
  it('needs a door, a connected camera and live video', () => {
    expect(unlockAvailable({ doorId: 'door-a', connected: true, streaming: true })).toBe(true)
    expect(unlockAvailable({ doorId: null, connected: true, streaming: true })).toBe(false)
    expect(unlockAvailable({ doorId: 'door-a', connected: false, streaming: true })).toBe(false)
    expect(unlockAvailable({ doorId: 'door-a', connected: true, streaming: false })).toBe(false)
  })
})

describe('shouldWatchDoors (DOOR-6)', () => {
  const watch = (
    refs: readonly string[],
    ...rest: [doorLinks?: Record<string, string> | null, accessEnabled?: boolean]
  ): boolean =>
    shouldWatchDoors({
      // An explicit `undefined` ("no settings loaded") must stay `undefined`, not become LINKS.
      doorLinks: rest.length === 0 ? LINKS : rest[0],
      accessEnabled: rest[1] ?? true,
      viewCameraRefs: refs,
    })

  it('watches when a camera of the View has a link', () => {
    expect(watch(['cam2', 'cam1'])).toBe(true)
  })

  it('never watches while Access is off, whatever the links (DOOR-0)', () => {
    expect(watch(['cam1', 'doorbell'], LINKS, false)).toBe(false)
  })

  it('does not watch with no links, or none loaded', () => {
    expect(watch(['cam1'], {})).toBe(false)
    expect(watch(['cam1'], null)).toBe(false)
    expect(watch(['cam1'], undefined)).toBe(false)
  })

  it('does not watch for a link on a camera that is not in the View', () => {
    expect(watch(['cam2', 'cam3'])).toBe(false)
  })

  it("watches for a package ref through its doorbell's link", () => {
    expect(watch(['doorbell:package'])).toBe(true)
    expect(watch(['cam2:package'])).toBe(false)
  })

  it('does not watch an empty View', () => {
    expect(watch([])).toBe(false)
  })

  it('never reads a prototype member as a link', () => {
    expect(watch(['constructor', 'toString'], {})).toBe(false)
  })
})

describe('viewCameraRefs', () => {
  it("lists every camera of every cell, so a cell's linked camera need not be the first", () => {
    const view = { cells: [{ cameraIds: ['cam2', 'cam3', 'cam1'] }, { cameraIds: [] }] }
    expect(viewCameraRefs(view)).toEqual(['cam2', 'cam3', 'cam1'])
    expect(
      shouldWatchDoors({
        accessEnabled: true,
        doorLinks: LINKS,
        viewCameraRefs: viewCameraRefs(view),
      }),
    ).toBe(true)
  })

  it('is empty for no View and for a View with no cameras', () => {
    expect(viewCameraRefs(null)).toEqual([])
    expect(viewCameraRefs({ cells: [] })).toEqual([])
    expect(viewCameraRefs({ cells: [{ cameraIds: [] }] })).toEqual([])
  })
})
