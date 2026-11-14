// P2.3 (SPEC §5.3 "Buffer-trim requirement", NFR-5, R7): the arithmetic that keeps Protect's `high`
// stream from starving its own video track.
//
// These numbers are the whole fix for the P0.5 finding — upstream VideoRTC's 5 s keep-window against
// Protect's ~5.0 s GOP freezes the picture after ~4.4 s with `DEMUXER_UNDERFLOW` while audio plays
// on (docs/spikes/P0.5-video.md). The `updateend` listener that uses them cannot be tested at all
// here (no jsdom, no MediaSource; vitest.config.mts), which is exactly why the decisions were lifted
// out of it: `MsePlayer.onmse()` does nothing with the buffer that is not decided in `mseBuffer.ts`.
import { describe, expect, it } from 'vitest'
import {
  bufferTrim,
  catchUpRate,
  isCodecMismatchError,
  isCodecPlayable,
  MSE_KEEP_SECONDS,
  MSE_MAX_LAG_SECONDS,
  MSE_MIN_PLAYBACK_RATE,
  resyncTime,
} from '../../src/renderer/src/player/mseBuffer'

/** Protect's measured `high` keyframe interval (P0.5). The GOP the keep-window has to cover. */
const PROTECT_HIGH_GOP_SECONDS = 5

describe('MSE_KEEP_SECONDS', () => {
  it('keeps at least 2x the longest measured GOP (SPEC §5.3)', () => {
    expect(MSE_KEEP_SECONDS).toBeGreaterThanOrEqual(2 * PROTECT_HIGH_GOP_SECONDS)
  })

  it('is longer than the resync threshold it is often confused with', () => {
    // Conflating the two *is* the upstream bug: 5 s was both the keep-window and the live-edge
    // target, so trimming removed the frames being played.
    expect(MSE_KEEP_SECONDS).toBeGreaterThan(MSE_MAX_LAG_SECONDS)
  })
})

describe('bufferTrim', () => {
  it('keeps the last MSE_KEEP_SECONDS behind the buffered end', () => {
    expect(bufferTrim({ start: 0, end: 40 })).toEqual({ start: 0, end: 40 - MSE_KEEP_SECONDS })
  })

  it('would not have removed the frames P0.5 saw starve the decoder', () => {
    // The stall: 4.4 s in, one keyframe at 0.4 s and the next at 5.5 s. Upstream removed up to
    // end-5 and MSE extended that to the next keyframe, i.e. past `currentTime`.
    const trim = bufferTrim({ start: 0.4, end: 4.4 })
    expect(trim).toBeNull()
  })

  it('returns null while nothing is old enough to drop', () => {
    expect(bufferTrim({ start: 0, end: MSE_KEEP_SECONDS })).toBeNull()
    expect(bufferTrim({ start: 10, end: 20 })).toBeNull()
  })

  it('never asks for an empty or inverted removal', () => {
    // `remove(start, end)` with `end <= start` is a no-op at best and a TypeError at worst, several
    // times a second, per cell.
    for (let end = 0; end <= 40; end += 0.5) {
      const trim = bufferTrim({ start: 5, end })
      if (trim !== null) expect(trim.end).toBeGreaterThan(trim.start)
    }
  })

  it('takes a shorter window when asked, for a camera with a shorter GOP', () => {
    expect(bufferTrim({ start: 0, end: 10 }, 2)).toEqual({ start: 0, end: 8 })
  })
})

describe('resyncTime', () => {
  it('jumps forward once playback is more than MSE_MAX_LAG_SECONDS behind live', () => {
    expect(resyncTime(10, 20)).toBe(20 - MSE_MAX_LAG_SECONDS)
  })

  it('does not seek to the live edge, which would starve the next frame', () => {
    const target = resyncTime(0, 30)
    expect(target).not.toBeNull()
    expect(target).toBeLessThan(30)
  })

  it('leaves a healthy ~1 s buffer alone (NFR-5)', () => {
    expect(resyncTime(19, 20)).toBeNull()
    expect(resyncTime(15.1, 20)).toBeNull()
  })
})

describe('catchUpRate', () => {
  it('plays at 1x with the ~1 s buffer the player steers for (NFR-5)', () => {
    expect(catchUpRate(19, 20)).toBe(1)
  })

  it('drains a bigger gap proportionally faster', () => {
    expect(catchUpRate(16, 20)).toBe(4)
  })

  it('never stops the element when the buffer runs dry', () => {
    expect(catchUpRate(20, 20)).toBe(MSE_MIN_PLAYBACK_RATE)
    expect(catchUpRate(21, 20)).toBe(MSE_MIN_PLAYBACK_RATE)
  })
})

describe('isCodecPlayable (SPEC R7)', () => {
  const h264 = 'video/mp4; codecs="avc1.4D4029, mp4a.40.2"'
  const h265 = 'video/mp4; codecs="hvc1.1.6.L153.B0, mp4a.40.2"'
  const chromiumWithoutHevc = (type: string): boolean => !type.includes('hvc1')

  it('accepts the mime go2rtc answered with when this build can decode it', () => {
    expect(isCodecPlayable(h264, chromiumWithoutHevc)).toBe(true)
  })

  it('rejects H.265 where HEVC is missing, instead of leaving a black cell (R1/R7)', () => {
    expect(isCodecPlayable(h265, chromiumWithoutHevc)).toBe(false)
  })

  it('treats an empty handshake answer as unsupported', () => {
    expect(isCodecPlayable('', () => true)).toBe(false)
    expect(isCodecPlayable('   ', () => true)).toBe(false)
  })
})

describe('isCodecMismatchError (SPEC R7)', () => {
  it("recognises go2rtc's codec-mismatch refusal, whatever its prefix, case or codec list", () => {
    expect(isCodecMismatchError('mse: streams: codecs not matched: video:H265 => avc1')).toBe(true)
    expect(isCodecMismatchError('Codecs Not Matched')).toBe(true)
  })

  it('leaves every other refusal a stream error', () => {
    expect(isCodecMismatchError('streams: dial tcp: i/o timeout')).toBe(false)
    expect(isCodecMismatchError('')).toBe(false)
  })

  it('never matches a value that is not a string', () => {
    expect(isCodecMismatchError(undefined)).toBe(false)
    expect(isCodecMismatchError(null)).toBe(false)
    expect(isCodecMismatchError({ message: 'codecs not matched' })).toBe(false)
  })
})
