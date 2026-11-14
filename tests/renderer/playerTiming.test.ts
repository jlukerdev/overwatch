// P2.3 (NFR-7, gate G2): when the live player retries, and when it decides a picture has frozen.
//
// Both answers only show themselves minutes into a run — G2 kills go2rtc and watches the wall come
// back by itself — and neither can be observed in this environment (no jsdom, no WebSocket, no
// MediaSource; vitest.config.mts). So they are numbers in a pure module, checked here.
import { describe, expect, it } from 'vitest'
import {
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
