// The MSE player element: a subclass of the vendored go2rtc player with P0.5's buffer-trim fix
// (P2.3; SPEC §5.3 "Player", "Buffer-trim requirement", "Renderer isolation", R7, NFR-5/7, G2).
//
// **Why a subclass.** SPEC §5.3 requires the trim fix by overriding `onmse()` and leaving
// `vendor/video-rtc.js` unmodified — the vendored file carries its own hash and licence
// (vendor/README.md), and the P0.5 spike proved the pipeline against exactly those bytes. The
// upstream buffer loop lives inside a closure in `onmse()`, so there is no seam to patch from
// outside; the spike monkey-patched `SourceBuffer.prototype.remove` globally instead, which is fine
// for one page measuring one stream and wrong for an app with ten players and other media. So
// `onmse()` is re-implemented here: same handshake, same resync and the same uncapped
// playback-rate ramp that produced P0.5's ~1 s buffer (NFR-5), with **only the removal window
// changed** — and every number it uses imported from `mseBuffer.ts`, where tests can reach it.
//
// **What this element does not decide.** When to attach, when to reconnect, when a stream counts as
// frozen and what the viewer is told are all `playerMachine.ts`'s business. This element reports
// three things — first frame, socket closed, codec unsupported — and exposes a sample for the stall
// detector. That split is what keeps the untestable half (no jsdom, no MSE in the test environment)
// as small as it is.
//
// **Isolation (SPEC §5.3).** The only stream input is `start(wsUrl)`, and `wsUrl` is
// `StreamHandle.wsUrl` passed through verbatim: never built from a port and a name here, because
// main's `onBeforeSendHeaders` filter injects go2rtc's `Authorization` only for the exact loopback
// URL it built. This file contains no RTSPS URL, no credential and no way to name a stream.
import { bufferTrim, catchUpRate, isCodecPlayable, MSE_KEEP_SECONDS, resyncTime } from './mseBuffer'
import { VideoRTC } from './vendor/video-rtc.js'

/** The three things the element tells the machine. Set once, right after the element is created. */
export interface MsePlayerHooks {
  /** A frame has been painted: the swap trigger (QUAL-6, FILL-2). */
  readonly onFirstFrame: () => void
  /** The WebSocket closed on its own (go2rtc gone, a decode error, the network). Never on teardown. */
  readonly onSocketClosed: () => void
  /** SPEC R7: go2rtc offered a mime this build of Chromium cannot decode. */
  readonly onCodecUnsupported: (mime: string) => void
}

/** What the stall detector needs from one element (see `playerTiming.stallStep`). */
export interface MsePlayerSample {
  readonly currentTime: number
  readonly streaming: boolean
}

/** Custom element name. Namespaced `vp-` so it cannot collide with go2rtc's own `video-rtc`. */
export const MSE_PLAYER_TAG = 'vp-mse-player'

/**
 * Upstream's own buffer for WebSocket frames that arrive while the source buffer is updating. Same
 * 2 MB as the vendored player: one `high` keyframe is ~100–200 KB (P0.5), so this is many of them.
 */
const APPEND_BUFFER_BYTES = 2 * 1024 * 1024

export class MsePlayer extends VideoRTC {
  private hooks: MsePlayerHooks | null = null
  /** The `MediaSource` object URL, so teardown can revoke it even if `sourceopen` never fired. */
  private objectUrl: string | null = null
  private firstFrameReported = false
  private torn = false

  constructor() {
    super()
    // MSE only. WebRTC is off by config in main (SPEC §5.3: no `webrtc` module), HLS and MJPEG would
    // silently paper over an MSE failure this task exists to detect, and `mp4` is a poster frame.
    this.mode = 'mse'
    this.media = 'video,audio'
    // **This element never manages its own lifecycle.** `background = true` disables upstream's
    // disconnect-on-hidden and its 5 s disconnect timer, and `visibilityCheck = false` its
    // visibilitychange handler, because `playerMachine.ts` is the single owner of attach/detach
    // (two owners is how a stream stops while the machine believes it is live, and the stall
    // detector then fights it). Not streaming while the window is hidden is a real saving for
    // NFR-2/4 and belongs to P2.5/Phase 5 as one decision for the whole wall, not per element.
    this.background = true
    this.visibilityCheck = false
    this.visibilityThreshold = 0
  }

  /** Set before {@link start}. Cleared by {@link teardown}, so nothing calls back after unmount. */
  setHooks(hooks: MsePlayerHooks): void {
    this.hooks = hooks
  }

  /**
   * Points the element at a stream. `wsUrl` is `StreamHandle.wsUrl` **verbatim** (see the header):
   * the element must already be in the DOM, because upstream's `src` setter connects immediately and
   * `onconnect()` refuses while the element is not connected.
   */
  start(wsUrl: string): void {
    this.src = wsUrl
  }

  /** `muted` prop / the swap's audio rule: a layer that is not the visible one is always muted. */
  setMuted(muted: boolean): void {
    if (this.video !== null) this.video.muted = muted
  }

  /**
   * Stops the stream but **keeps the element and its last frame on screen** — the machine's "a dead
   * `current` keeps its last frame" rule, so a reconnect shows a still picture rather than a flash
   * of placeholder. Deliberately not upstream's `ondisconnect()`, which clears `video.src` and
   * blanks exactly that frame. Idempotent, and quiet: `onSocketClosed` is for sockets that die by
   * themselves, never for a close we asked for.
   */
  stopStream(): void {
    this.wsState = WebSocket.CLOSED
    if (this.reconnectTID !== 0) {
      clearTimeout(this.reconnectTID)
      this.reconnectTID = 0
    }
    if (this.disconnectTID !== 0) {
      clearTimeout(this.disconnectTID)
      this.disconnectTID = 0
    }
    if (this.ws !== null) {
      this.ws.close()
      this.ws = null
    }
    this.ondata = null
  }

  /**
   * Full teardown: socket, MSE, decoder, object URL, element. Called for every layer the machine
   * drops, including on unmount.
   *
   * `background = true` means upstream's `disconnectedCallback` does nothing, so removing the
   * element from the DOM would otherwise leave the WebSocket open and the `MediaSource` attached —
   * one leaked socket and ~4 MB of buffer per remount at `high`, which is precisely the half of gate
   * G2 that asks for no memory growth over 30 minutes. `load()` after clearing `src` is what makes
   * Chromium release the decoder rather than keeping it for a source that will never append again.
   */
  teardown(): void {
    if (this.torn) return
    this.torn = true
    this.hooks = null
    this.stopStream()
    const video = this.video
    if (video !== null) {
      video.pause()
      video.removeAttribute('src')
      video.srcObject = null
      video.load()
    }
    this.revokeObjectUrl()
    this.remove()
  }

  /** One sample for `playerTiming.stallStep`. "Streaming" means it ought to be advancing now. */
  sample(): MsePlayerSample {
    const video = this.video
    if (video === null || this.torn) return { currentTime: 0, streaming: false }
    return {
      currentTime: video.currentTime,
      // A frame has been seen, the socket is open and nothing paused the element: anything else is
      // idle, not stalled, and calling it stalled would make every cell reattach on mount.
      streaming: this.firstFrameReported && this.wsState === WebSocket.OPEN && !video.paused,
    }
  }

  override oninit(): void {
    super.oninit()
    const video = this.requireVideo()
    // A camera wall has no scrub bar, no download menu and no PiP button; the overlay is P3's.
    video.controls = false
    video.disablePictureInPicture = true
    // Muted until the machine says otherwise: an unmuted autoplay is blocked by Chromium, and
    // upstream's `play()` would then mute it anyway. The visible layer's `muted` comes from the
    // prop right after attach (AUD-1 — the single-active-audio policy itself is Phase 5).
    video.muted = true
    this.watchFirstFrame(video)
  }

  /**
   * Upstream reconnects by itself, no sooner than every `RECONNECT_TIMEOUT`, to the same `wsURL`.
   * Both halves are wrong here: a stale URL's port may by now belong to another local process
   * (src/shared/streams.ts on `epoch`), and the backoff is the machine's (NFR-7). So this reports
   * the close and schedules nothing — the machine answers it with a fresh `ensureStream`.
   */
  override onclose(): boolean {
    if (this.wsState === WebSocket.CLOSED) return false
    this.wsState = WebSocket.CLOSED
    this.ws = null
    this.hooks?.onSocketClosed()
    return false
  }

  /**
   * The buffer-trim fix (SPEC §5.3, docs/spikes/P0.5-video.md).
   *
   * Upstream removes everything older than 5 s behind the buffered end. MSE's coded-frame removal
   * then also drops every frame up to the next keyframe, and Protect's `high` keyframe interval is
   * ~5.0 s — so the frames being played are removed, the video track runs dry after ~4.4 s
   * (`DEMUXER_UNDERFLOW`), the picture freezes and the audio plays on. go2rtc delivered every
   * packet, so this is purely a player fault. Keeping {@link MSE_KEEP_SECONDS} (15 s, ≥ 2× the
   * longest GOP) instead costs about 4 MB per player at `high` and fixes it.
   *
   * The rest is upstream's loop, deliberately unchanged: a 2 MB staging buffer for frames that
   * arrive mid-update, the 5 s resync, and the gap-proportional `playbackRate` that holds ~1 s of
   * buffer (NFR-5). The `ManagedMediaSource` branch is dropped — that is Safari 17+, and this app is
   * Chromium only.
   */
  override onmse(): void {
    const video = this.requireVideo()
    const mediaSource = new MediaSource()

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        // The element has the source now, so the URL has done its job (upstream revokes it here
        // too). Teardown revokes it again for the case where `sourceopen` never fires.
        this.revokeObjectUrl()
        const offered = this.codecs((type) => MediaSource.isTypeSupported(type))
        // Nothing this build can decode to offer: go2rtc would answer an error we would have to
        // guess at, so call it what it is (SPEC R7) rather than waiting for a black cell.
        if (offered === '') {
          this.hooks?.onCodecUnsupported('')
          return
        }
        this.send({ type: 'mse', value: offered })
      },
      { once: true },
    )

    this.objectUrl = URL.createObjectURL(mediaSource)
    video.src = this.objectUrl
    video.srcObject = null
    this.play()
    this.mseCodecs = ''

    const handlers = this.onmessage
    if (handlers === null) return
    handlers.mse = (message: { type: string; value: string }): void => {
      if (message.type !== 'mse') return
      const mime = message.value
      this.mseCodecs = mime

      // SPEC R7: ask before appending. `addSourceBuffer` on an undecodable mime throws a
      // `NotSupportedError` that upstream swallows into a console line, which is the black cell the
      // spec says to replace with a state. H.265 on a machine without HEVC is the live case (R1).
      if (!isCodecPlayable(mime, (type) => MediaSource.isTypeSupported(type))) {
        this.hooks?.onCodecUnsupported(mime)
        return
      }
      let sourceBuffer: SourceBuffer
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime)
      } catch {
        // Supported by `isTypeSupported` and still refused (a quota, a second buffer): same state.
        this.hooks?.onCodecUnsupported(mime)
        return
      }
      sourceBuffer.mode = 'segments'

      const staging = new Uint8Array(APPEND_BUFFER_BYTES)
      let stagedBytes = 0

      sourceBuffer.addEventListener('updateend', () => {
        if (!sourceBuffer.updating && stagedBytes > 0) {
          try {
            sourceBuffer.appendBuffer(staging.slice(0, stagedBytes))
            stagedBytes = 0
          } catch {
            // Upstream ignores these too: the next frame appends, or the element errors and the
            // socket closes, which the machine answers with a reconnect.
          }
        }
        if (sourceBuffer.updating) return
        const buffered = sourceBuffer.buffered
        if (buffered.length === 0) return
        const end = buffered.end(buffered.length - 1)

        const trim = bufferTrim({ start: buffered.start(0), end }, MSE_KEEP_SECONDS)
        if (trim !== null) {
          try {
            sourceBuffer.remove(trim.start, trim.end)
            // Keeps the element's seekable range in step with what is actually buffered.
            mediaSource.setLiveSeekableRange(trim.end, end)
          } catch {
            // A removal that races an append: the next `updateend` trims again.
          }
        }

        const seek = resyncTime(video.currentTime, end)
        if (seek !== null) video.currentTime = seek
        video.playbackRate = catchUpRate(video.currentTime, end)
      })

      this.ondata = (data: ArrayBuffer): void => {
        if (sourceBuffer.updating || stagedBytes > 0) {
          const chunk = new Uint8Array(data)
          // Upstream writes into the staging buffer unchecked; a stall long enough to overflow it
          // would throw on every frame from then on. Dropping the chunk keeps the stream in a state
          // the stall detector can recover from.
          if (stagedBytes + chunk.byteLength > staging.byteLength) return
          staging.set(chunk, stagedBytes)
          stagedBytes += chunk.byteLength
          return
        }
        try {
          sourceBuffer.appendBuffer(data)
        } catch {
          // See above: upstream ignores append failures, and the socket speaks for itself.
        }
      }
    }
  }

  /**
   * Reports the first painted frame — the moment the machine swaps this layer in (QUAL-6).
   *
   * `requestVideoFrameCallback` is the only honest answer to "has a frame been painted"; `playing`
   * fires when the element starts advancing, which can precede the first composited frame. It is a
   * Chromium API (and this app is Chromium only), so `playing` is kept as a fallback rather than a
   * branch nobody would notice missing.
   */
  private watchFirstFrame(video: HTMLVideoElement): void {
    const report = (): void => {
      if (this.torn || this.firstFrameReported) return
      this.firstFrameReported = true
      this.hooks?.onFirstFrame()
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        report()
      })
      return
    }
    video.addEventListener('playing', report, { once: true })
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl === null) return
    URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  /** `video` is created by `oninit()` on the first `connectedCallback`, before anything here runs. */
  private requireVideo(): HTMLVideoElement {
    const video = this.video
    if (video === null) throw new Error('MsePlayer used before its <video> was created')
    return video
  }
}

/** Registers the element once. Safe to call per player: a second `define` would throw. */
export function defineMsePlayer(): void {
  if (customElements.get(MSE_PLAYER_TAG) === undefined) {
    customElements.define(MSE_PLAYER_TAG, MsePlayer)
  }
}

/**
 * Creates one player element. It must be appended to the DOM **before** {@link MsePlayer.start},
 * because upstream's `src` setter connects straight away and refuses while disconnected.
 */
export function createMsePlayer(): MsePlayer {
  defineMsePlayer()
  const element = document.createElement(MSE_PLAYER_TAG)
  if (!(element instanceof MsePlayer)) throw new Error(`<${MSE_PLAYER_TAG}> is not registered`)
  return element
}
