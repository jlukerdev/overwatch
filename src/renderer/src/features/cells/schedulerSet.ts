// The schedulers of the multi-camera cells on screen (P4.2; CELL-2, FILL-3): one `cellScheduler`
// per grid slot whose cell holds two or more cameras, keyed by the slot's key (gridLayout.ts,
// `schedulerEntries`). Pure, like the reducer it drives, so every rule is tested in the node
// environment (CLAUDE.md); `useCellSchedulers` only keeps the set in React state, feeds it the bus
// and a timer, and reads the views back.
//
// The rules, and why:
//
//  - **Only cells with two or more cameras get a scheduler.** A one-camera cell has nothing to
//    choose; the grid draws its camera as before (CELL-1). A cell that drops to one camera loses its
//    scheduler, and gets a fresh one if a second camera comes back.
//  - **Same key, same scheduler.** The key is the slot's, which follows the cell's *first* camera and
//    not the one shown (gridLayout.ts header), so rotation never changes it. A View edit that keeps
//    the key is a `configure` (the reducer keeps the shown camera by id and re-filters its events);
//    a key that disappears takes its scheduler with it.
//  - **A new scheduler replays the bus at the original arrival times** ({@link
//    createReplayedScheduler}). A cell mounted mid-event — a View switch, coming back from Settings —
//    must show a trigger that is still active, with its hold measured from when the event really
//    arrived. The reducer never lets time run backwards, so the replay starts the scheduler at the
//    first buffered arrival **with rotation off** (no rotation may happen during a replay: it would
//    only spin through cameras nobody saw), feeds each message at its own `at`, then `configure`s the
//    real cell at `now` — which switches rotation on, so its timer starts from now — and ticks at
//    `now`. The cell is then where it would be had it been on screen without rotation: on its first
//    camera if nothing triggered it, on the trigger camera while a trigger is active, and on the
//    camera that was last held if a trigger came and went before mount (the reducer's "rotation
//    resumes from the held camera"; a motion-only cell would have stayed on it too).
//  - **An event reaches only the schedulers it matches** (`eventMatchesCell`). Every reducer action
//    applies its time first, so handing an event to a cell it does not concern would still be a
//    tick for it; skipping it keeps unrelated cells' state (and their memoised views) untouched.
//  - **Pin follows the filled slot** ({@link pinSchedulerSet}, FILL-3): the one key pinned, every other
//    pinned one unpinned — so filling a second cell, or leaving fill, releases the first.
//  - **A manual step reaches only its own cell** ({@link stepSchedulerSet}, P4.3; CELL-3): the
//    overlay's next / previous buttons act on the cell they sit on, and the reducer's own rule
//    applies — in the grid it dismisses the triggers active then and restarts the interval; in fill
//    it only changes the pinned camera (FILL-3). Every other scheduler stays the same object.
//  - **Same object when nothing changed**, set and views alike, so React bails out. The views go
//    further ({@link stableViews}): a set that changed (a tick, an event that moved no camera) still
//    yields the previous views map when no shown camera, position or reason differs.
import {
  createScheduler,
  eventMatchesCell,
  nextWakeAt,
  reduceScheduler,
  sameSchedulerCell,
  schedulerView,
  type SchedulerCell,
  type SchedulerState,
  type SchedulerView,
} from './cellScheduler'
import type { BusEvent } from '../../state/eventBus'

/** The schedulers on screen, by grid slot key. */
export type SchedulerSet = ReadonlyMap<string, SchedulerState>

/** One grid slot that may need a scheduler: its key and its cell's CELL-2 settings. */
export interface SchedulerEntry {
  readonly key: string
  readonly cell: SchedulerCell
}

export const EMPTY_SCHEDULER_SET: SchedulerSet = new Map()

/**
 * Fewer cameras than this and a cell shows its one camera, no scheduler (header). Also where the
 * overlay's position and next / previous controls start (./cellPosition), so a cell has those
 * controls exactly when it has a scheduler for them to step.
 */
export const MIN_SCHEDULED_CAMERAS = 2

function needsScheduler(cell: SchedulerCell): boolean {
  return cell.cameraIds.length >= MIN_SCHEDULED_CAMERAS
}

/**
 * A scheduler for `cell` created at `now` that has already seen `replay`, at the times it arrived
 * (header). Messages stamped after `now` are taken as arriving at `now`. Without a replay it is
 * exactly `createScheduler(cell, now)`.
 */
export function createReplayedScheduler(
  cell: SchedulerCell,
  replay: readonly BusEvent[],
  now: number,
): SchedulerState {
  const first = replay[0]
  if (first === undefined) return createScheduler(cell, now)
  let state = createScheduler({ ...cell, rotateIntervalSec: undefined }, Math.min(first.at, now))
  for (const { event, at } of replay) {
    state = reduceScheduler(state, { type: 'event', event, now: Math.min(at, now) })
  }
  state = reduceScheduler(state, { type: 'configure', cell, now })
  return reduceScheduler(state, { type: 'tick', now })
}

/**
 * The set for the slots on screen now: a scheduler for each entry with ≥ 2 cameras — the existing
 * one `configure`d, or a new one replayed from `replay()`, which is called at most once and only when
 * a scheduler is created — and none for keys no longer listed. Same object when nothing changed.
 */
export function syncSchedulerSet(
  set: SchedulerSet,
  entries: readonly SchedulerEntry[],
  now: number,
  replay: () => readonly BusEvent[],
): SchedulerSet {
  let replayed: readonly BusEvent[] | null = null
  let changed = false
  const next = new Map<string, SchedulerState>()
  for (const { key, cell } of entries) {
    if (!needsScheduler(cell) || next.has(key)) continue
    const existing = set.get(key)
    let state: SchedulerState
    if (existing === undefined) {
      replayed ??= replay()
      state = createReplayedScheduler(cell, replayed, now)
    } else {
      state = reduceScheduler(existing, { type: 'configure', cell, now })
    }
    if (state !== existing) changed = true
    next.set(key, state)
  }
  return changed || next.size !== set.size ? next : set
}

/** `update` applied to every scheduler; the same set when it changes none. */
function mapSet(
  set: SchedulerSet,
  update: (key: string, state: SchedulerState) => SchedulerState,
): SchedulerSet {
  let next: Map<string, SchedulerState> | null = null
  for (const [key, state] of set) {
    const updated = update(key, state)
    if (updated === state) continue
    next ??= new Map(set)
    next.set(key, updated)
  }
  return next ?? set
}

/** One bus message, at its arrival time, to the schedulers whose cell it matches (header). */
export function applyBusEvent(set: SchedulerSet, busEvent: BusEvent): SchedulerSet {
  const { event, at } = busEvent
  return mapSet(set, (_key, state) =>
    eventMatchesCell(state.cell, event)
      ? reduceScheduler(state, { type: 'event', event, now: at })
      : state,
  )
}

/** {@link applyBusEvent} for each message in order. */
export function applyBusEvents(set: SchedulerSet, busEvents: readonly BusEvent[]): SchedulerSet {
  return busEvents.reduce(applyBusEvent, set)
}

/** Time passing, for every scheduler: what the timer at {@link nextWakeOfSet} calls. */
export function tickSchedulerSet(set: SchedulerSet, now: number): SchedulerSet {
  return mapSet(set, (_key, state) => reduceScheduler(state, { type: 'tick', now }))
}

/** FILL-3: pins `pinnedKey`'s scheduler (if it has one) and unpins every other pinned one. */
export function pinSchedulerSet(
  set: SchedulerSet,
  pinnedKey: string | null,
  now: number,
): SchedulerSet {
  return mapSet(set, (key, state) => {
    const pin = key === pinnedKey
    if (pin === state.pinned) return state
    return reduceScheduler(state, { type: pin ? 'pin' : 'unpin', now })
  })
}

/** A step of the manual next / previous control. */
export type StepDirection = 'next' | 'prev'

/**
 * The user's next / previous on the cell at `key` (header): only that scheduler is reduced, at
 * `now`. The same set when `key` has no scheduler (a one-camera cell) or the step changed nothing.
 */
export function stepSchedulerSet(
  set: SchedulerSet,
  key: string,
  direction: StepDirection,
  now: number,
): SchedulerSet {
  const state = set.get(key)
  if (state === undefined) return set
  const stepped = reduceScheduler(state, { type: direction, now })
  if (stepped === state) return set
  const next = new Map(set)
  next.set(key, stepped)
  return next
}

/** The earliest `nextWakeAt` across the set; `null` when no scheduler needs a tick. */
export function nextWakeOfSet(set: SchedulerSet): number | null {
  let wake: number | null = null
  for (const state of set.values()) {
    const at = nextWakeAt(state)
    if (at !== null && (wake === null || at < wake)) wake = at
  }
  return wake
}

/** The longest single `setTimeout` (2^31 − 1 ms); a later wake re-arms when this one fires. */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * The floor before the set's timer looks again after a tick at or past the wake time changed
 * nothing. The reducer should never do that (a due wake always moves something), but if it did, the
 * hook's timer effect — keyed on the set — would never re-arm and rotation would stall for good;
 * re-checking after a second is the cheap guard, and the floor keeps it from ever being a busy loop.
 */
export const STALLED_TICK_RECHECK_MS = 1000

/**
 * How long the hook's one timer waits: until `wake` (never negative, at most {@link MAX_TIMER_MS}),
 * or {@link STALLED_TICK_RECHECK_MS} when the last tick at/after the wake was a no-op (`stalled`).
 */
export function schedulerTimerDelay(wake: number, now: number, stalled: boolean): number {
  if (stalled) return STALLED_TICK_RECHECK_MS
  return Math.min(MAX_TIMER_MS, Math.max(0, wake - now))
}

/** What each scheduler shows (`schedulerView`), by slot key — for the grid and its overlays' position. */
export function schedulerViews(set: SchedulerSet): ReadonlyMap<string, SchedulerView> {
  const views = new Map<string, SchedulerView>()
  for (const [key, state] of set) views.set(key, schedulerView(state))
  return views
}

function sameView(a: SchedulerView, b: SchedulerView): boolean {
  return (
    a.index === b.index &&
    a.cameraId === b.cameraId &&
    a.count === b.count &&
    a.reason === b.reason &&
    a.trigger === b.trigger
  )
}

/**
 * {@link schedulerViews} kept stable against `previous`: `previous` itself when every key's view is
 * field-equal (same keys, same size), else a new map that still reuses each unchanged view object.
 * The set changes on every tick and every matching event — most of which move no camera — and the
 * grid rebuilds every slot when the views map changes, so this is what makes "nothing shown
 * changed" cost nothing downstream.
 */
export function stableViews(
  previous: ReadonlyMap<string, SchedulerView> | null,
  set: SchedulerSet,
): ReadonlyMap<string, SchedulerView> {
  const next = new Map<string, SchedulerView>()
  let changed = previous?.size !== set.size
  for (const [key, state] of set) {
    const view = schedulerView(state)
    const old = previous?.get(key)
    if (old !== undefined && sameView(old, view)) {
      next.set(key, old)
    } else {
      next.set(key, view)
      changed = true
    }
  }
  return changed || previous === null ? next : previous
}

/** Slot key → position in the cell's `cameraIds` shown, as `buildViewSlots`' `shown` takes it. */
export function shownIndices(
  views: ReadonlyMap<string, SchedulerView>,
): ReadonlyMap<string, number> {
  const shown = new Map<string, number>()
  for (const [key, view] of views) shown.set(key, view.index)
  return shown
}

// -------------------------------------------------------------------------------------------------
// The hook's render-time inputs

/**
 * What `useCellSchedulers` keeps in React state: the set and the inputs it was last brought in line
 * with, so a render can tell whether the slots or the filled slot changed.
 */
export interface SchedulerInputs {
  readonly entries: readonly SchedulerEntry[]
  readonly pinnedKey: string | null
  readonly set: SchedulerSet
}

/**
 * Entries equal by content — keys in order and every CELL-2 field — so a rebuild that changes
 * nothing the schedulers read (a quality pick saved to the View, say) is not a sync.
 */
export function sameEntries(a: readonly SchedulerEntry[], b: readonly SchedulerEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((entry, i) => {
    const other = b[i]
    return entry.key === other?.key && sameSchedulerCell(entry.cell, other.cell)
  })
}

/** The hook's first state: synced to `entries` and pinned to `pinnedKey`, at `now`. */
export function initialSchedulerInputs(
  entries: readonly SchedulerEntry[],
  pinnedKey: string | null,
  now: number,
  replay: () => readonly BusEvent[],
): SchedulerInputs {
  const synced = syncSchedulerSet(EMPTY_SCHEDULER_SET, entries, now, replay)
  return { entries, pinnedKey, set: pinSchedulerSet(synced, pinnedKey, now) }
}

/**
 * `inputs` brought in line with the slots and filled slot of this render: synced if the entries
 * changed by content, then pinned if that or the pinned key changed (a new scheduler for the filled
 * slot is pinned at once). The same object when neither changed, which is what keeps the hook's
 * render-time update from looping.
 */
export function updateSchedulerInputs(
  inputs: SchedulerInputs,
  entries: readonly SchedulerEntry[],
  pinnedKey: string | null,
  now: number,
  replay: () => readonly BusEvent[],
): SchedulerInputs {
  const entriesChanged = !sameEntries(inputs.entries, entries)
  if (!entriesChanged && inputs.pinnedKey === pinnedKey) return inputs
  const synced = entriesChanged ? syncSchedulerSet(inputs.set, entries, now, replay) : inputs.set
  return {
    entries: entriesChanged ? entries : inputs.entries,
    pinnedKey,
    set: pinSchedulerSet(synced, pinnedKey, now),
  }
}
