// The View editor's cell inspector (P3.3; VIEW-2, VIEW-3): the cameras of the one selected cell, in
// order, with ▲/▼ to reorder, a remove button each, and an "Add camera" picker — the keyboard way to
// assign cameras, beside the palette's drag-and-drop.
//
// Every edit is a call into ./editorModel (`addCellCamera`, `removeCellCamera`, `moveCellCamera`)
// made by the editor; this component only says which one. A cell holds several cameras already
// (VIEW-2); with two or more, what the Live grid does with them depends on the cell's CELL-2
// settings (P4.2) — it rotates only with a `rotateIntervalSec`, and switches on events only with
// `motionSwitch` on, otherwise it stays on the first camera — so the note under the list
// ({@link multiCameraHint}) says which of those this cell will do.
//
// Below the cameras, the cell's quality override (P3.7; QUAL-3): "View default (X)" — X being what
// the View and the app defaults give the cell now — then the qualities. It edits the draft's
// `quality` (`setCellQuality`), saved with the rest; the overlay's picker on the Live screen
// (QUAL-4) edits the same field directly.
import { useId, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { Cell } from '@shared/models'
import type { Quality } from '@shared/quality'
import {
  inheritOptionLabel,
  parseQualityOption,
  qualityOptionValue,
} from '../quality/qualityChoice'
import { QualityOptions } from '../quality/QualityOptions'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '../../ui/icons'
import { cameraRefLabel, type CameraChoice } from './editorModel'

export interface CellInspectorProps {
  /** The selected cell, or `null` when the selection is not exactly one cell. */
  readonly cell: Cell | null
  /** How many cells the selection holds (for the hint when it is not one). */
  readonly selectedCount: number
  readonly cameras: readonly Camera[]
  /** `cameraChoices(cameras)`, computed once by the editor and shared with the palette. */
  readonly choices: readonly CameraChoice[]
  readonly onAdd: (ref: string) => void
  readonly onRemove: (position: number) => void
  readonly onMove: (position: number, delta: -1 | 1) => void
  /**
   * What the cell plays with its override cleared (the draft's `gridQuality`, else the app default),
   * for the "View default (X)" option; `null` before settings load.
   */
  readonly viewDefaultQuality: Quality | null
  /** A new quality override for the cell; `null` clears it. */
  readonly onQualityChange: (quality: Quality | null) => void
}

/** The note under the camera list: what the Live grid does with this cell's cameras (header). */
export function multiCameraHint(cell: Pick<Cell, 'rotateIntervalSec' | 'motionSwitch'>): string {
  const rotates = cell.rotateIntervalSec !== undefined
  if (rotates && cell.motionSwitch) {
    return `With two or more cameras, the cell rotates through them in this order every ${String(cell.rotateIntervalSec)} s, and switches to a camera on its events.`
  }
  if (rotates) {
    return `With two or more cameras, the cell rotates through them in this order every ${String(cell.rotateIntervalSec)} s.`
  }
  if (cell.motionSwitch) {
    return 'With two or more cameras, the cell shows the first and switches to a camera on its events.'
  }
  return 'With two or more cameras, the cell shows the first (rotation and event switching are off).'
}

export function CellInspector({
  cell,
  selectedCount,
  cameras,
  choices,
  onAdd,
  onRemove,
  onMove,
  viewDefaultQuality,
  onQualityChange,
}: CellInspectorProps): JSX.Element {
  const qualityId = useId()
  if (cell === null) {
    return (
      <section className="viewEditor__panel" aria-label="Cell">
        <h3 className="viewEditor__panelTitle">Cell</h3>
        <p className="viewEditor__hint">
          {selectedCount === 0
            ? 'Select a cell to see its cameras. Drag across cells, or Shift-click, to select several.'
            : `${String(selectedCount)} cells selected. Select one cell to edit its cameras.`}
        </p>
      </section>
    )
  }

  const present = new Set(cell.cameraIds)
  const addable = choices.filter((choice) => !present.has(choice.ref))
  const last = cell.cameraIds.length - 1

  return (
    <section className="viewEditor__panel" aria-label="Cell">
      <h3 className="viewEditor__panelTitle">
        Cell {String(cell.col + 1)},{String(cell.row + 1)}
        {cell.colSpan > 1 || cell.rowSpan > 1
          ? ` (${String(cell.colSpan)}×${String(cell.rowSpan)})`
          : ''}
      </h3>
      {cell.cameraIds.length === 0 ? (
        <p className="viewEditor__hint">No cameras.</p>
      ) : (
        <ol className="viewEditor__cameraList">
          {cell.cameraIds.map((ref, position) => {
            const label = cameraRefLabel(ref, cameras)
            return (
              // Keyed by position too: a stored View's list may hold the same ref twice.
              <li key={`${ref}-${String(position)}`} className="viewEditor__cameraRow">
                <span className="viewEditor__cameraName" title={label}>
                  {label}
                </span>
                <button
                  type="button"
                  className="button button--icon button--ghost button--sm"
                  aria-label={`Move ${label} up`}
                  title={`Move ${label} up`}
                  disabled={position === 0}
                  onClick={() => {
                    onMove(position, -1)
                  }}
                >
                  <ChevronUpIcon />
                </button>
                <button
                  type="button"
                  className="button button--icon button--ghost button--sm"
                  aria-label={`Move ${label} down`}
                  title={`Move ${label} down`}
                  disabled={position === last}
                  onClick={() => {
                    onMove(position, 1)
                  }}
                >
                  <ChevronDownIcon />
                </button>
                <button
                  type="button"
                  className="button button--icon button--ghost button--danger button--sm"
                  aria-label={`Remove ${label}`}
                  title={`Remove ${label}`}
                  onClick={() => {
                    onRemove(position)
                  }}
                >
                  <XIcon />
                </button>
              </li>
            )
          })}
        </ol>
      )}
      <select
        className="field__input viewEditor__addCamera"
        aria-label="Add camera"
        value=""
        disabled={addable.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onAdd(event.target.value)
        }}
      >
        <option value="">{addable.length === 0 ? 'No more cameras' : 'Add camera…'}</option>
        {addable.map((choice) => (
          <option key={choice.ref} value={choice.ref}>
            {choice.label}
          </option>
        ))}
      </select>
      <p className="viewEditor__hint">{multiCameraHint(cell)}</p>
      <label className="field__label" htmlFor={qualityId}>
        Quality
      </label>
      <select
        id={qualityId}
        className="field__input"
        value={qualityOptionValue(cell.quality)}
        onChange={(event) => {
          onQualityChange(parseQualityOption(event.target.value))
        }}
      >
        <QualityOptions inheritLabel={inheritOptionLabel('View default', viewDefaultQuality)} />
      </select>
    </section>
  )
}
