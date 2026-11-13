// Player statistics for the P0.5 video spike: the sample shape the page reports, the on-page
// overlay text, and the run summary. Pure (no DOM, no Node), so the renderer page, the spike's
// Electron main and the unit tests all share it.

/** One reading of the player, taken by the page about once a second. */
export interface PlayerSample {
  /** ms since the page started (performance.now()). */
  t: number
  /** MSE mime from go2rtc's codec negotiation (`''` until it answers). */
  mseMime: string
  width: number
  height: number
  currentTime: number
  /** End of the last buffered range, or null when nothing is buffered. */
  bufferedEnd: number | null
  /** getVideoPlaybackQuality().totalVideoFrames */
  totalFrames: number
  /** getVideoPlaybackQuality().droppedVideoFrames */
  droppedFrames: number
  /** Frames presented, counted with requestVideoFrameCallback. */
  presentedFrames: number
  /** webkitAudioDecodedByteCount (Chromium), or null if unavailable. */
  audioDecodedBytes: number | null
  /** webkitVideoDecodedByteCount (Chromium), or null if unavailable. */
  videoDecodedBytes: number | null
  /** RMS level (0..1) of the decoded audio over the last ~50 ms, or null without Web Audio. */
  audioRms: number | null
  muted: boolean
  paused: boolean
  readyState: number
  playbackRate: number
  /** ms from the WebSocket connect to the first presented frame, or null before it. */
  firstFrameMs: number | null
  /** MediaError text, or null. */
  error: string | null
  /** SourceBuffer.appendBuffer diagnostics (VideoRTC swallows append exceptions). */
  appends: AppendStats
  /** SourceBuffer.remove calls the page's trim-keep workaround shortened or skipped. */
  trimsClamped: number
}

export interface AppendStats {
  count: number
  bytes: number
  maxBytes: number
  errors: number
  lastError: string | null
  /** Page times (ms) of appends over 100 KB: keyframes at high/medium, for the GOP estimate.
   * The first 30 only. */
  largeAppendsAt: number[]
}

/** Player buffer latency: how far behind the newest buffered media playback is, in seconds. */
export function bufferLatency(s: PlayerSample): number | null {
  if (s.bufferedEnd === null) return null
  return Math.max(0, s.bufferedEnd - s.currentTime)
}

/** Presented-frame rate between two samples. */
export function fpsBetween(prev: PlayerSample, cur: PlayerSample): number | null {
  const dt = (cur.t - prev.t) / 1000
  if (dt <= 0) return null
  return Math.max(0, (cur.presentedFrames - prev.presentedFrames) / dt)
}

export function droppedPercent(s: PlayerSample): number {
  return s.totalFrames > 0 ? (s.droppedFrames / s.totalFrames) * 100 : 0
}

/** Codecs listed in an MSE mime: `video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"`. */
export function codecsOf(mime: string): string[] {
  const m = /codecs\s*=\s*"?([^"]*)"?/i.exec(mime)
  return (m?.[1] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

export function hasAudioTrack(mime: string): boolean {
  return codecsOf(mime).some((c) => /^(mp4a|opus|flac|mp3)(\.|$)/i.test(c))
}

function fixed(n: number | null, digits: number, unit = ''): string {
  return n === null || !Number.isFinite(n) ? '–' : `${n.toFixed(digits)}${unit}`
}

/** Overlay lines for the on-page stats box. */
export function formatOverlay(cur: PlayerSample, prev: PlayerSample | undefined): string[] {
  const codecs = codecsOf(cur.mseMime)
  const fps = prev === undefined ? null : fpsBetween(prev, cur)
  return [
    `codecs     ${codecs.length > 0 ? codecs.join(', ') : 'negotiating…'}`,
    `resolution ${cur.width > 0 ? `${String(cur.width)}×${String(cur.height)}` : '–'}`,
    `fps        ${fixed(fps, 1)}`,
    `frames     ${String(cur.totalFrames)} decoded, ${String(cur.droppedFrames)} dropped (${droppedPercent(cur).toFixed(2)}%)`,
    `latency    ${fixed(bufferLatency(cur), 2, ' s')} (buffer)`,
    `first frame ${fixed(cur.firstFrameMs, 0, ' ms')}`,
    `audio      ${hasAudioTrack(cur.mseMime) ? 'track present' : 'no track'}, ${cur.muted ? 'muted' : 'unmuted'}, level ${fixed(cur.audioRms, 3)}`,
    ...(cur.error === null ? [] : [`error      ${cur.error}`]),
  ]
}

export interface SampleSummary {
  samples: number
  firstFrameMs: number | null
  meanFps: number | null
  latency: { mean: number | null; p95: number | null; max: number | null }
  totalFrames: number
  droppedFrames: number
  droppedPercent: number
  audioDecodedBytes: number
  maxAudioRms: number | null
  width: number
  height: number
  mseMime: string
  errors: string[]
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)] ?? null
}

/**
 * Summary of a run. Latency and fps are averaged over the steady state: samples taken at least
 * `warmupMs` after the first frame.
 */
export function summarizeSamples(samples: readonly PlayerSample[], warmupMs = 5000): SampleSummary {
  const last = samples.at(-1)
  const first = samples[0]
  const ff = samples.find((s) => s.firstFrameMs !== null)
  const firstFrameAt = ff?.t ?? Number.POSITIVE_INFINITY
  const steady = samples.filter((s) => s.t >= firstFrameAt + warmupMs)
  const lat = steady
    .map(bufferLatency)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const sFirst = steady[0]
  const sLast = steady.at(-1)
  const meanFps =
    sFirst !== undefined && sLast !== undefined && sLast !== sFirst
      ? fpsBetween(sFirst, sLast)
      : null
  const audioBytes =
    first !== undefined && last !== undefined
      ? (last.audioDecodedBytes ?? 0) - (first.audioDecodedBytes ?? 0)
      : 0
  const rms = samples.map((s) => s.audioRms).filter((v): v is number => v !== null)
  return {
    samples: samples.length,
    firstFrameMs: ff?.firstFrameMs ?? null,
    meanFps,
    latency: {
      mean: lat.length > 0 ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      p95: percentile(lat, 95),
      max: lat.at(-1) ?? null,
    },
    totalFrames: last?.totalFrames ?? 0,
    droppedFrames: last?.droppedFrames ?? 0,
    droppedPercent: last === undefined ? 0 : droppedPercent(last),
    audioDecodedBytes: Math.max(0, audioBytes),
    maxAudioRms: rms.length > 0 ? Math.max(...rms) : null,
    width: last?.width ?? 0,
    height: last?.height ?? 0,
    mseMime: last?.mseMime ?? '',
    errors: [...new Set(samples.flatMap((s) => (s.error === null ? [] : [s.error])))],
  }
}
