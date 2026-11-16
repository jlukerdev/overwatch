// `useCellSchedulers(entries, pinnedKey)` (P4.2; CELL-2, FILL-3): the schedulers of the grid's
// multi-camera cells, kept in React state and driven by the Protect event bus and one timer. Thin on
// purpose (no jsdom here; CLAUDE.md): every rule is in ./schedulerSet and ./cellScheduler; this file
// only decides *when* to call them.
//
//  - **Slots and fill are applied during render**, not in an effect (`updateSchedulerInputs`, React's
//    "adjust state when props change"). An effect would commit one frame with the new slots unsynced
//    — a View switch would first draw each multi-camera cell's camera 0, and that `<LivePlayer>`'s
//    own effect would already have asked main for its stream before the replay moved the cell to the
//    camera an event is holding. Likewise the pin lands in the very render that fills the cell, so a
//    filled cell can never rotate under the user (FILL-3). The update is a no-op on unchanged input
//    (same object), so it cannot loop; entries are compared by content, so a slot rebuild that
//    changes nothing the schedulers read — an inventory push, a quality pick — is not a sync.
//  - **Events** come from `cameraEventBus()` through a subscription made on mount. Anything that
//    arrived between the render that created the schedulers (which replayed `recent()`) and that
//    subscription is caught up from `recent()` once subscribed; the reducer is idempotent on
//    `(id, end)`, so what was already replayed changes nothing.
//  - **One timer** for the whole set, at `nextWakeOfSet`, re-armed whenever the set changes and
//    cleared on unmount. If it fires before the wake time (a clock step), it re-arms for the same
//    wake instead of ticking a tick that would change nothing and so never re-arm. If a tick at or
//    after the wake *still* changes nothing (the reducer should never do that), the set is the same
//    and the effect would never run again, so the timer re-checks after `STALLED_TICK_RECHECK_MS`
//    instead of stopping — a floor, so never a busy loop.
//  - **The views are stable** (`stableViews`): kept in state and brought in line during render like
//    the inputs, so a set change that moves no camera (most ticks, most events) hands the grid the
//    same views map and it rebuilds no slot. State rather than a ref, because a ref read during
//    render is exactly what the hooks lint forbids.
//  - **Manual next / previous** (P4.3; CELL-3) is the returned `step(key, direction)`:
//    `stepSchedulerSet` at the wall clock, through the same functional update as events and ticks,
//    so it composes with them in whatever order they land. Stable for the hook's life (no deps), so
//    the grid can hand it to its memoised cells as is. The step changes the set, so the timer effect
//    re-arms from the restarted interval.
//  - **The clock is `Date.now()`**, read through {@link wallClock}: the bus stamps arrivals with it,
//    and the scheduler compares those stamps with the `now` of every action.
import { useCallback, useEffect, useState } from 'react'
import { cameraEventBus, type BusEvent } from '../../state/eventBus'
import type { SchedulerView } from './cellScheduler'
import {
  applyBusEvent,
  applyBusEvents,
  initialSchedulerInputs,
  nextWakeOfSet,
  schedulerTimerDelay,
  stableViews,
  stepSchedulerSet,
  tickSchedulerSet,
  updateSchedulerInputs,
  type SchedulerEntry,
  type SchedulerInputs,
  type SchedulerSet,
  type StepDirection,
} from './schedulerSet'

/** The bus's clock (header). A function, so the render-time update reads it in one named place. */
function wallClock(): number {
  return Date.now()
}

function replayNow(): readonly BusEvent[] {
  return cameraEventBus().recent(wallClock())
}

/** What {@link useCellSchedulers} hands the grid. */
export interface CellSchedulers {
  /** What each multi-camera cell on screen shows, by slot key; stable while nothing shown changes. */
  readonly views: ReadonlyMap<string, SchedulerView>
  /** The user's next / previous on the cell at `key` (header). Stable; a no-op for other keys. */
  readonly step: (key: string, direction: StepDirection) => void
}

/**
 * The multi-camera cells on screen: what each shows, and the manual step. `entries` are the View's
 * slots (`schedulerEntries`); `pinnedKey` is the filled slot's key, or `null` in the grid (FILL-3).
 */
export function useCellSchedulers(
  entries: readonly SchedulerEntry[],
  pinnedKey: string | null,
): CellSchedulers {
  const [inputs, setInputs] = useState<SchedulerInputs>(() =>
    initialSchedulerInputs(entries, pinnedKey, wallClock(), replayNow),
  )
  // Render-time update (header). Same object when nothing changed, so no extra render.
  const current = updateSchedulerInputs(inputs, entries, pinnedKey, wallClock(), replayNow)
  if (current !== inputs) setInputs(current)

  const set = current.set

  // Events, with the catch-up for the gap before this subscription (header).
  useEffect(() => {
    const bus = cameraEventBus()
    const apply = (update: (set: SchedulerSet) => SchedulerSet): void => {
      setInputs((previous) => {
        const next = update(previous.set)
        return next === previous.set ? previous : { ...previous, set: next }
      })
    }
    const unsubscribe = bus.subscribe((busEvent) => {
      apply((s) => applyBusEvent(s, busEvent))
    })
    const missed = bus.recent(wallClock())
    apply((s) => applyBusEvents(s, missed))
    return unsubscribe
  }, [])

  // One timer at the set's next wake (header). `set` is the current set while this effect lives: any
  // change re-runs it and the cleanup clears the old timer.
  useEffect(() => {
    const wake = nextWakeOfSet(set)
    if (wake === null) return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = (stalled: boolean): void => {
      timer = setTimeout(fire, schedulerTimerDelay(wake, wallClock(), stalled))
    }
    const fire = (): void => {
      timer = null
      const now = wallClock()
      if (now < wake) {
        arm(false)
        return
      }
      if (tickSchedulerSet(set, now) === set) {
        // A due tick that changed nothing: the set stays the same, so this effect would never
        // re-run. Look again after the floor rather than stop (header).
        arm(true)
        return
      }
      setInputs((previous) => {
        const next = tickSchedulerSet(previous.set, now)
        return next === previous.set ? previous : { ...previous, set: next }
      })
    }
    arm(false)
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, [set])

  // Manual next / previous (header). The time is read here, not in the updater, which stays pure.
  const step = useCallback((key: string, direction: StepDirection): void => {
    const now = wallClock()
    setInputs((previous) => {
      const next = stepSchedulerSet(previous.set, key, direction, now)
      return next === previous.set ? previous : { ...previous, set: next }
    })
  }, [])

  // Stable views (header): the same map until a shown camera, position or reason changes.
  const [views, setViews] = useState(() => stableViews(null, set))
  const currentViews = stableViews(views, set)
  if (currentViews !== views) setViews(currentViews)
  // A fresh object each render is fine: callers destructure it, and both members are stable.
  return { views: currentViews, step }
}
