// A cell whose shown camera cannot play (CAM-2, CAM-4): the camera is gone from the console, or a
// package ref names a camera without a package camera (features/grid/gridLayout.ts, `missing`). It
// draws the label ("Camera not found (<id>)" / "No package camera (<name>)") centred on an empty
// cell, asks for no stream, and is not fillable — there is nothing to enlarge, so in the grid it has
// no click handler at all.
//
// **In a multi-camera cell it keeps the position and next / previous** (P4.3; CELL-2, CELL-3). The
// scheduler runs over the View's `cameraIds` as stored, so a missing camera takes its turn here; in
// a cell that does not rotate (one that only switches on events) it would otherwise be stuck on the
// placeholder until an event moved it. So the cell gets the same
// `<CellOverlay>` as a camera cell, with no name (the label already says which ref this is) and no
// quality badge (nothing streams), and the same `<CellStepControls>` in its strip: shown on hover,
// auto-hidden (CELL-4), its presses stopped at the strip's slot. A one-camera missing cell has no
// controls to offer and draws no overlay at all, as before.
//
// **Filled, it stays filled** (features/fill/fillMode.ts, `filledSlotKey`; the user's decision,
// 2026-11-15): a filled multi-camera cell whose shown camera is missing — a next / previous landed
// on it, or it left the console — must not throw the user out of fill. So while `filled` it carries
// fill's back control first in the strip, before the position, `Esc` leaves as everywhere (`<GridView>`'s listener), and its
// clicks and double-clicks go to the grid's `onClickEvent` with `filled` true, so `fillClickStep`'s
// plain double-click leaves exactly as on a filled camera. Only while filled: `fillClickStep` would
// fill from a grid click, and a missing cell must never fill. The next step back onto a camera plays
// it, still filled.
//
// Memoised on primitives and the grid's stable `onStep`, like `<Cell>`: the slot list is rebuilt on
// every camera-state push.
import { memo, type JSX } from 'react'
import { toFillClick, type FillClickEvent } from '../fill/fillMode'
import { BackToGridButton } from './BackToGridButton'
import { CellOverlay } from './CellOverlay'
import { CellStepControls } from './CellStepControls'
import { showsStepControls } from './cellPosition'
import type { StepDirection } from './schedulerSet'

export interface MissingCellProps {
  /** The grid slot (`GridSlot.key`), handed back with each step. */
  readonly slotKey: string
  /** The ref that cannot play, for the label's tooltip. */
  readonly cameraRef: string
  readonly label: string
  /** 0-based position of this ref in the cell's `cameraIds`, of `cameraCount`. */
  readonly cameraIndex: number
  readonly cameraCount: number
  /** CELL-4: `ui.overlayAutoHideSec` in ms, already defaulted. */
  readonly overlayAutoHideMs: number
  /** FILL-1: this is the filled slot (a step in fill landed here; header). */
  readonly filled: boolean
  /** FILL-1's back control. Stable. */
  readonly onBack: () => void
  /**
   * The grid's cell-click handler, wired only while `filled` (header), so a plain double-click
   * leaves fill. Stable.
   */
  readonly onClickEvent: (slotKey: string, filled: boolean, event: FillClickEvent) => void
  /** A manual step of this cell's scheduler. Stable (a `useCallback`), or the memo is lost. */
  readonly onStep: (slotKey: string, direction: StepDirection) => void
}

export const MissingCell = memo(function MissingCell({
  slotKey,
  cameraRef,
  label,
  cameraIndex,
  cameraCount,
  overlayAutoHideMs,
  filled,
  onBack,
  onClickEvent,
  onStep,
}: MissingCellProps): JSX.Element {
  return (
    // Still `gridCell--empty`, because nothing streams here. Click handlers only while filled
    // (header): in the grid a click here is nobody's.
    <div
      className="gridCell gridCell--empty gridCell--missing"
      onClick={
        filled
          ? (event) => {
              onClickEvent(slotKey, true, toFillClick(event, 'click'))
            }
          : undefined
      }
      onDoubleClick={
        filled
          ? (event) => {
              onClickEvent(slotKey, true, toFillClick(event, 'dblclick'))
            }
          : undefined
      }
    >
      <span className="gridCell__missing" title={cameraRef}>
        {label}
      </span>
      {showsStepControls(cameraCount) ? (
        <CellOverlay autoHideMs={overlayAutoHideMs}>
          {/* Back first while filled, then the position, as on a camera cell (Cell.tsx). */}
          {filled ? <BackToGridButton onBack={onBack} /> : null}
          <CellStepControls
            slotKey={slotKey}
            index={cameraIndex}
            count={cameraCount}
            onStep={onStep}
          />
        </CellOverlay>
      ) : null}
    </div>
  )
})
