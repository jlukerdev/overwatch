// P5.4 (DOOR-0, DOOR-2, DOOR-3): which door a cell's unlock control opens, and when it shows
// (src/renderer/src/features/door/doorLink.ts).
//
// What these tests protect: nothing while Access is saved as off; a camera's own link; a package
// ref (`<id>:package`) using its doorbell's link; no door for an unlinked camera (or a prototype
// key); and the control only for a linked camera that is connected and streaming.
import { describe, expect, it } from 'vitest'
import { doorForCell, unlockAvailable } from '../../src/renderer/src/features/door/doorLink'

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
