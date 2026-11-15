// A multi-camera cell's position and manual next / previous (P4.3; CELL-2, CELL-3): a "previous"
// button, the position (`2/4`), a "next" button, as one group in the overlay's strip. Thin on purpose
// (no jsdom here; CLAUDE.md): the gate and the text are ./cellPosition's, and what a step does is the
// scheduler's (`stepSchedulerSet`, ./schedulerSet). Its parent passes it to `<CellOverlay>` as
// `children`, so it shows and auto-hides with the strip (CELL-4) and its presses never reach the
// cell (FILL-1). The position is part of the group, so a click on it is swallowed too rather than
// filling the cell from between the two buttons.
//
// **The one place the controls are decided.** A camera cell (./Cell) and a missing-camera
// placeholder (./MissingCell) both render this with their slot's key, index and count and the grid's
// stable `onStep`; it draws nothing below two cameras (`showsStepControls`) and binds the slot key
// itself, so neither parent repeats the gate or the closure. `onBeforeStep` runs first on each press
// — the camera cell's zoom reset (Cell.tsx header).
import type { JSX } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons'
import { positionText, positionTitle, showsStepControls } from './cellPosition'
import type { StepDirection } from './schedulerSet'

export interface CellStepControlsProps {
  /** The grid slot (`GridSlot.key`), handed back with each step. */
  readonly slotKey: string
  /** 0-based position of the camera shown in the cell's `cameraIds` (./cellPosition header). */
  readonly index: number
  readonly count: number
  /** The grid's step (`useCellSchedulers`' `step`). */
  readonly onStep: (slotKey: string, direction: StepDirection) => void
  /** Runs just before each step (header). */
  readonly onBeforeStep?: () => void
}

export function CellStepControls({
  slotKey,
  index,
  count,
  onStep,
  onBeforeStep,
}: CellStepControlsProps): JSX.Element | null {
  if (!showsStepControls(count)) return null
  const step = (direction: StepDirection): void => {
    onBeforeStep?.()
    onStep(slotKey, direction)
  }
  return (
    <div className="cellOverlay__position" role="group" aria-label="Camera in this cell">
      <button
        type="button"
        className="cellOverlay__back cellOverlay__iconButton"
        aria-label="Previous camera"
        title="Previous camera"
        onClick={() => {
          step('prev')
        }}
      >
        <ChevronLeftIcon className="cellOverlay__icon" />
      </button>
      <span className="cellOverlay__positionText" title={positionTitle(index, count)}>
        {positionText(index, count)}
      </span>
      <button
        type="button"
        className="cellOverlay__back cellOverlay__iconButton"
        aria-label="Next camera"
        title="Next camera"
        onClick={() => {
          step('next')
        }}
      >
        <ChevronRightIcon className="cellOverlay__icon" />
      </button>
    </div>
  )
}
