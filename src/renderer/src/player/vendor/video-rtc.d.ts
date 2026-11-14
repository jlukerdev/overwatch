/**
 * Types for `video-rtc.js` next to this file (go2rtc's VideoRTC v1.6.0).
 *
 * **Hand-written for this repo. Not part of the vendored download** — the upstream file is plain
 * JavaScript with JSDoc, this project compiles with `allowJs: false` (tsconfig.base.json), and
 * TypeScript resolves `./vendor/video-rtc.js` to the `.d.ts` beside it. The vendored `.js` itself
 * stays byte-for-byte unmodified, as its README and SPEC §5.3 require: the trim fix is a subclass
 * (../MsePlayer.ts), never an edit here.
 *
 * Only the members that subclass actually uses are declared, and they are declared as the vendored
 * source really behaves — notably `src`, which upstream defines as a setter with no getter, and
 * `video`, which is `null` until `oninit()` runs on the first `connectedCallback`.
 *
 * If go2rtc is bumped in `scripts/go2rtc.manifest.json`, re-read the new `www/video-rtc.js` against
 * this file as part of the update: a signature that drifts here is a `TypeError` at the first frame,
 * not a compile error.
 */

/** What the vendored player sends over the WebSocket (`send()` JSON-stringifies it). */
export interface VideoRtcMessage {
  readonly type: string
  readonly value?: string
}

export declare class VideoRTC extends HTMLElement {
  /** Milliseconds the element waits after leaving the DOM before closing. Unused: `background`. */
  DISCONNECT_TIMEOUT: number
  /** Upstream's own reconnect floor. Unused here: `onclose()` is overridden (NFR-7 lives in P2.3). */
  RECONNECT_TIMEOUT: number
  /** The codecs offered in the MSE handshake, filtered by `codecs()`. */
  CODECS: string[]
  /** Comma-separated list of `webrtc`, `mse`, `hls`, `mp4`, `mjpeg`. P2.3 sets `mse` only. */
  mode: string
  /** Comma-separated list of `video`, `audio`, `microphone`. */
  media: string
  /** Keep streaming while off-screen or hidden. P2.3 owns the lifecycle, so this is `true`. */
  background: boolean
  visibilityThreshold: number
  visibilityCheck: boolean
  /** `WebSocket.CONNECTING | OPEN | CLOSED`. Read by the stall detector. */
  wsState: number
  pcState: number
  /** Created by `oninit()`; `null` before the element's first `connectedCallback`. */
  video: HTMLVideoElement | null
  ws: WebSocket | null
  wsURL: string
  /** `Date.now()` of the last connect attempt. */
  connectTS: number
  /** The mime from the server's `mse` reply, or `''` before the handshake. */
  mseCodecs: string
  disconnectTID: number
  reconnectTID: number
  /** Set by `onmse()`: where binary WebSocket frames go. */
  ondata: ((data: ArrayBuffer) => void) | null
  /** Per-mode JSON handlers, keyed by mode name. Created empty by `onopen()`. */
  onmessage: Record<string, (message: { type: string; value: string }) => void> | null

  /** Write-only upstream: assigning it stores `wsURL` and calls `onconnect()`. Never read. */
  set src(value: string)

  play(): void
  send(value: VideoRtcMessage): void
  /** The offered codec list: `CODECS` filtered by `media` and by `isSupported`, comma-joined. */
  codecs(isSupported: (type: string) => boolean): string

  connectedCallback(): void
  disconnectedCallback(): void
  /** Creates the `<video>` child. Called once, from the first `connectedCallback`. */
  oninit(): void
  onconnect(): boolean
  ondisconnect(): void
  onopen(): string[]
  onclose(): boolean
  /** Sets up `MediaSource`, the source buffer and the trim loop. Overridden in P2.3 (SPEC §5.3). */
  onmse(): void
}
