// One grid cell with a camera in it (CELL-1): the live player and, over it, the overlay with the
// camera's name and the auto-hiding controls (CellOverlay, P3.4; CELL-3/4, QUAL-7). Audio policy is
// Phase 5's (AUD-1), so the player is always muted here.
//
// **Fill (P3.5; FILL-1/2).** The same cell is the filled view: `<GridView>` enlarges its box to the
// grid area and hands it `filled`, the fill quality and the fill fit (features/fill/fillMode.ts). This
// file only reports the cell's clicks and double-clicks upward, as plain data, and — while filled —
// puts the back control in the overlay's slot. Whether a click fills, unfills or does nothing is
// `fillClickStep`'s call, not this file's. A click on a control never arrives here (CellOverlay stops
// it at its slot), so a control press is never a cell click.
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, type JSX, type MouseEvent } from 'react'
import type { Fit } from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'
import type { FillClickEvent } from '../fill/fillMode'
import { CellOverlay } from './CellOverlay'

export interface CellProps {
  /** The grid slot this cell is in (`GridSlot.key`), handed back with each click. */
  readonly slotKey: string
  readonly cameraId: string
  readonly name: string
  /** The effective stream, resolved by the caller (QUAL-3, or the package channel for CAM-4). */
  readonly quality: StreamQuality
  /** VIEW-5: the View's fit mode. */
  readonly fit: Fit
  /** CELL-4: `ui.overlayAutoHideSec` in ms, already defaulted (`overlayAutoHideMs`). */
  readonly overlayAutoHideMs: number
  /** FILL-1: this cell is the filled one (it covers the grid area, and shows the back control). */
  readonly filled: boolean
  /**
   * A click or double-click on the cell outside its controls, with whether it was filled when it
   * arrived. Must be stable (a `useCallback`) or the memo below is lost.
   */
  readonly onClickEvent: (slotKey: string, filled: boolean, event: FillClickEvent) => void
  /** FILL-1's back control. Stable, like `onClickEvent`. */
  readonly onBack: () => void
}

/** The parts of a mouse event `fillClickStep` reads. */
function toFillClick(event: MouseEvent, type: FillClickEvent['type']): FillClickEvent {
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

/**
 * Memoised: the slot list is rebuilt on every camera-state push (any camera's `state` changes the
 * inventory array), and without this every cell — and every `LivePlayer` — would re-render with it.
 * The props are primitives, so the default shallow compare is exact; a player still re-renders for
 * its own camera through its own store selector; the callbacks are the grid's stable ones. The overlay's hover state is the overlay's own, so
 * showing and hiding the controls re-renders the overlay and never the player. Its position is not a prop: the grid moves the box
 * around the cell, so a window resize does not re-render the cell either.
 */
export const Cell = memo(function Cell({
  slotKey,
  cameraId,
  name,
  quality,
  fit,
  overlayAutoHideMs,
  filled,
  onClickEvent,
  onBack,
}: CellProps): JSX.Element {
  return (
    // A mouse target only: the cell is not focusable, and fill is left from the keyboard by `Esc`
    // or the back control. `gridCell--fillable` is the pointer cursor (cells.css).
    <div
      className={filled ? 'gridCell' : 'gridCell gridCell--fillable'}
      onClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'click'))
      }}
      onDoubleClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'dblclick'))
      }}
    >
      <LivePlayer cameraId={cameraId} quality={quality} muted fit={fit} />
      <CellOverlay name={name} quality={quality} autoHideMs={overlayAutoHideMs}>
        {filled ? (
          <button
            type="button"
            className="cellOverlay__back"
            aria-label="Back to grid"
            title="Back to grid (Esc)"
            onClick={onBack}
          >
            ← Grid
          </button>
        ) : undefined}
      </CellOverlay>
    </div>
  )
})
