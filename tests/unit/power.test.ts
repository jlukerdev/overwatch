// P6.2: the display-sleep blocker (NFR-8) and the wake / network-change recovery triggers (NFR-7)
// in src/main/power.ts.
//
// Everything is a fake: the blocker records its ids, the power monitor is an emitter the test fires,
// the network interfaces are whatever the test says they are, and the clock and timers are vitest's
// fake ones (injected explicitly, so nothing real is scheduled). The addresses are documentation
// ranges (RFC 5737 / RFC 3849): no real network appears here.
import { EventEmitter } from 'node:events'
import type { RecoverReason } from '@shared/ipc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NETWORK_POLL_MS,
  RECOVER_COALESCE_MS,
  createPower,
  networkFingerprint,
  type NetworkInterfacesReader,
  type PowerMonitorLike,
  type PowerOptions,
} from '../../src/main/power'

type Interfaces = ReturnType<NetworkInterfacesReader>

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as const
const v6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal }) as const

const LOOPBACK: Interfaces = { lo0: [v4('127.0.0.1', true), v6('::1', true)] }
const HOME: Interfaces = { ...LOOPBACK, en0: [v4('192.0.2.20'), v6('2001:db8::20')] }
const OFFICE: Interfaces = { ...LOOPBACK, en0: [v4('198.51.100.7')] }

function fakeBlocker() {
  let next = 1
  const started = new Set<number>()
  return {
    started,
    start: vi.fn<(type: 'prevent-display-sleep') => number>(() => {
      const id = next++
      started.add(id)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.delete(id)
    }),
    isStarted: (id: number) => started.has(id),
  }
}

function setup(over: Partial<PowerOptions> = {}, initial: Interfaces = HOME) {
  let interfaces = initial
  const blocker = fakeBlocker()
  const emitter = new EventEmitter()
  const monitor: PowerMonitorLike = {
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
  }
  const recovers: RecoverReason[] = []
  const logged: string[] = []
  const power = createPower({
    blocker,
    monitor,
    recover: (reason) => {
      recovers.push(reason)
    },
    networkInterfaces: () => interfaces,
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>)
      },
    },
    log: (line) => {
      logged.push(line)
    },
    ...over,
  })
  return {
    power,
    blocker,
    emitter,
    recovers,
    logged,
    setInterfaces(next: Interfaces) {
      interfaces = next
    },
    /** One network poll's worth of time. */
    poll: (count = 1) => vi.advanceTimersByTimeAsync(NETWORK_POLL_MS * count),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('networkFingerprint', () => {
  it('keeps non-internal addresses only, sorted, so the order of interfaces does not matter', () => {
    const a = networkFingerprint({ ...LOOPBACK, en0: [v4('192.0.2.20')], en1: [v4('192.0.2.30')] })
    const b = networkFingerprint({ en1: [v4('192.0.2.30')], en0: [v4('192.0.2.20')], ...LOOPBACK })
    expect(a).toBe(b)
    expect(a).toBe('IPv4/192.0.2.20,IPv4/192.0.2.30')
  })

  it('is empty when only loopback and link-local addresses are left', () => {
    expect(
      networkFingerprint({
        ...LOOPBACK,
        en0: [v4('169.254.10.2'), v6('fe80::1c2b:3aff:fe4d:5e6f')],
        awdl0: [v6('FE80::AB')],
        en1: undefined,
      }),
    ).toBe('')
  })

  it('names an interface with IPv6, never its IPv6 address', () => {
    expect(networkFingerprint(HOME)).toBe('IPv4/192.0.2.20,IPv6@en0')
    // Two IPv6 addresses on one interface (stable + temporary) are one entry.
    expect(
      networkFingerprint({ en0: [v6('2001:db8::20'), v6('2001:db8::abcd'), v6('fe80::1')] }),
    ).toBe('IPv6@en0')
  })

  it('reads the numeric family some Node versions report', () => {
    const numeric = { en0: [{ address: '192.0.2.20', family: 4, internal: false }] }
    expect(networkFingerprint(numeric as unknown as Interfaces)).toBe('IPv4/192.0.2.20')
  })
})

describe('the display-sleep blocker (NFR-8)', () => {
  it('holds exactly one blocker however often a View is reported on screen', () => {
    const h = setup()
    expect(h.power.setViewVisible(true)).toEqual({ preventingDisplaySleep: true })
    expect(h.power.setViewVisible(true)).toEqual({ preventingDisplaySleep: true })
    expect(h.blocker.start).toHaveBeenCalledTimes(1)
    expect(h.blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(h.power.preventingDisplaySleep).toBe(true)
  })

  it('releases it when no View is on screen, and false twice is harmless', () => {
    const h = setup()
    h.power.setViewVisible(true)
    expect(h.power.setViewVisible(false)).toEqual({ preventingDisplaySleep: false })
    expect(h.power.setViewVisible(false)).toEqual({ preventingDisplaySleep: false })
    expect(h.blocker.stop).toHaveBeenCalledTimes(1)
    expect(h.blocker.started.size).toBe(0)
    // On again: a new blocker.
    h.power.setViewVisible(true)
    expect(h.blocker.start).toHaveBeenCalledTimes(2)
    expect(h.blocker.started.size).toBe(1)
  })

  it('release() drops it whatever the renderer said last, and is idempotent', () => {
    const h = setup()
    h.power.setViewVisible(true)
    h.power.release('the renderer process is gone')
    h.power.release('the window closed')
    expect(h.blocker.stop).toHaveBeenCalledTimes(1)
    expect(h.power.preventingDisplaySleep).toBe(false)
    expect(h.logged.filter((line) => line.includes('may sleep again'))).toHaveLength(1)
  })

  it('starts a new one if the old one was stopped behind its back', () => {
    const h = setup()
    h.power.setViewVisible(true)
    h.blocker.started.clear()
    expect(h.power.preventingDisplaySleep).toBe(false)
    expect(h.power.setViewVisible(true)).toEqual({ preventingDisplaySleep: true })
    expect(h.blocker.start).toHaveBeenCalledTimes(2)
  })

  it('answers false when the blocker cannot be started, rather than throwing', () => {
    const h = setup()
    h.blocker.start.mockImplementationOnce(() => {
      throw new Error('no')
    })
    expect(h.power.setViewVisible(true)).toEqual({ preventingDisplaySleep: false })
  })

  it('dispose() releases it and nothing holds one afterwards', () => {
    const h = setup()
    h.power.setViewVisible(true)
    h.power.dispose()
    expect(h.blocker.started.size).toBe(0)
    expect(h.power.setViewVisible(true)).toEqual({ preventingDisplaySleep: false })
    expect(h.blocker.start).toHaveBeenCalledTimes(1)
  })
})

describe('resume (NFR-7)', () => {
  it('recovers on resume and only logs a suspend', () => {
    const h = setup()
    h.emitter.emit('suspend')
    expect(h.recovers).toEqual([])
    h.emitter.emit('resume')
    expect(h.recovers).toEqual(['resume'])
    expect(h.logged).toContain('the machine is going to sleep')
  })

  it('stops listening on dispose', () => {
    const h = setup()
    h.power.dispose()
    h.emitter.emit('resume')
    expect(h.recovers).toEqual([])
    expect(h.emitter.listenerCount('resume')).toBe(0)
    expect(h.emitter.listenerCount('suspend')).toBe(0)
  })

  it('survives a recover callback that throws', () => {
    const h = setup({
      recover: () => {
        throw new Error('a bug')
      },
    })
    expect(() => h.emitter.emit('resume')).not.toThrow()
  })
})

describe('network changes (NFR-7)', () => {
  it('takes the first poll as the baseline: no recover at startup', async () => {
    const h = setup()
    await h.poll(5)
    expect(h.recovers).toEqual([])
  })

  it('recovers once a new set of addresses has read the same on one more poll', async () => {
    const h = setup()
    h.setInterfaces(OFFICE)
    await h.poll()
    expect(h.recovers).toEqual([])
    await h.poll()
    expect(h.recovers).toEqual(['network'])
    // Settled: nothing more while it stays the same.
    await h.poll(5)
    expect(h.recovers).toEqual(['network'])
  })

  it('ignores an IPv6 privacy address rotating', async () => {
    const h = setup()
    h.setInterfaces({ ...LOOPBACK, en0: [v4('192.0.2.20'), v6('2001:db8::7777')] })
    await h.poll(4)
    h.setInterfaces({
      ...LOOPBACK,
      en0: [v4('192.0.2.20'), v6('2001:db8::7777'), v6('2001:db8::8888')],
    })
    await h.poll(4)
    expect(h.recovers).toEqual([])
  })

  it('still counts an IPv6-only network appearing and going away', async () => {
    const h = setup({}, LOOPBACK)
    h.setInterfaces({ ...LOOPBACK, en0: [v6('2001:db8::20')] })
    await h.poll(2)
    expect(h.recovers).toEqual(['network'])
    // A second interface that has IPv6 only is a change too.
    h.setInterfaces({ ...LOOPBACK, en0: [v6('2001:db8::20')], en5: [v6('2001:db8:1::5')] })
    await h.poll(2)
    expect(h.recovers).toEqual(['network', 'network'])
  })

  it('ignores a change that flaps back within a poll', async () => {
    const h = setup()
    h.setInterfaces(OFFICE)
    await h.poll()
    h.setInterfaces(HOME)
    await h.poll(5)
    expect(h.recovers).toEqual([])
  })

  it('waits for a set that keeps changing to settle', async () => {
    const h = setup()
    h.setInterfaces(OFFICE)
    await h.poll()
    h.setInterfaces({ ...OFFICE, en1: [v4('198.51.100.8')] })
    await h.poll()
    expect(h.recovers).toEqual([])
    await h.poll()
    expect(h.recovers).toEqual(['network'])
  })

  it('does nothing when the network goes away, and recovers when it comes back', async () => {
    const h = setup()
    h.setInterfaces(LOOPBACK)
    await h.poll(4)
    expect(h.recovers).toEqual([])
    expect(h.logged.some((line) => line.includes('went away'))).toBe(true)
    // Back to the very same addresses: still a change, because offline was remembered.
    h.setInterfaces(HOME)
    await h.poll(2)
    expect(h.recovers).toEqual(['network'])
  })

  it('starting offline: the first addresses to appear are a change', async () => {
    const h = setup({}, LOOPBACK)
    h.setInterfaces(HOME)
    await h.poll(2)
    expect(h.recovers).toEqual(['network'])
  })

  it('never logs an address', async () => {
    const h = setup()
    h.setInterfaces(OFFICE)
    await h.poll(2)
    h.setInterfaces(LOOPBACK)
    await h.poll(2)
    const said = h.logged.join('\n')
    for (const address of ['192.0.2.20', '2001:db8::20', '198.51.100.7']) {
      expect(said).not.toContain(address)
    }
  })

  it('keeps polling through a read that throws', async () => {
    let fail = false
    let interfaces: Interfaces = HOME
    const h = setup({
      networkInterfaces: () => {
        if (fail) throw new Error('no')
        return interfaces
      },
    })
    fail = true
    await h.poll(2)
    fail = false
    interfaces = OFFICE
    await h.poll(2)
    expect(h.recovers).toEqual(['network'])
  })

  it('stops polling on dispose', async () => {
    const reads = vi.fn(() => HOME)
    const h = setup({ networkInterfaces: reads })
    expect(reads).toHaveBeenCalledTimes(1)
    h.power.dispose()
    await h.poll(5)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a poll interval of 0 turns the network trigger off', async () => {
    const reads = vi.fn(() => HOME)
    setup({ networkInterfaces: reads, networkPollMs: 0 })
    await vi.advanceTimersByTimeAsync(NETWORK_POLL_MS * 5)
    expect(reads).not.toHaveBeenCalled()
  })
})

describe('coalescing', () => {
  it('defers a network change right after a wake to 5 s after it, and runs it then', async () => {
    const h = setup()
    h.emitter.emit('resume')
    h.setInterfaces(OFFICE)
    await h.poll(2)
    // Settled at 6 s: past the window, so it runs at once.
    expect(h.recovers).toEqual(['resume', 'network'])
  })

  it('a second trigger inside the window runs once, at its end', async () => {
    const h = setup({ networkPollMs: 0 })
    h.emitter.emit('resume')
    await vi.advanceTimersByTimeAsync(1_000)
    h.emitter.emit('resume')
    h.emitter.emit('resume')
    expect(h.recovers).toEqual(['resume'])
    await vi.advanceTimersByTimeAsync(RECOVER_COALESCE_MS - 1_000 - 1)
    expect(h.recovers).toEqual(['resume'])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.recovers).toEqual(['resume', 'resume'])
    // And the window starts again from that one.
    h.emitter.emit('resume')
    expect(h.recovers).toEqual(['resume', 'resume'])
  })

  it('the deferred recover carries the latest reason', async () => {
    const h = setup({ coalesceMs: 20_000 })
    h.emitter.emit('resume')
    // Deferred as `resume`, then overtaken by the network change before the window ends.
    h.emitter.emit('resume')
    h.setInterfaces(OFFICE)
    await h.poll(2)
    expect(h.recovers).toEqual(['resume'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.recovers).toEqual(['resume', 'network'])
  })

  it('a clock that steps backwards defers by at most the window', async () => {
    let clock = 100_000
    const h = setup({ networkPollMs: 0, now: () => clock })
    h.emitter.emit('resume')
    clock -= 60_000
    h.emitter.emit('resume')
    expect(h.recovers).toEqual(['resume'])
    await vi.advanceTimersByTimeAsync(RECOVER_COALESCE_MS)
    expect(h.recovers).toEqual(['resume', 'resume'])
  })

  it('uses a monotonic clock by default, unmoved by a wall-clock step', () => {
    const emitter = new EventEmitter()
    const recovers: RecoverReason[] = []
    const power = createPower({
      blocker: fakeBlocker(),
      monitor: {
        on: (event, listener) => emitter.on(event, listener),
        removeListener: (event, listener) => emitter.removeListener(event, listener),
      },
      recover: (reason) => {
        recovers.push(reason)
      },
      networkPollMs: 0,
    })
    emitter.emit('resume')
    // Fake timers move performance.now() as time passes; a wall-clock jump alone does not.
    vi.setSystemTime(Date.now() + 3_600_000)
    emitter.emit('resume')
    expect(recovers).toEqual(['resume'])
    power.dispose()
  })

  it('a deferred recover does not run after dispose', async () => {
    const h = setup({ networkPollMs: 0 })
    h.emitter.emit('resume')
    h.emitter.emit('resume')
    h.power.dispose()
    await vi.advanceTimersByTimeAsync(RECOVER_COALESCE_MS * 2)
    expect(h.recovers).toEqual(['resume'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
