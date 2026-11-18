// P5.1: AUD-1's audio predicates (src/renderer/src/features/audio/cameraAudio.ts).
//
// What these tests protect:
//  - `cameraHasAudio` (the camera list's Audio badge, CAM-1): a mic that is switched on, online or
//    not.
//  - `cameraCanBeHeard` (a cell's mute toggle): the same, and the camera connected now (user
//    decision 2026-11-16).
import { describe, expect, it } from 'vitest'
import {
  cameraCanBeHeard,
  cameraHasAudio,
  type CameraAudioFlags,
} from '../../src/renderer/src/features/audio/cameraAudio'

function flags(overrides: Partial<CameraAudioFlags> = {}): CameraAudioFlags {
  return { hasMic: true, micEnabled: true, state: 'CONNECTED', ...overrides }
}

describe('cameraHasAudio (AUD-1, CAM-1)', () => {
  it('needs both a mic and the mic switched on', () => {
    expect(cameraHasAudio(flags())).toBe(true)
    expect(cameraHasAudio(flags({ micEnabled: false }))).toBe(false)
    expect(cameraHasAudio(flags({ hasMic: false }))).toBe(false)
    expect(cameraHasAudio(undefined)).toBe(false)
  })

  it('does not care whether the camera is online', () => {
    expect(cameraHasAudio(flags({ state: 'DISCONNECTED' }))).toBe(true)
  })
})

describe('cameraCanBeHeard (AUD-1, user decision 2026-11-16)', () => {
  it('is an audio source that is connected now', () => {
    expect(cameraCanBeHeard(flags())).toBe(true)
  })

  it('is false while offline or connecting', () => {
    expect(cameraCanBeHeard(flags({ state: 'DISCONNECTED' }))).toBe(false)
    expect(cameraCanBeHeard(flags({ state: 'CONNECTING' }))).toBe(false)
  })

  it('is false with no mic, the mic off, or no camera', () => {
    expect(cameraCanBeHeard(flags({ hasMic: false }))).toBe(false)
    expect(cameraCanBeHeard(flags({ micEnabled: false }))).toBe(false)
    expect(cameraCanBeHeard(undefined)).toBe(false)
  })
})
