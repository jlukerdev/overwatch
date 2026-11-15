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
//  - **A plain primary click on a camera cell fills it** (FILL-1). Clicks on a control never get here
//    (CellOverlay stops them at its slot); empty and missing cells have no `<Cell>` and so no handler.
//    A click with a modifier is left alone, for the same reason the View shortcuts refuse them: they
//    belong to the OS, and ZOOM-2 (P3.6) takes modifier + double-click for itself.
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
//  - **Modifier + double-click is ZOOM-2's** (zoom reset, P3.6), so it never leaves fill.
//  - **`Esc` leaves** ({@link isFillExitKey}), with the View shortcuts' manners: not on auto-repeat,
//    not with a modifier, not while typing, not if someone already handled it.
//  - **Fit in fill is `contain`** ({@link FILL_FIT}), whatever the View's `fit`: fill is for seeing the
//    whole camera, and the View's `cover` crops to make a wall of cells tidy. Detail is what zoom is
//    for (ZOOM-1, P3.6).
//  - **FILL-3 pins trivially for now.** A cell shows `cameraIds[0]` until Phase 4 (gridLayout.ts), so
//    a filled cell already never rotates. TODO(Phase 4, CELL-2): when `cellScheduler` drives the
//    shown camera, a filled cell must hold its current camera — feed the scheduler a "pinned" input
//    while `filledSlotKey` names the cell, and release it on leaving fill.
import type { Fit } from '@shared/models'
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
 * `viewId` is the View on screen and that slot is still a camera slot in it (header).
 */
export function filledSlotKey(
  state: FillState,
  viewId: string,
  slots: readonly GridSlot[],
): string | null {
  if (state?.viewId !== viewId) return null
  const slot = slots.find((candidate) => candidate.key === state.slotKey)
  return slot?.kind === 'camera' ? slot.key : null
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
  // `dblclick`. With a modifier it is ZOOM-2's reset (P3.6), and keeps the arming for nothing.
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
