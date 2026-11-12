// P0.5 spike page: plays one go2rtc stream over MSE with the vendored VideoRTC player, shows a
// stats overlay and exposes `window.__vpSpike` for the spike's Electron main to poll.
//
// The page only ever sees the loopback go2rtc port and the stream name (query string). It never
// receives the RTSPS URL or any console secret.
import type { AppendStats, PlayerSample } from '../stats.ts'
import { formatOverlay } from '../stats.ts'

/** The VideoRTC custom element (vendored go2rtc www/video-rtc.js), only the parts used here. */
interface VideoRtcElement extends HTMLElement {
  mode: string
  media: string
  background: boolean
  visibilityCheck: boolean
  src: string
  video: ChromiumVideo | null
  mseCodecs: string
  connectTS: number
}

/** Chromium-only decoded byte counters. */
interface ChromiumVideo extends HTMLVideoElement {
  webkitAudioDecodedByteCount?: number
  webkitVideoDecodedByteCount?: number
}

export interface ProbeResult {
  isTypeSupported: Record<string, boolean>
  decodingInfo: Record<string, { supported: boolean; smooth: boolean; powerEfficient: boolean }>
  decodingInfoErrors: Record<string, string>
}

declare global {
  interface Window {
    __vpSpike?: {
      sample: () => PlayerSample
      probe: () => Promise<ProbeResult>
    }
  }
}

// Not a literal on purpose: TypeScript does not try to resolve it. launch.ts copies the vendored
// player next to this file when it stages the page.
const VENDOR_PLAYER = './video-rtc.js'

const MSE_PROBE_TYPES = [
  'video/mp4; codecs="hvc1.1.6.L153.B0"',
  'video/mp4; codecs="hev1.1.6.L153.B0"',
  'video/mp4; codecs="hvc1.1.6.L150.90"',
  'video/mp4; codecs="hvc1.2.4.L153.B0"',
  'video/mp4; codecs="avc1.640029"',
  'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="opus"',
  'audio/mp4; codecs="flac"',
]

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el
}

const params = new URLSearchParams(location.search)
const port = Number(params.get('port'))
const stream = params.get('stream') ?? ''
if (!Number.isInteger(port) || port <= 0 || !/^[A-Za-z0-9_-]+$/.test(stream)) {
  throw new Error('Bad port/stream query parameters')
}

const statsEl = requireEl('stats')
const clockEl = requireEl('clock')
const muteBtn = requireEl('mute')

// Diagnostics: count appends and record the exceptions VideoRTC catches and ignores.
const appends: AppendStats = {
  count: 0,
  bytes: 0,
  maxBytes: 0,
  errors: 0,
  lastError: null,
  largeAppendsAt: [],
}
const originalAppend = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'appendBuffer')
  ?.value as (this: SourceBuffer, data: BufferSource) => void
SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
  appends.count++
  appends.bytes += data.byteLength
  appends.maxBytes = Math.max(appends.maxBytes, data.byteLength)
  if (data.byteLength > 100_000 && appends.largeAppendsAt.length < 30)
    appends.largeAppendsAt.push(Math.round(performance.now()))
  try {
    originalAppend.call(this, data)
  } catch (err) {
    appends.errors++
    appends.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    throw err
  }
}
// Workaround under test (P0.5 finding): VideoRTC trims everything older than 5 s behind the
// buffered end. MSE then also removes every frame up to the next keyframe, so with a 5 s GOP
// (Protect `high`) the video track empties while audio keeps playing. Keep `trimKeep` seconds
// instead (0 = upstream behaviour).
const trimKeepSec = Number(params.get('trimKeep') ?? '0')
let trimsClamped = 0
const originalRemove = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'remove')?.value as (
  this: SourceBuffer,
  start: number,
  end: number,
) => void
if (Number.isFinite(trimKeepSec) && trimKeepSec > 0) {
  SourceBuffer.prototype.remove = function (this: SourceBuffer, start: number, end: number): void {
    const b = this.buffered
    const limit = (b.length > 0 ? b.end(b.length - 1) : end) - trimKeepSec
    if (end > limit) {
      trimsClamped++
      if (limit <= start) return
      originalRemove.call(this, start, limit)
      return
    }
    originalRemove.call(this, start, end)
  }
}

window.addEventListener('error', (ev) => {
  console.error(`[spike] uncaught: ${ev.message}`)
})
window.addEventListener('unhandledrejection', (ev) => {
  console.error(`[spike] unhandled rejection: ${String(ev.reason)}`)
})

const mod = (await import(VENDOR_PLAYER)) as { VideoRTC: CustomElementConstructor }
customElements.define('video-rtc', mod.VideoRTC)

const player = document.createElement('video-rtc') as VideoRtcElement
player.mode = 'mse'
player.media = 'video,audio'
// Keep streaming when the window is hidden or occluded: the spike measures, it doesn't save power.
player.background = true
player.visibilityCheck = false
requireEl('player').append(player) // connectedCallback → creates player.video
const created = player.video
if (!created) throw new Error('VideoRTC did not create a <video>')
const video: ChromiumVideo = created
video.muted = false
player.src = `ws://127.0.0.1:${String(port)}/api/ws?src=${encodeURIComponent(stream)}`

// Presented frames and the first frame, via requestVideoFrameCallback.
let presentedFrames = 0
let firstFrameMs: number | null = null
const onFrame = (): void => {
  presentedFrames++
  if (firstFrameMs === null && player.connectTS > 0) firstFrameMs = Date.now() - player.connectTS
  video.requestVideoFrameCallback(onFrame)
}
video.requestVideoFrameCallback(onFrame)

// `bare=1`: no Web Audio analyser, no 60 Hz clock and no overlay updates, to measure the cost
// of the player alone (the rest is spike instrumentation).
const bare = params.get('bare') === '1'

// Audio level: route the element through an analyser (it still plays to the speakers).
let analyser: AnalyserNode | null = null
if (!bare)
  try {
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(video)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    src.connect(analyser)
    analyser.connect(ctx.destination)
    void ctx.resume()
  } catch (err) {
    console.warn('Web Audio analyser unavailable', err)
  }
const pcm = new Float32Array(2048)
function audioRms(): number | null {
  if (!analyser) return null
  analyser.getFloatTimeDomainData(pcm)
  let sum = 0
  for (const v of pcm) sum += v * v
  return Math.sqrt(sum / pcm.length)
}

/** Rounded, so result files stay readable (and free of long hex-looking digit runs). */
function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function sample(): PlayerSample {
  const rms = audioRms()
  const v = video
  const q = v.getVideoPlaybackQuality()
  const b = v.buffered
  return {
    t: Math.round(performance.now()),
    mseMime: player.mseCodecs || '',
    width: v.videoWidth,
    height: v.videoHeight,
    currentTime: round(v.currentTime, 3),
    bufferedEnd: b.length > 0 ? round(b.end(b.length - 1), 3) : null,
    totalFrames: q.totalVideoFrames,
    droppedFrames: q.droppedVideoFrames,
    presentedFrames,
    audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null,
    videoDecodedBytes: v.webkitVideoDecodedByteCount ?? null,
    audioRms: rms === null ? null : round(rms, 5),
    muted: v.muted,
    paused: v.paused,
    readyState: v.readyState,
    playbackRate: round(v.playbackRate, 3),
    firstFrameMs,
    error: v.error ? `${String(v.error.code)} ${v.error.message}` : null,
    appends: { ...appends, largeAppendsAt: [...appends.largeAppendsAt] },
    trimsClamped,
  }
}

async function probe(): Promise<ProbeResult> {
  const isTypeSupported: Record<string, boolean> = {}
  for (const t of MSE_PROBE_TYPES) isTypeSupported[t] = MediaSource.isTypeSupported(t)
  const configs: Record<string, MediaDecodingConfiguration> = {}
  for (const [w, h] of [
    [1920, 1080],
    [3840, 2160],
  ] as const) {
    configs[`hvc1 ${String(w)}x${String(h)}@30`] = {
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="hvc1.1.6.L153.B0"',
        width: w,
        height: h,
        bitrate: 8_000_000,
        framerate: 30,
      },
    }
  }
  // The stream's own codec and resolution, once known.
  const s = sample()
  const own = /codecs\s*=\s*"?([^",]+)/.exec(s.mseMime)?.[1]
  if (own !== undefined && s.width > 0) {
    configs[`stream ${own} ${String(s.width)}x${String(s.height)}@30`] = {
      type: 'media-source',
      video: {
        contentType: `video/mp4; codecs="${own}"`,
        width: s.width,
        height: s.height,
        bitrate: 8_000_000,
        framerate: 30,
      },
    }
  }
  const decodingInfo: ProbeResult['decodingInfo'] = {}
  const decodingInfoErrors: Record<string, string> = {}
  for (const [name, cfg] of Object.entries(configs)) {
    try {
      const r = await navigator.mediaCapabilities.decodingInfo(cfg)
      decodingInfo[name] = {
        supported: r.supported,
        smooth: r.smooth,
        powerEfficient: r.powerEfficient,
      }
    } catch (err) {
      decodingInfoErrors[name] = err instanceof Error ? err.message : String(err)
    }
  }
  return { isTypeSupported, decodingInfo, decodingInfoErrors }
}

window.__vpSpike = { sample, probe }

muteBtn.addEventListener('click', () => {
  video.muted = !video.muted
  muteBtn.textContent = video.muted ? 'Unmute' : 'Mute'
})

let prev: PlayerSample | undefined
if (bare) {
  statsEl.textContent = 'bare mode: overlay, clock and audio analyser off'
} else {
  setInterval(() => {
    const cur = sample()
    statsEl.textContent = formatOverlay(cur, prev).join('\n')
    prev = cur
  }, 1000)
}

// Wall clock with milliseconds: compare with the camera's on-screen clock in a screenshot to
// estimate glass-to-glass latency.
const tick = (): void => {
  const d = new Date()
  clockEl.textContent = `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  requestAnimationFrame(tick)
}
if (!bare) tick()
