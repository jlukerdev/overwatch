// P5.6: the Doors screen's details reads (src/main/access/doorDetailsMonitor.ts) — each door's lock
// rule and the emergency status of all doors.
//
// On vitest's fake clock against hand-driven readers, so every rule in the module's header is a
// number of requests at a point in time: one request at a time, one round at a time, the cadence,
// the coalescing, and what a failure leaves behind.
import type { DoorEmergency, DoorRule } from '@shared/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessApiError } from '../../src/main/access/client'
import {
  createDoorDetailsMonitor,
  detailsReadEndsRound,
  mergeDetailsScopes,
} from '../../src/main/access/doorDetailsMonitor'

const INTERVAL_MS = 30_000
const NORMAL: DoorEmergency = { lockdown: false, evacuation: false }
const NO_RULE: DoorRule = { type: '', endedTime: null }

/** A promise the test settles by hand, to hold a request "in flight". */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function accessError(kind: AccessApiError['kind'], code: string | null = null): AccessApiError {
  return new AccessApiError(`a ${kind} failure`, { kind, code })
}

function setup(options: { doors?: readonly string[] } = {}) {
  let doorIds = [...(options.doors ?? ['front', 'garage'])]
  let intervalMs = INTERVAL_MS
  let ready = true
  let emergency: DoorEmergency | Error = NORMAL
  const rules = new Map<string, DoorRule | Error>()
  /** Every request in the order it was started: `emergency`, or the door id. */
  const requests: string[] = []
  const logged: string[] = []
  let changes = 0
  /** How many requests are running right now, and the most that ever were. */
  let running = 0
  let mostAtOnce = 0
  /** When set, the next request waits on it instead of answering at once. */
  let hold: Promise<undefined> | null = null

  async function answer<T>(value: T | Error): Promise<T> {
    running += 1
    mostAtOnce = Math.max(mostAtOnce, running)
    try {
      if (hold !== null) await hold
      else await Promise.resolve()
      if (value instanceof Error) throw value
      return value
    } finally {
      running -= 1
    }
  }

  const readEmergency = vi.fn(() => {
    requests.push('emergency')
    return answer<DoorEmergency>(emergency)
  })
  const readLockRule = vi.fn((doorId: string) => {
    requests.push(doorId)
    return answer<DoorRule>(rules.get(doorId) ?? NO_RULE)
  })
  const details = createDoorDetailsMonitor({
    readEmergency,
    readLockRule,
    doorIds: () => doorIds,
    intervalMs: () => intervalMs,
    ready: () => ready,
    onChange: () => {
      changes += 1
    },
    log: (line) => {
      logged.push(line)
    },
  })
  return {
    details,
    readEmergency,
    readLockRule,
    requests,
    logged,
    get changes() {
      return changes
    },
    get mostAtOnce() {
      return mostAtOnce
    },
    rulesNow(): Record<string, DoorRule> {
      return Object.fromEntries(details.rules)
    },
    setDoorIds(next: readonly string[]) {
      doorIds = [...next]
    },
    setInterval(next: number) {
      intervalMs = next
    },
    setReady(next: boolean) {
      ready = next
    },
    setEmergency(next: DoorEmergency | Error) {
      emergency = next
    },
    setRule(doorId: string, next: DoorRule | Error) {
      rules.set(doorId, next)
    },
    /** Makes every request wait until the returned function is called. */
    holdRequests(): () => void {
      const gate = deferred<undefined>()
      hold = gate.promise
      return () => {
        hold = null
        gate.resolve(undefined)
      }
    },
    /** Lets every microtask of a round that answers at once run. */
    async settle() {
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a round', () => {
  it('reads the emergency status, then each door, in order, on start', async () => {
    const h = setup()
    h.setEmergency({ lockdown: true, evacuation: false })
    h.setRule('front', { type: 'schedule', endedTime: 1795000000 })
    h.details.start()
    expect(h.details.running).toBe(true)
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'front', 'garage'])
    expect(h.details.emergency).toEqual({ lockdown: true, evacuation: false })
    expect(h.rulesNow()).toEqual({
      front: { type: 'schedule', endedTime: 1795000000 },
      // `type: ''` is the console saying "no rule": kept, and distinct from "not known".
      garage: NO_RULE,
    })
  })

  it('never has two requests in flight, however many doors there are', async () => {
    const h = setup({ doors: ['a', 'b', 'c', 'd', 'e', 'f'] })
    h.details.start()
    await h.settle()
    expect(h.requests).toHaveLength(7)
    expect(h.mostAtOnce).toBe(1)
  })

  it('waits for each answer before the next request', async () => {
    const h = setup()
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    // Only the first request is out; the doors wait for it.
    expect(h.requests).toEqual(['emergency'])
    release()
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'front', 'garage'])
  })

  it('reads the door ids once per round, so a list that changed is used by the next one', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setDoorIds(['front', 'office'])
    h.setRule('office', { type: 'keep_lock', endedTime: 3602128562 })
    h.details.request('test')
    await h.settle()
    expect(h.requests.slice(3)).toEqual(['emergency', 'front', 'office'])
    // The door that left the list keeps no rule.
    expect(h.rulesNow()).toEqual({
      front: NO_RULE,
      office: { type: 'keep_lock', endedTime: 3602128562 },
    })
  })

  it('is idempotent to start, and reads nothing with no doors but the emergency status', async () => {
    const h = setup({ doors: [] })
    h.details.start()
    h.details.start()
    await h.settle()
    expect(h.requests).toEqual(['emergency'])
  })

  it('calls onChange only when a value actually changed', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    // The emergency status and two rules arrived: three changes.
    expect(h.changes).toBe(3)
    h.details.request('test')
    await h.settle()
    expect(h.changes).toBe(3)
    h.setRule('garage', { type: 'custom', endedTime: 100 })
    h.details.request('test')
    await h.settle()
    expect(h.changes).toBe(4)
    h.setRule('garage', { type: 'custom', endedTime: 200 })
    h.setEmergency({ lockdown: false, evacuation: true })
    h.details.request('test')
    await h.settle()
    expect(h.changes).toBe(6)
  })

  it('hands out copies: a caller cannot change what the monitor holds', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    const emergency = h.details.emergency
    if (emergency === null) throw new Error('expected an emergency status')
    emergency.lockdown = true
    expect(h.details.emergency).toEqual(NORMAL)
  })
})

describe('the cadence', () => {
  it('runs a round every interval, counted from the end of the last one', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(h.readEmergency).toHaveBeenCalledTimes(5)
    expect(h.mostAtOnce).toBe(1)
  })

  it('reads the interval at every arming, and rearm() applies a shorter one at once', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    await vi.advanceTimersByTimeAsync(10_000)
    // 10 s into a 30 s wait, the user saves 12 s: the next round is 2 s away, not 20.
    h.setInterval(12_000)
    h.details.rearm()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    // And the one after that is 12 s later.
    await vi.advanceTimersByTimeAsync(12_000)
    expect(h.readEmergency).toHaveBeenCalledTimes(3)
  })

  it('rearm() to an interval that has already passed reads now, once', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    await vi.advanceTimersByTimeAsync(20_000)
    h.setInterval(10_000)
    h.details.rearm()
    await h.settle()
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('rearm() to a longer interval postpones the pending round', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setInterval(60_000)
    h.details.rearm()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('rearm() does nothing while stopped or while a round is running', async () => {
    const h = setup()
    h.details.rearm()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(h.requests).toEqual([])
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    h.details.rearm()
    h.details.rearm()
    release()
    await h.settle()
    // Still the one round, and exactly one timer for the next.
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('skips a timed round while not ready, and does not queue it', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setReady(false)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    h.setReady(true)
    // Nothing was owed: the next round is the next timer, a full interval after the last skip.
    await h.settle()
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('a requested round is not held back by ready()', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setReady(false)
    h.details.request('the user acted')
    await h.settle()
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })
})

describe('request (a round now)', () => {
  it('reads at once, and the next timed round is a full interval after it', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    await vi.advanceTimersByTimeAsync(25_000)
    h.details.request('a door action was answered')
    await h.settle()
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    // Not at the old 30 s mark, 5 s later.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(3)
  })

  it('coalesces any number of requests during a round into exactly one more', async () => {
    const h = setup()
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    for (let i = 0; i < 20; i += 1) h.details.request('a relay changed')
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    release()
    await h.settle()
    // The round that was running, and one more. Not twenty.
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    expect(h.requests).toEqual(['emergency', 'front', 'garage', 'emergency', 'front', 'garage'])
    expect(h.mostAtOnce).toBe(1)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('does nothing while stopped', async () => {
    const h = setup()
    h.details.request('too early')
    await h.settle()
    expect(h.requests).toEqual([])
  })
})

describe('scoped requests (rule 2a)', () => {
  it("reads only the named doors' rules, and the emergency status only when asked", async () => {
    const h = setup({ doors: ['front', 'garage', 'office'] })
    h.details.start()
    await h.settle()
    h.requests.length = 0
    h.setRule('garage', { type: 'keep_unlock', endedTime: 9 })
    h.details.request('a relay changed', { doorIds: ['garage'], emergency: false })
    await h.settle()
    expect(h.requests).toEqual(['garage'])
    expect(h.rulesNow().garage).toEqual({ type: 'keep_unlock', endedTime: 9 })
    h.requests.length = 0
    h.details.request('a door action was answered', { doorIds: ['front'], emergency: true })
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'front'])
    expect(h.mostAtOnce).toBe(1)
  })

  it('reads everything without a scope, as a timed round does', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.requests.length = 0
    h.details.request('the emergency status was changed')
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'front', 'garage'])
  })

  it('never asks about a door that is not listed, and keeps what the others had', async () => {
    const h = setup()
    h.setRule('front', { type: 'custom', endedTime: 5 })
    h.details.start()
    await h.settle()
    h.requests.length = 0
    h.details.request('test', { doorIds: ['gone', 'constructor'], emergency: false })
    await h.settle()
    expect(h.requests).toEqual([])
    expect(h.rulesNow()).toEqual({ front: { type: 'custom', endedTime: 5 }, garage: NO_RULE })
  })

  it('asks once about a door the list names twice', async () => {
    const h = setup({ doors: ['front', 'front', 'garage'] })
    h.details.start()
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'front', 'garage'])
  })

  it('merges the scopes asked for during a round into one more round', async () => {
    const h = setup({ doors: ['front', 'garage', 'office'] })
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    h.details.request('a relay changed', { doorIds: ['garage'], emergency: false })
    h.details.request('a relay changed', { doorIds: ['office', 'garage'], emergency: false })
    h.details.request('a door action was answered', { doorIds: ['garage'], emergency: true })
    release()
    await h.settle()
    // The first (full) round, then one round with the union: not three.
    expect(h.requests).toEqual([
      'emergency',
      'front',
      'garage',
      'office',
      'emergency',
      'garage',
      'office',
    ])
    expect(h.mostAtOnce).toBe(1)
  })

  it('lets a full request win over any scoped one waiting with it', async () => {
    const h = setup({ doors: ['front', 'garage', 'office'] })
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    h.details.request('a relay changed', { doorIds: ['garage'], emergency: false })
    h.details.request('the door list changed')
    h.details.request('a relay changed', { doorIds: ['office'], emergency: false })
    release()
    await h.settle()
    expect(h.requests.slice(4)).toEqual(['emergency', 'front', 'garage', 'office'])
  })

  it('merges scopes as a union, with "all" winning', () => {
    const garage = { doorIds: ['garage'], emergency: false }
    expect(mergeDetailsScopes(null, garage)).toEqual(garage)
    expect(mergeDetailsScopes(null, 'all')).toBe('all')
    expect(mergeDetailsScopes('all', garage)).toBe('all')
    expect(mergeDetailsScopes(garage, 'all')).toBe('all')
    expect(mergeDetailsScopes(garage, { doorIds: ['front', 'garage'], emergency: true })).toEqual({
      doorIds: ['garage', 'front'],
      emergency: true,
    })
    expect(mergeDetailsScopes(garage, { doorIds: [], emergency: false })).toEqual(garage)
  })

  it('does not postpone the timed full round, however often a scoped one runs', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.requests.length = 0
    // A busy door: a scoped round every 10 s.
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      h.details.request('a relay changed', { doorIds: ['front'], emergency: false })
      await h.settle()
    }
    expect(h.requests).toEqual(['front', 'front'])
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    // 30 s after the last *full* round, not after the last scoped one.
    await vi.advanceTimersByTimeAsync(1)
    expect(h.requests.slice(2)).toEqual(['emergency', 'front', 'garage'])
  })

  it('a failed scoped read is that door unknown, and says nothing about "the rules"', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setRule('front', accessError('not-found'))
    h.details.request('a relay changed', { doorIds: ['front'], emergency: false })
    await h.settle()
    expect(h.rulesNow()).toEqual({ garage: NO_RULE })
    // The transition lines are about a whole round's worth of rules: one door does not flip them.
    expect(h.logged.filter((line) => line.includes('cannot be'))).toEqual([])
    h.setRule('front', NO_RULE)
    h.details.request('a relay changed', { doorIds: ['garage'], emergency: false })
    await h.settle()
    expect(h.logged.filter((line) => line.includes('can be read again'))).toEqual([])
  })
})

describe('failures (unknown, nothing more)', () => {
  it('a failed rule read leaves that door unknown and the others as read', async () => {
    const h = setup()
    h.setRule('front', { type: 'custom', endedTime: 5 })
    h.details.start()
    await h.settle()
    h.setRule('front', accessError('not-found'))
    h.setRule('garage', { type: 'keep_unlock', endedTime: 9 })
    h.details.request('test')
    await h.settle()
    // `front` is not in the map at all: unknown, not "no rule".
    expect(h.rulesNow()).toEqual({ garage: { type: 'keep_unlock', endedTime: 9 } })
    expect(h.details.emergency).toEqual(NORMAL)
  })

  it('a failed emergency read is null, and the rules are still read when the console answered', async () => {
    const h = setup()
    h.setEmergency(accessError('not-found'))
    h.details.start()
    await h.settle()
    expect(h.details.emergency).toBeNull()
    expect(h.requests).toEqual(['emergency', 'front', 'garage'])
    expect(h.rulesNow()).toEqual({ front: NO_RULE, garage: NO_RULE })
  })

  it('an older console (neither endpoint) is just "unknown", at the round cadence and no faster', async () => {
    const h = setup()
    h.setEmergency(accessError('not-found', 'CODE_RESOURCE_NOT_FOUND'))
    h.setRule('front', accessError('not-found', 'CODE_RESOURCE_NOT_FOUND'))
    h.setRule('garage', accessError('not-found', 'CODE_RESOURCE_NOT_FOUND'))
    h.details.start()
    await h.settle()
    expect(h.details.emergency).toBeNull()
    expect(h.rulesNow()).toEqual({})
    expect(h.requests).toHaveLength(3)
    // No retry of its own: ten intervals are ten more rounds, three requests each.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10)
    expect(h.requests).toHaveLength(33)
    expect(h.mostAtOnce).toBe(1)
    // Two lines for the whole time, not one per failed request.
    expect(h.logged.filter((line) => line.includes('cannot be read'))).toHaveLength(2)
  })

  it.each(['timeout', 'network', 'auth', 'pin', 'disabled', 'server', 'rate-limit'] as const)(
    'ends the round at a %s failure instead of asking every door',
    async (kind) => {
      const h = setup({ doors: ['a', 'b', 'c', 'd'] })
      h.details.start()
      await h.settle()
      expect(h.rulesNow()).toEqual({ a: NO_RULE, b: NO_RULE, c: NO_RULE, d: NO_RULE })
      h.setRule('b', accessError(kind))
      h.details.request('test')
      await h.settle()
      // `a` was read, `b` failed, `c` and `d` were not asked and are unknown too.
      expect(h.requests.slice(5)).toEqual(['emergency', 'a', 'b'])
      expect(h.rulesNow()).toEqual({ a: NO_RULE })
    },
  )

  it('ends the round at once when the emergency read finds the endpoint dead', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.setEmergency(accessError('timeout'))
    h.details.request('test')
    await h.settle()
    expect(h.requests.slice(3)).toEqual(['emergency'])
    expect(h.details.emergency).toBeNull()
    expect(h.rulesNow()).toEqual({})
  })

  it('classifies what ends a round', () => {
    for (const kind of ['forbidden', 'not-found', 'bad-request', 'invalid-response'] as const) {
      expect(detailsReadEndsRound(accessError(kind)), kind).toBe(false)
    }
    for (const kind of ['timeout', 'network', 'auth', 'pin', 'disabled', 'server'] as const) {
      expect(detailsReadEndsRound(accessError(kind)), kind).toBe(true)
    }
    // A console that refuses the whole API has a door-level kind and is not door-level.
    expect(
      detailsReadEndsRound(accessError('forbidden', 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED')),
    ).toBe(true)
    // Anything that is not an Access answer at all (an address that does not resolve).
    expect(detailsReadEndsRound(new Error('boom'))).toBe(true)
    expect(detailsReadEndsRound(undefined)).toBe(true)
  })

  it('treats a reader that throws like one that rejects', async () => {
    const h = setup()
    h.readEmergency.mockImplementationOnce(() => {
      throw new Error('the address does not resolve')
    })
    h.details.start()
    await h.settle()
    expect(h.details.emergency).toBeNull()
    expect(h.rulesNow()).toEqual({})
    // And the cadence goes on.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.details.emergency).toEqual(NORMAL)
    expect(h.rulesNow()).toEqual({ front: NO_RULE, garage: NO_RULE })
  })

  it('recovers by itself at the next round', async () => {
    const h = setup()
    h.setEmergency(accessError('server'))
    h.details.start()
    await h.settle()
    expect(h.details.emergency).toBeNull()
    h.setEmergency({ lockdown: false, evacuation: true })
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.details.emergency).toEqual({ lockdown: false, evacuation: true })
  })

  it('logs when reading stops and starts working, never once per read', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    // Six rounds that worked: nothing to say.
    expect(h.logged).toEqual([])
    h.setEmergency(accessError('forbidden'))
    h.setRule('front', accessError('forbidden'))
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    expect(h.logged).toEqual([
      expect.stringContaining('the emergency status cannot be read (forbidden)'),
      expect.stringContaining('the lock rule of 1 of 2 door(s) cannot be read (forbidden)'),
    ])
    h.setEmergency(NORMAL)
    h.setRule('front', NO_RULE)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    expect(h.logged.slice(2)).toEqual([
      'door details: the emergency status can be read again',
      'door details: the lock rules can be read again',
    ])
  })

  it('logs no door id, URL or message of the failure: the kind only', async () => {
    const h = setup({ doors: ['d00e0001-secret-looking-id'] })
    h.setRule(
      'd00e0001-secret-looking-id',
      new AccessApiError('GET https://udm.local:12445/x failed for d00e0001', { kind: 'server' }),
    )
    h.details.start()
    await h.settle()
    expect(h.logged.join('\n')).not.toContain('d00e0001')
    expect(h.logged.join('\n')).not.toContain('https://')
  })
})

describe('stop and forget', () => {
  it('stop cancels the timer and forgets what was read, without calling onChange', async () => {
    const h = setup()
    h.setRule('front', { type: 'custom', endedTime: 5 })
    h.details.start()
    await h.settle()
    const changes = h.changes
    h.details.stop()
    expect(h.details.running).toBe(false)
    expect(h.details.emergency).toBeNull()
    expect(h.rulesNow()).toEqual({})
    expect(h.changes).toBe(changes)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the answers of a round that was running when it stopped, and asks nothing more', async () => {
    const h = setup()
    h.setEmergency({ lockdown: true, evacuation: false })
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    h.details.stop()
    release()
    await h.settle()
    // The emergency read was already out; its answer is not applied and no door is asked.
    expect(h.requests).toEqual(['emergency'])
    expect(h.details.emergency).toBeNull()
    expect(h.changes).toBe(0)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(h.requests).toEqual(['emergency'])
  })

  it('a restart begins a fresh round and ignores the old one', async () => {
    const h = setup()
    const release = h.holdRequests()
    h.details.start()
    await h.settle()
    h.details.stop()
    release()
    h.details.start()
    await h.settle()
    expect(h.requests).toEqual(['emergency', 'emergency', 'front', 'garage'])
    expect(h.rulesNow()).toEqual({ front: NO_RULE, garage: NO_RULE })
    // One cadence, not two.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(3)
  })

  it('forget drops the values and keeps the cadence', async () => {
    const h = setup()
    h.details.start()
    await h.settle()
    h.details.forget()
    expect(h.details.running).toBe(true)
    expect(h.details.emergency).toBeNull()
    expect(h.rulesNow()).toEqual({})
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.rulesNow()).toEqual({ front: NO_RULE, garage: NO_RULE })
  })

  it('is idempotent to stop', () => {
    const h = setup()
    h.details.stop()
    h.details.stop()
    expect(h.details.running).toBe(false)
  })
})
