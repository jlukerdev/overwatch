// The View editor's canvas (P3.3; VIEW-1, VIEW-3, VIEW-5): the draft View drawn with the same
// geometry as the Live grid (`layoutGrid` / `cellRect`, absolutely positioned, re-measured through a
// ResizeObserver), but with camera names instead of video. It is where cells are selected and where
// cameras are dropped.
//
// Thin on purpose: the tests run in vitest's node environment (vitest.config.mts), and CLAUDE.md
// says to keep logic that has no UI pure and unit-tested. So what a selection covers is
// `selectionRect`, what a drop does is `dropCameraOnCell` / `swapCellContents` (./editorModel);
// the editor applies them. This file only turns pointer, keyboard and drag events into those calls.
//
// **Selection and drag-and-drop do not fight.** Each cell has two layers:
//  - a full-size `<button>` underneath, the selection target. A primary-button pointerdown on it
//    selects the cell (Shift extends from the anchor), and moving over other cells with the button
//    held extends the selection. A keyboard activation (Enter / Space: a click with `detail === 0`)
//    does the same, so the canvas is usable without a mouse.
//  - the camera chip on top, the *only* draggable thing in a cell (native HTML5 DnD carrying the
//    cell index as `CELL_DRAG_TYPE`). A pointerdown on the chip never reaches the button, so
//    starting a drag never starts a selection.
// The whole cell is the drop target, for palette cameras (`CAMERA_DRAG_TYPE`) and for other cells.
import { useEffect, useRef, useState, type DragEvent, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import { cellRect, layoutGrid, type CellPlacement, type Rect } from '@shared/viewLayout'
import { cameraRefLabel, cellsInRect, type Slot } from './editorModel'
import { CAMERA_DRAG_TYPE, CELL_DRAG_TYPE, parseCellIndex } from './viewEditorHelpers'

export interface EditorCanvasProps {
  readonly view: View
  readonly cameras: readonly Camera[]
  /** The selected rectangle, or `null` when nothing is selected. */
  readonly selection: CellPlacement | null
  /** A cell was picked at `slot`; `extend` (Shift) grows the selection from its anchor instead. */
  readonly onSelect: (slot: Slot, extend: boolean) => void
  /** The pointer, still held down, moved onto the cell at `slot`. */
  readonly onExtend: (slot: Slot) => void
  readonly onDropCamera: (cellIndex: number, ref: string) => void
  readonly onSwapCells: (from: number, to: number) => void
}

interface BoxSize {
  readonly width: number
  readonly height: number
}

export function EditorCanvas({
  view,
  cameras,
  selection,
  onSelect,
  onExtend,
  onDropCamera,
  onSwapCells,
}: EditorCanvasProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<BoxSize | null>(null)
  // Whether a selection drag is in progress (primary button held since a pointerdown on a cell).
  const selecting = useRef(false)
  // The cell a drag is hovering, for the drop highlight.
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (rect === undefined) return
      setBox((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      )
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [])

  // The button can be released anywhere, even outside the window.
  useEffect(() => {
    const stop = (): void => {
      selecting.current = false
    }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  const layout = layoutGrid({
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    cols: view.cols,
    rows: view.rows,
    aspect: view.aspect,
    gap: view.gap,
  })
  const drawable = layout.unitWidth > 0 && layout.unitHeight > 0
  const selected = new Set(selection === null ? [] : cellsInRect(view, selection))

  const acceptsDrop = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(CAMERA_DRAG_TYPE) ||
    event.dataTransfer.types.includes(CELL_DRAG_TYPE)

  return (
    <div className="editorCanvas" ref={rootRef}>
      {drawable
        ? view.cells.map((cell, index) => {
            const slot: Slot = { col: cell.col, row: cell.row }
            const labels = cell.cameraIds.map((ref) => cameraRefLabel(ref, cameras))
            const first = labels[0]
            const classes = ['editorCanvas__cell']
            if (selected.has(index)) classes.push('editorCanvas__cell--selected')
            if (dropIndex === index) classes.push('editorCanvas__cell--drop')
            if (first === undefined) classes.push('editorCanvas__cell--empty')
            return (
              <div
                // The top-left slot: unique in a tiled View, and stable across camera edits.
                key={`${String(cell.col)},${String(cell.row)}`}
                className={classes.join(' ')}
                style={rectStyle(cellRect(layout, cell))}
                onDragOver={(event) => {
                  if (!acceptsDrop(event)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
                    CAMERA_DRAG_TYPE,
                  )
                    ? 'copy'
                    : 'move'
                  if (dropIndex !== index) setDropIndex(index)
                }}
                onDragLeave={(event) => {
                  // Leaving for a child of the same cell is not leaving the cell.
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setDropIndex((current) => (current === index ? null : current))
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  setDropIndex(null)
                  const ref = event.dataTransfer.getData(CAMERA_DRAG_TYPE)
                  if (ref !== '') {
                    onDropCamera(index, ref)
                    return
                  }
                  const from = parseCellIndex(
                    event.dataTransfer.getData(CELL_DRAG_TYPE),
                    view.cells.length,
                  )
                  if (from !== null) onSwapCells(from, index)
                }}
              >
                <button
                  type="button"
                  className="editorCanvas__select"
                  aria-pressed={selected.has(index)}
                  aria-label={cellLabel(cell, labels)}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    selecting.current = true
                    onSelect(slot, event.shiftKey)
                  }}
                  onPointerEnter={() => {
                    if (selecting.current) onExtend(slot)
                  }}
                  onClick={(event) => {
                    // A mouse click was already handled on pointerdown; this is the keyboard.
                    if (event.detail === 0) onSelect(slot, event.shiftKey)
                  }}
                />
                <div className="editorCanvas__content">
                  {first === undefined ? (
                    <span className="editorCanvas__empty">Empty</span>
                  ) : (
                    <span
                      className="editorCanvas__chip"
                      draggable
                      title={`${labels.join(', ')} — drag onto another cell to swap`}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(CELL_DRAG_TYPE, String(index))
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        setDropIndex(null)
                      }}
                    >
                      {first}
                    </span>
                  )}
                  {labels.length > 1 ? (
                    <span className="editorCanvas__more">+{String(labels.length - 1)}</span>
                  ) : null}
                </div>
              </div>
            )
          })
        : null}
      {drawable && selection !== null ? (
        <div
          className="editorCanvas__selection"
          aria-hidden="true"
          style={rectStyle(cellRect(layout, selection))}
        />
      ) : null}
    </div>
  )
}

/** Left/top/size in px, as in the Live grid (GridView). */
function rectStyle(rect: Rect): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

/** What a screen reader hears for a cell: where it is, how big, and what it shows. */
function cellLabel(cell: CellPlacement, labels: readonly string[]): string {
  const where = `Cell at column ${String(cell.col + 1)}, row ${String(cell.row + 1)}`
  const size =
    cell.colSpan > 1 || cell.rowSpan > 1 ? `, ${String(cell.colSpan)}×${String(cell.rowSpan)}` : ''
  const what = labels.length === 0 ? 'empty' : labels.join(', ')
  return `${where}${size}: ${what}`
}
