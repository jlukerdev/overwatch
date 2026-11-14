// P2.3/P2.4 (NFR-7, gate G2): when the live player retries, when it decides a picture has frozen,
// and when a layer that never painted is given up on.
//
// Both answers only show themselves minutes into a run — G2 kills go2rtc and watches the wall come
// back by itself — and neither can be observed in this environment (no jsdom, no WebSocket, no
// MediaSource; vitest.config.mts). So they are numbers in a pure module, checked here.
import { describe, expect, it } from 'vitest'
import {
  FIRST_FRAME_TIMEOUT_MS,
  MAX_PAINT_SAMPLE_MS,
  openPaintWindow,
  paintWindowStep,
  type PaintWindow,
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  stallStep,
  STALL_GRACE_MS,
  STALL_MIN_PROGRESS_SECONDS,
  STALL_POLL_MS,
  type StallState,
} from '../../src/renderer/src/player/playerTiming'

describe('reconnectDelayMs', () => {
  it('does not wait for the first attempt', () => {
    // Mounting a cell, a quality swap (QUAL-6) and the first recovery after a go2rtc restart all go
    // through here: a wall of ten cells that each slept first would look broken (G2).
    expect(reconnectDelayMs(0)).toBe(0)
  })

  it('backs off exponentially from RECONNECT_BASE_MS', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(3)).toBe(RECONNECT_BASE_MS * 4)
    expect(reconnectDelayMs(4)).toBe(RECONNECT_BASE_MS * 8)
  })

  it('caps at RECONNECT_MAX_MS, so a cell retrying for an hour still comes back promptly', () => {
    expect(reconnectDelayMs(10)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelayMs(1000)).toBe(RECONNECT_MAX_MS)
  })

  it('is monotonic and finite for anything it can be handed', () => {
    let previous = -1
    for (const failures of [-5, 0, 1, 2, 3, 4, 5, 6, 7, 8, 20]) {
      const delay = reconnectDelayMs(failures)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
    expect(reconnectDelayMs(Number.NaN)).toBe(0)
  })
})

describe('stallStep', () => {
  const poll = (
    state: StallState | null,
    currentTime: number,
    atMs: number,
    streaming = true,
  ): { state: StallState | null; stalled: boolean } =>
    stallStep(state, { currentTime, atMs, streaming })

  it('says nothing on the first sample', () => {
    const first = poll(null, 3, 1000)
    expect(first.stalled).toBe(false)
    expect(first.state).toEqual({ currentTime: 3, progressedAtMs: 1000 })
  })

  it('tracks a stream that is advancing', () => {
    let step = poll(null, 3, 1000)
    for (let tick = 1; tick <= 10; tick += 1) {
      step = poll(step.state, 3 + tick, 1000 + tick * STALL_POLL_MS)
      expect(step.stalled).toBe(false)
    }
  })

  it('reports a stall once the picture has stood still for STALL_GRACE_MS', () => {
    // The P0.5 failure mode: socket open, audio playing, video frozen (`DEMUXER_UNDERFLOW`).
    let step = poll(null, 12, 0)
    step = poll(step.state, 12, STALL_GRACE_MS - 1)
    expect(step.stalled).toBe(false)
    step = poll(step.state, 12, STALL_GRACE_MS)
    expect(step.stalled).toBe(true)
  })

  it('reports it once and then starts a fresh grace period', () => {
    // Otherwise every poll during the reattach would fire another one.
    let step = poll(null, 12, 0)
    step = poll(step.state, 12, STALL_GRACE_MS)
    expect(step.stalled).toBe(true)
    expect(step.state).toBeNull()
    step = poll(step.state, 12, STALL_GRACE_MS + STALL_POLL_MS)
    expect(step.stalled).toBe(false)
  })

  it('counts a frame of movement as progress', () => {
    const start = poll(null, 12, 0)
    const crawling = poll(start.state, 12 + STALL_MIN_PROGRESS_SECONDS, STALL_GRACE_MS * 2)
    expect(crawling.stalled).toBe(false)
  })

  it('does not mistake float noise for progress', () => {
    const start = poll(null, 12, 0)
    const noise = poll(start.state, 12.000001, STALL_GRACE_MS)
    expect(noise.stalled).toBe(true)
  })

  it('never calls an idle element stalled', () => {
    // Not yet connected, paused, or already closed: that is idle, and reattaching every cell on
    // mount would be a reconnect storm, not a recovery.
    let step = poll(null, 0, 0, false)
    for (let tick = 1; tick <= 10; tick += 1) {
      step = poll(step.state, 0, tick * STALL_GRACE_MS, false)
      expect(step.stalled).toBe(false)
      expect(step.state).toBeNull()
    }
  })

  it('samples often enough that STALL_GRACE_MS is a real threshold', () => {
    expect(STALL_POLL_MS).toBeLessThan(STALL_GRACE_MS)
  })
})

describe('FIRST_FRAME_TIMEOUT_MS (rule 6 of playerMachine)', () => {
  /** Protect's longest keyframe interval (`high`, SPEC §5.3), which a joining consumer waits out. */
  const LONGEST_GOP_MS = 5000
  /** The slow end of P0.5's cold first-frame figures (0.28–0.65 s). */
  const COLD_FIRST_FRAME_MS = 650

  it('comfortably exceeds the longest GOP plus connect time, so a healthy join is never killed', () => {
    // A consumer joining a producer that is already running starts at the *next* keyframe.
    expect(FIRST_FRAME_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * LONGEST_GOP_MS)
    expect(FIRST_FRAME_TIMEOUT_MS).toBeGreaterThan(LONGEST_GOP_MS + COLD_FIRST_FRAME_MS)
  })

  it('still gives up on the timescale of the backoff, not minutes later', () => {
    expect(FIRST_FRAME_TIMEOUT_MS).toBeLessThan(RECONNECT_MAX_MS)
    // Sampled on the stall poll, so it needs to be several polls long to mean what it says.
    expect(FIRST_FRAME_TIMEOUT_MS).toBeGreaterThan(STALL_POLL_MS * 5)
  })
})

describe('paintWindowStep (rule 6 of playerMachine: visible time only)', () => {
  /** Samples a layer every `stepMs` from `from` for `count` polls; returns each verdict. */
  function run(
    paint: PaintWindow,
    input: { from: number; stepMs: number; count: number; hidden?: boolean; painted?: boolean },
  ): { paint: PaintWindow; verdicts: boolean[] } {
    const verdicts: boolean[] = []
    let state = paint
    for (let poll = 1; poll <= input.count; poll += 1) {
      const step = paintWindowStep(state, {
        nowMs: input.from + poll * input.stepMs,
        hidden: input.hidden ?? false,
        painted: input.painted ?? false,
      })
      state = step.state
      verdicts.push(step.overdue)
    }
    return { paint: state, verdicts }
  }

  it('is not overdue inside the window, and is once it has run out without a frame', () => {
    const polls = FIRST_FRAME_TIMEOUT_MS / STALL_POLL_MS
    const { verdicts } = run(openPaintWindow(1000, false), {
      from: 1000,
      stepMs: STALL_POLL_MS,
      count: polls,
    })
    expect(verdicts.slice(0, -1).every((overdue) => !overdue)).toBe(true)
    expect(verdicts.at(-1)).toBe(true)
  })

  it('is never overdue once a frame has painted — including a stale layer holding its frame', () => {
    // After the first frame, freezing is the stall detector's question; a stale `current` with its
    // socket closed has painted by definition and must be left holding its last frame.
    const { verdicts } = run(openPaintWindow(0, false), {
      from: 0,
      stepMs: STALL_POLL_MS,
      count: 60,
      painted: true,
    })
    expect(verdicts.some(Boolean)).toBe(false)
  })

  it('does not count time while the window is hidden, so a hidden attach is never killed', () => {
    // requestVideoFrameCallback does not run while hidden, so no layer could ever paint there.
    const hidden = run(openPaintWindow(0, true), {
      from: 0,
      stepMs: STALL_POLL_MS,
      count: 120,
      hidden: true,
    })
    expect(hidden.verdicts.some(Boolean)).toBe(false)
    expect(hidden.paint.visibleMs).toBe(0)

    // Shown again: the full window starts from there, not from the attach two minutes earlier.
    const shown = run(hidden.paint, {
      from: 120 * STALL_POLL_MS,
      stepMs: STALL_POLL_MS,
      count: FIRST_FRAME_TIMEOUT_MS / STALL_POLL_MS + 1,
    })
    // The first visible sample follows a hidden one, so it adds nothing; the window then runs out
    // after exactly FIRST_FRAME_TIMEOUT_MS of visible polling.
    expect(shown.verdicts.slice(0, -1).every((overdue) => !overdue)).toBe(true)
    expect(shown.verdicts.at(-1)).toBe(true)
  })

  it('keeps the visible time it had counted before the window was hidden', () => {
    const before = run(openPaintWindow(0, false), { from: 0, stepMs: STALL_POLL_MS, count: 6 })
    expect(before.paint.visibleMs).toBe(6 * STALL_POLL_MS)
    const away = run(before.paint, {
      from: 6 * STALL_POLL_MS,
      stepMs: STALL_POLL_MS,
      count: 30,
      hidden: true,
    })
    expect(away.paint.visibleMs).toBe(6 * STALL_POLL_MS)
  })

  it('never reports overdue on a hidden sample, even with the window used up', () => {
    const used: PaintWindow = { visibleMs: FIRST_FRAME_TIMEOUT_MS, sampledAtMs: 0, hidden: false }
    expect(paintWindowStep(used, { nowMs: 1000, hidden: true, painted: false }).overdue).toBe(false)
  })

  it('caps one sample, so a throttled timer or a wake from sleep does not use the window up', () => {
    const step = paintWindowStep(openPaintWindow(0, false), {
      nowMs: 60_000,
      hidden: false,
      painted: false,
    })
    expect(step.overdue).toBe(false)
    expect(step.state.visibleMs).toBe(MAX_PAINT_SAMPLE_MS)
    expect(MAX_PAINT_SAMPLE_MS).toBeGreaterThan(STALL_POLL_MS)
    expect(MAX_PAINT_SAMPLE_MS).toBeLessThan(FIRST_FRAME_TIMEOUT_MS)
  })

  it('takes a custom window', () => {
    const open = openPaintWindow(0, false)
    expect(paintWindowStep(open, { nowMs: 500, hidden: false, painted: false }, 500).overdue).toBe(
      true,
    )
    expect(paintWindowStep(open, { nowMs: 499, hidden: false, painted: false }, 500).overdue).toBe(
      false,
    )
  })

  it('never tears a stream down on a bad clock', () => {
    const open = openPaintWindow(0, false)
    expect(
      paintWindowStep(openPaintWindow(Number.NaN, false), {
        nowMs: 1e9,
        hidden: false,
        painted: false,
      }).overdue,
    ).toBe(false)
    expect(
      paintWindowStep(open, { nowMs: Number.POSITIVE_INFINITY, hidden: false, painted: false })
        .overdue,
    ).toBe(false)
    // A clock that runs backwards adds nothing.
    const used: PaintWindow = { visibleMs: 0, sampledAtMs: 5000, hidden: false }
    expect(
      paintWindowStep(used, { nowMs: 1000, hidden: false, painted: false }).state.visibleMs,
    ).toBe(0)
  })
})
