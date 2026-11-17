// P4.1: the multi-camera cell's pure scheduler (src/renderer/src/features/cells/cellScheduler.ts;
// CELL-2, FILL-3, SPEC §5.1 "Event lifecycle").
//
// What these tests protect:
//  - the G4 scenario: a 4-camera cell rotates every 10 s, a motion `add` switches it in the same
//    action, the late `end` update still holds 15 s from the end *timestamp*, and rotation then
//    resumes from the held camera with a full interval.
//  - the hold is skew-corrected: a console clock ahead of or behind local time still holds ~15 s
//    after the real end, and an end is never placed in the local future.
//  - the event lifecycle is idempotent on `(id, end)`: repeated ends and end-less updates are
//    no-ops (same reference); an event with no end goes stale after 60 s and anything later for it
//    is ignored; an event first seen already ended triggers only while its hold lasts.
//  - priority: ring beats everything else, then the most recent start, then the earlier position.
//  - what counts: motionSwitch, motionTriggers, the smart-detect filter (only on smartDetect, empty
//    = no filter), exact camera ids (`<id>:package` is not matched by `<id>`).
//  - FILL-3: a pinned cell neither rotates nor switches, pins the trigger camera when one is shown,
//    still ages events, and resumes correctly on unpin.
//  - manual next/prev wrap, dismiss the active triggers (newer ones still win), restart the
//    interval, and work while pinned.
//  - configure keeps the camera by id, re-filters events, follows interval changes and survives an
//    emptied cell.
//  - missed intervals step once; `now` going backwards does not crash; nextWakeAt names the moment
//    a tick changes something; the reducer is pure, returns the same reference when nothing
//    changed, and prunes so its state stays bounded.
//  - (P4.4) upcomingRotation names exactly the camera and time of the next timed rotation step —
//    the same one a tick at that time shows — and nothing while rotation is off, pinned or
//    triggered, with fewer than two cameras, or when the next entry is the camera already shown.
import { CameraEventSchema, CellSchema, type CameraEvent } from '@shared/models'
import { describe, expect, it } from 'vitest'
import {
  createScheduler,
  eventMatchesCell,
  nextWakeAt,
  reduceScheduler,
  schedulerView,
  STALE_EVENT_MS,
  upcomingRotation,
  type SchedulerAction,
  type SchedulerCell,
  type SchedulerState,
} from '../../src/renderer/src/features/cells/cellScheduler'

/** Local "now" at the start of every scenario. */
const T = 1_700_000_000_000

const CAMS = ['c0', 'c1', 'c2', 'c3']

/** A 4-camera, 10 s rotation, motion-switching cell; defaults (hold 15 s, all triggers) via the schema. */
function cell(overrides: Record<string, unknown> = {}): SchedulerCell {
  return CellSchema.parse({
    col: 0,
    row: 0,
    cameraIds: CAMS,
    rotateIntervalSec: 10,
    motionSwitch: true,
    ...overrides,
  })
}

let eventSeq = 0

/** A Protect event; `end` defaults to null (an `add`) through the schema. */
function ev(overrides: Partial<CameraEvent> & { cameraId: string; start: number }): CameraEvent {
  eventSeq += 1
  return CameraEventSchema.parse({
    id: `e${String(eventSeq)}`,
    trigger: 'motion',
    protectType:
      overrides.trigger === 'smartDetect' ? 'smartDetectZone' : (overrides.trigger ?? 'motion'),
    ...overrides,
  })
}

/** The closing `update` for `event`. */
function ended(event: CameraEvent, end: number): CameraEvent {
  return { ...event, end }
}

const at = {
  event: (event: CameraEvent, now: number): SchedulerAction => ({ type: 'event', event, now }),
  tick: (now: number): SchedulerAction => ({ type: 'tick', now }),
  configure: (c: SchedulerCell, now: number): SchedulerAction => ({
    type: 'configure',
    cell: c,
    now,
  }),
  pin: (now: number): SchedulerAction => ({ type: 'pin', now }),
  unpin: (now: number): SchedulerAction => ({ type: 'unpin', now }),
  next: (now: number): SchedulerAction => ({ type: 'next', now }),
  prev: (now: number): SchedulerAction => ({ type: 'prev', now }),
}

function run(state: SchedulerState, ...actions: SchedulerAction[]): SchedulerState {
  return actions.reduce(reduceScheduler, state)
}

function shown(state: SchedulerState): { cameraId: string | null; reason: string } {
  const v = schedulerView(state)
  return { cameraId: v.cameraId, reason: v.reason }
}

function deepFreeze<V>(value: V): V {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

describe('STALE_EVENT_MS', () => {
  it('is 60 s', () => {
    expect(STALE_EVENT_MS).toBe(60_000)
  })
})

describe('createScheduler', () => {
  it('starts on the first camera, by rotation, with the first step one interval away', () => {
    const s = createScheduler(cell(), T)
    expect(schedulerView(s)).toEqual({
      index: 0,
      cameraId: 'c0',
      count: 4,
      reason: 'rotation',
      trigger: null,
    })
    expect(nextWakeAt(s)).toBe(T + 10_000)
  })

  it('has nothing to show and nothing to wake for with no cameras', () => {
    const s = createScheduler(cell({ cameraIds: [] }), T)
    expect(schedulerView(s)).toMatchObject({ index: -1, cameraId: null, count: 0 })
    expect(nextWakeAt(s)).toBeNull()
    const after = run(s, at.event(ev({ cameraId: 'c0', start: T }), T), at.tick(T + 60_000))
    expect(schedulerView(after)).toMatchObject({
      index: -1,
      cameraId: null,
      count: 0,
    })
    expect(nextWakeAt(after)).toBeNull()
  })
})

describe('G4 scenario (CELL-2)', () => {
  it('rotates every 10 s, switches on motion, holds 15 s from the end timestamp, then resumes from the held camera', () => {
    let s = createScheduler(cell(), T)

    // Rotation: one step every 10 s, wrapping.
    s = run(s, at.tick(T + 9_999))
    expect(schedulerView(s).index).toBe(0)
    for (const [t, i] of [
      [T + 10_000, 1],
      [T + 20_000, 2],
      [T + 30_000, 3],
      [T + 40_000, 0],
    ] as const) {
      s = run(s, at.tick(t))
      expect(schedulerView(s)).toMatchObject({ index: i, cameraId: CAMS[i], reason: 'rotation' })
      expect(nextWakeAt(s)).toBe(t + 10_000)
    }

    // Motion on camera 3 (index 2) switches in the same action.
    const motion = ev({ cameraId: 'c2', start: T + 45_000 })
    s = run(s, at.event(motion, T + 45_000))
    expect(schedulerView(s)).toEqual({
      index: 2,
      cameraId: 'c2',
      count: 4,
      reason: 'trigger',
      trigger: 'motion',
    })
    // Rotation is paused while the trigger is active; the only deadline is the stale one.
    expect(nextWakeAt(s)).toBe(T + 45_000 + STALE_EVENT_MS)
    s = run(s, at.tick(T + 50_000))
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'trigger' })

    // The end (timestamp T+52 s) arrives 4 s late: hold until T+52 s + 15 s.
    s = run(s, at.event(ended(motion, T + 52_000), T + 56_000))
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c2',
      reason: 'trigger',
      trigger: 'motion',
    })
    expect(nextWakeAt(s)).toBe(T + 67_000)
    s = run(s, at.tick(T + 66_999))
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'trigger' })

    // Hold over: rotation resumes from camera 3 with a full interval.
    s = run(s, at.tick(T + 67_000))
    expect(schedulerView(s)).toMatchObject({
      index: 2,
      cameraId: 'c2',
      reason: 'rotation',
      trigger: null,
    })
    expect(nextWakeAt(s)).toBe(T + 77_000)
    s = run(s, at.tick(T + 76_999))
    expect(schedulerView(s).index).toBe(2)
    s = run(s, at.tick(T + 77_000))
    expect(schedulerView(s)).toMatchObject({ index: 3, cameraId: 'c3', reason: 'rotation' })
  })
})

describe('clock skew (SPEC §5.1)', () => {
  // Real local timeline: add at T+5 s, real end at T+8 s, end update arrives at T+12 s.
  function holdEnd(skewMs: number): number | null {
    const motion = ev({ cameraId: 'c1', start: T + 5_000 + skewMs })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 5_000),
      at.event(ended(motion, T + 8_000 + skewMs), T + 12_000),
    )
    expect(shown(s)).toEqual({ cameraId: 'c1', reason: 'trigger' })
    return nextWakeAt(s)
  }

  it('holds 15 s after the real end with the console 30 s ahead', () => {
    expect(holdEnd(30_000)).toBe(T + 23_000)
  })

  it('holds 15 s after the real end with the console 30 s behind', () => {
    expect(holdEnd(-30_000)).toBe(T + 23_000)
  })

  it('holds 15 s after the end with no skew', () => {
    expect(holdEnd(0)).toBe(T + 23_000)
  })

  it('never places the end in the local future', () => {
    // The add arrives 2 s after its start (offset over-estimates by 2 s); the end arrives 1 s after it.
    const motion = ev({ cameraId: 'c1', start: T + 5_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 7_000),
      at.event(ended(motion, T + 8_000), T + 9_000),
    )
    // end + offset = T+10 s > now (T+9 s) → endLocal = now.
    expect(nextWakeAt(s)).toBe(T + 9_000 + 15_000)
  })

  it('an end update whose hold is already over ends the trigger at once', () => {
    const motion = ev({ cameraId: 'c1', start: T + 1_000 })
    const s = run(
      createScheduler(cell({ motionHoldSec: 0 }), T),
      at.event(motion, T + 1_000),
      at.event(ended(motion, T + 2_000), T + 5_000),
    )
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c1', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 15_000)
  })
})

describe('event lifecycle idempotence', () => {
  it('treats repeated identical end updates as no-ops (same reference)', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    const once = run(
      createScheduler(cell(), T),
      at.event(motion, T + 1_000),
      at.event(ended(motion, T + 3_000), T + 6_000),
    )
    const twice = reduceScheduler(once, at.event(ended(motion, T + 3_000), T + 6_000))
    expect(twice).toBe(once)
    const thrice = reduceScheduler(twice, at.event(ended(motion, T + 3_000), T + 7_000))
    expect(thrice).toBe(once)
    expect(nextWakeAt(thrice)).toBe(T + 18_000)
  })

  it('treats an update without end for a running event as a no-op (same reference)', () => {
    const motion = ev({
      cameraId: 'c2',
      start: T + 1_000,
      trigger: 'smartDetect',
      smartDetectTypes: ['person'],
    })
    const s = run(createScheduler(cell(), T), at.event(motion, T + 1_000))
    expect(reduceScheduler(s, at.event(motion, T + 1_000))).toBe(s)
    expect(
      reduceScheduler(
        s,
        at.event({ ...motion, smartDetectTypes: ['person', 'vehicle'] }, T + 2_000),
      ),
    ).toBe(s)
  })

  it('recomputes the hold when an ended event gets a different end value', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    const first = run(
      createScheduler(cell(), T),
      at.event(motion, T + 1_000),
      at.event(ended(motion, T + 3_000), T + 5_000),
    )
    expect(nextWakeAt(first)).toBe(T + 18_000)
    const revised = reduceScheduler(first, at.event(ended(motion, T + 4_000), T + 6_000))
    expect(revised).not.toBe(first)
    expect(nextWakeAt(revised)).toBe(T + 19_000)
    expect(shown(revised)).toEqual({ cameraId: 'c2', reason: 'trigger' })
  })

  it('does not resurrect an event once its hold is over', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 1_000),
      at.event(ended(motion, T + 3_000), T + 5_000),
      at.tick(T + 18_000),
    )
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'rotation' })
    // A late duplicate end and a late duplicate add change nothing visible.
    const late = run(
      s,
      at.event(ended(motion, T + 3_000), T + 19_000),
      at.event(motion, T + 20_000),
    )
    expect(schedulerView(late)).toMatchObject({ cameraId: 'c2', reason: 'rotation' })
    expect(nextWakeAt(late)).toBe(T + 28_000)
  })
})

describe('stale events', () => {
  it('ends an event with no end at firstSeen + 60 s and holds 15 s after that', () => {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    let s = run(createScheduler(cell(), T), at.event(motion, T + 2_000))
    expect(nextWakeAt(s)).toBe(T + 62_000)

    s = run(s, at.tick(T + 61_999))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c2', reason: 'trigger' })

    s = run(s, at.tick(T + 62_000))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c2', reason: 'trigger' })
    expect(nextWakeAt(s)).toBe(T + 77_000)

    s = run(s, at.tick(T + 77_000))
    expect(schedulerView(s)).toMatchObject({ index: 2, cameraId: 'c2', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 87_000)
  })

  it('ignores a late end for a stale event, during and after its hold', () => {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    const stale = run(createScheduler(cell(), T), at.event(motion, T + 2_000), at.tick(T + 62_000))

    // During the hold: the late end would otherwise move the hold to T+65 s + 15 s.
    const lateEnd = reduceScheduler(stale, at.event(ended(motion, T + 65_000), T + 66_000))
    expect(lateEnd).toBe(stale)
    expect(nextWakeAt(lateEnd)).toBe(T + 77_000)
    // A repeated add is ignored too.
    expect(reduceScheduler(stale, at.event(motion, T + 66_000))).toBe(stale)

    // After the hold: no resurrection.
    const resumed = run(stale, at.tick(T + 77_000))
    const later = run(resumed, at.event(ended(motion, T + 78_000), T + 80_000))
    expect(schedulerView(later)).toMatchObject({
      cameraId: 'c2',
      reason: 'rotation',
    })
    expect(nextWakeAt(later)).toBe(T + 87_000)
  })
})

describe('event first seen already ended', () => {
  it('triggers while within its hold', () => {
    // Start T+1 s, end T+3 s, first seen at T+5 s: hold until T+18 s (no offset known).
    const motion = ended(ev({ cameraId: 'c3', start: T + 1_000 }), T + 3_000)
    let s = run(createScheduler(cell(), T), at.event(motion, T + 5_000))
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c3',
      reason: 'trigger',
      trigger: 'motion',
    })
    expect(nextWakeAt(s)).toBe(T + 18_000)
    s = run(s, at.tick(T + 18_000))
    expect(schedulerView(s)).toMatchObject({ index: 3, reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 28_000)
  })

  it('clamps a future end to now', () => {
    const motion = ended(ev({ cameraId: 'c3', start: T + 1_000 }), T + 30_000)
    const s = run(createScheduler(cell(), T), at.event(motion, T + 5_000))
    expect(nextWakeAt(s)).toBe(T + 20_000)
  })

  it('has no effect beyond its hold', () => {
    const motion = ended(ev({ cameraId: 'c3', start: T - 30_000 }), T - 20_000)
    const s = run(createScheduler(cell(), T), at.event(motion, T + 5_000))
    expect(schedulerView(s)).toMatchObject({
      index: 0,
      cameraId: 'c0',
      reason: 'rotation',
    })
    expect(nextWakeAt(s)).toBe(T + 10_000)
  })
})

describe('trigger priority', () => {
  it('ring beats a newer motion', () => {
    const ring = ev({ cameraId: 'c3', start: T + 1_000, trigger: 'ring' })
    const motion = ev({ cameraId: 'c1', start: T + 2_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(ring, T + 1_000),
      at.event(motion, T + 2_000),
    )
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c3',
      reason: 'trigger',
      trigger: 'ring',
    })
  })

  it('ring beats a newer smartDetect arriving before it', () => {
    const smart = ev({
      cameraId: 'c1',
      start: T + 2_000,
      trigger: 'smartDetect',
      smartDetectTypes: ['person'],
    })
    const ring = ev({ cameraId: 'c3', start: T + 1_000, trigger: 'ring' })
    const s = run(createScheduler(cell(), T), at.event(smart, T + 2_000), at.event(ring, T + 2_500))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c3', trigger: 'ring' })
  })

  it('otherwise the most recent start wins, not the most recent arrival', () => {
    const a = ev({ cameraId: 'c1', start: T + 1_000 })
    const b = ev({ cameraId: 'c3', start: T + 3_000, trigger: 'smartDetect' })
    const c = ev({ cameraId: 'c0', start: T + 2_000 })
    let s = run(createScheduler(cell(), T), at.event(a, T + 1_000))
    expect(shown(s)).toEqual({ cameraId: 'c1', reason: 'trigger' })
    s = run(s, at.event(b, T + 3_000))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c3', trigger: 'smartDetect' })
    s = run(s, at.event(c, T + 3_500))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c3', trigger: 'smartDetect' })
  })

  it('a tie on start goes to the earlier position in cameraIds', () => {
    const late = ev({ cameraId: 'c3', start: T + 1_000 })
    const early = ev({ cameraId: 'c1', start: T + 1_000 })
    const s = run(createScheduler(cell(), T), at.event(late, T + 1_000), at.event(early, T + 1_200))
    expect(shown(s)).toEqual({ cameraId: 'c1', reason: 'trigger' })
  })

  it('falls back to the next active event when the winner is over', () => {
    const motion = ev({ cameraId: 'c1', start: T + 1_000 })
    const ring = ev({ cameraId: 'c3', start: T + 500, trigger: 'ring' })
    let s = run(
      createScheduler(cell({ motionHoldSec: 0 }), T),
      at.event(motion, T + 1_000),
      at.event(ring, T + 1_000),
    )
    expect(shown(s)).toEqual({ cameraId: 'c3', reason: 'trigger' })
    s = run(s, at.event(ended(ring, T + 2_000), T + 2_000))
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c1',
      reason: 'trigger',
      trigger: 'motion',
    })
  })

  it('uses the earliest position of a camera listed twice', () => {
    const s = run(
      createScheduler(cell({ cameraIds: ['c0', 'c1', 'c0'] }), T),
      at.tick(T + 10_000),
      at.event(ev({ cameraId: 'c0', start: T + 11_000 }), T + 11_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 0, cameraId: 'c0', reason: 'trigger' })
  })
})

describe('eventMatchesCell (filters)', () => {
  const motion = (cameraId = 'c1'): CameraEvent => ev({ cameraId, start: T })
  const smart = (types: string[]): CameraEvent =>
    ev({ cameraId: 'c1', start: T, trigger: 'smartDetect', smartDetectTypes: types })
  const ring = (): CameraEvent => ev({ cameraId: 'c1', start: T, trigger: 'ring' })

  it('matches an event on a camera of a motion-switching cell', () => {
    expect(eventMatchesCell(cell(), motion())).toBe(true)
    expect(eventMatchesCell(cell(), smart(['person']))).toBe(true)
    expect(eventMatchesCell(cell(), ring())).toBe(true)
  })

  it('matches nothing with motionSwitch off', () => {
    const c = cell({ motionSwitch: false })
    expect(eventMatchesCell(c, motion())).toBe(false)
    expect(eventMatchesCell(c, smart(['person']))).toBe(false)
    expect(eventMatchesCell(c, ring())).toBe(false)
  })

  it('matches only the triggers in motionTriggers', () => {
    const c = cell({ motionTriggers: ['ring'] })
    expect(eventMatchesCell(c, motion())).toBe(false)
    expect(eventMatchesCell(c, smart(['person']))).toBe(false)
    expect(eventMatchesCell(c, ring())).toBe(true)
    expect(eventMatchesCell(cell({ motionTriggers: [] }), ring())).toBe(false)
  })

  it('applies the smart-detect filter to smartDetect events', () => {
    const c = cell({ smartDetectTypes: ['person', 'animal'] })
    expect(eventMatchesCell(c, smart(['person']))).toBe(true)
    expect(eventMatchesCell(c, smart(['vehicle', 'animal']))).toBe(true)
    expect(eventMatchesCell(c, smart(['vehicle']))).toBe(false)
    expect(eventMatchesCell(c, smart([]))).toBe(false)
  })

  it('treats an empty or absent smart-detect filter as all', () => {
    for (const c of [cell({ smartDetectTypes: [] }), cell()]) {
      expect(eventMatchesCell(c, smart(['vehicle']))).toBe(true)
      expect(eventMatchesCell(c, smart([]))).toBe(true)
    }
  })

  it('never applies the smart-detect filter to motion or ring', () => {
    const c = cell({ smartDetectTypes: ['person'] })
    expect(eventMatchesCell(c, motion())).toBe(true)
    expect(eventMatchesCell(c, ring())).toBe(true)
  })

  it('does not match a camera outside the cell', () => {
    expect(eventMatchesCell(cell(), motion('c9'))).toBe(false)
    expect(eventMatchesCell(cell(), motion('c'))).toBe(false)
  })

  it('does not match a `<id>:package` entry with events from `<id>`', () => {
    const c = cell({ cameraIds: ['c0', 'door:package'] })
    expect(eventMatchesCell(c, motion('door'))).toBe(false)
    expect(eventMatchesCell(c, ev({ cameraId: 'door', start: T, trigger: 'ring' }))).toBe(false)
    expect(eventMatchesCell(c, motion('door:package'))).toBe(true)
  })

  it('the reducer drops non-matching events (same reference, no switch)', () => {
    const s = createScheduler(cell({ motionTriggers: ['motion'], smartDetectTypes: ['person'] }), T)
    for (const e of [motion('c9'), ring(), smart(['person'])]) {
      expect(reduceScheduler(s, at.event(e, T + 1_000))).toBe(s)
    }
    const off = createScheduler(cell({ motionSwitch: false }), T)
    const after = reduceScheduler(off, at.event(motion(), T + 1_000))
    expect(after).toBe(off)
    expect(schedulerView(after)).toMatchObject({
      cameraId: 'c0',
      reason: 'rotation',
    })
  })
})

describe('pin / unpin (FILL-3)', () => {
  it('neither rotates nor switches while pinned', () => {
    let s = run(createScheduler(cell(), T), at.tick(T + 10_000), at.pin(T + 12_000))
    expect(schedulerView(s)).toMatchObject({
      index: 1,
      cameraId: 'c1',
      reason: 'pinned',
      trigger: null,
    })
    expect(nextWakeAt(s)).toBeNull()

    s = run(s, at.tick(T + 30_000), at.tick(T + 45_000))
    expect(shown(s)).toEqual({ cameraId: 'c1', reason: 'pinned' })

    const other = ev({ cameraId: 'c3', start: T + 46_000, trigger: 'ring' })
    s = run(s, at.event(other, T + 46_000))
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c1',
      reason: 'pinned',
      trigger: null,
    })
    // Events are still aged while pinned: the stale deadline is pending.
    expect(nextWakeAt(s)).toBe(T + 46_000 + STALE_EVENT_MS)

    const here = ev({ cameraId: 'c1', start: T + 47_000 })
    s = run(s, at.event(here, T + 47_000))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c1', reason: 'pinned' })
  })

  it('pins the trigger camera when the cell is showing one', () => {
    const s = run(
      createScheduler(cell(), T),
      at.event(ev({ cameraId: 'c2', start: T + 1_000 }), T + 1_000),
      at.pin(T + 2_000),
    )
    expect(schedulerView(s)).toMatchObject({
      index: 2,
      cameraId: 'c2',
      reason: 'pinned',
      trigger: null,
    })
  })

  it('is a no-op when already pinned, and unpin is a no-op when not pinned', () => {
    const fresh = createScheduler(cell(), T)
    expect(reduceScheduler(fresh, at.unpin(T + 1_000))).toBe(fresh)
    const pinned = reduceScheduler(fresh, at.pin(T + 1_000))
    expect(reduceScheduler(pinned, at.pin(T + 2_000))).toBe(pinned)
  })

  it('unpin with no active events resumes rotation from the pinned camera with a full interval', () => {
    let s = run(
      createScheduler(cell(), T),
      at.tick(T + 10_000),
      at.pin(T + 11_000),
      at.unpin(T + 50_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 1, cameraId: 'c1', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 60_000)
    s = run(s, at.tick(T + 60_000))
    expect(schedulerView(s).index).toBe(2)
  })

  it('unpin with an active event shows the trigger winner', () => {
    const s = run(
      createScheduler(cell(), T),
      at.pin(T + 1_000),
      at.event(ev({ cameraId: 'c3', start: T + 2_000 }), T + 2_000),
      at.unpin(T + 3_000),
    )
    expect(schedulerView(s)).toMatchObject({
      cameraId: 'c3',
      reason: 'trigger',
      trigger: 'motion',
    })
  })

  it('ages events while pinned, so an event over during the pin does not show on unpin', () => {
    const motion = ev({ cameraId: 'c3', start: T + 2_000 })
    let s = run(
      createScheduler(cell(), T),
      at.pin(T + 1_000),
      at.event(motion, T + 2_000),
      at.event(ended(motion, T + 4_000), T + 5_000),
    )
    expect(nextWakeAt(s)).toBe(T + 19_000)
    s = run(s, at.tick(T + 19_000))
    expect(nextWakeAt(s)).toBeNull()
    s = run(s, at.unpin(T + 30_000))
    expect(schedulerView(s)).toMatchObject({ index: 0, cameraId: 'c0', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 40_000)
  })

  it('a trigger camera pinned and then over resumes rotation from that camera on unpin', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 1_000),
      at.pin(T + 2_000),
      at.event(ended(motion, T + 3_000), T + 3_000),
      at.tick(T + 18_000),
      at.unpin(T + 20_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 2, cameraId: 'c2', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 30_000)
  })
})

describe('manual next / prev', () => {
  it('wraps both ways and restarts the interval', () => {
    let s = createScheduler(cell(), T)
    s = run(s, at.prev(T + 4_000))
    expect(schedulerView(s)).toMatchObject({ index: 3, cameraId: 'c3', reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 14_000)
    s = run(s, at.next(T + 5_000))
    expect(schedulerView(s)).toMatchObject({ index: 0, cameraId: 'c0' })
    expect(nextWakeAt(s)).toBe(T + 15_000)
    s = run(s, at.next(T + 6_000), at.next(T + 7_000))
    expect(schedulerView(s).index).toBe(2)
    s = run(s, at.tick(T + 16_999))
    expect(schedulerView(s).index).toBe(2)
    s = run(s, at.tick(T + 17_000))
    expect(schedulerView(s).index).toBe(3)
  })

  it('moves from the trigger camera and dismisses the active triggers', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    let s = run(createScheduler(cell(), T), at.event(motion, T + 1_000), at.next(T + 2_000))
    expect(schedulerView(s)).toMatchObject({
      index: 3,
      cameraId: 'c3',
      reason: 'rotation',
      trigger: null,
    })

    // The dismissed event no longer drives the cell: its end and hold don't bring c2 back,
    // and rotation runs a full interval from the step.
    s = run(s, at.event(ended(motion, T + 3_000), T + 4_000))
    expect(shown(s)).toEqual({ cameraId: 'c3', reason: 'rotation' })
    const wake = nextWakeAt(s)
    expect(wake).not.toBeNull()
    expect(wake ?? Infinity).toBeLessThanOrEqual(T + 12_000)
    s = run(s, at.tick(T + 12_000))
    expect(schedulerView(s)).toMatchObject({ index: 0, cameraId: 'c0', reason: 'rotation' })
  })

  it('prev from the trigger camera steps back from it', () => {
    const s = run(
      createScheduler(cell(), T),
      at.event(ev({ cameraId: 'c2', start: T + 1_000 }), T + 1_000),
      at.prev(T + 2_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 1, cameraId: 'c1', reason: 'rotation' })
  })

  it('a newer event still triggers after a dismissal', () => {
    const s = run(
      createScheduler(cell(), T),
      at.event(ev({ cameraId: 'c2', start: T + 1_000 }), T + 1_000),
      at.next(T + 2_000),
      at.event(ev({ cameraId: 'c1', start: T + 3_000 }), T + 3_000),
    )
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c1', reason: 'trigger' })
  })

  it('is allowed while pinned and the new camera stays pinned', () => {
    let s = run(createScheduler(cell(), T), at.pin(T + 1_000), at.next(T + 2_000))
    expect(schedulerView(s)).toMatchObject({ index: 1, cameraId: 'c1', reason: 'pinned' })
    s = run(s, at.prev(T + 3_000), at.prev(T + 4_000))
    expect(schedulerView(s)).toMatchObject({ index: 3, cameraId: 'c3', reason: 'pinned' })
    expect(nextWakeAt(s)).toBeNull()
    s = run(s, at.unpin(T + 5_000))
    expect(schedulerView(s)).toMatchObject({ index: 3, reason: 'rotation' })
    expect(nextWakeAt(s)).toBe(T + 15_000)
  })

  it('is a no-op with fewer than 2 cameras', () => {
    for (const cameraIds of [['c0'], []]) {
      const s = createScheduler(cell({ cameraIds }), T)
      expect(reduceScheduler(s, at.next(T + 1_000))).toBe(s)
      expect(reduceScheduler(s, at.prev(T + 1_000))).toBe(s)
    }
  })
})

describe('configure', () => {
  it('keeps the shown camera by id when it is still in the list', () => {
    const s = run(
      createScheduler(cell(), T),
      at.tick(T + 10_000),
      at.tick(T + 20_000),
      at.configure(cell({ cameraIds: ['c9', 'c2', 'c0'] }), T + 25_000),
    )
    expect(schedulerView(s)).toMatchObject({
      index: 1,
      cameraId: 'c2',
      count: 3,
      reason: 'rotation',
    })
    // Same interval: the schedule is untouched.
    expect(nextWakeAt(s)).toBe(T + 30_000)
  })

  it('falls back to index 0 when the camera left the list', () => {
    const s = run(
      createScheduler(cell(), T),
      at.tick(T + 10_000),
      at.configure(cell({ cameraIds: ['c3', 'c2'] }), T + 12_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 0, cameraId: 'c3', count: 2 })
  })

  it('re-filters stored events against the new config', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    const triggered = run(createScheduler(cell(), T), at.event(motion, T + 1_000))

    const stillMatches = run(
      triggered,
      at.configure(cell({ motionTriggers: ['motion', 'ring'] }), T + 2_000),
    )
    expect(schedulerView(stillMatches)).toMatchObject({
      cameraId: 'c2',
      reason: 'trigger',
    })

    for (const next of [
      cell({ motionTriggers: ['ring'] }),
      cell({ motionSwitch: false }),
      cell({ cameraIds: ['c0', 'c1', 'c3'] }),
    ]) {
      const s = run(triggered, at.configure(next, T + 2_000))
      expect(schedulerView(s).reason).not.toBe('trigger')
      // The dropped event does not come back with its end either.
      const after = run(s, at.event(ended(motion, T + 3_000), T + 3_000))
      expect(schedulerView(after).reason).not.toBe('trigger')
    }
  })

  it('restarts the interval when it changes or rotation becomes enabled; clears it when disabled', () => {
    const base = createScheduler(cell(), T)
    const slower = run(base, at.configure(cell({ rotateIntervalSec: 20 }), T + 5_000))
    expect(nextWakeAt(slower)).toBe(T + 25_000)

    const off = run(base, at.configure(cell({ rotateIntervalSec: undefined }), T + 5_000))
    expect(nextWakeAt(off)).toBeNull()
    expect(schedulerView(run(off, at.tick(T + 100_000))).index).toBe(0)

    const on = run(off, at.configure(cell({ rotateIntervalSec: 5 }), T + 7_000))
    expect(nextWakeAt(on)).toBe(T + 12_000)
    expect(schedulerView(run(on, at.tick(T + 12_000))).index).toBe(1)
  })

  it('handles the cameras being emptied', () => {
    const s = run(
      createScheduler(cell(), T),
      at.event(ev({ cameraId: 'c2', start: T + 1_000 }), T + 1_000),
      at.configure(cell({ cameraIds: [] }), T + 2_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: -1, cameraId: null, count: 0 })
    expect(nextWakeAt(s)).toBeNull()
    expect(schedulerView(run(s, at.tick(T + 100_000))).cameraId).toBeNull()
  })

  it('keeps the pin, on the same camera or on the new index when it vanished', () => {
    const pinned = run(
      createScheduler(cell(), T),
      at.tick(T + 10_000),
      at.tick(T + 20_000),
      at.pin(T + 21_000),
    )
    expect(shown(pinned)).toEqual({ cameraId: 'c2', reason: 'pinned' })

    const moved = run(pinned, at.configure(cell({ cameraIds: ['c2', 'c0'] }), T + 22_000))
    expect(schedulerView(moved)).toMatchObject({ index: 0, cameraId: 'c2', reason: 'pinned' })
    expect(nextWakeAt(moved)).toBeNull()

    const gone = run(pinned, at.configure(cell({ cameraIds: ['c1', 'c3'] }), T + 22_000))
    expect(schedulerView(gone)).toMatchObject({ index: 0, cameraId: 'c1', reason: 'pinned' })
  })
})

describe('time handling', () => {
  it('advances only one step after missed intervals (sleep) and reschedules from now', () => {
    const s = run(createScheduler(cell(), T), at.tick(T + 35_000))
    expect(schedulerView(s).index).toBe(1)
    expect(nextWakeAt(s)).toBe(T + 45_000)
  })

  it('schedules from the scheduled time when a tick is a little late (no drift)', () => {
    const s = run(createScheduler(cell(), T), at.tick(T + 10_500))
    expect(schedulerView(s).index).toBe(1)
    expect(nextWakeAt(s)).toBe(T + 20_000)
  })

  it('does not crash when now goes backwards, and treats it as no time passing', () => {
    let s = run(createScheduler(cell(), T), at.tick(T + 15_000))
    expect(schedulerView(s).index).toBe(1)
    s = run(s, at.tick(T + 5_000))
    expect(schedulerView(s)).toMatchObject({ index: 1, reason: 'rotation' })
    const motion = ev({ cameraId: 'c3', start: T + 16_000 })
    s = run(
      s,
      at.event(motion, T + 16_000),
      at.event(ended(motion, T + 17_000), T + 1_000),
      at.next(T),
      at.pin(T - 1_000),
      at.unpin(T - 2_000),
      at.configure(cell(), T - 3_000),
      at.prev(0),
    )
    const v = schedulerView(s)
    expect(v.count).toBe(4)
    expect(v.index).toBeGreaterThanOrEqual(0)
    expect(v.index).toBeLessThan(4)
    expect(v.cameraId).toBe(CAMS[v.index])
  })
})

describe('nextWakeAt', () => {
  it('is null with no rotation and nothing pending', () => {
    expect(nextWakeAt(createScheduler(cell({ rotateIntervalSec: undefined }), T))).toBeNull()
    expect(nextWakeAt(createScheduler(cell({ cameraIds: ['c0'] }), T))).toBeNull()
  })

  it('takes the earliest of the running and holding deadlines, ignoring rotation while triggered', () => {
    const a = ev({ cameraId: 'c1', start: T + 1_000 })
    const b = ev({ cameraId: 'c2', start: T + 2_000 })
    let s = run(createScheduler(cell(), T), at.event(a, T + 1_000), at.event(b, T + 2_000))
    expect(nextWakeAt(s)).toBe(T + 61_000)
    s = run(s, at.event(ended(a, T + 3_000), T + 4_000))
    expect(nextWakeAt(s)).toBe(T + 18_000)
    s = run(s, at.tick(T + 18_000))
    expect(nextWakeAt(s)).toBe(T + 62_000)
  })

  it('a tick exactly at nextWakeAt changes the state; a tick just before does not', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    let s = createScheduler(cell(), T)
    const steps: SchedulerAction[] = [
      at.event(motion, T + 1_000), // running → stale deadline
      at.event(ended(motion, T + 3_000), T + 5_000), // holding → holdUntil
    ]
    const check = (state: SchedulerState): SchedulerState => {
      const wake = nextWakeAt(state)
      expect(wake).not.toBeNull()
      expect(reduceScheduler(state, at.tick((wake ?? 0) - 1))).toBe(state)
      const changed = reduceScheduler(state, at.tick(wake ?? 0))
      expect(changed).not.toBe(state)
      return changed
    }
    check(s) // rotation step
    for (const step of steps) s = reduceScheduler(s, step)
    s = check(s) // hold ends
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'rotation' })
    s = check(s) // rotation step from the held camera
    expect(schedulerView(s).index).toBe(3)

    const stale = run(createScheduler(cell(), T), at.event(ev({ cameraId: 'c1', start: T }), T))
    check(stale) // stale deadline
  })
})

describe('purity', () => {
  it('never mutates its input (deep-frozen state and actions)', () => {
    const c = deepFreeze(cell())
    let s = deepFreeze(createScheduler(c, T))
    const snapshot = JSON.stringify(s)
    const motion = deepFreeze(ev({ cameraId: 'c2', start: T + 1_000 }))
    const actions = [
      at.tick(T + 500),
      at.event(motion, T + 1_000),
      at.event(deepFreeze(ended(motion, T + 3_000)), T + 4_000),
      at.pin(T + 5_000),
      at.next(T + 6_000),
      at.unpin(T + 7_000),
      at.event(deepFreeze(ev({ cameraId: 'c0', start: T + 8_000, trigger: 'ring' })), T + 8_000),
      at.prev(T + 9_000),
      at.configure(
        deepFreeze(cell({ cameraIds: ['c3', 'c0'], rotateIntervalSec: 20 })),
        T + 10_000,
      ),
      at.tick(T + 100_000),
      at.tick(T + 1_000_000),
    ].map(deepFreeze)
    const first = s
    for (const action of actions) {
      const prev = JSON.stringify(s)
      const next = reduceScheduler(s, action)
      expect(JSON.stringify(s)).toBe(prev)
      s = deepFreeze(next)
    }
    expect(JSON.stringify(first)).toBe(snapshot)
  })

  it('returns the same reference when nothing changed', () => {
    const s = createScheduler(cell(), T)
    expect(reduceScheduler(s, at.tick(T))).toBe(s)
    expect(reduceScheduler(s, at.tick(T + 9_999))).toBe(s)
    expect(reduceScheduler(s, at.event(ev({ cameraId: 'c9', start: T }), T + 1_000))).toBe(s)
    expect(reduceScheduler(s, at.unpin(T + 1_000))).toBe(s)
    const single = createScheduler(cell({ cameraIds: ['c0'] }), T)
    expect(reduceScheduler(single, at.next(T + 1_000))).toBe(single)
    expect(reduceScheduler(single, at.tick(T + 1_000_000))).toBe(single)
  })

  it('prunes, so the state stays bounded after many events', () => {
    const fresh = createScheduler(cell(), T)
    const freshSize = JSON.stringify(fresh).length
    let s = fresh
    let t = T
    const sizes: number[] = []
    for (let i = 0; i < 3_000; i += 1) {
      t += 2_000
      const e = ev({
        cameraId: CAMS[i % 4] ?? 'c0',
        start: t,
        trigger: i % 7 === 0 ? 'ring' : 'motion',
      })
      s = reduceScheduler(s, at.event(e, t))
      // Most end normally; every tenth is left to go stale.
      if (i % 10 !== 0) s = reduceScheduler(s, at.event(ended(e, t + 1_000), t + 1_500))
      if (i % 500 === 499) sizes.push(JSON.stringify(s).length)
    }
    // The size plateaus: the last sample is no bigger than ~1.5× the first (after 1000 s of events).
    const [first = 0] = sizes
    const last = sizes.at(-1) ?? Infinity
    expect(last).toBeLessThan(first * 1.5)
    expect(last).toBeLessThan(200_000)
    // After a quiet hour everything (events and tombstones) is gone.
    s = run(s, at.tick(t + 3_600_000))
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(freshSize * 2 + 500)
  })
})

describe('no rotation configured', () => {
  it('never rotates, and after a hold stays on the held camera', () => {
    let s = createScheduler(cell({ rotateIntervalSec: undefined }), T)
    s = run(s, at.tick(T + 100_000))
    expect(schedulerView(s)).toMatchObject({ index: 0, reason: 'rotation' })
    const motion = ev({ cameraId: 'c2', start: T + 101_000 })
    s = run(s, at.event(motion, T + 101_000), at.event(ended(motion, T + 102_000), T + 103_000))
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'trigger' })
    expect(nextWakeAt(s)).toBe(T + 117_000)
    s = run(s, at.tick(T + 117_000))
    expect(schedulerView(s)).toMatchObject({
      index: 2,
      cameraId: 'c2',
      reason: 'rotation',
    })
    expect(nextWakeAt(s)).toBeNull()
    s = run(s, at.tick(T + 1_000_000))
    expect(schedulerView(s).index).toBe(2)
  })
})

describe('single-camera cell', () => {
  it('stays on index 0 and still triggers', () => {
    const one = cell({ cameraIds: ['c0'] })
    let s = createScheduler(one, T)
    expect(schedulerView(s)).toMatchObject({
      index: 0,
      cameraId: 'c0',
      count: 1,
      reason: 'rotation',
    })
    expect(nextWakeAt(s)).toBeNull()
    const motion = ev({ cameraId: 'c0', start: T + 1_000 })
    s = run(s, at.event(motion, T + 1_000))
    expect(schedulerView(s)).toMatchObject({
      index: 0,
      reason: 'trigger',
      trigger: 'motion',
    })
    s = run(s, at.pin(T + 2_000))
    expect(schedulerView(s)).toMatchObject({ index: 0, reason: 'pinned' })
    s = run(
      s,
      at.event(ended(motion, T + 3_000), T + 3_000),
      at.tick(T + 18_000),
      at.unpin(T + 19_000),
    )
    expect(schedulerView(s)).toMatchObject({ index: 0, reason: 'rotation' })
    expect(nextWakeAt(s)).toBeNull()
  })
})

describe('late messages for pruned events', () => {
  // Pruned 5 min after its hold: a stale-closed event first seen at T+2 s ends (stale) at T+62 s,
  // holds to T+77 s and is pruned at T+377 s.
  function pruned(): { motion: CameraEvent; s: SchedulerState } {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 2_000),
      at.tick(T + 380_000),
      at.tick(T + 420_000),
    )
    return { motion, s }
  }

  it("ignores a pruned event's very late real end", () => {
    const { motion, s } = pruned()
    const late = reduceScheduler(s, at.event(ended(motion, T + 415_000), T + 420_000))
    expect(late).toBe(s)
    expect(schedulerView(late).reason).toBe('rotation')
  })

  it('ignores an end-less update for a pruned event instead of taking the cell for 60 s', () => {
    const { motion, s } = pruned()
    expect(reduceScheduler(s, at.event(motion, T + 420_000))).toBe(s)
  })

  it('ignores an unknown end-less event whose start is already older than 60 s', () => {
    const first = ev({ cameraId: 'c0', start: T })
    const s = run(createScheduler(cell(), T), at.event(first, T), at.tick(T + 200_000))
    const old = ev({ cameraId: 'c1', start: T + 100_000 })
    expect(reduceScheduler(s, at.event(old, T + 200_000))).toBe(s)
  })

  it('uses the latest add offset, so a skewed console still triggers', () => {
    const skew = -10 * 60_000 // console clock 10 min behind
    const first = ev({ cameraId: 'c0', start: T + skew })
    let s = run(createScheduler(cell(), T), at.event(first, T), at.tick(T + 200_000))
    const fresh = ev({ cameraId: 'c3', start: T + 200_000 + skew })
    s = run(s, at.event(fresh, T + 200_000))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c3', reason: 'trigger' })
  })

  it('accepts the first add from a console whose clock is minutes behind (no offset known yet)', () => {
    const motion = ev({ cameraId: 'c3', start: T - 10 * 60_000 })
    const s = run(createScheduler(cell(), T), at.event(motion, T))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c3', reason: 'trigger' })
  })
})

describe('ends for events that are over or dismissed', () => {
  it('does not resurrect an event whose hold is over with a different end', () => {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    const over = run(
      createScheduler(cell(), T),
      at.event(motion, T + 2_000),
      at.event(ended(motion, T + 5_000), T + 5_000),
      at.tick(T + 20_000),
    )
    expect(schedulerView(over).reason).toBe('rotation')
    expect(reduceScheduler(over, at.event(ended(motion, T + 19_000), T + 20_000))).toBe(over)
  })

  it('does not bring back a dismissed event with a different end', () => {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    const dismissed = run(
      createScheduler(cell(), T),
      at.event(motion, T + 2_000),
      at.event(ended(motion, T + 5_000), T + 5_000),
      at.next(T + 6_000),
    )
    expect(schedulerView(dismissed)).toMatchObject({ cameraId: 'c3', reason: 'rotation' })
    const after = reduceScheduler(dismissed, at.event(ended(motion, T + 6_000), T + 7_000))
    expect(after).toBe(dismissed)
  })

  it('still recomputes a different end for a holding event', () => {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    const s = run(
      createScheduler(cell(), T),
      at.event(motion, T + 2_000),
      at.event(ended(motion, T + 5_000), T + 5_000),
      at.event(ended(motion, T + 8_000), T + 9_000),
    )
    expect(nextWakeAt(s)).toBe(T + 23_000)
  })
})

describe('configure with a new motionHoldSec', () => {
  function endedAt5(): SchedulerState {
    const motion = ev({ cameraId: 'c2', start: T + 2_000 })
    return run(
      createScheduler(cell(), T),
      at.event(motion, T + 2_000),
      at.event(ended(motion, T + 5_000), T + 5_000),
    )
  }

  it('lengthens a hold that is still running', () => {
    const s = run(endedAt5(), at.configure(cell({ motionHoldSec: 30 }), T + 10_000))
    expect(nextWakeAt(s)).toBe(T + 35_000)
    expect(schedulerView(run(s, at.tick(T + 34_999))).reason).toBe('trigger')
  })

  it('gives the same answer when the old hold had already run out', () => {
    const s = run(
      endedAt5(),
      at.tick(T + 20_000),
      at.configure(cell({ motionHoldSec: 30 }), T + 21_000),
    )
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c2', reason: 'trigger' })
    expect(nextWakeAt(s)).toBe(T + 35_000)
  })

  it('shortens a hold, ending it at once when it is already past', () => {
    const s = run(endedAt5(), at.configure(cell({ motionHoldSec: 2 }), T + 10_000))
    expect(schedulerView(s)).toMatchObject({ cameraId: 'c2', reason: 'rotation' })
  })
})

describe('non-finite times', () => {
  it('ignores an action whose now is not finite', () => {
    const s = createScheduler(cell(), T)
    for (const now of [Number.NaN, Infinity, -Infinity]) {
      expect(reduceScheduler(s, at.tick(now))).toBe(s)
      expect(reduceScheduler(s, at.next(now))).toBe(s)
    }
    // The clock is not poisoned: rotation still runs on time.
    const after = run(s, at.tick(Number.NaN), at.tick(T + 10_000))
    expect(schedulerView(after).index).toBe(1)
  })

  it('ignores an event whose start or end is not finite', () => {
    const s = createScheduler(cell(), T)
    const bad = ev({ cameraId: 'c2', start: T })
    expect(reduceScheduler(s, at.event({ ...bad, start: Number.NaN }, T))).toBe(s)
    expect(reduceScheduler(s, at.event({ ...bad, end: Infinity }, T))).toBe(s)
    const running = run(s, at.event(bad, T))
    expect(reduceScheduler(running, at.event({ ...bad, end: Number.NaN }, T + 1_000))).toBe(running)
  })
})

describe('upcomingRotation (P4.4)', () => {
  it('names the next camera and when the step is due', () => {
    const s = createScheduler(cell(), T)
    expect(upcomingRotation(s)).toEqual({ index: 1, cameraId: 'c1', at: T + 10_000 })
  })

  it('is exactly what a tick at that time shows, through a whole cycle and its wrap', () => {
    let s = createScheduler(cell(), T)
    for (let i = 0; i < 6; i += 1) {
      const upcoming = upcomingRotation(s)
      if (upcoming === null) throw new Error('expected an upcoming rotation')
      expect(reduceScheduler(s, at.tick(upcoming.at - 1))).toBe(s)
      s = reduceScheduler(s, at.tick(upcoming.at))
      expect(schedulerView(s)).toMatchObject({
        index: upcoming.index,
        cameraId: upcoming.cameraId,
        reason: 'rotation',
      })
    }
    // Six steps of four cameras: on c2, next is c3.
    expect(upcomingRotation(s)).toMatchObject({ index: 3, cameraId: 'c3' })
  })

  it('wraps from the last camera to the first', () => {
    const s = run(createScheduler(cell(), T), at.prev(T + 1_000))
    expect(schedulerView(s).index).toBe(3)
    expect(upcomingRotation(s)).toEqual({ index: 0, cameraId: 'c0', at: T + 11_000 })
  })

  it('is null without rotation, or with fewer than two cameras', () => {
    expect(upcomingRotation(createScheduler(cell({ rotateIntervalSec: undefined }), T))).toBeNull()
    expect(upcomingRotation(createScheduler(cell({ cameraIds: ['c0'] }), T))).toBeNull()
    expect(upcomingRotation(createScheduler(cell({ cameraIds: [] }), T))).toBeNull()
  })

  it('is null while pinned, and back with a full interval on unpin', () => {
    const pinned = run(createScheduler(cell(), T), at.pin(T + 1_000))
    expect(upcomingRotation(pinned)).toBeNull()
    expect(upcomingRotation(run(pinned, at.next(T + 2_000)))).toBeNull()
    const unpinned = run(pinned, at.unpin(T + 3_000))
    expect(upcomingRotation(unpinned)).toEqual({ index: 1, cameraId: 'c1', at: T + 13_000 })
  })

  it('is null while a trigger shows, and resumes from the held camera when it is over', () => {
    const motion = ev({ cameraId: 'c2', start: T + 1_000 })
    let s = run(createScheduler(cell(), T), at.event(motion, T + 1_000))
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'trigger' })
    expect(upcomingRotation(s)).toBeNull()
    s = run(s, at.event(ended(motion, T + 2_000), T + 2_000), at.tick(T + 17_000))
    expect(shown(s)).toEqual({ cameraId: 'c2', reason: 'rotation' })
    expect(upcomingRotation(s)).toEqual({ index: 3, cameraId: 'c3', at: T + 27_000 })
  })

  it('follows a manual step, which restarts the interval', () => {
    const s = run(createScheduler(cell(), T), at.next(T + 4_000))
    expect(upcomingRotation(s)).toEqual({ index: 2, cameraId: 'c2', at: T + 14_000 })
  })

  it('is null when the next entry is the camera already shown (listed twice in a row)', () => {
    const twice = cell({ cameraIds: ['c0', 'c0', 'c1'] })
    let s = createScheduler(twice, T)
    expect(upcomingRotation(s)).toBeNull()
    s = run(s, at.tick(T + 10_000))
    expect(schedulerView(s).index).toBe(1)
    expect(upcomingRotation(s)).toEqual({ index: 2, cameraId: 'c1', at: T + 20_000 })
  })

  it('names the ref as stored, a package entry included', () => {
    const s = createScheduler(cell({ cameraIds: ['c0', 'c0:package'] }), T)
    expect(upcomingRotation(s)).toMatchObject({ cameraId: 'c0:package' })
  })

  it('reports a step already overdue (a late tick) with its past time', () => {
    const s = createScheduler(cell(), T)
    // No tick has run: the step at T+10 s is still upcoming whatever the wall clock says.
    expect(upcomingRotation(s)?.at).toBe(T + 10_000)
  })

  it('never mutates its input', () => {
    const s = deepFreeze(createScheduler(cell(), T))
    expect(() => upcomingRotation(s)).not.toThrow()
  })
})
