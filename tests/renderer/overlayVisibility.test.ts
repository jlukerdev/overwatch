// P3.4: when a cell's overlay controls are shown (src/renderer/src/features/cells/overlayVisibility.ts;
// CELL-3, CELL-4, QUAL-7).
//
// What these tests protect: the strip shows on hover and hides `ui.overlayAutoHideSec` after the
// last movement, every move pushes that out, a timeout that fires early changes nothing, leaving
// hides at once unless keyboard focus is inside, focus holds the strip open, the cursor hides only
// while hovered and idle, (P3.7) any focus on a select holds the strip like keyboard focus, and an
// unusable
// `ui.overlayAutoHideSec` falls back to CELL-4's 3 s (sanitised once, in `overlayAutoHideMs`).
import { describe, expect, it } from 'vitest'
import {
  blursOnKey,
  DEFAULT_OVERLAY_AUTO_HIDE_MS,
  focusHoldsControls,
  INITIAL_OVERLAY_VISIBILITY,
  overlayAutoHideMs,
  overlayView,
  reduceOverlayVisibility,
  releasesOnPointerLeave,
  isControlsShown,
  isCursorHidden,
  type OverlayView,
  type OverlayVisibilityEvent,
  type OverlayVisibilityState,
} from '../../src/renderer/src/features/cells/overlayVisibility'

const AUTO_HIDE = 3000

function run(
  events: readonly OverlayVisibilityEvent[],
  autoHideMs = AUTO_HIDE,
  from: OverlayVisibilityState = INITIAL_OVERLAY_VISIBILITY,
): OverlayVisibilityState {
  return events.reduce((state, event) => reduceOverlayVisibility(state, event, autoHideMs), from)
}

const SHOWN: OverlayView = { controlsShown: true, cursorHidden: false }
const HIDDEN: OverlayView = { controlsShown: false, cursorHidden: false }
const IDLE: OverlayView = { controlsShown: false, cursorHidden: true }

describe('overlayVisibility (CELL-4)', () => {
  it('starts hidden, with the cursor left alone', () => {
    expect(overlayView(INITIAL_OVERLAY_VISIBILITY)).toEqual(HIDDEN)
    expect(INITIAL_OVERLAY_VISIBILITY.hideAt).toBeNull()
  })

  it('shows on enter and hides autoHideMs later', () => {
    const entered = run([{ type: 'pointerEnter', now: 1000 }])
    expect(overlayView(entered)).toEqual(SHOWN)
    expect(entered.hideAt).toBe(4000)

    const hidden = run([{ type: 'check', now: 4000 }], AUTO_HIDE, entered)
    expect(overlayView(hidden)).toEqual(IDLE)
    expect(hidden.hideAt).toBeNull()
  })

  it('shows on a move with no enter before it', () => {
    const moved = run([{ type: 'pointerMove', now: 500 }])
    expect(moved.hovered).toBe(true)
    expect(overlayView(moved)).toEqual(SHOWN)
    expect(moved.hideAt).toBe(3500)
  })

  it('pushes the deadline out on every move', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'pointerMove', now: 2000 },
      { type: 'pointerMove', now: 2900 },
    ])
    expect(state.hideAt).toBe(5900)
    // The timeout set for the first deadline fires: still shown.
    const early = run([{ type: 'check', now: 3000 }], AUTO_HIDE, state)
    expect(overlayView(early)).toEqual(SHOWN)
    // The real deadline hides it.
    expect(overlayView(run([{ type: 'check', now: 5900 }], AUTO_HIDE, state))).toEqual(IDLE)
  })

  it('ignores a check before the deadline, returning the same state', () => {
    const state = run([{ type: 'pointerEnter', now: 0 }])
    expect(reduceOverlayVisibility(state, { type: 'check', now: 2999 }, AUTO_HIDE)).toBe(state)
    expect(reduceOverlayVisibility(state, { type: 'check', now: -1 }, AUTO_HIDE)).toBe(state)
  })

  it('ignores a check with no deadline pending, returning the same state', () => {
    expect(
      reduceOverlayVisibility(INITIAL_OVERLAY_VISIBILITY, { type: 'check', now: 1e9 }, AUTO_HIDE),
    ).toBe(INITIAL_OVERLAY_VISIBILITY)
    const idle = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'check', now: 3000 },
    ])
    expect(reduceOverlayVisibility(idle, { type: 'check', now: 9000 }, AUTO_HIDE)).toBe(idle)
  })

  it('hides at once on leave, cursor included', () => {
    const left = run([{ type: 'pointerEnter', now: 0 }, { type: 'pointerLeave' }])
    expect(overlayView(left)).toEqual(HIDDEN)
    expect(left).toEqual(INITIAL_OVERLAY_VISIBILITY)
  })

  it('brings the cursor back on leave after it was hidden', () => {
    const left = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'check', now: 3000 },
      { type: 'pointerLeave' },
    ])
    expect(overlayView(left)).toEqual(HIDDEN)
  })

  it('treats a leave while not hovered as nothing', () => {
    expect(
      reduceOverlayVisibility(INITIAL_OVERLAY_VISIBILITY, { type: 'pointerLeave' }, AUTO_HIDE),
    ).toBe(INITIAL_OVERLAY_VISIBILITY)
  })

  it('shows again on re-enter after hiding, with a fresh deadline', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'check', now: 3000 },
      { type: 'pointerLeave' },
      { type: 'pointerEnter', now: 10_000 },
    ])
    expect(overlayView(state)).toEqual(SHOWN)
    expect(state.hideAt).toBe(13_000)
  })

  it('shows again on a move after the cursor was hidden', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'check', now: 3000 },
      { type: 'pointerMove', now: 7000 },
    ])
    expect(overlayView(state)).toEqual(SHOWN)
    expect(state.hideAt).toBe(10_000)
  })
})

describe('overlayVisibility: keyboard focus', () => {
  it('shows while focus is inside, hovered or not', () => {
    const focused = run([{ type: 'focusIn' }])
    expect(overlayView(focused)).toEqual(SHOWN)
    expect(focused.hideAt).toBeNull()
  })

  it('stays shown past the deadline while focus is inside, and keeps the cursor', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'focusIn' },
      { type: 'check', now: 3000 },
    ])
    expect(overlayView(state)).toEqual(SHOWN)
  })

  it('stays shown on leave while focus is inside', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'focusIn' },
      { type: 'pointerLeave' },
    ])
    expect(state.hovered).toBe(false)
    expect(overlayView(state)).toEqual(SHOWN)
  })

  it('hides on focus-out while not hovered', () => {
    const state = run([
      { type: 'pointerEnter', now: 0 },
      { type: 'focusIn' },
      { type: 'pointerLeave' },
      { type: 'focusOut' },
    ])
    expect(overlayView(state)).toEqual(HIDDEN)
  })

  it('on focus-out while hovered, follows the pointer deadline', () => {
    const base: OverlayVisibilityEvent[] = [{ type: 'pointerEnter', now: 0 }, { type: 'focusIn' }]
    // Deadline still pending: stays shown until it.
    const pending = run([...base, { type: 'focusOut' }])
    expect(overlayView(pending)).toEqual(SHOWN)
    expect(pending.hideAt).toBe(3000)
    // Deadline already passed: hides, and the idle cursor hides with it.
    const passed = run([...base, { type: 'check', now: 3000 }, { type: 'focusOut' }])
    expect(overlayView(passed)).toEqual(IDLE)
  })

  it('returns the same state for a repeated focus-in or a focus-out with no focus inside', () => {
    const focused = run([{ type: 'focusIn' }])
    expect(reduceOverlayVisibility(focused, { type: 'focusIn' }, AUTO_HIDE)).toBe(focused)
    expect(
      reduceOverlayVisibility(INITIAL_OVERLAY_VISIBILITY, { type: 'focusOut' }, AUTO_HIDE),
    ).toBe(INITIAL_OVERLAY_VISIBILITY)
  })
})

describe('overlayVisibility: the two booleans', () => {
  it('match overlayView for every combination of hovered, focus and deadline', () => {
    for (const hovered of [false, true]) {
      for (const focusWithin of [false, true]) {
        for (const hideAt of [null, 5]) {
          const state: OverlayVisibilityState = { hovered, focusWithin, hideAt }
          expect(overlayView(state)).toEqual({
            controlsShown: isControlsShown(state),
            cursorHidden: isCursorHidden(state),
          })
          expect(isControlsShown(state)).toBe(focusWithin || hideAt !== null)
          expect(isCursorHidden(state)).toBe(hovered && !focusWithin && hideAt === null)
        }
      }
    }
  })
})

describe('overlayVisibility: the auto-hide delay', () => {
  it('uses the delay it is given', () => {
    expect(run([{ type: 'pointerEnter', now: 100 }], 10_000).hideAt).toBe(10_100)
    expect(run([{ type: 'pointerEnter', now: 100 }], 1).hideAt).toBe(101)
  })

  it('converts ui.overlayAutoHideSec to ms, defaulting what is unusable', () => {
    expect(DEFAULT_OVERLAY_AUTO_HIDE_MS).toBe(3000)
    expect(overlayAutoHideMs(3)).toBe(3000)
    expect(overlayAutoHideMs(0.5)).toBe(500)
    expect(overlayAutoHideMs(10)).toBe(10_000)
    for (const bad of [undefined, null, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, '3', {}]) {
      expect(overlayAutoHideMs(bad), JSON.stringify(bad)).toBe(DEFAULT_OVERLAY_AUTO_HIDE_MS)
    }
  })
})

describe('overlayVisibility: which focus holds the strip (P3.7)', () => {
  it('holds for keyboard focus on any control', () => {
    expect(focusHoldsControls({ tagName: 'BUTTON', focusVisible: true })).toBe(true)
    expect(focusHoldsControls({ tagName: 'SELECT', focusVisible: true })).toBe(true)
  })

  it('holds for mouse focus on a select, whose open dropdown takes the pointer', () => {
    expect(focusHoldsControls({ tagName: 'SELECT', focusVisible: false })).toBe(true)
  })

  it('does not hold for mouse focus on a button', () => {
    expect(focusHoldsControls({ tagName: 'BUTTON', focusVisible: false })).toBe(false)
  })
})

describe('overlayVisibility: a mouse-focused select lets go (P3.7)', () => {
  const mouseSelect = { tagName: 'SELECT', focusVisible: false }
  const keyboardSelect = { tagName: 'SELECT', focusVisible: true }
  const mouseButton = { tagName: 'BUTTON', focusVisible: false }
  const realLeave = { toElement: true, insideCell: false }

  it('releases a mouse-focused select when the pointer leaves the cell', () => {
    expect(releasesOnPointerLeave(mouseSelect, realLeave)).toBe(true)
    // Out of the window: nothing to go to, but the point is outside the cell.
    expect(releasesOnPointerLeave(mouseSelect, { toElement: false, insideCell: false })).toBe(true)
    // Onto something drawn over the cell.
    expect(releasesOnPointerLeave(mouseSelect, { toElement: true, insideCell: true })).toBe(true)
  })

  it('does not release on the leave the dropdown popup itself may cause', () => {
    expect(releasesOnPointerLeave(mouseSelect, { toElement: false, insideCell: true })).toBe(false)
  })

  it('leaves keyboard focus, other controls and no focus alone', () => {
    expect(releasesOnPointerLeave(keyboardSelect, realLeave)).toBe(false)
    expect(releasesOnPointerLeave(mouseButton, realLeave)).toBe(false)
    expect(releasesOnPointerLeave(null, realLeave)).toBe(false)
  })

  it('blurs a mouse-focused select on Escape only', () => {
    expect(blursOnKey('Escape', mouseSelect)).toBe(true)
    expect(blursOnKey('ArrowDown', mouseSelect)).toBe(false)
    expect(blursOnKey('Escape', keyboardSelect)).toBe(false)
    expect(blursOnKey('Escape', mouseButton)).toBe(false)
  })
})
