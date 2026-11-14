// The MSE buffer arithmetic of the live player (P2.3), as pure functions over numbers.
//
// Why these four tiny functions are a module of their own: they are the *only* part of the player's
// hot loop that can be wrong in a way nobody sees for 4.4 seconds. P0.5 measured exactly that —
// upstream `VideoRTC` trims everything older than 5 s behind the buffered end, MSE's coded-frame
// removal then also drops every frame up to the next keyframe, and Protect's `high` stream (keyframe
// every ~5.0 s) runs its video track dry: `DEMUXER_UNDERFLOW`, a frozen picture and audio still
// playing (docs/spikes/P0.5-video.md, SPEC §5.3 "Buffer-trim requirement"). The fix is a number, so
// the number lives somewhere a test can reach it; `MsePlayer.onmse()` does nothing with the buffer
// that is not decided here. The project has no jsdom (vitest.config.mts), so a rule that lives
// inside an `updateend` listener is a rule no test can reach at all (CLAUDE.md).
//
// Everything below mirrors the vendored player's `updateend` handler on purpose. Only the *removal*
// window changes: the resync threshold and the playback-rate ramp are kept bit-for-bit, because they
// are what produced the measured 0.99–1.02 s mean buffer and p95 ≤ 1.07 s on both platforms
// (NFR-5), and this task is not the place to re-tune latency (that is P2.5).

/**
 * How much media to keep behind the buffered end, in seconds.
 *
 * **At least 2× the longest GOP** (SPEC §5.3): Protect's `high` keyframe interval is ~5.0 s, so 15 s
 * covers it three times over and still covers a camera whose GOP is twice that. The alternative the
 * spec allows — trimming only up to the last keyframe before `currentTime` — needs keyframe
 * positions, which MSE does not expose; `SourceBuffer.buffered` is ranges, not frames. A fixed
 * window needs no such knowledge, which is why it is the one P0.5 measured.
 *
 * **Cost: about 4 MB per player at `high`** (~2 Mbit/s × 15 s, measured in P0.5). Ten cells at
 * `high` is therefore ~40 MB of buffer, which is a deliberate trade against NFR-3 and is one of the
 * numbers the P2.5 harness re-measures. `low` and `medium` cost a fraction of it.
 */
export const MSE_KEEP_SECONDS = 15

/**
 * How far `currentTime` may fall behind the buffered end before the player jumps forward, and where
 * it jumps to. Unchanged from the vendored player (which used the same 5 s for this *and* for the
 * removal window — conflating the two is the P0.5 stall).
 */
export const MSE_MAX_LAG_SECONDS = 5

/** Slowest the player will run while it has less than ~0.1 s of buffer. From the vendored player. */
export const MSE_MIN_PLAYBACK_RATE = 0.1

/** A `[start, end)` span of media time. What `SourceBuffer.buffered` hands out, and what we remove. */
export interface MediaRange {
  readonly start: number
  readonly end: number
}

/**
 * What to remove from the source buffer, or `null` when there is nothing old enough to drop.
 *
 * Returns a range rather than calling `remove` so the decision is testable without a `SourceBuffer`.
 * The guard is `limit > buffered.start`: a `remove(start, end)` with `end <= start` is either a
 * no-op or a `TypeError`, and asking for it every `updateend` (which fires several times a second,
 * per player, per cell) is how a wall of 10 cells spends its CPU on exceptions.
 */
export function bufferTrim(
  buffered: MediaRange,
  keepSeconds: number = MSE_KEEP_SECONDS,
): MediaRange | null {
  const limit = buffered.end - keepSeconds
  if (!(limit > buffered.start)) return null
  return { start: buffered.start, end: limit }
}

/**
 * Where to seek to when playback has fallen more than {@link MSE_MAX_LAG_SECONDS} behind live, or
 * `null` when it has not.
 *
 * This is the recovery path for a tab that was throttled or a decoder that hiccuped: without it the
 * element plays an ever-older picture while the buffer grows past the keep window. Note it does
 * **not** seek to the buffered end — landing exactly on the live edge starves the decoder on the
 * next frame, which is the stall this file exists to avoid.
 */
export function resyncTime(
  currentTime: number,
  bufferedEnd: number,
  maxLagSeconds: number = MSE_MAX_LAG_SECONDS,
): number | null {
  const target = bufferedEnd - maxLagSeconds
  return currentTime < target ? target : null
}

/**
 * The playback rate that steers the buffer towards ~1 s (NFR-5, SPEC §5.3 "Latency").
 *
 * `rate = gap` is the vendored player's own controller: with a 1 s gap it plays at 1×, and a bigger
 * gap is drained proportionally faster until it settles. Deliberately uncapped, exactly as upstream
 * — {@link resyncTime} already bounds the gap at {@link MSE_MAX_LAG_SECONDS}, so the rate cannot run
 * away, and the measured latency figures come from this curve.
 */
export function catchUpRate(currentTime: number, bufferedEnd: number): number {
  const gap = bufferedEnd - currentTime
  return gap > MSE_MIN_PLAYBACK_RATE ? gap : MSE_MIN_PLAYBACK_RATE
}

/**
 * Whether this player can decode what go2rtc offered to send (SPEC R7).
 *
 * go2rtc answers the MSE handshake with the mime it will actually produce, e.g.
 * `video/mp4; codecs="avc1.4D4029, mp4a.40.2"`. If Chromium cannot decode it — an H.265 camera on a
 * machine without HEVC support, which R1 says can come back the moment Enhanced Encoding is turned
 * on again — then `addSourceBuffer` throws a `NotSupportedError` and the cell goes black with a
 * console message nobody reads. Asking `MediaSource.isTypeSupported` first turns that into the
 * "codec unsupported" state R7 asks for.
 *
 * An empty mime counts as unsupported: it is what the handshake produces when *we* offered no codec
 * the server could match, and `isTypeSupported('')` is false anyway.
 *
 * `isTypeSupported` is injected rather than read off `MediaSource` so this stays callable in the
 * node test environment.
 */
export function isCodecPlayable(mime: string, isTypeSupported: (type: string) => boolean): boolean {
  const trimmed = mime.trim()
  if (trimmed === '') return false
  return isTypeSupported(trimmed)
}

/**
 * Whether go2rtc's handshake `{ type: 'error' }` reply means "the codecs you offered are not what
 * this camera produces" (SPEC R7) rather than a transient failure to open the source.
 *
 * go2rtc answers the MSE handshake with a mime only when one of the codecs we offered matches the
 * producer. An H.265 camera on a build whose `sourceopen` could only offer `avc1`/`mp4a` gets an
 * error such as `mse: streams: codecs not matched: …` instead — and treated as a stream error, that
 * cell would retry for ever. Matching the phrase is the one signal go2rtc gives; the check is a
 * case-insensitive substring so the prefix and the codec list after it do not matter.
 *
 * **The text itself goes nowhere.** Only this boolean leaves: go2rtc's error strings can quote the
 * source's RTSPS URL (CON-2, NFR-9), so the caller must not log, show or store `value`. A value that
 * is not a string is never a match.
 */
export function isCodecMismatchError(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('codecs not matched')
}
