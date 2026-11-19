// DOOR-6 (P5.5): the door-state monitor (src/main/access/doorStateMonitor.ts).
//
// Everything runs on vitest's fake clock (which the monitor's default `Date.now` and `setTimeout`
// read) against a hand-driven `GET /doors` and a fake notifications socket, so each cadence in the
// module's header is asserted as a number of reads at a point in time, with no socket and no HTTP.
import type { DoorsScreenState } from '@shared/ipc'
import type { Door, DoorStates } from '@shared/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessApiError } from '../../src/main/access/client'
import {
  BURST_AFTER_TRIGGER_MS,
  BURST_POLL_MS,
  BURST_UNLOCKED_MAX_MS,
  DEFAULT_DOOR_MONITOR_INTERVALS,
  DETAILS_POLL_MS,
  FAILURE_BACKOFF_MAX_MS,
  NO_SOCKET_FAST_POLL_MS,
  POLL_WITHOUT_SOCKET_MS,
  POLL_WITH_SOCKET_MS,
  TRIGGER_COALESCE_MS,
  createDoorStateMonitor,
  type DoorMonitorHaltReason,
  type DoorMonitorIntervals,
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
  const sockets: { handlers: DoorNotificationHandlers; stops: number; reconnects: number }[] = []
  const openNotifications = vi.fn((handlers: DoorNotificationHandlers) => {
    if (options.socket === false) return null
    const socket = { handlers, stops: 0, reconnects: 0 }
    sockets.push(socket)
    return {
      stop: () => {
        socket.stops += 1
      },
      reconnectNow: () => {
        socket.reconnects += 1
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

// -------------------------------------------------------------------------------------------------
// P5.6: the Doors screen as a second watcher, and the user-set intervals.

const EMPTY_SCREEN: DoorsScreenState = {
  doors: null,
  stale: false,
  rules: {},
  emergency: null,
  error: null,
}
const NORMAL = { lockdown: false, evacuation: false }
const NO_RULE = { type: '', endedTime: null }

interface ScreenSetupOptions {
  readonly linked?: readonly string[]
  /** Whether the Doors screen is open when the test starts. Default: open. */
  readonly open?: boolean
  readonly intervals?: DoorMonitorIntervals
}

function screenSetup(options: ScreenSetupOptions = {}) {
  let doors: readonly Door[] = [door('front'), door('garage'), door('unlinked')]
  let failure: unknown = null
  let open = options.open ?? true
  let intervals = options.intervals ?? DEFAULT_DOOR_MONITOR_INTERVALS
  let emergency: { lockdown: boolean; evacuation: boolean } | Error = NORMAL
  const rules = new Map<string, { type: string; endedTime: number | null } | Error>()
  const linked = new Set(options.linked ?? ['front'])
  const readDoors = vi.fn(() =>
    failure === null ? Promise.resolve(doors) : Promise.reject(failure as Error),
  )
  const readEmergency = vi.fn(() =>
    emergency instanceof Error ? Promise.reject(emergency) : Promise.resolve(emergency),
  )
  const readLockRule = vi.fn((id: string) => {
    const rule = rules.get(id) ?? NO_RULE
    return rule instanceof Error ? Promise.reject(rule) : Promise.resolve(rule)
  })
  const liveStates: DoorStates[] = []
  const screens: DoorsScreenState[] = []
  const halts: DoorMonitorHaltReason[] = []
  const logged: string[] = []
  const sockets: DoorNotificationHandlers[] = []
  const monitor = createDoorStateMonitor({
    readDoors,
    openNotifications: (handlers) => {
      sockets.push(handlers)
      return { stop: () => undefined }
    },
    linkedDoorIds: () => linked,
    onStates: (states) => {
      liveStates.push(states)
    },
    onHalt: (reason) => {
      halts.push(reason)
    },
    intervals: () => intervals,
    screen: {
      open: () => open,
      readEmergency,
      readLockRule,
      onState: (state) => {
        screens.push(state)
      },
      toError: (error) => ({
        kind: error instanceof AccessApiError && error.kind === 'auth' ? 'auth' : 'network',
        message: error instanceof Error ? error.message : 'unknown',
        endpoint: 'console:12445',
        retryable: false,
      }),
    },
    log: (line) => {
      logged.push(line)
    },
  })
  return {
    monitor,
    readDoors,
    readEmergency,
    readLockRule,
    liveStates,
    screens,
    halts,
    logged,
    sockets,
    lastScreen(): DoorsScreenState {
      const last = screens.at(-1)
      if (last === undefined) throw new Error('no screen state was sent')
      return last
    },
    setDoors(next: readonly Door[]) {
      doors = next
    },
    setFailure(next: unknown) {
      failure = next
    },
    setOpen(next: boolean) {
      open = next
      monitor.screenChanged()
    },
    setIntervals(next: DoorMonitorIntervals) {
      intervals = next
    },
    setEmergency(next: { lockdown: boolean; evacuation: boolean } | Error) {
      emergency = next
    },
    setRule(id: string, next: { type: string; endedTime: number | null } | Error) {
      rules.set(id, next)
    },
    /** Starts, lets the first door read and the first details round answer, opens the socket, and
     *  waits out the trigger burst so the next read is a plain baseline one. */
    async started() {
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      sockets.at(-1)?.onStateChange('open')
      await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS + BURST_AFTER_TRIGGER_MS)
      const before = readDoors.mock.calls.length
      while (readDoors.mock.calls.length === before) await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(0)
      readDoors.mockClear()
      readEmergency.mockClear()
      readLockRule.mockClear()
    },
  }
}

describe('the Doors screen: every door (P5.6)', () => {
  it('reports every door the console lists, with rules and emergency, once they are read', async () => {
    const h = screenSetup()
    h.setRule('garage', { type: 'schedule', endedTime: 1795000000 })
    h.monitor.start()
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.lastScreen()).toEqual({
      doors: [door('front'), door('garage'), door('unlinked')],
      stale: false,
      rules: {
        front: NO_RULE,
        garage: { type: 'schedule', endedTime: 1795000000 },
        unlinked: NO_RULE,
      },
      emergency: NORMAL,
      error: null,
    })
    expect(h.monitor.screen).toEqual(h.lastScreen())
    // The first state had the list and no details yet: unknown is "missing", never a guess.
    expect(h.screens[0]).toEqual({
      doors: [door('front'), door('garage'), door('unlinked')],
      stale: false,
      rules: {},
      emergency: null,
      error: null,
    })
  })

  it('leaves the Live states as they were: linked doors only, same shape', async () => {
    const h = screenSetup({ linked: ['front'] })
    h.setDoors([door('front', 'unlock', 'open'), door('garage', 'unlock'), door('unlinked')])
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.liveStates).toEqual([{ front: { relay: 'unlock', position: 'open' } }])
    expect(h.monitor.states).toEqual({ front: { relay: 'unlock', position: 'open' } })
  })

  it('sends the screen state only when it changed', async () => {
    const h = screenSetup()
    await h.started()
    const sent = h.screens.length
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 6)
    expect(h.readDoors.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(h.screens).toHaveLength(sent)
    h.setDoors([door('front', 'lock', 'open'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.screens).toHaveLength(sent + 1)
    expect(h.lastScreen().doors?.[0]).toMatchObject({ id: 'front', position: 'open' })
  })

  it('hands out copies: a caller cannot change the list actions are checked against', async () => {
    const h = screenSetup()
    await h.started()
    const first = h.monitor.screen.doors?.[0]
    const known = h.monitor.knownDoor('front')
    if (first === undefined || known === null) throw new Error('expected the door')
    first.boundToHub = false
    known.boundToHub = false
    known.id = 'other'
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
  })

  it('bursts while any door is unlocked, linked or not, and stops with the relock', async () => {
    const h = screenSetup({ linked: ['front'] })
    await h.started()
    h.setDoors([door('front'), door('garage'), door('unlinked', 'unlock')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS * 5)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
    h.setDoors([door('front'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors).not.toHaveBeenCalled()
  })

  it('gives up the burst for a door held unlocked for 30 s, as for a linked one', async () => {
    const h = screenSetup({ linked: [] })
    await h.started()
    h.setDoors([door('front'), door('garage', 'unlock'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS + BURST_UNLOCKED_MAX_MS)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 4)
    // Back on the baseline: four reads in 20 s, not twenty.
    expect(h.readDoors.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('knows a door only from its own last read, and only while the screen is open', async () => {
    const h = screenSetup()
    h.monitor.start()
    // Nothing read yet.
    expect(h.monitor.knownDoor('front')).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
    expect(h.monitor.knownDoor('unlinked')).toEqual(door('unlinked'))
    for (const id of ['', 'nope', 'FRONT', 'front ', 'constructor', '__proto__', 'toString']) {
      expect(h.monitor.knownDoor(id), id).toBeNull()
    }
    // A door the console stops listing is no longer known.
    h.setDoors([door('front')])
    h.monitor.poke('test')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.monitor.knownDoor('unlinked')).toBeNull()
    h.setOpen(false)
    expect(h.monitor.knownDoor('front')).toBeNull()
  })

  it('reports a rule only once it was read, and drops it with the screen', async () => {
    const h = screenSetup()
    h.setRule('front', { type: 'custom', endedTime: 99 })
    h.setRule('garage', new AccessApiError('nope', { kind: 'not-found' }))
    h.monitor.start()
    expect(h.monitor.screen.rules).toEqual({})
    await vi.advanceTimersByTimeAsync(0)
    // Read and found to be "no rule" is known; a failed read is missing, not a guess.
    expect(h.monitor.screen.rules).toEqual({
      front: { type: 'custom', endedTime: 99 },
      unlinked: NO_RULE,
    })
    h.setOpen(false)
    expect(h.monitor.screen.rules).toEqual({})
  })
})

describe('the Doors screen: opening and closing while the monitor runs (P5.6)', () => {
  it('reads nothing extra, keeps no list and sends no screen state while the screen is closed', async () => {
    const h = screenSetup({ open: false })
    await h.started()
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 2)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    expect(h.screens).toEqual([])
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    expect(h.monitor.knownDoor('front')).toBeNull()
    // Live is served as in P5.5.
    expect(h.monitor.states).toEqual({ front: LOCKED })
  })

  it('opening reads the doors at once, then the details; closing stops both and forgets the list', async () => {
    const h = screenSetup({ open: false })
    await h.started()
    h.setOpen(true)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule).toHaveBeenCalledTimes(3)
    expect(h.lastScreen().doors).toHaveLength(3)
    expect(h.lastScreen().emergency).toEqual(NORMAL)

    const sent = h.screens.length
    h.setOpen(false)
    // Closing sends nothing: the renderer asked for it, and its answer is the reset.
    expect(h.screens).toHaveLength(sent)
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    h.readEmergency.mockClear()
    h.readLockRule.mockClear()
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 3)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    // The door reads go on for Live.
    expect(h.monitor.running).toBe(true)
    expect(h.monitor.states).toEqual({ front: LOCKED })
  })

  it('closing ends the burst an unlinked door was holding', async () => {
    const h = screenSetup({ linked: ['front'] })
    await h.started()
    h.setDoors([door('front'), door('garage'), door('unlinked', 'unlock')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS + BURST_POLL_MS)
    h.setOpen(false)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('reopening starts from nothing: the list is read again, not remembered', async () => {
    const h = screenSetup()
    await h.started()
    h.setOpen(false)
    h.setOpen(true)
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
  })

  it('screenChanged does nothing to the reads while the monitor is stopped', async () => {
    const h = screenSetup({ open: false })
    h.setOpen(true)
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS)
    expect(h.readDoors).not.toHaveBeenCalled()
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.screens).toEqual([])
  })
})

describe('the details rounds as the monitor drives them (P5.6)', () => {
  it('runs one round after the first door read that worked, then every detailsMs', async () => {
    const h = screenSetup()
    h.monitor.start()
    // Not before a door read has worked: the token and the certificate are unproven.
    expect(h.readEmergency).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual([
      'front',
      'garage',
      'unlinked',
    ])
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS - 1)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 3)
    expect(h.readEmergency).toHaveBeenCalledTimes(5)
  })

  it('starts no round while the first door reads fail', async () => {
    const h = screenSetup()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
  })

  it('re-reads only the rule of a door whose relay changed between two reads, and only then', async () => {
    const h = screenSetup()
    await h.started()
    // Unchanged reads, and a position change, cause none.
    h.setDoors([door('front', 'lock', 'open'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 2)
    expect(h.readLockRule).not.toHaveBeenCalled()
    h.setRule('garage', { type: 'keep_unlock', endedTime: 3602128562 })
    h.setDoors([door('front', 'lock', 'open'), door('garage', 'unlock'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    // That door's rule, not the other doors' — and the emergency status, one request: a lockdown
    // or an evacuation started elsewhere is exactly a relay that moved.
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual(['garage'])
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.lastScreen().rules.garage).toEqual({ type: 'keep_unlock', endedTime: 3602128562 })
    // The door staying unlocked is not a change: the burst reads cause no more.
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS * 5)
    expect(h.readLockRule).toHaveBeenCalledTimes(1)
    // The relock is one.
    h.setDoors([door('front', 'lock', 'open'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS)
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual(['garage', 'garage'])
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('shows an emergency started elsewhere as soon as the relays move, not at the next round', async () => {
    const h = screenSetup()
    await h.started()
    // An evacuation from the Access app: every relay opens, and the status says why.
    h.setEmergency({ lockdown: false, evacuation: true })
    h.setDoors([door('front', 'unlock'), door('garage', 'unlock'), door('unlinked', 'unlock')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.lastScreen().emergency).toEqual({ lockdown: false, evacuation: true })
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
  })

  it('re-reads the rules of every door that moved in the same read, in one round', async () => {
    const h = screenSetup()
    await h.started()
    h.setDoors([door('front', 'unlock'), door('garage'), door('unlinked', 'unlock')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual(['front', 'unlinked'])
  })

  it('runs a full round when a door joins or leaves the list', async () => {
    const h = screenSetup()
    await h.started()
    h.setRule('office', { type: 'keep_lock', endedTime: 5 })
    h.setDoors([door('front'), door('garage'), door('unlinked'), door('office')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule).toHaveBeenCalledTimes(4)
    expect(h.lastScreen().rules.office).toEqual({ type: 'keep_lock', endedTime: 5 })
    // Same count, another door: still a changed list.
    h.setDoors([door('front'), door('garage'), door('unlinked'), door('shed')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    expect(h.lastScreen().rules).not.toHaveProperty('office')
    h.setDoors([door('front'), door('garage')])
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(3)
  })

  it('asks for no round because the console lists a door id twice', async () => {
    const h = screenSetup()
    h.setDoors([door('front'), door('front'), door('garage')])
    await h.started()
    // Every poll would count three doors against two ids and call the list changed.
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 4)
    expect(h.readDoors.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    // And a round asks about that door once.
    h.monitor.refreshDetails('test')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual(['front', 'garage'])
  })

  it('refreshDetails with a scope reads only that: one door and the emergency status', async () => {
    const h = screenSetup()
    await h.started()
    h.setRule('garage', { type: 'custom', endedTime: 42 })
    h.monitor.refreshDetails('a door action was answered', { doorIds: ['garage'], emergency: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual(['garage'])
    expect(h.lastScreen().rules.garage).toEqual({ type: 'custom', endedTime: 42 })
  })

  it('a door action costs its own door, not three rounds of every door', async () => {
    const h = screenSetup()
    await h.started()
    // What the connection manager does after an answered action: a read now, and that door's rule.
    h.setDoors([door('front'), door('garage', 'unlock'), door('unlinked')])
    h.monitor.poke('a door action was answered')
    h.monitor.refreshDetails('a door action was answered', { doorIds: ['garage'], emergency: true })
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    // …and the relock a few seconds later.
    h.setDoors([door('front'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(BURST_POLL_MS)
    expect(new Set(h.readLockRule.mock.calls.map((call) => call[0]))).toEqual(new Set(['garage']))
    expect(h.readLockRule.mock.calls.length).toBeLessThanOrEqual(3)
    // One emergency read beside each of those: three requests' worth, not three rounds.
    expect(h.readEmergency.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('refreshDetails runs a round now, coalesced, and nothing while closed or stopped', async () => {
    const h = screenSetup()
    await h.started()
    for (let i = 0; i < 10; i += 1) h.monitor.refreshDetails('a door action was answered')
    await vi.advanceTimersByTimeAsync(0)
    // The round that started, and the one the other nine were folded into.
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
    h.setOpen(false)
    h.readEmergency.mockClear()
    h.monitor.refreshDetails('closed')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).not.toHaveBeenCalled()
    h.monitor.stop()
    h.monitor.refreshDetails('stopped')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).not.toHaveBeenCalled()
  })

  it('shows a failed rule as a missing rule and a failed emergency read as null', async () => {
    const h = screenSetup()
    h.setEmergency(new AccessApiError('no such endpoint', { kind: 'not-found' }))
    h.setRule('garage', new AccessApiError('no such endpoint', { kind: 'not-found' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.lastScreen()).toMatchObject({
      rules: { front: NO_RULE, unlinked: NO_RULE },
      emergency: null,
      // A details failure is not a door-list failure: no error, not stale.
      error: null,
      stale: false,
    })
    expect(h.lastScreen().rules).not.toHaveProperty('garage')
    // The door reads are untouched by it: the monitor keeps running and halts nothing.
    expect(h.monitor.running).toBe(true)
    expect(h.halts).toEqual([])
  })

  it('never halts or moves the door reads over a details failure, even an auth one', async () => {
    const h = screenSetup()
    h.setEmergency(new AccessApiError('scope missing', { kind: 'auth' }))
    await h.started()
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 2)
    expect(h.monitor.running).toBe(true)
    expect(h.halts).toEqual([])
    expect(h.monitor.screen.error).toBeNull()
    expect(h.monitor.screen.doors).toHaveLength(3)
  })

  it('skips the timed rounds while the door reads fail, and reads again when they work', async () => {
    const h = screenSetup()
    await h.started()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 3)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.lastScreen()).toMatchObject({ stale: false, error: null, emergency: NORMAL })
  })
})

describe('the Doors screen while the door reads fail (P5.6)', () => {
  const down = new AccessApiError('The console did not answer.', { kind: 'network' })

  it('reports the error together with stale, from the second failure, keeping the names', async () => {
    const h = screenSetup()
    h.setRule('front', { type: 'custom', endedTime: 7 })
    h.setDoors([door('front', 'unlock'), door('garage'), door('unlinked')])
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.setFailure(down)
    h.monitor.poke('test')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    // One lost poll with a list on screen is not news (user decision 2026-11-18): nothing changes,
    // so nothing is sent, and the screen keeps what was last read.
    expect(h.monitor.screen).toMatchObject({
      stale: false,
      error: null,
      rules: { front: { type: 'custom', endedTime: 7 } },
      emergency: NORMAL,
    })
    expect(h.monitor.stale).toBe(false)
    expect(h.monitor.screen.doors).toHaveLength(3)
    h.monitor.poke('test')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.monitor.stale).toBe(true)
    expect(h.lastScreen()).toMatchObject({
      stale: true,
      error: { kind: 'network', message: 'The console did not answer.' },
      // As old as the relays now: unknown too.
      rules: {},
      emergency: null,
    })
    // The list is kept so the screen still names its doors; the relay in it is the old one, which
    // is exactly what `stale` tells the renderer not to draw.
    expect(h.lastScreen().doors?.map((entry) => entry.id)).toEqual(['front', 'garage', 'unlinked'])
    // Live's states are unknown at the same moment, as in P5.5.
    expect(h.monitor.states).toEqual({})
  })

  it('sends nothing for a single failed read between two that work', async () => {
    const h = screenSetup()
    await h.started()
    const sent = h.screens.length
    h.setFailure(down)
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.screens).toHaveLength(sent)
    expect(h.monitor.stale).toBe(false)
  })

  it('is not stale once stopped, and stale ends with the next read that works', async () => {
    const h = screenSetup()
    await h.started()
    h.setFailure(down)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.monitor.stale).toBe(true)
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.monitor.stale).toBe(false)
    h.setFailure(down)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    h.monitor.stop()
    expect(h.monitor.stale).toBe(false)
  })

  it('clears the error and stale with the next read that works', async () => {
    const h = screenSetup()
    await h.started()
    h.setFailure(down)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 2)
    expect(h.lastScreen()).toMatchObject({ stale: true, error: { kind: 'network' } })
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.lastScreen()).toMatchObject({
      stale: false,
      error: null,
      rules: { front: NO_RULE, garage: NO_RULE, unlinked: NO_RULE },
      emergency: NORMAL,
    })
  })

  it('has no list and says why when no read has worked yet', async () => {
    const h = screenSetup()
    h.setFailure(down)
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.lastScreen()).toEqual({
      ...EMPTY_SCREEN,
      error: expect.objectContaining({ kind: 'network' }) as unknown,
    })
    expect(h.monitor.knownDoor('front')).toBeNull()
  })

  it('on a halt: drops the list, the rules and the rounds, and keeps the reason', async () => {
    const h = screenSetup()
    await h.started()
    expect(h.monitor.knownDoor('front')).not.toBeNull()
    h.setFailure(new AccessApiError('The token was rejected.', { kind: 'auth' }))
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.halts).toEqual(['auth'])
    expect(h.monitor.running).toBe(false)
    expect(h.lastScreen()).toEqual({
      ...EMPTY_SCREEN,
      error: {
        kind: 'auth',
        message: 'The token was rejected.',
        endpoint: 'console:12445',
        retryable: false,
      },
    })
    expect(h.monitor.screen).toEqual(h.lastScreen())
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(h.monitor.screen.rules).toEqual({})
    h.readEmergency.mockClear()
    h.readLockRule.mockClear()
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 3)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a restart after a halt keeps showing the reason until a read answers', async () => {
    const h = screenSetup()
    h.setFailure(new AccessApiError('The token was rejected.', { kind: 'auth' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    const sent = h.screens.length
    // The 60 s retry of a rejected token: same failure, nothing new to show.
    h.monitor.start()
    expect(h.monitor.screen.error?.kind).toBe('auth')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.screens).toHaveLength(sent)
    // And once it works the reason goes.
    h.setFailure(null)
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.lastScreen()).toMatchObject({ error: null })
    expect(h.lastScreen().doors).toHaveLength(3)
  })

  it('an explicit stop after a halt drops the reason too', async () => {
    const h = screenSetup()
    h.setFailure(new AccessApiError('The token was rejected.', { kind: 'auth' }))
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.stop()
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    expect(h.lastScreen()).toEqual(EMPTY_SCREEN)
  })
})

describe('stop, and forgetting the list (P5.6)', () => {
  it('stop sends one reset state while the screen is open, and ends every read', async () => {
    const h = screenSetup()
    await h.started()
    const sent = h.screens.length
    h.monitor.stop()
    expect(h.screens).toHaveLength(sent + 1)
    expect(h.lastScreen()).toEqual(EMPTY_SCREEN)
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS * 2)
    expect(h.readDoors).not.toHaveBeenCalled()
    expect(h.readEmergency).not.toHaveBeenCalled()
    // A second stop has nothing to say.
    h.monitor.stop()
    expect(h.screens).toHaveLength(sent + 1)
  })

  it('ignores a details answer that arrives after the stop', async () => {
    const h = screenSetup()
    let release: (value: { lockdown: boolean; evacuation: boolean }) => void = () => undefined
    h.readEmergency.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.stop()
    const sent = h.screens.length
    release({ lockdown: true, evacuation: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.screens).toHaveLength(sent)
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    expect(h.readLockRule).not.toHaveBeenCalled()
  })

  it('a restart begins with no list: one read from the last run is not carried over', async () => {
    const h = screenSetup()
    await h.started()
    h.monitor.stop()
    h.monitor.start()
    expect(h.monitor.knownDoor('front')).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
  })

  it('forgetScreen drops the list and the details at once, reads them again, and leaves Live alone', async () => {
    const h = screenSetup({ linked: ['front'] })
    await h.started()
    const live = h.liveStates.length
    h.monitor.forgetScreen('the Access token was saved')
    // At once, before any read: no door action can be checked against the old list.
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(h.lastScreen()).toEqual(EMPTY_SCREEN)
    expect(h.monitor.states).toEqual({ front: LOCKED })
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
    expect(h.lastScreen().rules).toEqual({ front: NO_RULE, garage: NO_RULE, unlinked: NO_RULE })
    expect(h.liveStates).toHaveLength(live)
  })

  it('forgetScreen: a door read already in flight cannot bring the old list back', async () => {
    const h = screenSetup({ linked: ['front'] })
    await h.started()
    // A read sent with the old token, still unanswered when the token is replaced.
    let answerOld: (doors: readonly Door[]) => void = () => undefined
    h.readDoors.mockImplementationOnce(
      () =>
        new Promise<readonly Door[]>((resolve) => {
          answerOld = resolve
        }),
    )
    h.monitor.poke('test')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    h.monitor.forgetScreen('the Access token was saved')
    expect(h.monitor.knownDoor('front')).toBeNull()

    // The old console's answer: a door the new token must not be able to act on.
    answerOld([door('front'), door('old-console-door')])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(h.monitor.knownDoor('old-console-door')).toBeNull()
    expect(h.monitor.screen.doors).toBeNull()
    expect(h.lastScreen()).toEqual(EMPTY_SCREEN)
    // Nothing was asked about its doors either.
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()

    // The read the forget asked for follows it, and is the one that counts.
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
    expect(h.monitor.knownDoor('front')).toEqual(door('front'))
    expect(h.monitor.knownDoor('old-console-door')).toBeNull()
    expect(h.readLockRule.mock.calls.map((call) => call[0])).toEqual([
      'front',
      'garage',
      'unlinked',
    ])
  })

  it('forgetScreen: a details round already in flight cannot bring the old rules back', async () => {
    const h = screenSetup()
    await h.started()
    let answerOld: (rule: { type: string; endedTime: number | null }) => void = () => undefined
    h.readLockRule.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerOld = resolve
        }),
    )
    h.monitor.refreshDetails('test', { doorIds: ['front'], emergency: false })
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.forgetScreen('a certificate was accepted')
    answerOld({ type: 'keep_unlock', endedTime: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.screen.rules).toEqual({})
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.monitor.screen.rules.front).toEqual(NO_RULE)
  })

  it('forgetScreen does nothing while stopped', async () => {
    const h = screenSetup()
    h.monitor.forgetScreen('test')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).not.toHaveBeenCalled()
    expect(h.screens).toEqual([])
  })
})

describe('user-set intervals (DOOR-6, P5.6)', () => {
  const custom: DoorMonitorIntervals = {
    withSocketMs: 20_000,
    withoutSocketMs: 4_000,
    unlockedMs: 2_000,
    detailsMs: 60_000,
  }

  it("defaults to P5.5's constants", () => {
    expect(DEFAULT_DOOR_MONITOR_INTERVALS).toEqual({
      withSocketMs: POLL_WITH_SOCKET_MS,
      withoutSocketMs: POLL_WITHOUT_SOCKET_MS,
      unlockedMs: BURST_POLL_MS,
      detailsMs: DETAILS_POLL_MS,
    })
    expect(DETAILS_POLL_MS).toBe(30_000)
  })

  it('polls at the set baseline with the socket open', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    await vi.advanceTimersByTimeAsync(custom.withSocketMs * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(3)
  })

  it('polls at the set no-socket interval while the socket is not open', async () => {
    const h = screenSetup({ intervals: custom, open: false })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(custom.withoutSocketMs * 5)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
  })

  it('polls at the set unlocked interval while a door is unlocked', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    h.setDoors([door('front', 'unlock'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(custom.withSocketMs)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(custom.unlockedMs * 6)
    expect(h.readDoors).toHaveBeenCalledTimes(6)
  })

  it('runs the details rounds at the set interval', async () => {
    const h = screenSetup({ intervals: custom })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(custom.detailsMs - DETAILS_POLL_MS)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('never reads a failing console more often than a healthy one (a 60 s baseline)', async () => {
    const slow: DoorMonitorIntervals = { ...custom, withSocketMs: 60_000 }
    const h = screenSetup({ intervals: slow })
    await h.started()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    await vi.advanceTimersByTimeAsync(slow.withSocketMs)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    // The backoff's 30 s cap is below this baseline: the wait is still the baseline, every time.
    for (let failure = 2; failure <= 4; failure += 1) {
      await vi.advanceTimersByTimeAsync(slow.withSocketMs - 1)
      expect(h.readDoors).toHaveBeenCalledTimes(failure - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.readDoors).toHaveBeenCalledTimes(failure)
    }
  })

  it('still backs off up to the cap from a baseline below it', async () => {
    const h = screenSetup({ intervals: { ...custom, withSocketMs: 20_000 } })
    await h.started()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    // 20 s doubled is 40 s, capped at 30 s — and never under the 20 s baseline.
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('never lets the unlocked interval slow a door below the baseline', async () => {
    // The ranges overlap: 10 s "unlocked" with a 2 s baseline must not mean a slower poll.
    const h = screenSetup({
      intervals: { ...custom, withSocketMs: 2_000, unlockedMs: 10_000 },
    })
    await h.started()
    h.setDoors([door('front', 'unlock'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(2_000)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.readDoors).toHaveBeenCalledTimes(5)
  })

  it('rearm applies a shorter door-read interval now, not after the old one runs out', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.readDoors).not.toHaveBeenCalled()
    // 5 s into a 20 s wait, the user saves 6 s: the next read is 1 s away.
    h.setIntervals({ ...custom, withSocketMs: 6_000 })
    h.monitor.rearm()
    await vi.advanceTimersByTimeAsync(999)
    expect(h.readDoors).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_000 * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
  })

  it('rearm reads at once when the new interval has already passed, exactly once', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    await vi.advanceTimersByTimeAsync(10_000)
    h.setIntervals({ ...custom, withSocketMs: 5_000 })
    h.monitor.rearm()
    h.monitor.rearm()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('rearm applies a longer interval to the pending read too', async () => {
    const h = screenSetup()
    await h.started()
    h.setIntervals({ ...DEFAULT_DOOR_MONITOR_INTERVALS, withSocketMs: 60_000 })
    h.monitor.rearm()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.readDoors).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('rearm applies a shorter details interval now', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    await vi.advanceTimersByTimeAsync(12_000)
    // 60 s was set, so nothing has run since the first round.
    expect(h.readEmergency).not.toHaveBeenCalled()
    h.setIntervals({ ...custom, detailsMs: 10_000 })
    h.monitor.rearm()
    // That round ended more than 10 s ago, so the next one is due now.
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.readEmergency).toHaveBeenCalledTimes(2)
  })

  it('a value read without rearm still applies from the next scheduling decision', async () => {
    const h = screenSetup({ intervals: custom })
    await h.started()
    h.setIntervals({ ...custom, withSocketMs: 3_000 })
    // The pending 20 s wait runs out as it was armed; everything after it is 3 s.
    await vi.advanceTimersByTimeAsync(custom.withSocketMs)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(3_000 * 4)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
  })

  it('rearm does nothing while stopped: no read, no timer', async () => {
    const h = screenSetup()
    h.monitor.rearm()
    await vi.advanceTimersByTimeAsync(DETAILS_POLL_MS)
    expect(h.readDoors).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the constants that are not settings: coalescing, the after-trigger burst, the backoff cap', async () => {
    const h = screenSetup({ intervals: { ...custom, unlockedMs: 1_000 } })
    await h.started()
    // A flood of triggers is still one read per 250 ms.
    for (let i = 0; i < 20; i += 1) {
      h.monitor.poke('flood')
      await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS / 5)
    }
    expect(h.readDoors.mock.calls.length).toBeLessThanOrEqual(5)
    // And the failure backoff still caps at 30 s whatever the baseline.
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 4)
    h.readDoors.mockClear()
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS * 3)
    expect(h.readDoors).toHaveBeenCalledTimes(3)
  })
})

describe('without the Doors screen option (P5.5 behaviour, unchanged)', () => {
  it('has an empty screen, knows no door, and its new methods are harmless', async () => {
    const h = setup()
    await h.started()
    expect(h.monitor.screen).toEqual(EMPTY_SCREEN)
    expect(h.monitor.knownDoor('front')).toBeNull()
    expect(h.monitor.stale).toBe(false)
    h.monitor.screenChanged()
    h.monitor.refreshDetails('test')
    h.monitor.rearm()
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.monitor.running).toBe(true)
    expect(h.monitor.states).toEqual({ front: LOCKED, garage: LOCKED })
  })
})

describe('recoverNow (P6.2, NFR-7)', () => {
  const network = (): AccessApiError =>
    new AccessApiError('The console did not answer.', { kind: 'network' })

  it('reads at once and tells the socket to reconnect, without starting the burst', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    h.monitor.recoverNow('the machine woke from sleep')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.socket().reconnects).toBe(1)
    // No 1 s burst: the next read is a whole baseline later.
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS - 1)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('is coalesced like any trigger: right after a read it waits out the 250 ms', async () => {
    const h = setup()
    await h.started()
    await h.settle()
    h.monitor.poke('an unlock was answered')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.recoverNow('the network changed')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
  })

  it('cuts the failure backoff short, and a further failure waits only a baseline', async () => {
    const h = setup()
    await h.started(false)
    h.readDoors.mockImplementation(() => Promise.reject(network()))
    // Four failures in a row: 2 s, then 4, 8 and 16 s apart; the next would be 30 s away.
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS + 4_000 + 8_000 + 16_000)
    expect(h.readDoors).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    h.monitor.recoverNow('the machine woke from sleep')
    expect(h.readDoors).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(0)
    // That one failed too: the next is one baseline later (2 s: the socket has not been down a
    // minute), then doubling again from there.
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_SOCKET_MS * 2)
    expect(h.readDoors).toHaveBeenCalledTimes(6)
    // The reads that failed still count: the states stay unknown until one works.
    expect(h.monitor.states).toEqual({})
    expect(h.monitor.stale).toBe(true)
  })

  it('is a no-op while not running, and after a halt', async () => {
    const h = setup()
    h.monitor.recoverNow('the machine woke from sleep')
    expect(h.readDoors).not.toHaveBeenCalled()
    await h.started()
    h.setFailure(new AccessApiError('HTTP 401.', { kind: 'auth' }))
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.halts).toEqual(['auth'])
    h.readDoors.mockClear()
    const reconnects = h.socket().reconnects
    h.monitor.recoverNow('the machine woke from sleep')
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MAX_MS)
    expect(h.readDoors).not.toHaveBeenCalled()
    expect(h.socket().reconnects).toBe(reconnects)
  })

  it('reads with no socket yet, or an opener whose handle cannot reconnect', async () => {
    const h = setup({ socket: false })
    await h.started(false)
    await h.settle()
    h.monitor.recoverNow('the network changed')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
  })

  it('runs one full details round after the door read works, never beside it', async () => {
    const h = screenSetup()
    await h.started()
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    let answer: (doors: readonly Door[]) => void = () => undefined
    h.readDoors.mockImplementationOnce(
      () =>
        new Promise<readonly Door[]>((resolve) => {
          answer = resolve
        }),
    )
    h.monitor.recoverNow('the machine woke from sleep')
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    // The door read is still out: nothing else is sent meanwhile.
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    answer([door('front'), door('garage'), door('unlinked')])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule).toHaveBeenCalledTimes(3)

    const closed = screenSetup({ open: false })
    await closed.started()
    closed.monitor.recoverNow('the machine woke from sleep')
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    expect(closed.readDoors).toHaveBeenCalledTimes(1)
    expect(closed.readEmergency).not.toHaveBeenCalled()
    expect(closed.readLockRule).not.toHaveBeenCalled()
  })
})

describe('recoverNow and the Doors screen details (P6.2)', () => {
  it('sends no details while the recover read fails, then exactly one round once one works', async () => {
    const h = screenSetup()
    await h.started()
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    h.monitor.recoverNow('the machine woke from sleep')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    expect(h.readEmergency).not.toHaveBeenCalled()
    expect(h.readLockRule).not.toHaveBeenCalled()
    // The network is back: the next read works, and it is both the "recovered" read and the one
    // after a wake. One full round, not two.
    h.setFailure(null)
    // One failure with the socket open: the next read is 10 s away (inside the 30 s details period).
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS * 2)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule).toHaveBeenCalledTimes(3)
  })

  it('one round only when a wake follows a failure and the read works', async () => {
    const h = screenSetup()
    await h.started()
    h.setFailure(new AccessApiError('The console did not answer.', { kind: 'network' }))
    await vi.advanceTimersByTimeAsync(POLL_WITH_SOCKET_MS)
    expect(h.readDoors).toHaveBeenCalledTimes(1)
    h.setFailure(null)
    await vi.advanceTimersByTimeAsync(TRIGGER_COALESCE_MS)
    h.monitor.recoverNow('the network changed')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readDoors).toHaveBeenCalledTimes(2)
    expect(h.readEmergency).toHaveBeenCalledTimes(1)
    expect(h.readLockRule).toHaveBeenCalledTimes(3)
  })
})
