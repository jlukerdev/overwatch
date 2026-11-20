// When the live player retries, and when it decides a stream has frozen or failed to start (P2.3,
// P2.4; NFR-7, gate G2).
//
// Pure on purpose, like `mseBuffer.ts` next to it: these answers are numbers that only ever reveal
// themselves minutes into a 30-minute run (G2), and the project has no jsdom, so a threshold that
// lives inside a `setInterval` callback is a threshold no test can reach (CLAUDE.md,
// vitest.config.mts).
//
// Note what is *not* here: nothing in this file knows about go2rtc, WebSockets or the IPC bridge.
// The player machine asks these three questions — when to retry, whether a playing stream has
// frozen, whether a new one has taken too long to paint — and acts on the answers; that is the whole
// contract.

/** First delay after a failure. Short, because the common case is a go2rtc restart a cell can ride. */
export const RECONNECT_BASE_MS = 500

/**
 * Longest delay between attempts. 15 s is the vendored player's own `RECONNECT_TIMEOUT`, kept so a
 * cell that has been retrying for an hour still comes back within the same quarter minute as one
 * that just started (NFR-7: "reconnect with backoff … no manual restart needed").
 */
export const RECONNECT_MAX_MS = 15_000

/**
 * How long to wait before attempt number `failures + 1`: **0 for the first attempt**, then 500 ms,
 * 1 s, 2 s, 4 s, 8 s, 15 s, 15 s…
 *
 * The first attempt being immediate is the point of the zero case: mounting a cell, changing quality
 * (QUAL-6) and the first reconnect after a go2rtc restart must not wait half a second each — gate
 * G2 watches a wall come back by itself, and a wall of 10 cells that each sleep first looks broken.
 * Growth only starts once something has actually failed, which is also what keeps 10 cells from
 * hammering `ensureStream` while the gateway is down (`gateway-down` is retryable but pointless to
 * retry fast).
 *
 * Deterministic — no jitter. The retries here are loopback IPC to our own main process, not requests
 * to a shared server, so there is no thundering-herd to spread; a fixed curve is one a test can
 * assert and a log can be read against. Negative or non-finite input is treated as "no failures yet".
 */
export function reconnectDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0
  const exponential = RECONNECT_BASE_MS * 2 ** (failures - 1)
  return Math.min(exponential, RECONNECT_MAX_MS)
}

/**
 * How often the player samples `currentTime` to see whether the picture is still moving.
 *
 * `currentTime` is the media clock: it advances on the media pipeline's own clock whether or not
 * the compositor keeps up with drawing the frames, so a slow compositor (a struggling GPU, a heavy
 * zoom) is never read as a stall. Only a decoder that truly stops — an underflow — is.
 */
export const STALL_POLL_MS = 1000

/**
 * How long the picture may stand still, with the socket open, before the player gives up on it.
 *
 * 3 s is under P0.5's observed failure (`high` froze 4.4 s in with `DEMUXER_UNDERFLOW` while audio
 * kept playing) and well over any normal gap: at `low` the stream is 15 fps, so one frame is 67 ms,
 * and the sample interval alone is 1 s. The buffer-trim fix in `mseBuffer.ts` is what *prevents*
 * that stall; this is the net underneath it, because a frozen frame is the one failure mode a
 * reconnect cannot see — the socket stays open and healthy while nothing decodes.
 */
export const STALL_GRACE_MS = 3000

/**
 * How much `currentTime` must move to count as progress. Half a frame at 15 fps would be 33 ms;
 * 50 ms is comfortably below one frame at every quality and comfortably above float noise.
 */
export const STALL_MIN_PROGRESS_SECONDS = 0.05

/** The last moment the picture was seen to move. `null` while the stream is not expected to play. */
export interface StallState {
  readonly currentTime: number
  /** `performance.now()`-style timestamp of the last observed progress. */
  readonly progressedAtMs: number
}

/** One sample of a playing element: where it is, when, and whether it should be moving at all. */
export interface StallSample {
  readonly currentTime: number
  readonly atMs: number
  /**
   * Whether this element is supposed to be advancing right now: socket open, not paused, media
   * already started. A paused or not-yet-connected element is not stalled, it is idle — calling it
   * stalled would make every cell reattach on mount, which is a reconnect storm, not a recovery.
   */
  readonly streaming: boolean
}

/**
 * Folds one sample into the stall state and says whether the stream has frozen.
 *
 * Returns `stalled: true` exactly once per freeze: the state resets to `null` with the verdict, so
 * the caller's next sample starts a fresh grace period instead of re-firing every second while the
 * reattach is in flight.
 */
export function stallStep(
  state: StallState | null,
  sample: StallSample,
  graceMs: number = STALL_GRACE_MS,
): { readonly state: StallState | null; readonly stalled: boolean } {
  if (!sample.streaming) return { state: null, stalled: false }
  if (state === null) {
    return {
      state: { currentTime: sample.currentTime, progressedAtMs: sample.atMs },
      stalled: false,
    }
  }
  if (sample.currentTime - state.currentTime >= STALL_MIN_PROGRESS_SECONDS) {
    return {
      state: { currentTime: sample.currentTime, progressedAtMs: sample.atMs },
      stalled: false,
    }
  }
  if (sample.atMs - state.progressedAtMs >= graceMs) return { state: null, stalled: true }
  return { state, stalled: false }
}

/**
 * How long an attached layer may go without painting its first frame before the player gives up on
 * it and retries on the backoff (NFR-7, gate G2; `playerMachine` rule 6).
 *
 * Without this, a layer whose socket stays open but never delivers a decodable frame sits on
 * "Connecting…" forever: the reconnect path needs a close, and the stall detector needs a first
 * frame before it has anything to compare.
 *
 * **Why 10 s, from the evidence rather than P0.5's headline figure.** P0.5 measured the first frame
 * 0.28–0.65 s after connect — but that was a *cold* go2rtc stream, where go2rtc opens the RTSPS
 * session for this consumer and the camera's first packet is a keyframe. A consumer that joins a
 * producer **already running** (another cell on the same `<cameraId>_<quality>`, or the other swap
 * layer of this very cell during a reconnect) starts at the *next* keyframe, and Protect's longest
 * GOP is ~5.0 s at `high` (SPEC §5.3; the same figure `mseBuffer.MSE_KEEP_SECONDS` is sized from).
 * So the honest worst case for a healthy stream is one full GOP plus connect, handshake and the
 * first MSE append: ~5–6 s. 10 s is about twice the longest GOP — comfortably past that, so a
 * healthy layer is never killed on a busy wall (which would be a reconnect storm, and each retry
 * would wait for a keyframe again) — while still well under the backoff's 15 s ceiling, so a layer
 * that will never paint is retried on the same timescale as every other failure.
 *
 * It is sampled on the existing {@link STALL_POLL_MS} timer, so the effective window is 10–11 s
 * **of visible time** — see {@link paintWindowStep} for why hidden time does not count. Re-measure
 * in P2.5 against a real grid and adjust here if the GOP figures change.
 */
export const FIRST_FRAME_TIMEOUT_MS = 10_000

/**
 * The most one sample may add to a paint window. Two poll intervals: a normal sample adds about
 * {@link STALL_POLL_MS}, so a longer gap means the timer itself was not running — a throttled
 * background window, a machine waking from sleep — and that gap is not time the layer had to paint.
 * Without the cap, the first sample after a long gap would kill every layer that was waiting.
 */
export const MAX_PAINT_SAMPLE_MS = 2 * STALL_POLL_MS

/**
 * How long one layer has had to paint its first frame, counting **visible time only**.
 *
 * The first frame is detected with `requestVideoFrameCallback` (MsePlayer.watchFirstFrame), which
 * Chromium does not run while the window is hidden or minimised. Wall-clock time since attach would
 * therefore kill every layer attached while hidden every {@link FIRST_FRAME_TIMEOUT_MS}, for as long
 * as the window stays hidden — a reconnect storm behind a minimised window, each retry waiting for a
 * keyframe again. So a window only advances between two samples that were both visible.
 */
export interface PaintWindow {
  /** Visible milliseconds counted so far. */
  readonly visibleMs: number
  /** `performance.now()`-style timestamp of the previous sample (the attach, at first). */
  readonly sampledAtMs: number
  /** Whether the document was hidden at that sample. */
  readonly hidden: boolean
}

/** A window opened at attach. `hidden` is `document.hidden` at that moment. */
export function openPaintWindow(atMs: number, hidden: boolean): PaintWindow {
  return { visibleMs: 0, sampledAtMs: atMs, hidden }
}

/** One sample of a layer's paint window. */
export interface PaintSample {
  readonly nowMs: number
  /** `document.hidden` now. */
  readonly hidden: boolean
  /** Whether the layer has reported its first painted frame. */
  readonly painted: boolean
}

/**
 * Folds one sample into a layer's paint window and says whether it has used the window up.
 *
 * - A layer that has painted is never overdue — after its first frame, freezing is the stall
 *   detector's question ({@link stallStep}), and a stale layer holding its last frame on purpose
 *   has painted by definition.
 * - The time since the previous sample counts only when that sample **and** this one were visible,
 *   capped at {@link MAX_PAINT_SAMPLE_MS}; a hidden sample is never overdue (see {@link PaintWindow}).
 * - Non-finite or backwards clocks add nothing: a bad clock must not tear down a stream.
 */
export function paintWindowStep(
  paint: PaintWindow,
  sample: PaintSample,
  timeoutMs: number = FIRST_FRAME_TIMEOUT_MS,
): { readonly state: PaintWindow; readonly overdue: boolean } {
  if (sample.painted) return { state: paint, overdue: false }
  if (!Number.isFinite(sample.nowMs) || !Number.isFinite(paint.sampledAtMs)) {
    return { state: paint, overdue: false }
  }
  const elapsed = Math.max(0, sample.nowMs - paint.sampledAtMs)
  const counted = paint.hidden || sample.hidden ? 0 : Math.min(elapsed, MAX_PAINT_SAMPLE_MS)
  const state: PaintWindow = {
    visibleMs: paint.visibleMs + counted,
    sampledAtMs: sample.nowMs,
    hidden: sample.hidden,
  }
  return { state, overdue: !sample.hidden && state.visibleMs >= timeoutMs }
}
