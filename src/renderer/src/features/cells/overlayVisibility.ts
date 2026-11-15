// When a cell's overlay controls are on screen (P3.4; CELL-3, CELL-4), as one pure reducer over the
// pointer and focus events the overlay sees, so the rules are tested in the node environment and
// `<CellOverlay>` holds none of them (CLAUDE.md: no jsdom here).
//
// What is decided here is the *controls strip* only — the quality badge (QUAL-7) and, in later
// tasks, the buttons. The camera name is always on screen and never goes through this.
//
// The rules, and why:
//
//  - **Shown on enter and on every move.** CELL-4: "show on hover". A move with no enter before it
//    (the pointer was already over the cell when it mounted, e.g. after a View switch) counts as an
//    enter, so the overlay never waits for a pointer to leave and come back.
//  - **Hidden `autoHideMs` after the last movement while hovered** (CELL-4, `ui.overlayAutoHideSec`).
//    Every move pushes the deadline out; a pointer resting on a cell is "not moving".
//  - **Hidden at once on leave**, there is nothing to hover any more. The deadline is dropped with it.
//  - **Keyboard focus inside keeps it shown.** The controls must be reachable without a mouse, and a
//    control that fades out from under the keyboard focus is unusable. Focus does not *start* a
//    deadline: it holds the strip for as long as it is inside, then leaving focus hides the strip
//    unless the pointer is still moving over it (its deadline is still pending). Only keyboard focus
//    counts (the component's call, `:focus-visible`): a mouse click on a button also focuses it, and
//    that must not pin the strip open after the pointer leaves. **A select is the exception**
//    ({@link focusHoldsControls}, P3.7): a click on the quality picker (QUAL-4/5) opens its native
//    dropdown, the pointer events go to that dropdown rather than the cell, and a strip that hid
//    meanwhile would take the select — and the badge saying what was picked — away mid-choice. So
//    any focus on a select holds; the picker gives focus back after a pointer pick (QualityPicker).
//  - **A mouse-focused select lets go when it is done with.** A dropdown opened with the mouse and
//    closed with no pick (the same option, `Esc`, a click away) leaves the select focused, and that
//    focus would hold the strip for ever and keep fill's `Esc` from working (a select is a
//    text-entry target, fillMode.ts). So a select focused by the pointer, not the keyboard, is
//    released — and blurred by the component — when the pointer leaves the cell
//    ({@link releasesOnPointerLeave}), and blurred by an `Esc` that reaches it, which only happens
//    while its dropdown is closed: an open one takes the key itself ({@link blursOnKey}). The next
//    `Esc` then leaves fill. A leave with nowhere to go and a point still inside the cell is not the
//    pointer leaving — it is what the browser may send when the dropdown's own popup takes the
//    pointer — and releases nothing. Keyboard focus is untouched by both rules.
//  - **The cursor hides with the controls while hovered.** An idle cursor parked over a wall of
//    cameras is in the way of the picture; it comes back with the first movement (CELL-4's spirit).
//    It is never hidden while not hovered — there is no cursor over the cell to hide — nor while the
//    strip is held open by focus.
//
// **Deterministic.** There is no clock in here: every event that needs a time carries `now` (ms, any
// monotonic origin — the component uses `performance.now()`). The state says when the next hide is
// due (`hideAt`), so the component sets *one* timeout and checks back, rather than polling. A check
// that arrives before the deadline (the timeout was set for an earlier deadline that a move has since
// pushed out) changes nothing, and the component simply sets a new timeout for the remaining time.
//
// **Identity is meaningful.** An event that changes nothing returns the very same state object, so
// the caller can skip work with `===`. A move always changes `hideAt`, so the component compares
// what it draws — {@link isControlsShown}, {@link isCursorHidden} — not the state, before it touches
// anything.
//
// **The delay is trusted.** `autoHideMs` is sanitised once, where the setting is read
// ({@link overlayAutoHideMs}); the reducer adds it as given.
import { DEFAULT_OVERLAY_AUTO_HIDE_SEC } from '@shared/models'

/** CELL-4's default in ms, used when a configured value is unusable. */
export const DEFAULT_OVERLAY_AUTO_HIDE_MS = DEFAULT_OVERLAY_AUTO_HIDE_SEC * 1000

export interface OverlayVisibilityState {
  /** The pointer is over the overlay (i.e. over the cell). */
  readonly hovered: boolean
  /** Keyboard focus is on something inside the overlay. */
  readonly focusWithin: boolean
  /**
   * When the pointer-driven showing ends, in the events' `now` units; `null` when the pointer is
   * not keeping the strip shown (never moved, left, or the deadline has passed).
   */
  readonly hideAt: number | null
}

export type OverlayVisibilityEvent =
  | { readonly type: 'pointerEnter'; readonly now: number }
  | { readonly type: 'pointerMove'; readonly now: number }
  | { readonly type: 'pointerLeave' }
  | { readonly type: 'focusIn' }
  | { readonly type: 'focusOut' }
  /** The timeout for `hideAt` fired (or any other reason to check the clock). */
  | { readonly type: 'check'; readonly now: number }

/** What the component draws. */
export interface OverlayView {
  readonly controlsShown: boolean
  readonly cursorHidden: boolean
}

export const INITIAL_OVERLAY_VISIBILITY: OverlayVisibilityState = {
  hovered: false,
  focusWithin: false,
  hideAt: null,
}

/**
 * The auto-hide delay in ms for `ui.overlayAutoHideSec`. `SettingsSchema` already refuses a
 * non-positive value, but the overlay has to behave whatever reaches it — settings not loaded yet
 * (`undefined`), `NaN`, `Infinity`, `0` — and an overlay that never hides, or flickers off at once,
 * is worse than the default. So anything that is not a finite positive number is the default.
 */
export function overlayAutoHideMs(seconds: unknown): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_OVERLAY_AUTO_HIDE_MS
}

/** The parts of the focused element {@link focusHoldsControls} reads. */
export interface FocusedControl {
  /** `Element.tagName`, upper case for HTML elements. */
  readonly tagName: string
  /** It matches `:focus-visible`, i.e. the focus came from the keyboard. */
  readonly focusVisible: boolean
}

/**
 * Whether focus on this control is a `focusIn` (holds the strip) rather than a `focusOut`: keyboard
 * focus anywhere, and any focus on a select, whose open dropdown takes the pointer (header).
 */
export function focusHoldsControls(control: FocusedControl): boolean {
  return control.focusVisible || control.tagName === 'SELECT'
}

/** A select focused by the pointer rather than the keyboard (header, "lets go"). */
function isPointerFocusedSelect(control: FocusedControl): boolean {
  return control.tagName === 'SELECT' && !control.focusVisible
}

/** The parts of the cell's `pointerleave` {@link releasesOnPointerLeave} reads. */
export interface CellPointerLeave {
  /** `relatedTarget` is an element: the pointer moved onto something else on the page. */
  readonly toElement: boolean
  /** The event's point is still inside the cell's box. */
  readonly insideCell: boolean
}

/**
 * Whether the pointer leaving the cell ends the hold of the focused control — `null` when focus is
 * not inside the overlay — and the component blurs it: a pointer-focused select, on a real leave
 * (header). Keyboard focus, and focus on anything else, is left as it is.
 */
export function releasesOnPointerLeave(
  focused: FocusedControl | null,
  leave: CellPointerLeave,
): boolean {
  if (focused === null || !isPointerFocusedSelect(focused)) return false
  return leave.toElement || !leave.insideCell
}

/**
 * Whether a keydown on the focused control gives its focus back: `Escape` on a pointer-focused
 * select, whose dropdown is closed since the key reached it (header). `focusVisible` here is the
 * picker's own record of its last input, not `:focus-visible`, which the browser turns on for the
 * very key being handled.
 */
export function blursOnKey(key: string, focused: FocusedControl): boolean {
  return key === 'Escape' && isPointerFocusedSelect(focused)
}

/**
 * Returns `state` itself when nothing changes (see the header). `autoHideMs` is trusted: it is
 * sanitised once, where the setting is read, by {@link overlayAutoHideMs}.
 */
export function reduceOverlayVisibility(
  state: OverlayVisibilityState,
  event: OverlayVisibilityEvent,
  autoHideMs: number,
): OverlayVisibilityState {
  switch (event.type) {
    case 'pointerEnter':
    case 'pointerMove':
      return { ...state, hovered: true, hideAt: event.now + autoHideMs }
    case 'pointerLeave':
      return !state.hovered && state.hideAt === null
        ? state
        : { ...state, hovered: false, hideAt: null }
    case 'focusIn':
      return state.focusWithin ? state : { ...state, focusWithin: true }
    case 'focusOut':
      return state.focusWithin ? { ...state, focusWithin: false } : state
    case 'check':
      return state.hideAt !== null && event.now >= state.hideAt ? { ...state, hideAt: null } : state
  }
}

/** The controls strip is on screen. */
export function isControlsShown(state: OverlayVisibilityState): boolean {
  return state.focusWithin || state.hideAt !== null
}

/** The idle cursor is hidden: hovered, and the strip is not on screen. */
export function isCursorHidden(state: OverlayVisibilityState): boolean {
  return state.hovered && !isControlsShown(state)
}

/** Both, as one object (tests; the component reads the two above so a move allocates nothing). */
export function overlayView(state: OverlayVisibilityState): OverlayView {
  return { controlsShown: isControlsShown(state), cursorHidden: isCursorHidden(state) }
}
