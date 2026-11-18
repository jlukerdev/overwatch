// P5.4 (DOOR-3, DOOR-4): the unlock control's press-and-hold
// (src/renderer/src/features/door/unlockHold.ts).
//
// What these tests protect: only a completed hold of the primary pointer reaches `requesting` (the
// one unlock request); any release, leave, cancel or abort before then goes back to idle; a second
// pointer and every press while requesting are ignored; a result ends the request (green on
// success for the shown time, idle on failure or an unknown outcome — never a second request);
// and the toast copy.
import { describe, expect, it } from 'vitest'
import {
  HOLD_MS,
  holdsUnlockShown,
  INITIAL_UNLOCK_HOLD,
  reduceUnlockHold,
  UNLOCKED_SHOWN_MS,
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
  it('holds for 1 s and shows unlocked for 5 s', () => {
    expect(HOLD_MS).toBe(1000)
    expect(UNLOCKED_SHOWN_MS).toBe(5000)
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

  it('a success shows unlocked, then idle when the shown time is up', () => {
    const unlocked = run([press(), elapsed(), { type: 'result', ok: true }])
    expect(unlocked).toEqual({ phase: 'unlocked' })
    expect(reduceUnlockHold(unlocked, { type: 'shownElapsed' })).toEqual({ phase: 'idle' })
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

  it('a press while unlocked starts a new hold', () => {
    const unlocked = run([press(), elapsed(), { type: 'result', ok: true }])
    expect(reduceUnlockHold(unlocked, press(3))).toEqual({ phase: 'holding', pointerId: 3 })
  })

  it('a stale shown timer does nothing outside unlocked', () => {
    const holding = run([press()])
    expect(reduceUnlockHold(holding, { type: 'shownElapsed' })).toBe(holding)
  })
})

describe('holdsUnlockShown', () => {
  it('holds the button on screen while holding, requesting or unlocked, not at rest', () => {
    expect(holdsUnlockShown(INITIAL_UNLOCK_HOLD)).toBe(false)
    expect(holdsUnlockShown(run([press()]))).toBe(true)
    expect(holdsUnlockShown(run([press(), elapsed()]))).toBe(true)
    expect(holdsUnlockShown(run([press(), elapsed(), { type: 'result', ok: true }]))).toBe(true)
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

  it('is green only for a confirmed unlock', () => {
    expect(
      unlockResultEvent({ ok: true, value: { ...value, outcome: 'unlocked', reason: null } }),
    ).toEqual({ type: 'result', ok: true })
  })

  it('treats an unknown outcome like a failure: back to the neutral padlock, no second request', () => {
    const event = unlockResultEvent({
      ok: true,
      value: { ...value, outcome: 'unknown', reason: 'The Access API did not answer in time.' },
    })
    expect(event).toEqual({ type: 'result', ok: false })
    const after = run([press(), elapsed(), event])
    expect(after).toEqual({ phase: 'idle' })
    expect(holdsUnlockShown(after)).toBe(false)
  })

  it('is not green for a failure', () => {
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
