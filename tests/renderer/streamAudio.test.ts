// RTSP-4 (AUD-1 in RTSP mode): the per slot + camera "has audio" answers `<GridView>` keeps from its
// players' MSE handshakes (src/renderer/src/features/audio/streamAudio.ts).
//
// What these tests protect:
//  - an answer is kept per slot *and* camera, so one slot's stream never speaks for another slot,
//    nor for another camera the same slot rotates to;
//  - a report that changes nothing hands back the very same set (no re-render, no per-frame churn);
//  - `false` removes the answer, so a stream that stopped no longer claims sound;
//  - a player keeps its last answer while no layer is visible (a reconnect of the same stream), so
//    a brief reconnect never mutes a heard cell, and a promoted layer's answer always counts.
import { describe, expect, it } from 'vitest'
import {
  nextPlayerAudio,
  NO_STREAM_AUDIO,
  streamAudioKey,
  streamAudioStep,
  streamHasAudio,
} from '../../src/renderer/src/features/audio/streamAudio'

describe('streamAudioStep', () => {
  it('records a stream with audio for its slot and camera only', () => {
    const state = streamAudioStep(NO_STREAM_AUDIO, 'slot-1', 'cam-a', true)
    expect(streamHasAudio(state, 'slot-1', 'cam-a')).toBe(true)
    expect(streamHasAudio(state, 'slot-2', 'cam-a')).toBe(false)
    expect(streamHasAudio(state, 'slot-1', 'cam-b')).toBe(false)
  })

  it('hands back the same set when nothing changes', () => {
    expect(streamAudioStep(NO_STREAM_AUDIO, 'slot-1', 'cam-a', false)).toBe(NO_STREAM_AUDIO)
    const state = streamAudioStep(NO_STREAM_AUDIO, 'slot-1', 'cam-a', true)
    expect(streamAudioStep(state, 'slot-1', 'cam-a', true)).toBe(state)
  })

  it('forgets the answer when the stream reports no audio, or goes', () => {
    const state = streamAudioStep(NO_STREAM_AUDIO, 'slot-1', 'cam-a', true)
    const after = streamAudioStep(state, 'slot-1', 'cam-a', false)
    expect(streamHasAudio(after, 'slot-1', 'cam-a')).toBe(false)
    // The input is never changed.
    expect(streamHasAudio(state, 'slot-1', 'cam-a')).toBe(true)
  })

  it('never lets two different pairs share a key', () => {
    expect(streamAudioKey('a', 'bc')).not.toBe(streamAudioKey('ab', 'c'))
  })
})

describe('nextPlayerAudio', () => {
  it('keeps the last answer while no layer is visible (a reconnect)', () => {
    expect(nextPlayerAudio(true, null)).toBe(true)
    expect(nextPlayerAudio(false, null)).toBe(false)
  })

  it('takes the visible layer’s answer, including a swap to a stream without audio', () => {
    expect(nextPlayerAudio(false, true)).toBe(true)
    expect(nextPlayerAudio(true, false)).toBe(false)
    expect(nextPlayerAudio(true, true)).toBe(true)
  })
})
