// P4.2: the renderer's Protect event bus (src/renderer/src/state/eventBus.ts; CELL-2, SPEC §5.1).
//
// What these tests protect:
//  - every message, repeats included, reaches every listener, stamped with its local arrival time;
//    unsubscribing stops delivery; a listener that throws is logged and does not stop the others.
//  - the buffer keeps, per event id, the first message and the latest with a different `end` — at
//    the arrival of the first copy of that end, so identical repeats are stored once.
//  - `recent` is sorted by arrival, prunes ids whose last message is older than the retention
//    window (5 min by default, the scheduler's tombstone window) — every one, even after the clock
//    steps backwards — and the buffer is bounded by `maxEvents` distinct ids: the least recently
//    heard from ended event dropped first, the least recently heard from overall only if none ended.
import { CameraEventSchema, type CameraEvent } from '@shared/models'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEventBus,
  DEFAULT_RETAIN_MS,
  type BusEvent,
} from '../../src/renderer/src/state/eventBus'

const T = 1_700_000_000_000

function ev(id: string, overrides: Partial<CameraEvent> = {}): CameraEvent {
  return CameraEventSchema.parse({
    id,
    cameraId: 'c0',
    trigger: 'motion',
    protectType: 'motion',
    start: T - 1000,
    ...overrides,
  })
}

/** A bus on a fake source and clock; `push(event, at)` delivers a message arriving at `at`. */
function harness(opts: { retainMs?: number; maxEvents?: number } = {}) {
  let clock = T
  let emit: ((event: CameraEvent) => void) | null = null
  let sourceUnsubscribed = false
  const bus = createEventBus({
    source: (listener) => {
      emit = listener
      return () => {
        sourceUnsubscribed = true
      }
    },
    now: () => clock,
    ...opts,
  })
  return {
    bus,
    push(event: CameraEvent, at: number): void {
      clock = at
      if (emit === null) throw new Error('source not subscribed')
      emit(event)
    },
    sourceUnsubscribed: () => sourceUnsubscribed,
  }
}

/** `recent` as `[id, end, at]`, for compact expectations. */
function summary(list: readonly BusEvent[]): [string, number | null, number][] {
  return list.map(({ event, at }) => [event.id, event.end, at])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createEventBus: delivery', () => {
  it('subscribes to its source at creation and never lets go', () => {
    const h = harness()
    h.push(ev('e1'), T)
    expect(h.bus.recent(T)).toHaveLength(1)
    expect(h.sourceUnsubscribed()).toBe(false)
  })

  it('fans every message out to every listener, with its arrival time', () => {
    const h = harness()
    const a: BusEvent[] = []
    const b: BusEvent[] = []
    h.bus.subscribe((e) => a.push(e))
    h.bus.subscribe((e) => b.push(e))
    const event = ev('e1')
    h.push(event, T + 5)
    expect(a).toEqual([{ event, at: T + 5 }])
    expect(b).toEqual(a)
  })

  it('delivers identical repeats too (the scheduler is the one that dedupes)', () => {
    const h = harness()
    const seen: BusEvent[] = []
    h.bus.subscribe((e) => seen.push(e))
    const end = ev('e1', { end: T })
    h.push(end, T + 1)
    h.push(end, T + 2)
    h.push(end, T + 3)
    expect(seen.map((e) => e.at)).toEqual([T + 1, T + 2, T + 3])
  })

  it('stops delivering after unsubscribe, and only to that listener', () => {
    const h = harness()
    const a: BusEvent[] = []
    const b: BusEvent[] = []
    const offA = h.bus.subscribe((e) => a.push(e))
    h.bus.subscribe((e) => b.push(e))
    h.push(ev('e1'), T)
    offA()
    h.push(ev('e2'), T + 1)
    expect(a.map((e) => e.event.id)).toEqual(['e1'])
    expect(b.map((e) => e.event.id)).toEqual(['e1', 'e2'])
  })

  it('isolates a listener that throws: logged, and the others still get the message', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness()
    const seen: string[] = []
    h.bus.subscribe(() => {
      throw new Error('boom')
    })
    h.bus.subscribe((e) => seen.push(e.event.id))
    h.push(ev('e1'), T)
    expect(seen).toEqual(['e1'])
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('is unaffected by a listener unsubscribing another mid-delivery', () => {
    const h = harness()
    const seen: string[] = []
    let offB = (): void => undefined
    h.bus.subscribe(() => {
      offB()
    })
    offB = h.bus.subscribe((e) => seen.push(e.event.id))
    h.push(ev('e1'), T)
    h.push(ev('e2'), T + 1)
    // Delivered the message it was already being handed, then gone.
    expect(seen).toEqual(['e1'])
  })
})

describe('createEventBus: buffering', () => {
  it('keeps the first message and the latest with a different end, sorted by arrival', () => {
    const h = harness()
    const add = ev('e1')
    h.push(add, T)
    h.push(ev('e2'), T + 1000)
    h.push({ ...add, end: T + 2000 }, T + 3000)
    expect(summary(h.bus.recent(T + 3000))).toEqual([
      ['e1', null, T],
      ['e2', null, T + 1000],
      ['e1', T + 2000, T + 3000],
    ])
  })

  it('stores identical repeats once, at the first copy’s arrival', () => {
    const h = harness()
    const add = ev('e1')
    h.push(add, T)
    h.push(add, T + 100) // an end-less update: same as the add
    const end = { ...add, end: T + 2000 }
    h.push(end, T + 4000)
    h.push(end, T + 4200)
    h.push(end, T + 4500)
    expect(summary(h.bus.recent(T + 5000))).toEqual([
      ['e1', null, T],
      ['e1', T + 2000, T + 4000],
    ])
  })

  it('replaces the latest when the end changes again', () => {
    const h = harness()
    const add = ev('e1')
    h.push(add, T)
    h.push({ ...add, end: T + 1000 }, T + 2000)
    h.push({ ...add, end: T + 1500 }, T + 2500)
    expect(summary(h.bus.recent(T + 3000))).toEqual([
      ['e1', null, T],
      ['e1', T + 1500, T + 2500],
    ])
  })

  it('keeps a message first seen already ended as one entry', () => {
    const h = harness()
    const end = ev('e1', { end: T })
    h.push(end, T + 10)
    h.push(end, T + 20)
    expect(summary(h.bus.recent(T + 30))).toEqual([['e1', T, T + 10]])
  })

  it('keeps arrival order for messages that share an `at`', () => {
    const h = harness()
    h.push(ev('b'), T)
    h.push(ev('a'), T)
    expect(h.bus.recent(T).map((e) => e.event.id)).toEqual(['b', 'a'])
  })

  it('returns an empty list before any message', () => {
    expect(harness().bus.recent(T)).toEqual([])
  })
})

describe('createEventBus: retention and bounds', () => {
  it('prunes an id whose last message is older than 5 minutes by default', () => {
    const h = harness()
    h.push(ev('old'), T)
    h.push(ev('young'), T + 60_000)
    expect(h.bus.recent(T + DEFAULT_RETAIN_MS).map((e) => e.event.id)).toEqual(['old', 'young'])
    expect(h.bus.recent(T + DEFAULT_RETAIN_MS + 1).map((e) => e.event.id)).toEqual(['young'])
  })

  it('counts retention from the last message for an id, repeats included', () => {
    const h = harness({ retainMs: 10_000 })
    const add = ev('e1')
    h.push(add, T)
    h.push(add, T + 8000)
    expect(h.bus.recent(T + 15_000).map((e) => e.event.id)).toEqual(['e1'])
    expect(h.bus.recent(T + 18_001)).toEqual([])
  })

  it('also prunes on arrival, without anyone calling recent', () => {
    const h = harness({ retainMs: 1000, maxEvents: 2 })
    h.push(ev('a'), T)
    h.push(ev('b'), T + 5000)
    h.push(ev('c'), T + 5001)
    // `a` went on age, not on the bound, so `b` survives.
    expect(h.bus.recent(T + 5001).map((e) => e.event.id)).toEqual(['b', 'c'])
  })

  it('keeps at most maxEvents ids, dropping the least recently heard from when none has ended', () => {
    const h = harness({ maxEvents: 2 })
    const a = ev('a')
    h.push(a, T)
    h.push(ev('b'), T + 1)
    h.push(a, T + 2) // `a` heard from again (still running): now `b` is the oldest
    h.push(ev('c'), T + 3)
    expect(summary(h.bus.recent(T + 3))).toEqual([
      ['a', null, T],
      ['c', null, T + 3],
    ])
  })

  it('drops the least recently heard from ended event before any running one', () => {
    const h = harness({ maxEvents: 4 })
    h.push(ev('run1'), T)
    h.push(ev('done1', { end: T - 500 }), T + 1)
    h.push(ev('run2'), T + 2)
    h.push(ev('done2'), T + 3)
    h.push(ev('done2', { end: T + 3 }), T + 4) // ended by its closing update
    h.push(ev('new'), T + 5)
    // Over the cap by one: `run1` is the least recently heard, but it is still running, so the
    // oldest ended one (`done1`) goes instead.
    expect(h.bus.recent(T + 5).map((e) => e.event.id)).toEqual([
      'run1',
      'run2',
      'done2',
      'done2',
      'new',
    ])
    h.push(ev('newer'), T + 6)
    // Next ended one in recency order: `done2`, not the older running `run1`.
    expect(h.bus.recent(T + 6).map((e) => e.event.id)).toEqual(['run1', 'run2', 'new', 'newer'])
  })

  it('prunes every expired id after the clock steps backwards', () => {
    const h = harness({ retainMs: 10_000 })
    h.push(ev('a'), T)
    // The wall clock steps back a minute (an NTP correction): `b` is stamped earlier than `a`
    // but is inserted after it, so recency order no longer follows `lastAt`.
    h.push(ev('b'), T - 60_000)
    // At T + 5 s, `a` is young and `b` is long expired. Stopping at the first young entry (`a`)
    // would keep `b`; a full scan drops it.
    expect(h.bus.recent(T + 5000).map((e) => e.event.id)).toEqual(['a'])
  })
})
