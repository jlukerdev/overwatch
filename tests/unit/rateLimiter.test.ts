// P1.3 (SPEC §5.1, R9): the shared Protect request throttle. The console's 10-requests-per-second
// limit is undocumented and shared between REST calls and WebSocket upgrades, so these tests pin
// down the three things that keep the app under it: minimum spacing, the sliding window, and the
// penalty the server's own 429 imposes.
//
// Everything runs on an injected clock — no real waiting, and the assertions are on exact
// milliseconds rather than on timing that happens to pass.
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MIN_GAP_MS,
  PROTECT_RATE_LIMIT,
  PROTECT_RATE_WINDOW_MS,
  createRateLimiter,
} from '../../src/main/net/rateLimiter'

/** Lets the microtask queue drain so awaited continuations run before the next assertion. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface FakeClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Every duration a caller asked to sleep for, in order. */
  readonly slept: number[]
  /** Moves the clock forward, releasing any sleep that comes due. */
  advance: (ms: number) => Promise<void>
  readonly pending: number
}

function fakeClock(start = 1_000_000): FakeClock {
  let t = start
  const slept: number[] = []
  let waiting: { at: number; resolve: () => void }[] = []
  return {
    now: () => t,
    sleep: (ms) => {
      slept.push(ms)
      return new Promise((resolve) => {
        waiting.push({ at: t + ms, resolve })
      })
    },
    slept,
    async advance(ms) {
      const target = t + ms
      // Drain first: a caller that has not reached its `sleep` yet would otherwise register it
      // after the clock has already moved, and wait for a moment that never comes.
      await flush()
      for (;;) {
        const due = waiting.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)
        const next = due[0]
        if (next === undefined) break
        waiting = waiting.filter((w) => w !== next)
        t = Math.max(t, next.at)
        next.resolve()
        await flush()
      }
      t = target
      await flush()
    },
    get pending() {
      return waiting.length
    },
  }
}

describe('createRateLimiter', () => {
  it('lets the first request through without waiting', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
    await limiter.acquire()
    expect(clock.slept).toEqual([])
  })

  it('spaces consecutive requests by minGapMs', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 150 })
    await limiter.acquire()
    const second = limiter.acquire()
    await flush()
    expect(clock.slept).toEqual([150])
    await clock.advance(150)
    await expect(second).resolves.toBeUndefined()
  })

  it('counts the sliding window, not just the gap', async () => {
    const clock = fakeClock()
    // minGapMs 0 isolates the window rule: three permits are free, the fourth waits for the
    // oldest one to leave the window.
    const limiter = createRateLimiter({
      now: clock.now,
      sleep: clock.sleep,
      minGapMs: 0,
      limit: 3,
      windowMs: 1000,
    })
    await limiter.acquire()
    await clock.advance(100)
    await limiter.acquire()
    await clock.advance(100)
    await limiter.acquire()
    const fourth = limiter.acquire()
    await flush()
    // The first permit was taken 200 ms ago, so it leaves the window in 800 ms.
    expect(clock.slept).toEqual([800])
    await clock.advance(800)
    await expect(fourth).resolves.toBeUndefined()
  })

  it('hands out permits in call order', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 100 })
    const order: number[] = []
    const calls = [0, 1, 2, 3].map((i) =>
      limiter.acquire().then(() => {
        order.push(i)
      }),
    )
    expect(limiter.pending).toBe(4)
    await clock.advance(1000)
    await Promise.all(calls)
    expect(order).toEqual([0, 1, 2, 3])
    expect(limiter.pending).toBe(0)
  })

  it('holds everything back for the window the server reported', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 0 })
    limiter.penalize(1000)
    const next = limiter.acquire()
    await flush()
    expect(clock.slept).toEqual([1000])
    await clock.advance(1000)
    await expect(next).resolves.toBeUndefined()
  })

  it('never shortens a penalty, and ignores a nonsense one', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 0 })
    limiter.penalize(5000)
    limiter.penalize(10) // a shorter one must not undo the longer wait
    limiter.penalize(-1)
    limiter.penalize(Number.NaN)
    void limiter.acquire()
    await flush()
    expect(clock.slept).toEqual([5000])
  })

  it('run() spends a permit and returns the function result', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 150 })
    const fn = vi.fn(() => Promise.resolve('ok'))
    await expect(limiter.run(fn)).resolves.toBe('ok')
    const second = limiter.run(fn)
    await flush()
    // The permit is spent when the function starts, so the second call is still waiting.
    expect(fn).toHaveBeenCalledTimes(1)
    await clock.advance(150)
    await expect(second).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('keeps the queue moving when one caller fails', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, minGapMs: 100 })
    const failing = limiter.run(() => Promise.reject(new Error('boom')))
    await expect(failing).rejects.toThrow('boom')
    const after = limiter.acquire()
    await clock.advance(100)
    await expect(after).resolves.toBeUndefined()
  })

  it('refuses a limit below one', () => {
    expect(() => createRateLimiter({ limit: 0 })).toThrow(/limit must be at least 1/)
  })

  it('fails loudly when the injected sleep does not move the injected clock', async () => {
    const limiter = createRateLimiter({
      now: () => 1000,
      // Resolves immediately without the clock moving: the wait can never be satisfied.
      sleep: () => Promise.resolve(),
      minGapMs: 100,
    })
    await limiter.acquire()
    await expect(limiter.acquire()).rejects.toThrow(/clock is not advancing/)
  })

  it('defaults to the limit P0.3 measured on the console', () => {
    expect(PROTECT_RATE_LIMIT).toBe(10)
    expect(PROTECT_RATE_WINDOW_MS).toBe(1000)
    // 150 ms is the spacing both Phase 0 spikes ran at without ever being rate limited.
    expect(DEFAULT_MIN_GAP_MS).toBe(150)
  })
})
