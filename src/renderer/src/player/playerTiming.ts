// When the live player retries, and when it decides a stream has frozen (P2.3; NFR-7, gate G2).
//
// Pure on purpose, like `mseBuffer.ts` next to it: both answers are numbers that only ever reveal
// themselves minutes into a 30-minute run (G2), and the project has no jsdom, so a threshold that
// lives inside a `setInterval` callback is a threshold no test can reach (CLAUDE.md,
// vitest.config.mts).
//
// Note what is *not* here: nothing in this file knows about go2rtc, WebSockets or the IPC bridge.
// The player machine asks these two questions and acts on the answers; that is the whole contract.

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

/** How often the player samples `currentTime` to see whether the picture is still moving. */
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
