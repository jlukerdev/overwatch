// A multi-camera cell's scheduler (P4.1; CELL-2, FILL-3): which of a cell's cameras is shown, and
// why — rotation on a timer, a trigger event breaking in, or the camera pinned by fill. Pure, so
// every rule is tested in the node environment (CLAUDE.md): no React, no timers, no `Date.now()`,
// no IPC. The caller (P4.2) feeds it the cell's events and a `tick` at {@link nextWakeAt}; every
// action carries `now`, local ms since the epoch. P4.3 draws {@link schedulerView}.
//
// The rules, and why:
//
//  - **Time first, then the action.** Every action first applies the time it carries (as a `tick`
//    would), then does its own thing, so a stale event or a due rotation is never skipped because
//    something else arrived first. Time never runs backwards here: a `now` older than the state's
//    own is treated as no time passing, never a crash. That clock only advances on an action that
//    changes something else, so a tick that changes nothing can return the same object; P4.2 feeds
//    a monotonic clock, so the clamp is a guard, not a mechanism. An action whose `now` is not a
//    finite number, or an event whose `start` / `end` is not, is ignored (same state), so a `NaN`
//    can never poison the clock or a deadline.
//  - **What matches** ({@link eventMatchesCell}). `motionSwitch` on, the event's camera **exactly**
//    one of the cell's (a `<id>:package` entry, CAM-4, is not triggered by `<id>`'s events: package
//    events are unverified, there is no doorbell on the dev network), its trigger one of
//    `motionTriggers`, and for `smartDetect` only, a non-empty `smartDetectTypes` filter must share a
//    type with the event's. An empty filter is no filter. Anything else is dropped, not stored.
//  - **The hold is measured from the `end` timestamp, in local time** (SPEC §5.1). The console's
//    clock may be skewed against ours, so an event's first sight without an `end` (the `add`)
//    records `offset = now − start`: the skew, plus the add's small delivery lag (the end update is
//    the one that lags 3–5 s). An `end` then lands at `end + offset`, clamped to when it arrived — an
//    end is never in the future. The camera is held until `endLocal + motionHoldSec`. An event first
//    seen already ended (we connected mid-event) has no offset to apply: `endLocal = min(end, now)`.
//  - **Idempotent on `(id, end)`.** End updates repeat (2–3× identical, §5.1): the same `end` again
//    is a no-op that returns the same state. A *different* `end` for an event still running or
//    holding is recomputed; one whose hold is over, or that next / previous dismissed, is not
//    brought back. An update without `end` changes nothing we use (update items are full objects).
//  - **Stale after 60 s** ({@link STALE_EVENT_MS}). A running event with no `end` 60 s after we
//    first saw it is treated as ended at that moment, and held after it like any other. Anything
//    later for that id is ignored.
//  - **Nothing grows without bound.** An event whose hold is over stays as a tombstone for
//    {@link TOMBSTONE_MS} — so a late duplicate end cannot resurrect it — and is then pruned, lazily,
//    on whatever action comes next. A message for an id we no longer know could then be a very late
//    one for a pruned event (a stale-closed event's real end, say), so an unknown id is ignored if
//    its `start`, moved to local time by the latest `add`'s offset, is older than the tombstone
//    window — or, without an `end`, older than {@link STALE_EVENT_MS}, as it would already be stale.
//    Until an `add` has given an offset these checks are skipped: comparing console and local time
//    raw would drop every event of a console whose clock is minutes behind.
//  - **Priority** (CELL-2): pinned (FILL-3) beats a trigger beats rotation. Among active events —
//    running, or within their hold — `ring` beats anything else, then the most recent `start` (the
//    console's own timestamps, compared with each other only), then the earlier position in
//    `cameraIds`. A camera listed twice counts at its first position.
//  - **Rotation** steps every `rotateIntervalSec` with two or more cameras, scheduled from the time
//    it was due, so it does not drift. After a sleep that missed more than one interval it steps
//    once and reschedules from now, instead of spinning through the cameras. It is paused, not
//    consulted, while a trigger shows or the cell is pinned.
//  - **Rotation resumes from the held camera** with a full interval when the last trigger is over:
//    the camera that motion brought up is the one to look at last, and it gets its whole turn.
//    Without rotation the cell simply stays on it.
//  - **Pin** (FILL-3) freezes the camera on screen, a trigger's included, until `unpin`. Events are
//    still recorded and aged while pinned, so the state is right on unpin: a trigger still active
//    then shows; otherwise rotation resumes from the pinned camera with a full interval.
//  - **Manual next / previous** (P4.3) steps from the camera on screen. Outside fill it dismisses the
//    events active at that moment — the user has moved on from them; newer events still break in —
//    and restarts the interval. In fill it just changes the pinned camera.
//  - **`configure`** follows a View edit: the shown position stays on the same camera id if it is
//    still in the cell, stored events that no longer match are dropped, and the timer restarts only
//    if the interval changed or rotation was switched on. A new `motionHoldSec` is re-applied to
//    every ended, not dismissed, event from its local end, so the result does not depend on whether
//    the old hold happened to have run out yet.
//  - **Same object when nothing changed**, for React's bail-out; the input is never mutated. The
//    state is plain, readonly, JSON-serialisable data, opaque to callers.
import type { CameraEvent, Cell, MotionTrigger } from '@shared/models'

/** The CELL-2 fields the scheduler reads. A full `Cell` satisfies it. */
export type SchedulerCell = Pick<
  Cell,
  | 'cameraIds'
  | 'rotateIntervalSec'
  | 'motionSwitch'
  | 'motionTriggers'
  | 'smartDetectTypes'
  | 'motionHoldSec'
>

/** CELL-2: a running event with no `end` this long after first sight is treated as ended. */
export const STALE_EVENT_MS = 60_000

/** How long an over event is kept to swallow late messages for its id (header). */
const TOMBSTONE_MS = 5 * 60_000

export type ShownReason = 'rotation' | 'trigger' | 'pinned'

export interface SchedulerView {
  /** Position in `cell.cameraIds` of the camera shown; -1 only when the cell has no cameras. */
  index: number
  cameraId: string | null
  count: number
  reason: ShownReason
  /** The trigger of the winning event when reason === 'trigger', else null. */
  trigger: MotionTrigger | null
  /** True when the shown camera has a matching event still running (no end, not stale) — the motion badge (P4.3). */
  motion: boolean
}

/**
 * One matching event we have seen. `running` has no end yet; `holding` has ended and is within its
 * hold; `over` is a tombstone until `holdUntil + TOMBSTONE_MS`.
 */
interface TrackedEvent {
  readonly id: string
  readonly cameraId: string
  readonly trigger: MotionTrigger
  readonly smartDetectTypes: readonly string[]
  /** Console time; only ever compared with other events' `start`. */
  readonly start: number
  readonly firstSeenAt: number
  /** Local − console time, from the `add`; `null` when first seen already ended. */
  readonly offset: number | null
  readonly phase: 'running' | 'holding' | 'over'
  /** The console `end` last applied, for idempotency; `null` while running or when stale-closed. */
  readonly end: number | null
  readonly endLocal: number | null
  readonly holdUntil: number | null
  readonly stale: boolean
  /** Dismissed by a manual next / previous: recorded, but no longer drives the cell. */
  readonly dismissed: boolean
}

export interface SchedulerState {
  readonly cell: SchedulerCell
  /** The rotation position, or the pinned one while pinned. */
  readonly index: number
  readonly pinned: boolean
  /** Position of the camera the trigger winner shows, kept so rotation resumes from it. */
  readonly triggerIndex: number | null
  /** When rotation next steps; `null` when rotation is off. */
  readonly nextRotateAt: number | null
  readonly events: readonly TrackedEvent[]
  /** Local − console time from the latest recorded `add`; `null` until one (header). */
  readonly offset: number | null
  /** The latest `now` applied; time never runs back past it. */
  readonly at: number
}

export type SchedulerAction =
  | { type: 'event'; event: CameraEvent; now: number }
  | { type: 'tick'; now: number }
  | { type: 'configure'; cell: SchedulerCell; now: number }
  | { type: 'pin'; now: number } // FILL-3: cell filled
  | { type: 'unpin'; now: number } // back to the grid
  | { type: 'next'; now: number } // manual (P4.3)
  | { type: 'prev'; now: number }

// -------------------------------------------------------------------------------------------------
// Matching

function matches(
  cell: SchedulerCell,
  cameraId: string,
  trigger: MotionTrigger,
  types: readonly string[],
): boolean {
  if (!cell.motionSwitch) return false
  if (!cell.cameraIds.includes(cameraId)) return false
  if (!cell.motionTriggers.includes(trigger)) return false
  const filter = cell.smartDetectTypes
  if (trigger === 'smartDetect' && filter !== undefined && filter.length > 0) {
    return types.some((type) => filter.includes(type))
  }
  return true
}

/** Pure predicate, exported for tests and P4.2: does this event count for this cell (camera in cell, motionSwitch on, trigger in motionTriggers, smart-type filter)? */
export function eventMatchesCell(cell: SchedulerCell, event: CameraEvent): boolean {
  return matches(cell, event.cameraId, event.trigger, event.smartDetectTypes)
}

// -------------------------------------------------------------------------------------------------
// Derivations

function rotationIntervalMs(cell: SchedulerCell): number | null {
  return cell.rotateIntervalSec !== undefined && cell.cameraIds.length >= 2
    ? cell.rotateIntervalSec * 1000
    : null
}

function isActive(event: TrackedEvent): boolean {
  return event.phase !== 'over' && !event.dismissed
}

/** The active event that wins the cell (header, "Priority"), with its position; `null` if none. */
function triggerWinner(
  state: SchedulerState,
): { readonly event: TrackedEvent; readonly position: number } | null {
  let best: { event: TrackedEvent; position: number } | null = null
  for (const event of state.events) {
    if (!isActive(event)) continue
    const position = state.cell.cameraIds.indexOf(event.cameraId)
    if (position < 0) continue
    if (best === null || beats(event, position, best.event, best.position)) {
      best = { event, position }
    }
  }
  return best
}

function beats(a: TrackedEvent, aPos: number, b: TrackedEvent, bPos: number): boolean {
  const aRing = a.trigger === 'ring'
  const bRing = b.trigger === 'ring'
  if (aRing !== bRing) return aRing
  if (a.start !== b.start) return a.start > b.start
  return aPos < bPos
}

/**
 * The position on screen: pinned, else the trigger winner's, else rotation's. Reads the stored
 * `triggerIndex`, which `settleTriggers` keeps on the winner — so only on a settled state.
 */
function shownIndex(state: SchedulerState): number {
  if (state.pinned) return state.index
  return state.triggerIndex ?? state.index
}

function withHold(
  endLocal: number,
  hold: number,
  now: number,
): Pick<TrackedEvent, 'endLocal' | 'holdUntil' | 'phase'> {
  const holdUntil = endLocal + hold * 1000
  return { endLocal, holdUntil, phase: holdUntil > now ? 'holding' : 'over' }
}

// -------------------------------------------------------------------------------------------------
// Steps. Each returns its input when it changes nothing.

/** Ages events to `now`: stale-closes, ends holds, prunes tombstones. */
function ageEvents(state: SchedulerState, now: number): SchedulerState {
  let changed = false
  const events: TrackedEvent[] = []
  for (const event of state.events) {
    let next = event
    if (next.phase === 'running' && now >= next.firstSeenAt + STALE_EVENT_MS) {
      const endLocal = next.firstSeenAt + STALE_EVENT_MS
      next = { ...next, ...withHold(endLocal, state.cell.motionHoldSec, now), stale: true }
    } else if (next.phase === 'holding' && next.holdUntil !== null && now >= next.holdUntil) {
      next = { ...next, phase: 'over' }
    }
    if (next.phase === 'over' && next.holdUntil !== null && now >= next.holdUntil + TOMBSTONE_MS) {
      changed = true
      continue
    }
    if (next !== event) changed = true
    events.push(next)
  }
  return changed ? { ...state, events } : state
}

/**
 * Keeps `triggerIndex` on the trigger winner, and when the last trigger is over hands the cell back
 * to rotation from that camera with a full interval (header). Nothing while pinned.
 */
function settleTriggers(state: SchedulerState, now: number): SchedulerState {
  if (state.pinned) return state
  const winner = triggerWinner(state)
  if (winner !== null) {
    return winner.position === state.triggerIndex
      ? state
      : { ...state, triggerIndex: winner.position }
  }
  if (state.triggerIndex === null) return state
  const interval = rotationIntervalMs(state.cell)
  return {
    ...state,
    index: state.triggerIndex,
    triggerIndex: null,
    nextRotateAt: interval === null ? null : now + interval,
  }
}

/** One rotation step if it is due and nothing else holds the cell (header). */
function rotate(state: SchedulerState, now: number): SchedulerState {
  const interval = rotationIntervalMs(state.cell)
  const due = state.nextRotateAt
  if (interval === null || due === null || now < due) return state
  if (state.pinned || state.triggerIndex !== null) return state
  const count = state.cell.cameraIds.length
  return {
    ...state,
    index: (state.index + 1) % count,
    // More than one interval missed (sleep): one step, rescheduled from now.
    nextRotateAt: now - due >= interval ? now + interval : due + interval,
  }
}

function applyTime(state: SchedulerState, now: number): SchedulerState {
  const aged = ageEvents(state, now)
  return rotate(settleTriggers(aged, now), now)
}

// -------------------------------------------------------------------------------------------------
// Actions

function onEvent(state: SchedulerState, event: CameraEvent, now: number): SchedulerState {
  const hold = state.cell.motionHoldSec
  const at = state.events.findIndex((tracked) => tracked.id === event.id)
  const existing = at < 0 ? undefined : state.events[at]

  if (existing === undefined) {
    if (!eventMatchesCell(state.cell, event)) return state
    if (state.offset !== null) {
      // Possibly a late message for a pruned event (header, "Nothing grows without bound").
      const startLocal = event.start + state.offset
      if (startLocal < now - TOMBSTONE_MS) return state
      if (event.end === null && startLocal < now - STALE_EVENT_MS) return state
    }
    const base: TrackedEvent = {
      id: event.id,
      cameraId: event.cameraId,
      trigger: event.trigger,
      smartDetectTypes: [...event.smartDetectTypes],
      start: event.start,
      firstSeenAt: now,
      offset: null,
      phase: 'running',
      end: null,
      endLocal: null,
      holdUntil: null,
      stale: false,
      dismissed: false,
    }
    if (event.end === null) {
      const offset = now - event.start
      return { ...state, offset, events: [...state.events, { ...base, offset }] }
    }
    const tracked: TrackedEvent = {
      ...base,
      end: event.end,
      ...withHold(Math.min(event.end, now), hold, now),
    }
    return { ...state, events: [...state.events, tracked] }
  }

  if (existing.stale || existing.dismissed || existing.phase === 'over') return state
  if (event.end === null || event.end === existing.end) return state
  const endLocal = Math.min(event.end + (existing.offset ?? 0), now)
  const updated: TrackedEvent = {
    ...existing,
    end: event.end,
    ...withHold(endLocal, hold, now),
  }
  const events = state.events.slice()
  events[at] = updated
  return { ...state, events }
}

function onPin(state: SchedulerState): SchedulerState {
  if (state.pinned) return state
  return { ...state, index: shownIndex(state), pinned: true, triggerIndex: null }
}

function onUnpin(state: SchedulerState, now: number): SchedulerState {
  if (!state.pinned) return state
  const interval = rotationIntervalMs(state.cell)
  // settleTriggers then picks up any trigger still active.
  return { ...state, pinned: false, nextRotateAt: interval === null ? null : now + interval }
}

function onStep(state: SchedulerState, delta: 1 | -1, now: number): SchedulerState {
  const count = state.cell.cameraIds.length
  if (count < 2) return state
  const index = (shownIndex(state) + delta + count) % count
  if (state.pinned) return { ...state, index }
  const interval = rotationIntervalMs(state.cell)
  const events = state.events.map((event) =>
    isActive(event) ? { ...event, dismissed: true } : event,
  )
  return {
    ...state,
    index,
    triggerIndex: null,
    nextRotateAt: interval === null ? null : now + interval,
    events,
  }
}

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true
  if (a?.length !== b?.length || a === undefined || b === undefined) return false
  return a.every((value, i) => value === b[i])
}

function sameCell(a: SchedulerCell, b: SchedulerCell): boolean {
  return (
    sameList(a.cameraIds, b.cameraIds) &&
    a.rotateIntervalSec === b.rotateIntervalSec &&
    a.motionSwitch === b.motionSwitch &&
    sameList(a.motionTriggers, b.motionTriggers) &&
    sameList(a.smartDetectTypes, b.smartDetectTypes) &&
    a.motionHoldSec === b.motionHoldSec
  )
}

function pickCell(cell: SchedulerCell): SchedulerCell {
  return {
    cameraIds: [...cell.cameraIds],
    rotateIntervalSec: cell.rotateIntervalSec,
    motionSwitch: cell.motionSwitch,
    motionTriggers: [...cell.motionTriggers],
    smartDetectTypes: cell.smartDetectTypes === undefined ? undefined : [...cell.smartDetectTypes],
    motionHoldSec: cell.motionHoldSec,
  }
}

function onConfigure(state: SchedulerState, input: SchedulerCell, now: number): SchedulerState {
  if (sameCell(state.cell, input)) return state
  const cell = pickCell(input)
  const old = state.cell.cameraIds

  /** The new position of the camera at old position `i`, or `null` if it left the cell. */
  const remap = (i: number): number | null => {
    const id = old[i]
    if (id === undefined) return null
    const next = cell.cameraIds.indexOf(id)
    return next < 0 ? null : next
  }
  const index = remap(state.index) ?? 0
  // A trigger camera that left still ends "a trigger", so rotation restarts with a full interval.
  const triggerIndex = state.triggerIndex === null ? null : (remap(state.triggerIndex) ?? index)

  const holdChanged = cell.motionHoldSec !== state.cell.motionHoldSec
  const events = state.events
    .filter((event) => matches(cell, event.cameraId, event.trigger, event.smartDetectTypes))
    .map((event) =>
      holdChanged && event.phase !== 'running' && !event.dismissed && event.endLocal !== null
        ? { ...event, ...withHold(event.endLocal, cell.motionHoldSec, now) }
        : event,
    )

  const interval = rotationIntervalMs(cell)
  const oldInterval = rotationIntervalMs(state.cell)
  const nextRotateAt =
    interval === null ? null : interval !== oldInterval ? now + interval : state.nextRotateAt

  return { ...state, cell, index, triggerIndex, nextRotateAt, events }
}

// -------------------------------------------------------------------------------------------------
// Public API

export function createScheduler(cell: SchedulerCell, now: number): SchedulerState {
  const picked = pickCell(cell)
  const interval = rotationIntervalMs(picked)
  return {
    cell: picked,
    index: 0,
    pinned: false,
    triggerIndex: null,
    nextRotateAt: interval === null ? null : now + interval,
    events: [],
    offset: null,
    at: now,
  }
}

export function reduceScheduler(state: SchedulerState, action: SchedulerAction): SchedulerState {
  if (!Number.isFinite(action.now)) return state
  if (
    action.type === 'event' &&
    (!Number.isFinite(action.event.start) ||
      (action.event.end !== null && !Number.isFinite(action.event.end)))
  ) {
    return state
  }
  const now = Math.max(action.now, state.at)
  let next = applyTime(state, now)
  switch (action.type) {
    case 'tick':
      break
    case 'event':
      next = onEvent(next, action.event, now)
      break
    case 'configure':
      next = onConfigure(next, action.cell, now)
      break
    case 'pin':
      next = onPin(next)
      break
    case 'unpin':
      next = onUnpin(next, now)
      break
    case 'next':
      next = onStep(next, 1, now)
      break
    case 'prev':
      next = onStep(next, -1, now)
      break
  }
  next = settleTriggers(next, now)
  if (next === state) return state
  return next.at === now ? next : { ...next, at: now }
}

export function schedulerView(state: SchedulerState): SchedulerView {
  const count = state.cell.cameraIds.length
  if (count === 0) {
    return { index: -1, cameraId: null, count: 0, reason: 'rotation', trigger: null, motion: false }
  }
  const index = shownIndex(state)
  const cameraId = state.cell.cameraIds[index] ?? null
  const triggered = !state.pinned && state.triggerIndex !== null
  return {
    index,
    cameraId,
    count,
    reason: state.pinned ? 'pinned' : triggered ? 'trigger' : 'rotation',
    trigger: triggered ? (triggerWinner(state)?.event.trigger ?? null) : null,
    // A dismissed event still counts: the camera is still seeing motion.
    motion: state.events.some((event) => event.phase === 'running' && event.cameraId === cameraId),
  }
}

/** Earliest local time at which a 'tick' can change the view or internal state; null if none. */
export function nextWakeAt(state: SchedulerState): number | null {
  let wake: number | null = null
  const consider = (time: number | null): void => {
    if (time !== null && (wake === null || time < wake)) wake = time
  }
  for (const event of state.events) {
    if (event.phase === 'running') consider(event.firstSeenAt + STALE_EVENT_MS)
    else if (event.phase === 'holding') consider(event.holdUntil)
  }
  if (rotationIntervalMs(state.cell) !== null && !state.pinned && state.triggerIndex === null) {
    consider(state.nextRotateAt)
  }
  return wake
}
