// P5.5 (DOOR-6): a door-watch session and its retry policy
// (src/renderer/src/features/door/doorWatchRetry.ts).
//
// What these tests protect: a start that fails is asked again (2 s, then every 5 s) until it
// succeeds, so the unlock controls do not stay neutral for the whole Live visit; a success stops
// the retries; stopping the session (the wall unmounted, or the watch rule turned false) clears the
// pending retry and sends exactly one stop, which is never retried; and never two timers at once.
import { describe, expect, it } from 'vitest'
import {
  startDoorWatch,
  WATCH_RETRY_FIRST_MS,
  WATCH_RETRY_MS,
  watchRetryDelay,
} from '../../src/renderer/src/features/door/doorWatchRetry'

type Answer = { ok: boolean } | 'throw'

/** Fake timers and a `watchDoors` that answers each start from `starts`, in order (then `ok`). */
function harness(starts: Answer[]) {
  const calls: boolean[] = []
  const timers = new Map<number, { run: () => void; ms: number }>()
  const delays: number[] = []
  let nextTimer = 1
  let cleared = 0

  const watchDoors = (watching: boolean): Promise<{ ok: boolean }> => {
    calls.push(watching)
    if (!watching) return Promise.resolve({ ok: true })
    const answer = starts.shift() ?? { ok: true }
    return answer === 'throw' ? Promise.reject(new Error('bridge')) : Promise.resolve(answer)
  }
  const stop = startDoorWatch<number>({
    watchDoors,
    setTimer: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { run, ms })
      delays.push(ms)
      return id
    },
    clearTimer: (id) => {
      cleared += 1
      timers.delete(id)
    },
  })

  return {
    calls,
    delays,
    stop,
    pending: () => timers.size,
    cleared: () => cleared,
    /** Lets the answers already resolved reach the session. */
    settle: async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    },
    /** Fires the one pending timer. */
    fire: (): void => {
      const [entry] = [...timers.entries()]
      if (entry === undefined) throw new Error('no timer pending')
      timers.delete(entry[0])
      entry[1].run()
    },
  }
}

describe('watchRetryDelay', () => {
  it('waits 2 s after the first failure, then 5 s each time', () => {
    expect(WATCH_RETRY_FIRST_MS).toBe(2000)
    expect(WATCH_RETRY_MS).toBe(5000)
    expect(watchRetryDelay(1)).toBe(2000)
    expect(watchRetryDelay(2)).toBe(5000)
    expect(watchRetryDelay(50)).toBe(5000)
  })
})

describe('startDoorWatch', () => {
  it('a start that succeeds asks once and sets no timer', async () => {
    const h = harness([{ ok: true }])
    await h.settle()
    expect(h.calls).toEqual([true])
    expect(h.pending()).toBe(0)
  })

  it('fails then succeeds: one retry after 2 s, then nothing more', async () => {
    const h = harness([{ ok: false }, { ok: true }])
    await h.settle()
    expect(h.calls).toEqual([true])
    expect(h.delays).toEqual([WATCH_RETRY_FIRST_MS])

    h.fire()
    await h.settle()
    expect(h.calls).toEqual([true, true])
    expect(h.pending()).toBe(0)
    expect(h.delays).toHaveLength(1)
  })

  it('retries a bridge that throws like a failed answer', async () => {
    const h = harness(['throw', { ok: true }])
    await h.settle()
    expect(h.delays).toEqual([WATCH_RETRY_FIRST_MS])
    h.fire()
    await h.settle()
    expect(h.calls).toEqual([true, true])
    expect(h.pending()).toBe(0)
  })

  it('keeps retrying a repeated failure at the capped delay, one timer at a time', async () => {
    const h = harness([{ ok: false }, { ok: false }, 'throw', { ok: false }, { ok: false }])
    await h.settle()
    for (let i = 0; i < 4; i += 1) {
      expect(h.pending()).toBe(1)
      h.fire()
      await h.settle()
    }
    expect(h.calls).toEqual([true, true, true, true, true])
    expect(h.delays).toEqual([
      WATCH_RETRY_FIRST_MS,
      WATCH_RETRY_MS,
      WATCH_RETRY_MS,
      WATCH_RETRY_MS,
      WATCH_RETRY_MS,
    ])
    expect(h.pending()).toBe(1)
  })

  it('stopping during the wait (unmount, or the watch rule turning false) clears the retry', async () => {
    const h = harness([{ ok: false }])
    await h.settle()
    expect(h.pending()).toBe(1)

    h.stop()
    await h.settle()

    expect(h.cleared()).toBe(1)
    expect(h.pending()).toBe(0)
    // The one stop, and no start after it.
    expect(h.calls).toEqual([true, false])
  })

  it('a failure answered after the stop sets no timer and asks nothing', async () => {
    const h = harness([{ ok: false }])
    // Stopped before the failed answer has reached the session.
    h.stop()
    await h.settle()
    expect(h.calls).toEqual([true, false])
    expect(h.pending()).toBe(0)
    expect(h.delays).toEqual([])
  })

  it('sends one stop, never retried, and stopping twice does nothing more', async () => {
    const h = harness([{ ok: true }])
    await h.settle()
    h.stop()
    h.stop()
    await h.settle()
    expect(h.calls).toEqual([true, false])
    expect(h.pending()).toBe(0)
  })
})
