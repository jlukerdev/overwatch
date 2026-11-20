// The header's nav per mode (src/renderer/src/navScreens.ts, MODE-3, DOOR-0): Protect keeps
// Cameras, Doors only while Access is saved on, and Live; RTSP has Streams and Live only. Settings
// is reachable in both modes; a screen outside the mode's nav is not.
import { describe, expect, it } from 'vitest'
import { navScreens, screenAvailable } from '../../src/renderer/src/navScreens'

describe('navScreens', () => {
  it('offers Cameras and Live in Protect mode, with Doors between them while Access is on', () => {
    expect(navScreens('protect', false)).toEqual(['cameras', 'grid'])
    expect(navScreens('protect', true)).toEqual(['cameras', 'doors', 'grid'])
  })

  it('offers Streams and Live in RTSP mode, whatever the Access switch says (MODE-3)', () => {
    expect(navScreens('rtsp', false)).toEqual(['streams', 'grid'])
    expect(navScreens('rtsp', true)).toEqual(['streams', 'grid'])
  })
})

describe('screenAvailable', () => {
  it('always allows Settings and Live', () => {
    for (const mode of ['protect', 'rtsp'] as const) {
      for (const access of [false, true]) {
        expect(screenAvailable('settings', mode, access)).toBe(true)
        expect(screenAvailable('grid', mode, access)).toBe(true)
      }
    }
  })

  it('refuses Cameras and Doors in RTSP mode, and Streams in Protect mode', () => {
    expect(screenAvailable('cameras', 'rtsp', true)).toBe(false)
    expect(screenAvailable('doors', 'rtsp', true)).toBe(false)
    expect(screenAvailable('streams', 'protect', true)).toBe(false)
    expect(screenAvailable('streams', 'rtsp', false)).toBe(true)
    expect(screenAvailable('cameras', 'protect', false)).toBe(true)
  })

  it('refuses Doors in Protect mode while Access is off (DOOR-0)', () => {
    expect(screenAvailable('doors', 'protect', false)).toBe(false)
    expect(screenAvailable('doors', 'protect', true)).toBe(true)
  })
})
