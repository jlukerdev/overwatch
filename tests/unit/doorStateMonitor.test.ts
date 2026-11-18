// DOOR-6 (P5.5): the door-state monitor (src/main/access/doorStateMonitor.ts).
//
// Everything runs on vitest's fake clock (which the monitor's default `Date.now` and `setTimeout`
// read) against a hand-driven `GET /doors` and a fake notifications socket, so each cadence in the
// module's header is asserted as a number of reads at a point in time, with no socket and no HTTP.
import type { Door, DoorStates } from '@shared/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessApiError } from '../../src/main/access/client'
import {
  BURST_AFTER_TRIGGER_MS,
  BURST_POLL_MS,
  BURST_UNLOCKED_MAX_MS,
  FAILURE_BACKOFF_MAX_MS,
  NO_SOCKET_FAST_POLL_MS,
  POLL_WITHOUT_SOCKET_MS,
  POLL_WITH_SOCKET_MS,
  TRIGGER_COALESCE_MS,
  createDoorStateMonitor,
  type DoorMonitorHaltReason,
  type DoorNotificationHandlers,
  type DoorReadResult,
} from '../../src/main/access/doorStateMonitor'

function door(id: string, relay: Door['relay'] = 'lock', position: Door['position'] = null): Door {
  return {
    id,
    name: id,
    fullName: id,
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay,
    position,
  }
}

const LOCKED: DoorStates[string] = { relay: 'lock', position: null }
const UNLOCKED: DoorStates[string] = { relay: 'unlock', position: null }

interface SetupOptions {
  readonly linked?: readonly string[]
  /** `false`: the opener answers `null`. */
  readonly socket?: boolean
}

function setup(options: SetupOptions = {}) {
  let doors: readonly Door[] = [door('front'), door('garage'), door('unlinked', 'unlock')]
  let failure: unknown = null
  let linked = new Set(options.linked ?? ['front', 'garage'])
  const readDoors = vi.fn(() =>
    failure === null ? Promise.resolve(doors) : Promise.reject(failure as Error),
  )
  const emitted: DoorStates[] = []
  const results: DoorReadResult[] = []
  const logged: string[] = []
  const halts: DoorMonitorHaltReason[] = []
  const sockets: { handlers: DoorNotificationHandlers; stops: number }[] = []
  const openNotifications = vi.fn((handlers: DoorNotificationHandlers) => {
    if (options.socket === false) return null
    const socket = { handlers, stops: 0 }
    sockets.push(socket)
    return {
      stop: () => {
        socket.stops += 1
      },
    }
  })
  const monitor = createDoorStateMonitor({
    readDoors,
    openNotifications,
    linkedDoorIds: () => linked,
    onStates: (states) => {
      emitted.push(states)
    },
    onReadResult: (result) => {
      results.push(result)
    },
    onHalt: (reason) => {
      halts.push(reason)
    },
    log: (line) => {
      logged.push(line)
    },
  })
  const socket = () => {
    const last = sockets.at(-1)
    if (last === undefined) throw new Error('no socket has been opened')
    return last
  }
  return {
    monitor,
    readDoors,
    openNotifications,
    emitted,
    results,
    logged,
    halts,
    sockets,
    socket,
    setDoors(next: readonly Door[]) {
      doors = next
    },
    setFailure(next: unknown) {
      failure = next
    },
    setLinked(next: readonly string[]) {
      linked = new Set(next)
    },
    /** Far enough past the last read that a trigger reads at once instead of being coalesced. */
    async settle() {
      await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    },
    /** Starts, lets the first read answer, and (by default) opens the socket and settles again. */
    async started(open = true) {
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      if (open && options.socket !== false) {
        socket().handlers.onStateChange('open')
        // The open is a trigger: its read, then its 3 s burst, are let through.
        await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS + BURST_AFTER_TRIGGER_MS)
        await quiet()
      }
      readDoors.mockClear()
    },
  }

  /** Advances to just after a baseline read, so the next one is a full baseline away. */
  async function quiet(): Promise<void> {
    const before = readDoors.mock.calls.length
    while (readDoors.mock.calls.length === before) await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(0)
  }
}

const frame = { event: 'access.data.device.remote_unlock', data: { unique_id: 'front' } }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('start and the baseline poll', () => {
  it('reads at once on start, opens the socket once that read worked, and reports only linked doors', async () => {
    const h = setup()
    h.monitor.start()
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    // Not yet: the token and the certificate are unproven until a read has worked.
    expect(h.openNotifications).not.toHaveBeenCalled()
    expect(h.monitor.running).toBe(true)
    expect(h.monitor.states).toEqual({})
    await vi.advanceTimersByTimeAsync(0)
    expect(h.openNotifications).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 3)
    expect(h.openNotifications).toHaveBeenCalledTimes(1)
    // `unlinked` is in the console's answer and not in the map.
    expect(h.emitted).toEqual([{ front: LOCKED, garage: LOCKED }])
    expect(h.monitor.states).toEqual({ front: LOCKED, garage: LOCKED })
    expect(h.results.every((result) => result.ok)).toBe(true)
  })

  it('opens no socket while the first reads fail, and opens it once one works', async () => {
    const h = setup()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.openNotifications).not.toHaveBeenCalled()
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.openNotifications).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second start reads nothing and opens nothing', async () => {
    const h = setup()
    h.monitor.start()
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.openNotifications).toHaveBeenCalledTimes(1)
  })

  it('polls every 2 s while the socket is not open', async () => {
    const h = setup()
    await h.started(false)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 4)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
  })

  it('polls every 5 s while the socket is open', async () => {
    const h = setup()
    await h.started()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
  })

  it('tightens to 2 s as soon as the socket stops being open', async () => {
    const h = setup()
    await h.started()
    h.socket().handlers.onStateChange('reconnecting')
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('still polls at 2 s when the socket cannot be opened at all', async () => {
    const h = setup({ socket: false })
    await h.started()
    expect(h.sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(3)
  })

  it('still polls when the opener throws', async () => {
    const h = setup()
    h.openNotifications.mockImplementationOnce(() => {
      throw new Error('no socket for you')
    })
    await h.started(false)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('emits only when something changed, and carries the position through', async () => {
    const h = setup()
    await h.started(false)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 3)
    expect(h.emitted).toHaveLength(1)
    h.setDoors([door('front', 'lock', 'open'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.emitted).toHaveLength(2)
    expect(h.emitted.at(-1)).toEqual({ front: { relay: 'lock', position: 'open' }, garage: LOCKED })
  })

  it('leaves a linked door the console did not list out of the map', async () => {
    const h = setup({ linked: ['front', 'gone'] })
    await h.started(false)
    expect(h.monitor.states).toEqual({ front: LOCKED })
  })

  it('reads the links at every read', async () => {
    const h = setup()
    await h.started(false)
    h.setLinked(['garage'])
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.emitted.at(-1)).toEqual({ garage: LOCKED })
  })
})

describe('triggers', () => {
  it('reads at once on a notification frame, whatever its event', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    h.socket().handlers.onNotification({ event: 'something.undocumented' })
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('coalesces frames that arrive together into one read plus one follow-up', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    for (let i = 0; i < 100; i += 1) h.socket().handlers.onNotification(frame)
    // One read at once (in flight), and exactly one more for everything that arrived during it.
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('bounds the reads a sustained flood can cause to one per 250 ms', async () => {
    const h = setup()
    await h.started()
    // 100 frames, one every 10 ms: a full second of them.
    for (let i = 0; i < 100; i += 1) {
      h.socket().handlers.onNotification(frame)
      await vi.advanceTimersByTimeAsync(10)
    }
    const reads = h.readDoors.mock.calls.length
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(reads).toBeLessThanOrEqual(1_000 / TRIGGER_COALESCE_MS + 1)
  })

  it('reads when the socket opens: something may have been missed while it was down', async () => {
    const h = setup()
    await h.started(false)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    h.socket().handlers.onStateChange('connecting')
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    h.socket().handlers.onStateChange('open')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    // A repeated `open` is not a transition.
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    h.socket().handlers.onStateChange('open')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('reads on poke, and not at all while stopped', async () => {
    const h = setup()
    h.monitor.poke('before start')
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    await h.started()
    await h.settle()
    h.monitor.poke('an unlock was answered')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('poke drops a door that is no longer linked without waiting for the read', async () => {
    const h = setup()
    await h.started()
    h.setLinked(['front'])
    h.monitor.poke('the door links were saved')
    expect(h.emitted.at(-1)).toEqual({ front: LOCKED })
  })

  it('follows a read in flight with exactly one more, however many triggers arrive', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    let answer: (doors: readonly Door[]) => void = () => undefined
    h.readDoors.mockImplementationOnce(
      () =>
        new Promise<readonly Door[]>((resolve) => {
          answer = resolve
        }),
    )
    h.monitor.poke('first')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    h.monitor.poke('second')
    h.socket().handlers.onNotification(frame)
    h.monitor.poke('third')
    // Nothing overlaps the read in flight.
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    answer([door('front'), door('garage')])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
    // …and that was the only follow-up: the next read is a burst poll away.
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })
})

describe('the burst', () => {
  it('polls every second for 3 s after a trigger with nothing unlocked, then falls back', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    h.monitor.poke('test')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BURST_AFTER_TRIGGER_MS)
    // The trigger's read, then one per second while the burst lasts.
    expect(h.readDoors).toHaveBeenCalledTimes(1 + BURST_AFTER_TRIGGER_MS / BURST_POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
  })

  it('polls every second while a linked door is unlocked, and returns to the baseline after the relock', async () => {
    const h = setup()
    await h.started()
    // Seen by a plain baseline poll: an unlock made elsewhere, with no trigger at all.
    h.setDoors([door('front', 'unlock'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.emitted.at(-1)).toEqual({ front: UNLOCKED, garage: LOCKED })
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS * 6)
    expect(h.readDoors).toHaveBeenCalledTimes(6)
    h.setDoors([door('front'), door('garage')])
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS)
    expect(h.emitted.at(-1)).toEqual({ front: LOCKED, garage: LOCKED })
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('is not kept alive by an unlocked door that is not linked', async () => {
    const h = setup()
    await h.started()
    // `unlinked` reads `unlock` throughout.
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 2)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('gives up after 30 s of continuous unlock, until the door relocks', async () => {
    const h = setup()
    await h.started()
    h.setDoors([door('front', 'unlock'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(BURST_UNLOCKED_MAX_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(BURST_UNLOCKED_MAX_MS / BURST_POLL_MS)
    // Held open: back to the baseline although it still reads `unlock`.
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 4)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
    // A relock and a new unlock is a new episode.
    h.setDoors([door('front'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    h.setDoors([door('front', 'unlock'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(3)
  })
})

describe('failures', () => {
  const network = (): AccessApiError =>
    new AccessApiError('The console did not answer.', { kind: 'network' })

  it('keeps the states after one failed read and clears them after the second', async () => {
    const h = setup()
    await h.started(false)
    h.setFailure(network())
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.monitor.states).toEqual({ front: LOCKED, garage: LOCKED })
    expect(h.emitted).toHaveLength(1)
    expect(h.results.at(-1)).toMatchObject({ ok: false })
    // The second failure, one backoff later.
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 2)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
    expect(h.emitted.at(-1)).toEqual({})
    expect(h.monitor.states).toEqual({})
    expect(h.monitor.running).toBe(true)
    // Further failures emit nothing more.
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.emitted).toHaveLength(2)
  })

  it('doubles the interval per failure up to the cap, and a success resets it', async () => {
    const h = setup()
    await h.started(false)
    h.setFailure(network())
    const gaps: number[] = []
    let last = Date.now()
    h.readDoors.mockImplementation(() => {
      gaps.push(Date.now() - last)
      last = Date.now()
      return Promise.reject(network())
    })
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS + 4_000 + 8_000 + 16_000 + 30_000 * 2)
    expect(gaps).toEqual([POLL_WITHOUT_SOCKET_MS, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(Math.max(...gaps)).toBe(FAILURE_BACKOFF_MAX_MS)

    h.readDoors.mockImplementation(() => Promise.resolve([door('front')]))
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.monitor.states).toEqual({ front: LOCKED })
    // Back to a baseline (the 5 s one by now: the socket has been down for over a minute).
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('reports each failure with its consecutive count, and whether it halts', async () => {
    const h = setup()
    await h.started(false)
    h.results.length = 0
    h.setFailure(network())
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 3)
    expect(h.results).toMatchObject([
      { ok: false, failures: 1, fatal: false },
      { ok: false, failures: 2, fatal: false },
    ])
    h.setFailure(new AccessApiError('HTTP 401.', { kind: 'auth' }))
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.results.at(-1)).toMatchObject({ ok: false, failures: 3, fatal: true })
    expect(h.halts).toEqual(['auth'])
  })

  it('halts on a console that refuses the whole API, although its kind is forbidden', async () => {
    const h = setup()
    await h.started()
    h.setFailure(
      new AccessApiError('The API is not available after upgrading to Identity Enterprise.', {
        kind: 'forbidden',
        code: 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED',
      }),
    )
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.monitor.running).toBe(false)
    expect(h.halts).toEqual(['api-unavailable'])
    expect(h.results.at(-1)).toMatchObject({ ok: false, fatal: true })
    expect(h.socket().stops).toBe(1)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 4)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('keeps polling through an ordinary forbidden (a door-level refusal)', async () => {
    const h = setup()
    await h.started()
    h.setFailure(new AccessApiError('Refused.', { kind: 'forbidden' }))
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.monitor.running).toBe(true)
    expect(h.halts).toEqual([])
  })

  it('does not let notification frames cut the backoff short, but a poke does', async () => {
    const h = setup()
    await h.started()
    h.setFailure(network())
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i += 1) h.socket().handlers.onNotification(frame)
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    h.monitor.poke('an unlock was answered')
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  for (const kind of ['auth', 'pin', 'disabled'] as const) {
    it(`stops polling and the socket for good on a ${kind} failure, until the next start`, async () => {
      const h = setup()
      await h.started()
      h.setFailure(new AccessApiError('Refused.', { kind }))
      await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
      expect(h.readDoors).toHaveBeenCalledTimes(1)
      expect(h.monitor.running).toBe(false)
      expect(h.socket().stops).toBe(1)
      expect(h.emitted.at(-1)).toEqual({})
      expect(h.results.at(-1)).toMatchObject({ ok: false, failures: 1, fatal: true })
      expect(h.halts).toEqual([kind])
      await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 4)
      h.socket().handlers.onNotification(frame)
      h.monitor.poke('ignored')
      expect(h.readDoors).toHaveBeenCalledTimes(1)

      // Fixed in Settings: a start works again.
      h.setFailure(null)
      h.monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.monitor.running).toBe(true)
      expect(h.monitor.states).toEqual({ front: LOCKED, garage: LOCKED })
      expect(h.sockets).toHaveLength(2)
    })
  }

  it('treats a reader that throws like one that rejects', async () => {
    const h = setup()
    h.readDoors.mockImplementationOnce(() => {
      throw new Error('the address does not resolve')
    })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.results).toEqual([
      { ok: false, error: expect.any(Error) as unknown, failures: 1, fatal: false },
    ])
    expect(h.monitor.running).toBe(true)
  })
})

describe('stop', () => {
  it('cancels the poll, stops the socket and emits {} exactly once', async () => {
    const h = setup()
    await h.started()
    h.monitor.stop()
    h.monitor.stop()
    expect(h.monitor.running).toBe(false)
    expect(h.monitor.states).toEqual({})
    expect(h.socket().stops).toBe(1)
    expect(h.emitted.filter((states) => Object.keys(states).length === 0)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('emits nothing on stop when nothing was known', () => {
    const h = setup()
    h.monitor.start()
    h.monitor.stop()
    expect(h.emitted).toEqual([])
  })

  it('ignores a read that answers after the stop: no emit, no result', async () => {
    const h = setup()
    let answer: (doors: readonly Door[]) => void = () => undefined
    h.readDoors.mockImplementationOnce(
      () =>
        new Promise<readonly Door[]>((resolve) => {
          answer = resolve
        }),
    )
    h.monitor.start()
    h.monitor.stop()
    answer([door('front', 'unlock')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.emitted).toEqual([])
    expect(h.results).toEqual([])
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('ignores the old socket and an old read after a restart', async () => {
    const h = setup()
    await h.started(false)
    const old = h.socket()
    await h.settle()
    let answer: (doors: readonly Door[]) => void = () => undefined
    h.readDoors.mockImplementationOnce(
      () =>
        new Promise<readonly Door[]>((resolve) => {
          answer = resolve
        }),
    )
    h.monitor.poke('a read that will answer late')
    h.monitor.stop()
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets).toHaveLength(2)
    const known = { front: LOCKED, garage: LOCKED }
    expect(h.emitted).toEqual([known, {}, known])
    h.readDoors.mockClear()
    // The first run's answer and its socket's callbacks arrive late.
    answer([door('front', 'unlock')])
    old.handlers.onStateChange('open')
    old.handlers.onNotification(frame)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.emitted).toHaveLength(3)
    expect(h.readDoors).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('never logs a line per read', async () => {
    const h = setup()
    await h.started()
    const before = h.logged.length
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 10)
    expect(h.logged).toHaveLength(before)
  })
})

describe('a socket that stays down', () => {
  const pollingOnly = (h: ReturnType<typeof setup>): number =>
    h.logged.filter((line) => line.includes('polling only') && line.includes('view:device')).length

  it('polls at 2 s for the first minute only, then at the 5 s baseline, and says so once', async () => {
    const h = setup()
    await h.started(false)
    await vi.advanceTimersByTimeAsync(NO_SOCKET_FAST_POLL_MS - POLL_WITHOUT_SOCKET_MS)
    // The first read was at 0, so this is one read every 2 s up to just short of the minute.
    expect(h.readDoors).toHaveBeenCalledTimes(NO_SOCKET_FAST_POLL_MS / POLL_WITHOUT_SOCKET_MS - 1)
    expect(pollingOnly(h)).toBe(0)

    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 6)
    expect(h.readDoors).toHaveBeenCalledTimes(6)
    expect(pollingOnly(h)).toBe(1)
  })

  it('applies to a socket that could not be opened at all', async () => {
    const h = setup({ socket: false })
    await h.started()
    await vi.advanceTimersByTimeAsync(NO_SOCKET_FAST_POLL_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 4)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
    expect(pollingOnly(h)).toBe(1)
  })

  it('starts the minute again each time the socket drops, and says it once per outage', async () => {
    const h = setup()
    await h.started(false)
    await vi.advanceTimersByTimeAsync(NO_SOCKET_FAST_POLL_MS + POLL_WITH_SOCKET_MS)
    expect(pollingOnly(h)).toBe(1)

    // It opens after all, then drops: the fast poll is back for a minute.
    h.socket().handlers.onStateChange('open')
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 4)
    h.socket().handlers.onStateChange('reconnecting')
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 5)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
    expect(pollingOnly(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(NO_SOCKET_FAST_POLL_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(3)
    expect(pollingOnly(h)).toBe(2)
  })

  it('does not blame the socket while it is the reads that fail', async () => {
    const h = setup()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(NO_SOCKET_FAST_POLL_MS * 3)
    expect(pollingOnly(h)).toBe(0)
  })
})
