// The renderer's Protect event bus (P4.2; CELL-2, SPEC §5.1 "Event lifecycle"): every
// `vp:event/cameraEvent` push from main, stamped with its local arrival time, fanned out to whoever
// listens — the multi-camera cells' schedulers (features/cells/useCellSchedulers.ts) — and kept for
// a while so a scheduler created later can catch up.
//
// The core ({@link createEventBus}) is pure of the bridge and the clock, both injected, so every rule
// is tested in the node environment (CLAUDE.md); {@link cameraEventBus} is the app's one instance on
// `window.viewProtect.onCameraEvent` and `Date.now`.
//
// The rules, and why:
//
//  - **One bus, alive from startup.** `main.tsx` creates the singleton before the first render, and it
//    is never torn down, so events that arrive while no grid is mounted (Settings open, the View
//    editor open, the inventory still loading) are still buffered.
//  - **`at` is the local arrival time.** The scheduler measures the hold from the event's `end`
//    corrected by the `add`'s arrival (cellScheduler.ts header, "The hold is measured…"), so a
//    message replayed later must carry the time it *arrived*, not the time it was replayed.
//  - **Retention: what a new scheduler needs, nothing more.** {@link BusEvent}s are kept per event
//    id: the first message, and the latest one whose `end` differs from it (the closing update, or a
//    corrected end). That is all the reducer reads — update items are full objects and it is
//    idempotent on `(id, end)` — so the 2–3 identical end updates of §5.1 are delivered to listeners
//    (harmless, the reducer ignores them) but stored once, at the arrival of the first of them, which
//    is the arrival the hold's clamp needs. An id is forgotten {@link DEFAULT_RETAIN_MS} after its
//    last message: the scheduler's own tombstone window, past which it would ignore the event anyway.
//  - **Bounded.** At most `maxEvents` ids are kept. Over the cap, the least recently heard from
//    *ended* event (one whose latest message has an `end`) is dropped first: a still-running event
//    is the one a scheduler created now most needs to replay, while an ended one is at worst a hold
//    a new cell misses. Only when none is ended does the least recently heard from overall go. A
//    storm of events cannot grow the renderer without limit.
//  - **Pruning scans every id**, not just the oldest few: insertion order is recency order only
//    while the clock moves forward, and `Date.now()` can step backwards (an NTP correction), after
//    which an entry stamped "in the future" sits ahead of older ones. At most `maxEvents` entries,
//    so the full scan is cheap.
//  - **A listener that throws is logged and skipped**, never allowed to stop the others — one broken
//    cell must not freeze every other cell's motion switching.
import type { CameraEvent } from '@shared/models'

/** One message from main, with when it reached this renderer (`Date.now()` ms). */
export interface BusEvent {
  readonly event: CameraEvent
  readonly at: number
}

export interface EventBus {
  /** Every message from now on, repeats included. Returns the unsubscribe. */
  subscribe(listener: (busEvent: BusEvent) => void): () => void
  /**
   * For replay into a scheduler created now: per retained event id its first message and, if its
   * `end` differs, its latest; sorted by `at` (arrival order on ties). Prunes ids whose last message
   * is older than the retention window first.
   */
  recent(now: number): readonly BusEvent[]
}

/** The scheduler's tombstone window (cellScheduler.ts, `TOMBSTONE_MS`): older is ignored anyway. */
export const DEFAULT_RETAIN_MS = 5 * 60_000

/** Distinct event ids kept at most (header, "Bounded"). */
export const DEFAULT_MAX_EVENTS = 500

interface Retained {
  readonly first: BusEvent
  /** The latest message whose `end` differs from `first`'s; `null` when there is none. */
  latest: BusEvent | null
  /** Arrival of the last message for this id, repeats included: what retention counts from. */
  lastAt: number
  /** Arrival order, for a stable sort of messages that share an `at`. */
  readonly firstSeq: number
  latestSeq: number
}

export function createEventBus(opts: {
  readonly source: (listener: (event: CameraEvent) => void) => () => void
  readonly now: () => number
  readonly retainMs?: number
  readonly maxEvents?: number
}): EventBus {
  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS
  const maxEvents = Math.max(1, opts.maxEvents ?? DEFAULT_MAX_EVENTS)
  const listeners = new Set<(busEvent: BusEvent) => void>()
  // Insertion order is "least recently heard from first": an id is re-inserted on every message.
  const retained = new Map<string, Retained>()
  let seq = 0

  // Every entry, not up to the first young one: a backwards clock step breaks recency order (header).
  const prune = (now: number): void => {
    for (const [id, entry] of retained) {
      if (entry.lastAt < now - retainMs) retained.delete(id)
    }
  }

  /** Over the cap: the least recently heard from ended id, else the least recently heard from. */
  const evictOne = (): void => {
    let victim: string | null = null
    for (const [id, entry] of retained) {
      victim ??= id
      if ((entry.latest ?? entry.first).event.end !== null) {
        victim = id
        break
      }
    }
    if (victim !== null) retained.delete(victim)
  }

  const retain = (busEvent: BusEvent): void => {
    const { event, at } = busEvent
    seq += 1
    const entry = retained.get(event.id)
    if (entry === undefined) {
      retained.set(event.id, {
        first: busEvent,
        latest: null,
        lastAt: at,
        firstSeq: seq,
        latestSeq: 0,
      })
    } else {
      const shown = entry.latest ?? entry.first
      if (event.end !== shown.event.end) {
        // A different end (or, oddly, back to the first's): what a replay must end on.
        entry.latest = event.end === entry.first.event.end ? null : busEvent
        entry.latestSeq = seq
      }
      entry.lastAt = at
      retained.delete(event.id)
      retained.set(event.id, entry)
    }
    prune(at)
    while (retained.size > maxEvents) evictOne()
  }

  opts.source((event) => {
    const busEvent: BusEvent = { event, at: opts.now() }
    retain(busEvent)
    // A copy, so a listener that unsubscribes (or subscribes) mid-delivery changes nothing here.
    for (const listener of [...listeners]) {
      try {
        listener(busEvent)
      } catch (error) {
        console.error('[eventBus] a listener threw', error)
      }
    }
  })

  return {
    subscribe(listener) {
      // Wrapped, so the same function subscribed twice is two subscriptions with two unsubscribes.
      const entry = (busEvent: BusEvent): void => {
        listener(busEvent)
      }
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
    recent(now) {
      prune(now)
      const out: { readonly busEvent: BusEvent; readonly seq: number }[] = []
      for (const entry of retained.values()) {
        out.push({ busEvent: entry.first, seq: entry.firstSeq })
        if (entry.latest !== null) out.push({ busEvent: entry.latest, seq: entry.latestSeq })
      }
      out.sort((a, b) => a.busEvent.at - b.busEvent.at || a.seq - b.seq)
      return out.map((item) => item.busEvent)
    },
  }
}

let singleton: EventBus | null = null

/**
 * The app's bus, on the bridge's `onCameraEvent` and `Date.now`. Created on first call — `main.tsx`
 * calls it at startup so buffering starts then — and never torn down (header).
 */
export function cameraEventBus(): EventBus {
  singleton ??= createEventBus({
    source: (listener) => window.viewProtect.onCameraEvent(listener),
    now: () => Date.now(),
  })
  return singleton
}
