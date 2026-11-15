// The View editor's cell inspector (P3.3; VIEW-2, VIEW-3): the cameras of the one selected cell, in
// order, with ▲/▼ to reorder, a remove button each, and an "Add camera" picker — the keyboard way to
// assign cameras, beside the palette's drag-and-drop.
//
// Every edit is a call into ./editorModel (`addCellCamera`, `removeCellCamera`, `moveCellCamera`)
// made by the editor; this component only says which one. A cell holds several cameras already
// (VIEW-2), but until multi-camera cells play (Phase 4) the Live grid shows the first, which the
// note under the list says.
import type { JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { Cell } from '@shared/models'
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
}

export function CellInspector({
  cell,
  selectedCount,
  cameras,
  choices,
  onAdd,
  onRemove,
  onMove,
}: CellInspectorProps): JSX.Element {
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
                  className="button viewEditor__iconButton"
                  aria-label={`Move ${label} up`}
                  disabled={position === 0}
                  onClick={() => {
                    onMove(position, -1)
                  }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="button viewEditor__iconButton"
                  aria-label={`Move ${label} down`}
                  disabled={position === last}
                  onClick={() => {
                    onMove(position, 1)
                  }}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="button viewEditor__iconButton"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    onRemove(position)
                  }}
                >
                  ✕
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
      <p className="viewEditor__hint">
        Until multi-camera cells (Phase 4), a cell shows its first camera.
      </p>
    </section>
  )
}
