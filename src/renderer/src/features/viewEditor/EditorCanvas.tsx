// The View editor's canvas (P3.3; VIEW-1, VIEW-3, VIEW-5): the draft View drawn with the same
// geometry as the Live grid (`layoutGrid` / `cellRect`, absolutely positioned, re-measured through a
// ResizeObserver), but with camera names (over a still snapshot, P5.2) instead of video. It is where cells are selected and where
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
// The cell a drag is over is tinted and ringed in the accent colour, over its snapshot too.
//
// **Empty cells (UX polish 2026-11-17).** A cell with no camera shows a plus mark and "Drop a
// camera"; a cell too small for the words (`EMPTY_TEXT_MIN_*`) shows the plus alone. Decorative:
// the selection button's label already says the cell is empty.
//
// **Snapshots (P5.2, VIEW-3).** A cell whose head camera has a cached snapshot draws it as the
// bottom layer, under the selection button, with `pointer-events: none`, so it never takes a click,
// a drag or a drop: selection, dragging the chip and dropping all work exactly as on a text-only
// cell. It is fitted with the View's `fit`, as the Live grid fits video. The selected and drop
// highlights are drawn over it (viewEditor.css). Which image, if any, is `cellSnapshot`.
//
// **RTSP mode (RTSP-4)** has no snapshots: a cell holding a camera draws a large, dimmed camera
// icon in the image's place instead (`cameraIcons`, from `cellCameraIcon`), the same bottom layer
// that never takes the pointer, with the name chip over it.
import { useEffect, useRef, useState, type DragEvent, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import { cellRect, layoutGrid, type CellPlacement, type Rect } from '@shared/viewLayout'
import { CameraIcon, PlusIcon } from '../../ui/icons'
import { SnapshotImage } from '../../ui/SnapshotImage'
import { cameraRefLabel, cellsInRect, type Slot } from './editorModel'
import type { ReadySnapshot } from './editorThumbnails'
import { CAMERA_DRAG_TYPE, CELL_DRAG_TYPE, parseCellIndex } from './viewEditorHelpers'

export interface EditorCanvasProps {
  readonly view: View
  readonly cameras: readonly Camera[]
  /**
   * VIEW-3 (P5.2): per cell, by index, the head camera's cached snapshot to draw behind its name,
   * or `null` for a text-only cell (./editorThumbnails `cellSnapshot`).
   */
  readonly snapshots: readonly (ReadySnapshot | null)[]
  /**
   * RTSP-4: per cell, by index, whether it draws the camera icon behind its name in place of a
   * snapshot (./editorThumbnails `cellCameraIcon`). Absent entries draw none.
   */
  readonly cameraIcons: readonly boolean[]
  /** The selected rectangle, or `null` when nothing is selected. */
  readonly selection: CellPlacement | null
  /** A cell was picked at `slot`; `extend` (Shift) grows the selection from its anchor instead. */
  readonly onSelect: (slot: Slot, extend: boolean) => void
  /** The pointer, still held down, moved onto the cell at `slot`. */
  readonly onExtend: (slot: Slot) => void
  readonly onDropCamera: (cellIndex: number, ref: string) => void
  readonly onSwapCells: (from: number, to: number) => void
}

/** The smallest cell, in px, that still has room for "Drop a camera" beside the plus mark. */
const EMPTY_TEXT_MIN_WIDTH = 132
const EMPTY_TEXT_MIN_HEIGHT = 40

interface BoxSize {
  readonly width: number
  readonly height: number
}

export function EditorCanvas({
  view,
  cameras,
  snapshots,
  cameraIcons,
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
            const image = snapshots[index] ?? null
            const rect = cellRect(layout, cell)
            const classes = ['editorCanvas__cell']
            if (image !== null) classes.push('editorCanvas__cell--image')
            if (selected.has(index)) classes.push('editorCanvas__cell--selected')
            if (dropIndex === index) classes.push('editorCanvas__cell--drop')
            if (first === undefined) classes.push('editorCanvas__cell--empty')
            return (
              <div
                // The top-left slot: unique in a tiled View, and stable across camera edits.
                key={`${String(cell.col)},${String(cell.row)}`}
                className={classes.join(' ')}
                style={rectStyle(rect)}
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
                {image === null ? (
                  cameraIcons[index] === true ? (
                    <CameraIcon className="editorCanvas__cameraIcon" />
                  ) : null
                ) : (
                  <SnapshotImage
                    className={`editorCanvas__image editorCanvas__image--${view.fit}`}
                    bytes={image.bytes}
                    mimeType={image.mimeType}
                  />
                )}
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
                    <span className="editorCanvas__empty" aria-hidden="true">
                      <PlusIcon />
                      {rect.width >= EMPTY_TEXT_MIN_WIDTH && rect.height >= EMPTY_TEXT_MIN_HEIGHT
                        ? 'Drop a camera'
                        : null}
                    </span>
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
