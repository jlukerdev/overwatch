// P6.2: the cancellable backoff wait shared by the Protect feeds and the Access notifications
// socket (src/main/net/backoffWait.ts). Fake timers only; nothing real is scheduled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBackoffWait, timerSleep } from '../../src/main/net/backoffWait'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Whether a promise has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('startBackoffWait', () => {
  it('ends when the sleep runs out', async () => {
    const wait = startBackoffWait(timerSleep, 1000)
    expect(await settled(wait.done)).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await settled(wait.done)).toBe(true)
  })

  it('ends at once on wake, clearing the timer', async () => {
    const wait = startBackoffWait(timerSleep, 60_000)
    expect(vi.getTimerCount()).toBe(1)
    wait.wake()
    expect(vi.getTimerCount()).toBe(0)
    expect(await settled(wait.done)).toBe(true)
    wait.wake()
  })

  it("ends at once on the parent's abort, and when the parent was already aborted", async () => {
    const parent = new AbortController()
    const wait = startBackoffWait(timerSleep, 60_000, parent.signal)
    parent.abort()
    expect(await settled(wait.done)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const late = startBackoffWait(timerSleep, 60_000, parent.signal)
    expect(await settled(late.done)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('swallows a rejection caused by the abort', async () => {
    const rejecting = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const wait = startBackoffWait(rejecting, 1000)
    wait.wake()
    await expect(wait.done).resolves.toBeUndefined()
  })

  it('passes on a rejection the sleep made by itself, thrown or returned', async () => {
    await expect(
      startBackoffWait(() => Promise.reject(new Error('broken')), 1000).done,
    ).rejects.toThrow('broken')
    await expect(
      startBackoffWait(() => {
        throw new Error('thrown')
      }, 1000).done,
    ).rejects.toThrow('thrown')
  })
})
