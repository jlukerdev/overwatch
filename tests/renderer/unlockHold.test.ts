// P5.4, P5.5 (DOOR-3, DOOR-4, DOOR-6): the unlock control's press-and-hold
// (src/renderer/src/features/door/unlockHold.ts).
//
// What these tests protect: only a completed hold of the primary pointer reaches `requesting` (the
// one unlock request); any release, leave, cancel or abort before then goes back to idle; a second
// pointer and every press while requesting are ignored; a result ends the request and goes back
// to idle whatever it was (the green look is the door's pushed state since P5.5, not a phase here)
// — never a second request; and the toast copy.
import { describe, expect, it } from 'vitest'
import {
  HOLD_MS,
  INITIAL_UNLOCK_HOLD,
  reduceUnlockHold,
  unlockFailureMessage,
  unlockResultEvent,
  unlockSuccessMessage,
  unlockUnknownMessage,
  type UnlockHoldEvent,
  type UnlockHoldState,
} from '../../src/renderer/src/features/door/unlockHold'

function run(
  events: readonly UnlockHoldEvent[],
  from: UnlockHoldState = INITIAL_UNLOCK_HOLD,
): UnlockHoldState {
  return events.reduce(reduceUnlockHold, from)
}

const press = (pointerId = 1, primary = true): UnlockHoldEvent => ({
  type: 'press',
  pointerId,
  primary,
})
const release = (pointerId = 1): UnlockHoldEvent => ({ type: 'release', pointerId })
const elapsed = (pointerId = 1): UnlockHoldEvent => ({ type: 'holdElapsed', pointerId })

describe('constants', () => {
  it('holds for 1 s', () => {
    expect(HOLD_MS).toBe(1000)
  })
})

describe('reduceUnlockHold', () => {
  it('starts idle', () => {
    expect(INITIAL_UNLOCK_HOLD).toEqual({ phase: 'idle' })
  })

  it('a primary press starts a hold for that pointer', () => {
    expect(run([press(7)])).toEqual({ phase: 'holding', pointerId: 7 })
  })

  it('a non-primary press (secondary button, second pointer) does nothing', () => {
    const idle = INITIAL_UNLOCK_HOLD
    expect(reduceUnlockHold(idle, press(1, false))).toBe(idle)
  })

  it('a completed hold requests the unlock', () => {
    expect(run([press(), elapsed()])).toEqual({ phase: 'requesting' })
  })

  it('a release, leave or cancel before 1 s cancels', () => {
    expect(run([press(), release()])).toEqual({ phase: 'idle' })
    // The timer firing afterwards finds no hold and changes nothing.
    expect(run([press(), release(), elapsed()])).toEqual({ phase: 'idle' })
  })

  it('an abort (window blur, no longer available) cancels a hold', () => {
    expect(run([press(), { type: 'abort' }])).toEqual({ phase: 'idle' })
  })

  it('an abort never cancels a request in flight', () => {
    const requesting = run([press(), elapsed()])
    expect(reduceUnlockHold(requesting, { type: 'abort' })).toBe(requesting)
  })

  it('ignores a second pointer while one holds, and its release', () => {
    const holding = run([press(1)])
    expect(reduceUnlockHold(holding, press(2))).toBe(holding)
    expect(reduceUnlockHold(holding, release(2))).toBe(holding)
    expect(reduceUnlockHold(holding, elapsed(2))).toBe(holding)
    expect(run([press(2), elapsed(1)], holding)).toEqual({ phase: 'requesting' })
  })

  it('ignores every press while requesting, so one hold is one request', () => {
    const requesting = run([press(), elapsed()])
    expect(reduceUnlockHold(requesting, press(1))).toBe(requesting)
    expect(reduceUnlockHold(requesting, press(2))).toBe(requesting)
    expect(reduceUnlockHold(requesting, release(1))).toBe(requesting)
    expect(reduceUnlockHold(requesting, elapsed(1))).toBe(requesting)
  })

  it('a success goes back to idle: there is no unlocked phase (DOOR-6)', () => {
    const done = run([press(), elapsed(), { type: 'result', ok: true }])
    expect(done).toEqual({ phase: 'idle' })
    // Nothing follows by itself: no timer event, no second request.
    expect(reduceUnlockHold(done, elapsed())).toBe(done)
    expect(reduceUnlockHold(done, { type: 'result', ok: true })).toBe(done)
  })

  it('only idle, holding and requesting are ever reached', () => {
    const events: UnlockHoldEvent[] = [
      press(),
      release(),
      press(2),
      elapsed(2),
      press(3),
      { type: 'result', ok: true },
      press(4),
      { type: 'abort' },
      press(5),
      elapsed(5),
      { type: 'result', ok: false },
    ]
    const phases = new Set<string>()
    let state = INITIAL_UNLOCK_HOLD
    for (const event of events) {
      state = reduceUnlockHold(state, event)
      phases.add(state.phase)
    }
    expect([...phases].sort()).toEqual(['holding', 'idle', 'requesting'])
  })

  it('a failure goes back to idle and never requests again by itself', () => {
    const failed = run([press(), elapsed(), { type: 'result', ok: false }])
    expect(failed).toEqual({ phase: 'idle' })
    expect(reduceUnlockHold(failed, elapsed())).toBe(failed)
  })

  it('a result with no request out changes nothing', () => {
    const idle = INITIAL_UNLOCK_HOLD
    expect(reduceUnlockHold(idle, { type: 'result', ok: true })).toBe(idle)
    const holding = run([press()])
    expect(reduceUnlockHold(holding, { type: 'result', ok: true })).toBe(holding)
  })

  it('a press after a successful unlock starts a new hold, and that hold is one more request', () => {
    // The door may still be unlocked (the button green, DOOR-6): holding again is allowed.
    const done = run([press(), elapsed(), { type: 'result', ok: true }])
    expect(reduceUnlockHold(done, press(3))).toEqual({ phase: 'holding', pointerId: 3 })
    expect(run([press(3), elapsed(3)], done)).toEqual({ phase: 'requesting' })
  })

  it('has no event but a completed primary-pointer hold that reaches requesting (DOOR-4)', () => {
    // Every event the reducer knows, from idle and from a request just answered: none requests.
    const others: UnlockHoldEvent[] = [
      press(1, false),
      release(),
      elapsed(),
      { type: 'result', ok: true },
      { type: 'result', ok: false },
      { type: 'abort' },
    ]
    for (const event of others) {
      expect(reduceUnlockHold(INITIAL_UNLOCK_HOLD, event).phase).toBe('idle')
    }
  })
})

describe('toast copy', () => {
  it('names the camera on success', () => {
    expect(unlockSuccessMessage('Front Door')).toBe('Door unlocked for Front Door.')
  })

  it('names the camera and carries the reason on failure', () => {
    expect(unlockFailureMessage('Front Door', 'Access refused the token.')).toBe(
      "Couldn't unlock the door for Front Door. Access refused the token.",
    )
    expect(unlockFailureMessage('Front Door', '  ')).toBe(
      "Couldn't unlock the door for Front Door.",
    )
  })
})

describe('unlockResultEvent (user decision 2026-11-18)', () => {
  const value = { doorId: 'door-1', cameraName: 'Front Door' }

  it('is ok only for a confirmed unlock', () => {
    expect(
      unlockResultEvent({ ok: true, value: { ...value, outcome: 'unlocked', reason: null } }),
    ).toEqual({ type: 'result', ok: true })
  })

  it('treats an unknown outcome like a failure: back to idle, no second request', () => {
    const event = unlockResultEvent({
      ok: true,
      value: { ...value, outcome: 'unknown', reason: 'The Access API did not answer in time.' },
    })
    expect(event).toEqual({ type: 'result', ok: false })
    const after = run([press(), elapsed(), event])
    expect(after).toEqual({ phase: 'idle' })
  })

  it('is not ok for a failure', () => {
    expect(
      unlockResultEvent({
        ok: false,
        error: { kind: 'network', message: 'down', endpoint: null, retryable: false },
      }),
    ).toEqual({ type: 'result', ok: false })
  })
})

describe('unknown-outcome toast copy', () => {
  it('warns that the door may have unlocked and asks for a check first', () => {
    expect(unlockUnknownMessage('Front Door')).toBe(
      'No answer from Access. The door for Front Door may have unlocked — check before trying again.',
    )
  })
})
