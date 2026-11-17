// P4.2: the schedulers of the cells on screen (src/renderer/src/features/cells/schedulerSet.ts;
// CELL-2, FILL-3).
//
// What these tests protect:
//  - sync: only cells with two or more cameras get a scheduler; an existing key is `configure`d
//    (keeping its camera), a new one created, an absent one dropped; nothing changed → same object;
//    the replay is read only when a scheduler is created.
//  - replay: no replay is exactly `createScheduler`; a still-running event replayed into a newly
//    mounted cell shows that camera; one whose hold ran out before mount does not; the hold is
//    measured from the original arrival, not from mount; the rotation timer starts at mount with the
//    first camera, however long the replay spans.
//  - events reach only the schedulers whose cell they match; pin pins one key and unpins any other
//    (switching the pinned key, leaving fill); a manual step (P4.3) moves only its own cell, wraps,
//    dismisses the active trigger, and in fill changes the pinned camera without unpinning; nextWake is the minimum across the set; views and
//    shown indices read back what each cell shows; `stableViews` hands back the previous map when no
//    view changed (an event ending on the camera already shown included) and reuses unchanged view objects otherwise; the timer delay never goes negative,
//    and a due tick that changed nothing re-checks after a floor, never at 0 ms.
//  - pre-warm (P4.4): a slot is a target from PREWARM_LEAD_MS before its rotation step until the
//    step (which drops it); never while triggered, pinned, without rotation or for a one-camera
//    cell; `stablePrewarm` keeps the same map while the targets are equal; `nextPrewarmAt` is the
//    earliest start strictly after now, so a timer that fires on time moves on to the next.
//  - the hook's render-time inputs: unchanged input → same object (no render loop); entries are
//    compared by content; a scheduler created for the filled slot is pinned at once.
import { CameraEventSchema, CellSchema, type CameraEvent } from '@shared/models'
import { describe, expect, it } from 'vitest'
import {
  createScheduler,
  nextWakeAt,
  reduceScheduler,
  schedulerView,
  type SchedulerCell,
} from '../../src/renderer/src/features/cells/cellScheduler'
import {
  applyBusEvent,
  applyBusEvents,
  createReplayedScheduler,
  EMPTY_SCHEDULER_SET,
  initialSchedulerInputs,
  nextPrewarmAt,
  nextWakeOfSet,
  NO_PREWARM,
  pinSchedulerSet,
  PREWARM_LEAD_MS,
  prewarmTargets,
  sameEntries,
  MAX_TIMER_MS,
  stepSchedulerSet,
  schedulerTimerDelay,
  schedulerViews,
  shownIndices,
  stablePrewarm,
  stableViews,
  STALLED_TICK_RECHECK_MS,
  syncSchedulerSet,
  tickSchedulerSet,
  updateSchedulerInputs,
  type SchedulerEntry,
  type SchedulerSet,
} from '../../src/renderer/src/features/cells/schedulerSet'
import type { BusEvent } from '../../src/renderer/src/state/eventBus'

const T = 1_700_000_000_000

/** A motion-switching cell over `cameraIds`, 10 s rotation, 15 s hold (schema defaults). */
function cell(
  cameraIds: readonly string[],
  overrides: Record<string, unknown> = {},
): SchedulerCell {
  return CellSchema.parse({
    col: 0,
    row: 0,
    cameraIds,
    rotateIntervalSec: 10,
    motionSwitch: true,
    ...overrides,
  })
}

let seq = 0

function ev(overrides: Partial<CameraEvent> & { cameraId: string; start: number }): CameraEvent {
  seq += 1
  return CameraEventSchema.parse({
    id: `e${String(seq)}`,
    trigger: 'motion',
    protectType: 'motion',
    ...overrides,
  })
}

function bus(event: CameraEvent, at: number): BusEvent {
  return { event, at }
}

const NO_REPLAY = (): readonly BusEvent[] => []

function shown(set: SchedulerSet, key: string): string | null {
  const state = set.get(key)
  if (state === undefined) throw new Error(`no scheduler for ${key}`)
  return schedulerView(state).cameraId
}

const ENTRY_A: SchedulerEntry = { key: 'cam:a#0', cell: cell(['a', 'b', 'c']) }
const ENTRY_X: SchedulerEntry = { key: 'cam:x#0', cell: cell(['x', 'y']) }
const SINGLE: SchedulerEntry = { key: 'cam:s#0', cell: cell(['s']) }

describe('createReplayedScheduler', () => {
  it('is exactly createScheduler without a replay', () => {
    expect(createReplayedScheduler(ENTRY_A.cell, [], T)).toEqual(createScheduler(ENTRY_A.cell, T))
  })

  it('is createScheduler too when nothing in the replay matches', () => {
    const replay = [bus(ev({ cameraId: 'other', start: T - 30_000 }), T - 30_000)]
    expect(createReplayedScheduler(ENTRY_A.cell, replay, T)).toEqual(
      createScheduler(ENTRY_A.cell, T),
    )
  })

  it('shows the camera of an event still running when the cell mounts', () => {
    const add = ev({ cameraId: 'c', start: T - 20_000 })
    const state = createReplayedScheduler(ENTRY_A.cell, [bus(add, T - 20_000)], T)
    expect(schedulerView(state)).toMatchObject({ cameraId: 'c', reason: 'trigger' })
  })

  it('does not show an event as a trigger once its hold ran out before mount', () => {
    const add = ev({ cameraId: 'c', start: T - 60_000 })
    const replay = [bus(add, T - 60_000), bus({ ...add, end: T - 50_000 }, T - 46_000)]
    // Held until T − 50 s + 15 s = T − 35 s: over by mount. As on a cell that had been on screen
    // (without rotation), the cell stays on the camera that was held, and rotation — switched on
    // at mount — runs from it with a full interval.
    const state = createReplayedScheduler(ENTRY_A.cell, replay, T)
    expect(schedulerView(state)).toMatchObject({
      cameraId: 'c',
      reason: 'rotation',
      trigger: null,
    })
    expect(nextWakeAt(state)).toBe(T + 10_000)
  })

  it('is on the first camera when the replay never triggered the cell', () => {
    const other = ev({ cameraId: 'x', start: T - 60_000 })
    const state = createReplayedScheduler(ENTRY_A.cell, [bus(other, T - 60_000)], T)
    expect(schedulerView(state)).toMatchObject({ cameraId: 'a', index: 0, reason: 'rotation' })
  })

  it('measures the hold from the original arrival, not from mount', () => {
    // Ended 10 s before mount (end update 4 s late): held 5 s more, not 15.
    const add = ev({ cameraId: 'b', start: T - 30_000 })
    const replay = [bus(add, T - 30_000), bus({ ...add, end: T - 10_000 }, T - 6_000)]
    const state = createReplayedScheduler(ENTRY_A.cell, replay, T)
    expect(schedulerView(state).cameraId).toBe('b')
    expect(nextWakeAt(state)).toBe(T + 5_000)
    // At T + 5 s the hold is over, and rotation resumes from the held camera.
    const after = reduceScheduler(state, { type: 'tick', now: T + 5_000 })
    expect(schedulerView(after)).toMatchObject({ cameraId: 'b', reason: 'rotation' })
  })

  it('starts the rotation timer at mount, on the first camera, however long the replay spans', () => {
    const old = ev({ cameraId: 'other', start: T - 200_000 })
    const state = createReplayedScheduler(ENTRY_A.cell, [bus(old, T - 200_000)], T)
    expect(schedulerView(state)).toMatchObject({ index: 0, reason: 'rotation' })
    expect(state.nextRotateAt).toBe(T + 10_000)
    expect(state.cell.rotateIntervalSec).toBe(10)
  })

  it('keeps the stale timeout from the original first sight', () => {
    const add = ev({ cameraId: 'c', start: T - 50_000 })
    const state = createReplayedScheduler(ENTRY_A.cell, [bus(add, T - 50_000)], T)
    // Stale 60 s after it was first seen, i.e. 10 s after mount; then held 15 s.
    expect(nextWakeAt(state)).toBe(T + 10_000)
  })

  it('takes a message stamped in the future as arriving now', () => {
    const add = ev({ cameraId: 'b', start: T })
    const state = createReplayedScheduler(ENTRY_A.cell, [bus(add, T + 5_000)], T)
    expect(state.at).toBe(T)
    expect(schedulerView(state).cameraId).toBe('b')
  })
})

describe('syncSchedulerSet', () => {
  it('creates a scheduler only for cells with two or more cameras', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, SINGLE, ENTRY_X], T, NO_REPLAY)
    expect([...set.keys()]).toEqual([ENTRY_A.key, ENTRY_X.key])
  })

  it('returns the same object when nothing changed', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    expect(syncSchedulerSet(set, [ENTRY_A, ENTRY_X], T, NO_REPLAY)).toBe(set)
    expect(
      syncSchedulerSet(set, [{ ...ENTRY_A, cell: { ...ENTRY_A.cell } }], T, NO_REPLAY),
    ).not.toBe(
      set, // ENTRY_X dropped
    )
    expect(syncSchedulerSet(EMPTY_SCHEDULER_SET, [SINGLE], T, NO_REPLAY)).toBe(EMPTY_SCHEDULER_SET)
  })

  it('configures an existing key, keeping the camera on screen by id', () => {
    let set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A], T, NO_REPLAY)
    set = tickSchedulerSet(set, T + 10_000) // rotated to b
    expect(shown(set, ENTRY_A.key)).toBe('b')
    const edited = { key: ENTRY_A.key, cell: cell(['a', 'z', 'b']) }
    const next = syncSchedulerSet(set, [edited], T + 11_000, NO_REPLAY)
    expect(shown(next, ENTRY_A.key)).toBe('b')
    expect(next.get(ENTRY_A.key)?.index).toBe(2)
  })

  it('drops keys no longer listed, and a cell that went down to one camera', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    const next = syncSchedulerSet(
      set,
      [{ key: ENTRY_A.key, cell: cell(['a']) }, ENTRY_X],
      T,
      NO_REPLAY,
    )
    expect([...next.keys()]).toEqual([ENTRY_X.key])
    expect(next.get(ENTRY_X.key)).toBe(set.get(ENTRY_X.key))
  })

  it('reads the replay once, and only when it creates a scheduler', () => {
    let reads = 0
    const replay = (): readonly BusEvent[] => {
      reads += 1
      return []
    }
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, replay)
    expect(reads).toBe(1)
    syncSchedulerSet(set, [ENTRY_A, ENTRY_X], T, replay)
    expect(reads).toBe(1)
  })

  it('replays the buffer into a newly created scheduler', () => {
    const add = ev({ cameraId: 'y', start: T - 5_000 })
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_X], T, () => [bus(add, T - 5_000)])
    expect(shown(set, ENTRY_X.key)).toBe('y')
  })
})

describe('applyBusEvent', () => {
  const base = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)

  it('changes only the schedulers whose cell the event matches', () => {
    const next = applyBusEvent(base, bus(ev({ cameraId: 'c', start: T }), T + 1_000))
    expect(next).not.toBe(base)
    expect(shown(next, ENTRY_A.key)).toBe('c')
    expect(next.get(ENTRY_X.key)).toBe(base.get(ENTRY_X.key))
  })

  it('returns the same set for an event no cell matches, even when a rotation is due', () => {
    const next = applyBusEvent(base, bus(ev({ cameraId: 'nobody', start: T }), T + 60_000))
    expect(next).toBe(base)
  })

  it('is idempotent on repeats, through applyBusEvents', () => {
    const add = ev({ cameraId: 'b', start: T })
    const once = applyBusEvent(base, bus(add, T + 100))
    expect(applyBusEvents(once, [bus(add, T + 100), bus(add, T + 200)])).toBe(once)
  })

  it('applies at the arrival time', () => {
    const add = ev({ cameraId: 'x', start: T })
    const next = applyBusEvent(base, bus(add, T + 2_000))
    expect(next.get(ENTRY_X.key)?.at).toBe(T + 2_000)
  })
})

describe('pinSchedulerSet (FILL-3)', () => {
  const base = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
  const pinned = (set: SchedulerSet): string[] =>
    [...set].filter(([, state]) => state.pinned).map(([key]) => key)

  it('pins one key and leaves the others alone', () => {
    const next = pinSchedulerSet(base, ENTRY_A.key, T)
    expect(pinned(next)).toEqual([ENTRY_A.key])
    expect(next.get(ENTRY_X.key)).toBe(base.get(ENTRY_X.key))
  })

  it('is the same object when already in that state', () => {
    const next = pinSchedulerSet(base, ENTRY_A.key, T)
    expect(pinSchedulerSet(next, ENTRY_A.key, T + 1)).toBe(next)
    expect(pinSchedulerSet(base, null, T)).toBe(base)
    expect(pinSchedulerSet(base, 'cam:single#0', T)).toBe(base)
  })

  it('moves the pin when another key is filled, and unpins all on null', () => {
    const a = pinSchedulerSet(base, ENTRY_A.key, T)
    const x = pinSchedulerSet(a, ENTRY_X.key, T + 1)
    expect(pinned(x)).toEqual([ENTRY_X.key])
    expect(pinned(pinSchedulerSet(x, null, T + 2))).toEqual([])
  })

  it('freezes the shown camera through rotation and events', () => {
    let set = pinSchedulerSet(base, ENTRY_A.key, T)
    set = tickSchedulerSet(set, T + 30_000)
    set = applyBusEvent(set, bus(ev({ cameraId: 'c', start: T + 30_000 }), T + 30_000))
    expect(shown(set, ENTRY_A.key)).toBe('a')
    expect(shown(pinSchedulerSet(set, null, T + 31_000), ENTRY_A.key)).toBe('c')
  })
})

describe('stepSchedulerSet (P4.3; CELL-3)', () => {
  const base = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)

  it('steps only the cell at the key', () => {
    const next = stepSchedulerSet(base, ENTRY_A.key, 'next', T + 1_000)
    expect(next).not.toBe(base)
    expect(shown(next, ENTRY_A.key)).toBe('b')
    expect(next.get(ENTRY_X.key)).toBe(base.get(ENTRY_X.key))
  })

  it('is the same set for a key with no scheduler', () => {
    expect(stepSchedulerSet(base, SINGLE.key, 'next', T + 1_000)).toBe(base)
    expect(stepSchedulerSet(base, 'cam:nobody#0', 'prev', T + 1_000)).toBe(base)
  })

  it('wraps around both ways', () => {
    expect(shown(stepSchedulerSet(base, ENTRY_A.key, 'prev', T + 1_000), ENTRY_A.key)).toBe('c')
    let set = base
    for (const t of [1, 2, 3]) set = stepSchedulerSet(set, ENTRY_A.key, 'next', T + t)
    expect(shown(set, ENTRY_A.key)).toBe('a')
  })

  it('restarts the interval from the step', () => {
    const next = stepSchedulerSet(base, ENTRY_A.key, 'next', T + 7_000)
    expect(nextWakeAt(next.get(ENTRY_A.key) ?? createScheduler(ENTRY_A.cell, T))).toBe(T + 17_000)
  })

  it('dismisses the active trigger and steps from the camera it showed', () => {
    const triggered = applyBusEvent(base, bus(ev({ cameraId: 'b', start: T }), T + 1_000))
    expect(shown(triggered, ENTRY_A.key)).toBe('b')
    const next = stepSchedulerSet(triggered, ENTRY_A.key, 'next', T + 2_000)
    const view = schedulerView(next.get(ENTRY_A.key) ?? createScheduler(ENTRY_A.cell, T))
    expect(view).toMatchObject({ cameraId: 'c', reason: 'rotation', trigger: null })
  })

  it('in fill changes the pinned camera and stays pinned', () => {
    const pinned = pinSchedulerSet(base, ENTRY_A.key, T)
    const next = stepSchedulerSet(pinned, ENTRY_A.key, 'prev', T + 1_000)
    const state = next.get(ENTRY_A.key)
    expect(state?.pinned).toBe(true)
    expect(shown(next, ENTRY_A.key)).toBe('c')
    // Still frozen: rotation does not move it.
    expect(shown(tickSchedulerSet(next, T + 60_000), ENTRY_A.key)).toBe('c')
  })
})

describe('tickSchedulerSet and nextWakeOfSet', () => {
  it('is null for an empty set, or one with nothing to wait for', () => {
    expect(nextWakeOfSet(EMPTY_SCHEDULER_SET)).toBeNull()
    const still = syncSchedulerSet(
      EMPTY_SCHEDULER_SET,
      [{ key: 'k', cell: cell(['a', 'b'], { rotateIntervalSec: undefined }) }],
      T,
      NO_REPLAY,
    )
    expect(nextWakeOfSet(still)).toBeNull()
  })

  it('is the earliest wake across the set', () => {
    const slow = { key: 'slow', cell: cell(['a', 'b'], { rotateIntervalSec: 30 }) }
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [slow, ENTRY_X], T, NO_REPLAY)
    expect(nextWakeOfSet(set)).toBe(T + 10_000)
  })

  it('a tick before the wake changes nothing; at the wake it does', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A], T, NO_REPLAY)
    expect(tickSchedulerSet(set, T + 9_999)).toBe(set)
    const next = tickSchedulerSet(set, T + 10_000)
    expect(next).not.toBe(set)
    expect(shown(next, ENTRY_A.key)).toBe('b')
  })
})

describe('schedulerViews and shownIndices', () => {
  it('reads what each scheduler shows, by key', () => {
    let set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    set = applyBusEvent(set, bus(ev({ cameraId: 'y', start: T }), T))
    const views = schedulerViews(set)
    expect(views.get(ENTRY_A.key)).toMatchObject({ index: 0, count: 3, reason: 'rotation' })
    expect(views.get(ENTRY_X.key)).toMatchObject({ index: 1, cameraId: 'y', reason: 'trigger' })
    expect([...shownIndices(views)]).toEqual([
      [ENTRY_A.key, 0],
      [ENTRY_X.key, 1],
    ])
  })
})

describe('schedulerTimerDelay', () => {
  it('waits until the wake, never negative and never past the longest setTimeout', () => {
    expect(schedulerTimerDelay(T + 2500, T, false)).toBe(2500)
    expect(schedulerTimerDelay(T - 10, T, false)).toBe(0)
    expect(schedulerTimerDelay(T + 2 * MAX_TIMER_MS, T, false)).toBe(MAX_TIMER_MS)
  })

  it('re-checks after the floor when a due tick changed nothing, never at 0 ms', () => {
    expect(STALLED_TICK_RECHECK_MS).toBeGreaterThanOrEqual(1000)
    expect(schedulerTimerDelay(T - 5000, T, true)).toBe(STALLED_TICK_RECHECK_MS)
    expect(schedulerTimerDelay(T, T, true)).toBe(STALLED_TICK_RECHECK_MS)
  })
})

describe('stableViews', () => {
  it('builds the views from scratch without a previous map', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    expect([...stableViews(null, set)]).toEqual([...schedulerViews(set)])
  })

  it('returns the previous map when the set changed but no view did', () => {
    let set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    set = applyBusEvent(set, bus(ev({ cameraId: 'y', start: T }), T))
    const views = stableViews(null, set)
    // A second motion event on `y`, already shown for the first: the scheduler stores it (a new
    // set), but `x`'s cell still shows `y` for a motion trigger, and `a`'s cell is untouched.
    const next = applyBusEvent(set, bus(ev({ cameraId: 'y', start: T + 1 }), T + 1))
    expect(next).not.toBe(set)
    expect(stableViews(views, next)).toBe(views)
  })

  it('returns the previous map when an event ends on the camera already shown', () => {
    const add = ev({ cameraId: 'y', start: T })
    const set = applyBusEvent(
      syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY),
      bus(add, T),
    )
    const views = stableViews(null, set)
    // The end starts the hold: `x`'s cell still shows `y` for the same motion trigger.
    const ended = applyBusEvent(set, bus({ ...add, end: T + 2_000 }, T + 2_000))
    expect(ended).not.toBe(set)
    expect(stableViews(views, ended)).toBe(views)
  })

  it('reuses unchanged view objects and replaces only the one that moved', () => {
    const set = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    const views = stableViews(null, set)
    const next = applyBusEvent(set, bus(ev({ cameraId: 'y', start: T }), T))
    const stable = stableViews(views, next)
    expect(stable).not.toBe(views)
    expect(stable.get(ENTRY_A.key)).toBe(views.get(ENTRY_A.key))
    expect(stable.get(ENTRY_X.key)).toMatchObject({ cameraId: 'y', reason: 'trigger' })
  })

  it('is a new map when a key appears or disappears', () => {
    const both = syncSchedulerSet(EMPTY_SCHEDULER_SET, [ENTRY_A, ENTRY_X], T, NO_REPLAY)
    const views = stableViews(null, both)
    const onlyA = syncSchedulerSet(both, [ENTRY_A], T, NO_REPLAY)
    const shrunk = stableViews(views, onlyA)
    expect(shrunk).not.toBe(views)
    expect([...shrunk.keys()]).toEqual([ENTRY_A.key])
    expect(shrunk.get(ENTRY_A.key)).toBe(views.get(ENTRY_A.key))
    const swapped = syncSchedulerSet(onlyA, [ENTRY_X], T, NO_REPLAY)
    expect(stableViews(shrunk, swapped)).not.toBe(shrunk)
  })
})

describe('the hook’s render-time inputs', () => {
  it('compares entries by content', () => {
    const copy = { key: ENTRY_A.key, cell: { ...ENTRY_A.cell, cameraIds: ['a', 'b', 'c'] } }
    expect(sameEntries([ENTRY_A], [copy])).toBe(true)
    expect(sameEntries([ENTRY_A], [{ ...copy, key: 'other' }])).toBe(false)
    expect(sameEntries([ENTRY_A], [{ ...copy, cell: { ...copy.cell, motionHoldSec: 30 } }])).toBe(
      false,
    )
    expect(sameEntries([ENTRY_A], [ENTRY_A, ENTRY_X])).toBe(false)
  })

  it('is the same object when neither the entries nor the pinned key changed', () => {
    const inputs = initialSchedulerInputs([ENTRY_A], null, T, NO_REPLAY)
    const rebuilt = [{ key: ENTRY_A.key, cell: { ...ENTRY_A.cell } }]
    expect(updateSchedulerInputs(inputs, rebuilt, null, T + 5_000, NO_REPLAY)).toBe(inputs)
  })

  it('syncs on a change of entries and pins on a change of key', () => {
    const inputs = initialSchedulerInputs([ENTRY_A], null, T, NO_REPLAY)
    const synced = updateSchedulerInputs(inputs, [ENTRY_A, ENTRY_X], null, T, NO_REPLAY)
    expect([...synced.set.keys()]).toEqual([ENTRY_A.key, ENTRY_X.key])
    const pinnedInputs = updateSchedulerInputs(
      synced,
      [ENTRY_A, ENTRY_X],
      ENTRY_X.key,
      T,
      NO_REPLAY,
    )
    expect(pinnedInputs.set.get(ENTRY_X.key)?.pinned).toBe(true)
    expect(pinnedInputs.entries).toBe(synced.entries)
  })

  it('pins a scheduler created for the filled slot at once', () => {
    const inputs = initialSchedulerInputs([ENTRY_A], ENTRY_X.key, T, NO_REPLAY)
    const next = updateSchedulerInputs(inputs, [ENTRY_A, ENTRY_X], ENTRY_X.key, T, NO_REPLAY)
    expect(next.set.get(ENTRY_X.key)?.pinned).toBe(true)
    expect(
      initialSchedulerInputs([ENTRY_A], ENTRY_A.key, T, NO_REPLAY).set.get(ENTRY_A.key)?.pinned,
    ).toBe(true)
  })
})

describe('pre-warm (P4.4)', () => {
  const LEAD = PREWARM_LEAD_MS
  const synced = (entries: readonly SchedulerEntry[]): SchedulerSet =>
    syncSchedulerSet(EMPTY_SCHEDULER_SET, entries, T, NO_REPLAY)

  it('leads by 2 s, well inside the 5 s minimum interval', () => {
    expect(PREWARM_LEAD_MS).toBe(2000)
  })

  it('names a slot from the lead before its step until the step, and drops it at the step', () => {
    const set = synced([ENTRY_A, SINGLE])
    expect([...prewarmTargets(set, T)]).toEqual([])
    expect([...prewarmTargets(set, T + 10_000 - LEAD - 1)]).toEqual([])
    expect([...prewarmTargets(set, T + 10_000 - LEAD)]).toEqual([[ENTRY_A.key, 'b']])
    expect([...prewarmTargets(set, T + 9_999)]).toEqual([[ENTRY_A.key, 'b']])
    // The step moves the cell to `b`; its next step is a whole interval away.
    const stepped = tickSchedulerSet(set, T + 10_000)
    expect(shown(stepped, ENTRY_A.key)).toBe('b')
    expect([...prewarmTargets(stepped, T + 10_000)]).toEqual([])
    expect([...prewarmTargets(stepped, T + 20_000 - LEAD)]).toEqual([[ENTRY_A.key, 'c']])
  })

  it('still names an overdue step until the tick lands', () => {
    expect([...prewarmTargets(synced([ENTRY_A]), T + 60_000)]).toEqual([[ENTRY_A.key, 'b']])
  })

  it('names every slot in its lead, each with its own camera', () => {
    const slow = { key: 'slow', cell: cell(['p', 'q'], { rotateIntervalSec: 11 }) }
    const set = synced([ENTRY_A, slow])
    expect([...prewarmTargets(set, T + 9_000)]).toEqual([
      [ENTRY_A.key, 'b'],
      ['slow', 'q'],
    ])
  })

  it('never names a triggered, pinned or non-rotating cell', () => {
    const still = { key: 'still', cell: cell(['p', 'q'], { rotateIntervalSec: undefined }) }
    const base = synced([ENTRY_A, ENTRY_X, still])
    const nearStep = T + 10_000 - LEAD
    // `x`'s cell triggered on `y`, `a`'s pinned (filled).
    const set = pinSchedulerSet(
      applyBusEvent(base, bus(ev({ cameraId: 'y', start: T }), T)),
      ENTRY_A.key,
      T,
    )
    expect([...prewarmTargets(set, nearStep)]).toEqual([])
    expect(nextPrewarmAt(set, T)).toBeNull()
  })

  it('drops the target when a trigger breaks in during the lead', () => {
    const set = synced([ENTRY_A])
    const lead = T + 10_000 - LEAD + 500
    expect(prewarmTargets(set, lead).get(ENTRY_A.key)).toBe('b')
    const triggered = applyBusEvent(set, bus(ev({ cameraId: 'c', start: lead }), lead))
    expect(shown(triggered, ENTRY_A.key)).toBe('c')
    expect(prewarmTargets(triggered, lead).size).toBe(0)
  })

  it('a manual step during the lead lands on the target and restarts the interval', () => {
    const set = synced([ENTRY_A])
    const lead = T + 10_000 - LEAD + 500
    expect(prewarmTargets(set, lead).get(ENTRY_A.key)).toBe('b')
    const stepped = stepSchedulerSet(set, ENTRY_A.key, 'next', lead)
    expect(shown(stepped, ENTRY_A.key)).toBe('b')
    expect(prewarmTargets(stepped, lead).size).toBe(0)
    expect(nextPrewarmAt(stepped, lead)).toBe(lead + 10_000 - LEAD)
  })

  describe('stablePrewarm', () => {
    it('is the shared empty map with nothing to pre-warm', () => {
      const set = synced([ENTRY_A])
      expect(stablePrewarm(null, set, T)).toBe(NO_PREWARM)
      expect(stablePrewarm(NO_PREWARM, set, T)).toBe(NO_PREWARM)
    })

    it('keeps the previous map while the targets are the same, across set changes', () => {
      const set = synced([ENTRY_A, ENTRY_X])
      const lead = T + 10_000 - LEAD
      const first = stablePrewarm(null, set, lead)
      expect([...first]).toEqual([
        [ENTRY_A.key, 'b'],
        [ENTRY_X.key, 'y'],
      ])
      expect(stablePrewarm(first, set, lead + 1_000)).toBe(first)
      // A new set — an event on another cell's camera — with the same targets keeps the map too.
      const unrelated = { key: 'u', cell: cell(['u', 'v'], { rotateIntervalSec: undefined }) }
      const withU = synced([ENTRY_A, ENTRY_X, unrelated])
      const kept = stablePrewarm(null, withU, lead)
      const moved = applyBusEvent(withU, bus(ev({ cameraId: 'v', start: lead }), lead))
      expect(moved).not.toBe(withU)
      expect(stablePrewarm(kept, moved, lead)).toBe(kept)
    })

    it('is a new map when a target starts, changes or ends', () => {
      const set = synced([ENTRY_A])
      const before = stablePrewarm(null, set, T)
      const started = stablePrewarm(before, set, T + 10_000 - LEAD)
      expect(started).not.toBe(before)
      expect([...started]).toEqual([[ENTRY_A.key, 'b']])
      const stepped = tickSchedulerSet(set, T + 10_000)
      const ended = stablePrewarm(started, stepped, T + 10_000)
      expect(ended).toBe(NO_PREWARM)
      const changed = stablePrewarm(new Map([[ENTRY_A.key, 'c']]), set, T + 10_000 - LEAD)
      expect([...changed]).toEqual([[ENTRY_A.key, 'b']])
    })
  })

  describe('nextPrewarmAt', () => {
    it('is null for an empty set and for one with no rotation coming', () => {
      expect(nextPrewarmAt(EMPTY_SCHEDULER_SET, T)).toBeNull()
      expect(nextPrewarmAt(synced([SINGLE]), T)).toBeNull()
    })

    it('is the earliest start strictly after now, so a timer that fires on time moves on', () => {
      const slow = { key: 'slow', cell: cell(['p', 'q'], { rotateIntervalSec: 30 }) }
      const set = synced([ENTRY_A, slow])
      expect(nextPrewarmAt(set, T)).toBe(T + 10_000 - LEAD)
      // Fired at (or after) the first start: that one is already a target, the next is `slow`'s.
      expect(nextPrewarmAt(set, T + 10_000 - LEAD)).toBe(T + 30_000 - LEAD)
      expect(nextPrewarmAt(set, T + 30_000 - LEAD)).toBeNull()
    })

    it('re-arms for the same start when it fires early', () => {
      const set = synced([ENTRY_A])
      expect(nextPrewarmAt(set, T + 10_000 - LEAD - 1)).toBe(T + 10_000 - LEAD)
    })
  })
})
