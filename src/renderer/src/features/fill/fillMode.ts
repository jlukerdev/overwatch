// Fill mode's rules (P3.5; FILL-1/2/3, QUAL-5/6): which cell is filled, which clicks and keys
// enter and leave it, and how a filled cell plays. Pure, so every rule is tested in the node
// environment (this project has no jsdom; CLAUDE.md) and `<GridView>` / `<Cell>` only feed it events
// and draw its answers.
//
// **Fill is the grid's own player, enlarged.** There is no fill component. `<GridView>` keeps the
// fill state and, for the filled slot, swaps the slot's box from its grid rectangle to the whole
// grid area (`gridView__slot--filled`, grid.css). The slot keeps its React key, so its `<Cell>` and
// `<LivePlayer>` are the same instances: no remount, no second connection while the first one is
// still on screen. The cell's `quality` prop becomes the slot's `fillQuality` (gridLayout.ts), and
// a change of that prop *is* the player's seamless swap (LivePlayer.tsx, QUAL-6) — the grid stream
// keeps playing until the fill stream paints its first frame (FILL-2). Leaving swaps back the same
// way. The rest of the grid stays mounted and laid out underneath, only covered: its streams keep
// running (NFR-2 budgets "10 grid streams at low + 1 fill stream at high"), so returning to the grid
// is instant rather than ten reconnects.
//
// The rules, and why:
//
//  - **The state names a slot of a View; the derivation decides.** The state is `{ viewId, slotKey }`.
//    A slot is filled only while that View is the one shown *and* it still has a camera slot with that
//    key ({@link filledSlotKey}). So switching View (`1`–`9`, VIEW-4), the camera leaving the console
//    (its slot turns `missing`, CAM-2) or the cell being edited away all leave fill without anyone
//    having to remember to clear it. `<GridView>` also drops a stale state, so coming back to that
//    View later does not re-fill it out of nowhere.
//  - **…except a multi-camera cell on a missing camera, deliberately** (P4.3; CELL-3, FILL-3; the
//    user's decision, 2026-11-15). Its slot stays filled when it turns `missing`, whatever the cause:
//    a next / previous in fill that lands on a camera gone from the console, or the shown camera
//    leaving the console while filled. Throwing the user back to the grid would end their browse of
//    the cell for a camera they can simply step past; the filled placeholder (MissingCell.tsx) keeps
//    the back control, the next / previous, `Esc` and the plain double-click to leave. A one-camera
//    cell has nothing to step to, so it still leaves fill when its camera goes.
//  - **A plain primary click on a camera cell fills it** (FILL-1). Clicks on a control never get here
//    (CellOverlay stops them at its slot); empty cells have no handler, and a missing cell has one
//    only while it is the filled one (to leave by double-click), so a click never fills either.
//    A click with a modifier is left alone, for the same reason the View shortcuts refuse them: they
//    belong to the OS, and ZOOM-2 takes modifier + double-click for itself (the zoom reset,
//    features/zoom/ZoomPan.tsx).
//  - **A plain double-click leaves, but a double-click on a grid cell does not bounce.** The browser
//    sends `click` (detail 1), `click` (detail 2), `dblclick` for one double-click. On a grid cell the
//    first click fills, and a naive "double-click exits" would unfill it a moment later. So a
//    `dblclick` exits only if the first click of its pair arrived while already filled: that click
//    *arms* the exit ({@link fillClickStep}), and a click in the grid disarms it. Only a click with
//    `detail === 1` arms, because `detail` counts the clicks of the current multi-click — a `detail
//    2` click is the second of a pair whose first half may have been the one that filled. Likewise
//    only a `detail` of 0 or 1 fills: the third click of a triple-click that just left fill is not a
//    new request to fill. (0 is a click with no pointer count, e.g. synthesised; the cell is not
//    focusable, so in practice it is always 1.)
//  - **Modifier + double-click is ZOOM-2's** (the zoom reset, P3.6), so it never leaves fill. A
//    drag that pans the zoomed picture never gets here as a click at all: the zoom swallows its
//    trailing `click` (and the `dblclick` of a pair it started), so panning never arms the exit.
//  - **`Esc` leaves** ({@link isFillExitKey}), with the View shortcuts' manners: not on auto-repeat,
//    not with a modifier, not while typing, not if someone already handled it.
//  - **Fit in fill is `contain`** ({@link FILL_FIT}), whatever the View's `fit`: fill is for seeing the
//    whole camera, and the View's `cover` crops to make a wall of cells tidy. Detail is what zoom is
//    for (ZOOM-1, P3.6): it works in fill only, at 1×–8× (features/zoom/).
//  - **FILL-3: a filled multi-camera cell is pinned** (P4.2). Its scheduler (features/cells/
//    useCellSchedulers.ts) is pinned while `<GridView>`'s fill state names its slot, in the same
//    render that fills it, and unpinned on every way out — so the camera on screen when the cell was
//    filled, a trigger's included, stays until the grid comes back. The slot's key follows the
//    cell's first camera (gridLayout.ts), never the shown one, so nothing here changes when the
//    shown camera does: the state keeps naming the same slot.
//  - **The fill picker's pick lasts as long as that fill** (P3.7; QUAL-5: "applies until you leave
//    fill mode"). It is a *session pick*, `{ viewId, slotKey, quality }`, held by `<GridView>` and
//    never persisted, applied above QUAL-5's chain (src/shared/quality.ts): the filled cell plays
//    `pick ?? slot.fillQuality`. Like the fill state, it is only ever *derived* into effect
//    ({@link activeFillPick}): it counts only while it names the slot that is filled right now, so
//    every way out of fill — Esc, back, a plain double-click, a View switch, the slot vanishing —
//    and filling another slot all drop it without anyone remembering to. `<GridView>` also clears a
//    pick that no longer counts, so filling the same cell again later starts from the persisted
//    quality. A package-channel cell (CAM-4) has no picker and ignores any pick: the package channel
//    is a source, not a quality.
//  - **"Save for this View" writes only `view.fillQuality`** (the user's call, 2026-11-15): the
//    app-wide default is Settings' (QUAL-1). It is offered only when it would change something
//    ({@link canSaveFillQuality}): the quality on screen is not already the View's own.
//    Once it lands the pick it saved is dropped, the View now giving the same quality — but only
//    that pick ({@link pickAfterFillSave}): one made while the save was in flight is kept.
import type { Fit } from '@shared/models'
import { PACKAGE_CHANNEL, type Quality, type StreamQuality } from '@shared/quality'
import { showsStepControls } from '../cells/cellPosition'
import type { GridSlot } from '../grid/gridLayout'
import { isTextEntryTarget, type ViewShortcutTarget } from '../viewSwitcher/viewShortcut'

// -------------------------------------------------------------------------------------------------
// Which slot is filled

/** What the user filled: a slot of a View. `null` is the grid. */
export type FillState = { readonly viewId: string; readonly slotKey: string } | null

/** Fill shows the whole camera, whatever the View's own `fit` (header). */
export const FILL_FIT: Fit = 'contain'

/**
 * The key of the slot that is actually filled, or `null` for the grid: `state`'s slot, only while
 * `viewId` is the View on screen and that slot is still a camera slot in it — or, deliberately, a
 * missing slot of a multi-camera cell, however it went missing (a step, or the camera leaving the
 * console; header).
 */
export function filledSlotKey(
  state: FillState,
  viewId: string,
  slots: readonly GridSlot[],
): string | null {
  if (state?.viewId !== viewId) return null
  const slot = slots.find((candidate) => candidate.key === state.slotKey)
  if (slot === undefined) return null
  if (slot.kind === 'camera') return slot.key
  return slot.kind === 'missing' && showsStepControls(slot.position.count) ? slot.key : null
}

// -------------------------------------------------------------------------------------------------
// The fill picker's session pick (QUAL-5)

/** A quality picked in fill for one slot of one View; `null` is no pick (header). */
export type FillQualityPick = {
  readonly viewId: string
  readonly slotKey: string
  readonly quality: Quality
} | null

/**
 * The pick that applies now: `pick`'s quality while it names the slot that is filled (`filledKey`,
 * from {@link filledSlotKey}) in the View on screen, `null` otherwise — out of fill, another View,
 * another slot filled (header).
 */
export function activeFillPick(
  pick: FillQualityPick,
  viewId: string,
  filledKey: string | null,
): Quality | null {
  if (pick === null || filledKey === null) return null
  return pick.viewId === viewId && pick.slotKey === filledKey ? pick.quality : null
}

/**
 * What the filled cell plays: the pick over QUAL-5's chain (`slotFillQuality`), except on the
 * package channel, which no pick changes (header).
 */
export function effectiveFillQuality(
  slotFillQuality: StreamQuality,
  pick: Quality | null,
): StreamQuality {
  return slotFillQuality === PACKAGE_CHANNEL ? slotFillQuality : (pick ?? slotFillQuality)
}

/**
 * The session pick once "Save for this View" has landed: dropped if it is still exactly the pick
 * that was saved (`saved`: the View, the slot and the quality that went out), because the View now
 * plays it by itself; kept otherwise. A pick made while the save was in flight — another quality,
 * or another slot after leaving and filling again — is the user's newer choice and survives it
 * (header). The same object comes back when nothing is dropped, for React's bail-out.
 */
export function pickAfterFillSave(
  current: FillQualityPick,
  saved: NonNullable<FillQualityPick>,
): FillQualityPick {
  if (current === null) return current
  const same =
    current.viewId === saved.viewId &&
    current.slotKey === saved.slotKey &&
    current.quality === saved.quality
  return same ? null : current
}

/**
 * Whether "Save for this View" is shown: only once the picker has changed what plays, i.e. the
 * quality shown (the session pick) differs from what this View fills at when nothing is picked
 * (`stored`: QUAL-5's chain, `view.fillQuality ?? streams.defaultFillQuality`). The user's call on
 * review: the button appears when the option changes, and not otherwise — so a View that inherits
 * the app default is not offered a save of the quality it already plays. Never on the package
 * channel, which is a source, not a quality.
 */
export function canSaveFillQuality(shown: StreamQuality, stored: StreamQuality): boolean {
  return shown !== PACKAGE_CHANNEL && shown !== stored
}

// -------------------------------------------------------------------------------------------------
// Clicks (FILL-1)

/** The parts of a `click` / `dblclick` `MouseEvent` the decision reads. */
export interface FillClickEvent {
  readonly type: 'click' | 'dblclick'
  /** 0 is the primary button. */
  readonly button: number
  /** The click count of the current multi-click (`UIEvent.detail`). */
  readonly detail: number
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** The parts of a mouse event {@link fillClickStep} reads, copied off the event (`MouseEvent` here). */
export function toFillClick(
  event: Pick<FillClickEvent, 'button' | 'detail' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  type: FillClickEvent['type'],
): FillClickEvent {
  return {
    type,
    button: event.button,
    detail: event.detail,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  }
}

/** What a click on a camera cell does: fill it, return to the grid, or nothing. */
export type FillClickAction = 'fill' | 'unfill' | null

export interface FillClickResult {
  /** Whether the next plain `dblclick` leaves fill (header, "does not bounce"). */
  readonly armed: boolean
  readonly action: FillClickAction
}

const PRIMARY_BUTTON = 0

function hasModifier(
  event: Pick<FillClickEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
}

/**
 * One click or double-click on a camera cell. `filled` is whether *that* cell is the filled one, as
 * drawn when the event arrived; `armed` is the previous result's. The caller does the action.
 */
export function fillClickStep(
  armed: boolean,
  filled: boolean,
  event: FillClickEvent,
): FillClickResult {
  if (event.button !== PRIMARY_BUTTON) return { armed, action: null }

  if (!filled) {
    // Anything in the grid disarms: a double-click there must not leave the fill it starts.
    if (event.type === 'click' && event.detail <= 1 && !hasModifier(event)) {
      return { armed: false, action: 'fill' }
    }
    return { armed: false, action: null }
  }

  if (event.type === 'click') {
    // Only the first click of a pair arms; the second keeps whatever the first decided.
    return { armed: event.detail === 1 ? true : armed, action: null }
  }
  // `dblclick`. With a modifier it is ZOOM-2's reset (useZoomPan does it), and disarms.
  if (hasModifier(event)) return { armed: false, action: null }
  return armed ? { armed: false, action: 'unfill' } : { armed: false, action: null }
}

// -------------------------------------------------------------------------------------------------
// Esc (FILL-1)

/** The parts of a `KeyboardEvent` the decision reads. */
export interface FillExitKey {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly defaultPrevented: boolean
}

/**
 * Whether a keydown leaves fill: a plain `Escape`, not repeated, not already handled, and not typed
 * into a text field (the View shortcuts' rule, `isTextEntryTarget`). The caller only listens while
 * something is filled, and calls `preventDefault` when this says yes.
 */
export function isFillExitKey(event: FillExitKey, target: ViewShortcutTarget | null): boolean {
  if (event.defaultPrevented || event.repeat) return false
  if (event.key !== 'Escape' || hasModifier(event)) return false
  return !isTextEntryTarget(target)
}
