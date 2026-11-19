// P6.2 (NFR-7): the shared `onRecover` subscription (src/renderer/src/player/recoverBus.ts).
//
// What these tests protect: however many players register, the bridge sees **one** subscription
// (a listener per cell on one IPC channel trips Node's MaxListenersExceededWarning past 10 and
// validates every push once per player); it is taken on the first registration and dropped with the
// last, and taken again by the next; every registered player hears every push; and one player that
// throws does not stop the others.
import { describe, expect, it, vi } from 'vitest'
import type { Recover } from '@shared/ipc'
import { createRecoverBus } from '../../src/renderer/src/player/recoverBus'

/** A fake bridge member that counts its subscriptions and can push. */
function fakeSource() {
  const listeners = new Set<(event: Recover) => void>()
  let subscribed = 0
  let unsubscribed = 0
  const source = (listener: (event: Recover) => void): (() => void) => {
    subscribed += 1
    listeners.add(listener)
    return () => {
      unsubscribed += 1
      listeners.delete(listener)
    }
  }
  return {
    source,
    push: (event: Recover) => {
      for (const listener of listeners) listener(event)
    },
    counts: () => ({ subscribed, unsubscribed, live: listeners.size }),
  }
}

describe('createRecoverBus (NFR-7)', () => {
  it('does not touch the bridge until a player registers', () => {
    const fake = fakeSource()
    createRecoverBus(fake.source)
    expect(fake.counts()).toEqual({ subscribed: 0, unsubscribed: 0, live: 0 })
  })

  it('holds one bridge subscription for any number of players, and delivers to each', () => {
    const fake = fakeSource()
    const bus = createRecoverBus(fake.source)
    const heard = Array.from({ length: 16 }, () => vi.fn())
    for (const listener of heard) bus.subscribe(listener)
    expect(fake.counts()).toEqual({ subscribed: 1, unsubscribed: 0, live: 1 })

    fake.push({ reason: 'resume' })
    for (const listener of heard)
      expect(listener).toHaveBeenCalledExactlyOnceWith({ reason: 'resume' })
  })

  it('drops the bridge subscription when the last player leaves, and takes it again for the next', () => {
    const fake = fakeSource()
    const bus = createRecoverBus(fake.source)
    const offA = bus.subscribe(vi.fn())
    const offB = bus.subscribe(vi.fn())
    offA()
    expect(fake.counts()).toEqual({ subscribed: 1, unsubscribed: 0, live: 1 })
    offB()
    expect(fake.counts()).toEqual({ subscribed: 1, unsubscribed: 1, live: 0 })
    // Unsubscribing twice changes nothing.
    offB()
    offA()
    expect(fake.counts()).toEqual({ subscribed: 1, unsubscribed: 1, live: 0 })

    const later = vi.fn()
    bus.subscribe(later)
    expect(fake.counts()).toEqual({ subscribed: 2, unsubscribed: 1, live: 1 })
    fake.push({ reason: 'network' })
    expect(later).toHaveBeenCalledExactlyOnceWith({ reason: 'network' })
  })

  it('stops delivering to a player that has left', () => {
    const fake = fakeSource()
    const bus = createRecoverBus(fake.source)
    const stays = vi.fn()
    const leaves = vi.fn()
    bus.subscribe(stays)
    bus.subscribe(leaves)()
    fake.push({ reason: 'resume' })
    expect(stays).toHaveBeenCalledTimes(1)
    expect(leaves).not.toHaveBeenCalled()
  })

  it('keeps delivering past a player that throws', () => {
    const fake = fakeSource()
    const bus = createRecoverBus(fake.source)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bus.subscribe(() => {
      throw new Error('broken cell')
    })
    const after = vi.fn()
    bus.subscribe(after)
    fake.push({ reason: 'resume' })
    expect(after).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
