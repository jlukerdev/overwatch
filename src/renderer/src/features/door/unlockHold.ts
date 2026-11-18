// The unlock control's press-and-hold, as one pure reducer (P5.4; DOOR-3, DOOR-4). `<UnlockButton>`
// feeds it pointer events and timer expiries and acts on its transitions; every rule is here, so it
// is tested in the node environment (CLAUDE.md: no jsdom).
//
//   idle ──press──▶ holding ──holdElapsed (1 s)──▶ requesting ──result ok──▶ unlocked ──5 s──▶ idle
//                     │                                 └──result not ok──▶ idle
//                     └──release / leave / cancel / abort──▶ idle
//
//  - **Only a completed pointer hold unlocks** (DOOR-4). There is no keyboard or click event here at
//    all: Space, Enter and a synthetic `click` reach the button and do nothing. A press must be the
//    primary button of the primary pointer (`primary`); a second pointer while one holds is ignored,
//    and only the holding pointer's release, or its own expiry, counts.
//  - **One request per hold.** `holdElapsed` for the holding pointer moves to `requesting`, which the
//    component turns into exactly one `unlockDoor` call. While requesting every press is ignored, and
//    nothing here ever starts a second request on its own: a failure goes back to idle and the user
//    holds again (no automatic retry, DOOR-3/4).
//  - **Unlocked is shown for a while, not known.** The app does not read the door's relay on the Live
//    screen yet, so a success is drawn as unlocked for {@link UNLOCKED_SHOWN_MS} and then neutral
//    again. A new press during that time starts a new hold.
//  - **Green only when the door is known unlocked.** `result.ok` is "the console accepted the
//    unlock". A failure and an unknown outcome (main's `outcome: 'unknown'`: no answer, the door may
//    have opened, user decision 2026-11-18) both go back to the neutral door icon; the toast tells
//    them apart ({@link unlockResultEvent}).
//  - `abort` ends a hold that can no longer be seen through: the window lost focus (a release would
//    never arrive), or the button stopped being available. It never cancels a request in flight,
//    which has already left.
//
// **Identity is meaningful.** An event that changes nothing returns the very same state object.
import type { IpcResult, UnlockResult } from '@shared/ipc'

/** DOOR-3: how long the pointer must be held on the button before the unlock is sent. */
export const HOLD_MS = 1000

/**
 * How long a successful unlock shows the open door in green. A stand-in: P5.5 replaces it with
 * the door's real relay state (lock / unlock) read from Access.
 */
export const UNLOCKED_SHOWN_MS = 5000

export type UnlockHoldState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'holding'; readonly pointerId: number }
  | { readonly phase: 'requesting' }
  | { readonly phase: 'unlocked' }

export type UnlockHoldPhase = UnlockHoldState['phase']

export type UnlockHoldEvent =
  /** `pointerdown`; `primary` = the primary button (`button === 0`) of the primary pointer. */
  | { readonly type: 'press'; readonly pointerId: number; readonly primary: boolean }
  /** `pointerup`, `pointerleave` or `pointercancel` of a pointer. */
  | { readonly type: 'release'; readonly pointerId: number }
  /** The hold's timer for this pointer fired. */
  | { readonly type: 'holdElapsed'; readonly pointerId: number }
  /** The unlock request answered; `ok` = the door is known unlocked ({@link unlockResultEvent}). */
  | { readonly type: 'result'; readonly ok: boolean }
  /** The unlocked display's timer fired. */
  | { readonly type: 'shownElapsed' }
  /** A hold that can no longer be followed (window blur, button no longer available). */
  | { readonly type: 'abort' }

export const INITIAL_UNLOCK_HOLD: UnlockHoldState = { phase: 'idle' }

const IDLE: UnlockHoldState = INITIAL_UNLOCK_HOLD
const REQUESTING: UnlockHoldState = { phase: 'requesting' }
const UNLOCKED: UnlockHoldState = { phase: 'unlocked' }

export function reduceUnlockHold(state: UnlockHoldState, event: UnlockHoldEvent): UnlockHoldState {
  switch (event.type) {
    case 'press':
      // Ignored while a hold runs (a second pointer) or a request is in flight.
      if (!event.primary) return state
      if (state.phase === 'idle' || state.phase === 'unlocked') {
        return { phase: 'holding', pointerId: event.pointerId }
      }
      return state
    case 'release':
      return state.phase === 'holding' && state.pointerId === event.pointerId ? IDLE : state
    case 'holdElapsed':
      return state.phase === 'holding' && state.pointerId === event.pointerId ? REQUESTING : state
    case 'result':
      if (state.phase !== 'requesting') return state
      return event.ok ? UNLOCKED : IDLE
    case 'shownElapsed':
      return state.phase === 'unlocked' ? IDLE : state
    case 'abort':
      return state.phase === 'holding' ? IDLE : state
  }
}

/** The toast after a successful unlock (DOOR-3), naming the door by its camera. */
export function unlockSuccessMessage(cameraName: string): string {
  return `Door unlocked for ${cameraName}.`
}

/**
 * The toast after an unlock whose outcome is unknown (main's `outcome: 'unknown'`, user decision
 * 2026-11-18): the request may have reached the console, so the door may be open. A warning, and it
 * asks for a look before another press — a second press is a second door release.
 */
export function unlockUnknownMessage(cameraName: string): string {
  return `No answer from Access. The door for ${cameraName} may have unlocked — check before trying again.`
}

/** The hold's `result` event for main's answer: green only for a confirmed unlock. */
export function unlockResultEvent(
  result: IpcResult<UnlockResult>,
): Extract<UnlockHoldEvent, { type: 'result' }> {
  return { type: 'result', ok: result.ok && result.value.outcome === 'unlocked' }
}

/** The toast after a failed unlock: the camera the cell shows, then main's safe reason. */
export function unlockFailureMessage(cameraName: string, reason: string): string {
  const trimmed = reason.trim()
  const head = `Couldn't unlock the door for ${cameraName}.`
  return trimmed === '' ? head : `${head} ${trimmed}`
}
