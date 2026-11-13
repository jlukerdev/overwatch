// One shared throttle for everything that spends the Protect API's request budget (SPEC §5.1, R9).
//
// The console allows **10 requests per 1-second window, per key**, and that is not in the contract:
// P0.3 §7 found it by hitting it. Over the limit it answers `429 TOO_MANY_REQUESTS_ERROR` with the
// window in the body. **WebSocket upgrades count against the same budget**, and a rate-limited
// upgrade is accepted, sent the 429 body as one text frame and closed with code 4500 — so the REST
// client and both subscriptions have to share one limiter, not have one each.
//
// The limiter is deliberately simple and injectable: `now` and `sleep` are parameters, so the unit
// tests drive it on a fake clock instead of waiting in real time.
//
// No Electron and no Node-only imports beyond timers, so this is plain-Node testable.

/** Requests per window the console allows per key (P0.3 §7; not in the contract). */
export const PROTECT_RATE_LIMIT = 10

/** The window those requests are counted in. The 429 body repeats it as `windowMs`. */
export const PROTECT_RATE_WINDOW_MS = 1000

/**
 * Minimum spacing between requests. 150 ms is what both Phase 0 spikes used without ever being
 * rate limited, and it leaves headroom for a burst the limiter cannot see (another integration
 * using the same key). It caps throughput at ~6.7 req/s, below the 10 the window allows.
 */
export const DEFAULT_MIN_GAP_MS = 150

/** Guard against a `sleep` that resolves without the clock moving (a mis-wired fake clock). */
const MAX_WAIT_ROUNDS = 100

export interface RateLimiterOptions {
  /** Requests per `windowMs`. Default {@link PROTECT_RATE_LIMIT}. */
  readonly limit?: number
  /** Default {@link PROTECT_RATE_WINDOW_MS}. */
  readonly windowMs?: number
  /** Default {@link DEFAULT_MIN_GAP_MS}. */
  readonly minGapMs?: number
  /** Clock, in ms. Tests inject a controllable one. */
  readonly now?: () => number
  /** Delay. Tests inject one tied to their clock. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface RateLimiter {
  /**
   * Resolves when the caller may send. Permits are handed out **in call order**, so a burst keeps
   * its ordering instead of all waking at once.
   */
  acquire(): Promise<void>
  /** `acquire()` and then run `fn`. The permit is spent when `fn` starts, not when it finishes. */
  run<T>(fn: () => Promise<T>): Promise<T>
  /**
   * The server said we are over the budget: hold everything back for `ms`. Called with the 429
   * body's `windowMs`, and on a WebSocket close code 4500. Never shortens an existing penalty.
   */
  penalize(ms: number): void
  /** Callers waiting for a permit, for diagnostics. */
  readonly pending: number
}

const timerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limit = options.limit ?? PROTECT_RATE_LIMIT
  const windowMs = options.windowMs ?? PROTECT_RATE_WINDOW_MS
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? timerSleep
  if (limit < 1) throw new Error('rate limiter: limit must be at least 1')

  /** When each permit still inside the window was granted, oldest first. */
  const granted: number[] = []
  let penaltyUntil = 0
  let pending = 0
  // Permits are granted one at a time in FIFO order: without this, ten callers would all compute
  // the same "free now" and send together.
  let queue: Promise<void> = Promise.resolve()

  /** How long the next permit has to wait. 0 means "send now". */
  const waitMs = (): number => {
    const t = now()
    while (granted.length > 0 && (granted[0] ?? 0) <= t - windowMs) granted.shift()
    const last = granted[granted.length - 1]
    const oldest = granted[0]
    return Math.max(
      0,
      last === undefined ? 0 : last + minGapMs - t,
      oldest !== undefined && granted.length >= limit ? oldest + windowMs - t : 0,
      penaltyUntil - t,
    )
  }

  const take = async (): Promise<void> => {
    for (let round = 0; ; round++) {
      const wait = waitMs()
      if (wait <= 0) break
      if (round >= MAX_WAIT_ROUNDS) {
        throw new Error(
          `rate limiter: still waiting ${String(wait)} ms after ${String(MAX_WAIT_ROUNDS)} ` +
            'rounds. The injected clock is not advancing with the injected sleep.',
        )
      }
      await sleep(wait)
    }
    granted.push(now())
    if (granted.length > limit) granted.shift()
  }

  const acquire = (): Promise<void> => {
    pending++
    // `take` on both paths: one caller's failure must not stall the queue behind it.
    const mine = queue.then(take, take)
    queue = mine.then(
      () => undefined,
      () => undefined,
    )
    return mine.finally(() => {
      pending--
    })
  }

  return {
    acquire,
    async run(fn) {
      await acquire()
      return await fn()
    },
    penalize(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return
      penaltyUntil = Math.max(penaltyUntil, now() + ms)
    },
    get pending() {
      return pending
    },
  }
}
