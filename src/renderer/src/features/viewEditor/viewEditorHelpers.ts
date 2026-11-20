// Small decisions the View editor's components need that are not edits of a View (those are
// ./editorModel): the next free "View N" name, keeping the draft in step with the stored View,
// reading what a drag carries, and the tooltips of the Cell tab's cell actions. Pure, so they are
// unit-tested in vitest's node environment (vitest.config.mts; tests/renderer/viewEditorHelpers.test.ts
// and editorPanel.test.ts), per CLAUDE.md's "keep logic that has no UI pure and unit-tested", and the
// components stay thin.
import type { View } from '@shared/models'
import { isDraftDirty } from './editorModel'

/** The `DataTransfer` type a palette entry carries: a camera ref (`<id>` or `<id>:package`). */
export const CAMERA_DRAG_TYPE = 'application/x-vp-camera-ref'

/** The `DataTransfer` type a cell's camera chip carries: the cell's index in the draft, as text. */
export const CELL_DRAG_TYPE = 'application/x-vp-cell'

/**
 * The name "New View" gives (VIEW-3): `View N` for the smallest N ≥ 1 that no View is called yet.
 * Names compare trimmed and case-insensitively, so a View renamed `view 2 ` still takes "View 2".
 */
export function nextViewName(views: readonly Pick<View, 'name'>[]): string {
  const taken = new Set(views.map((view) => view.name.trim().toLowerCase()))
  for (let n = 1; ; n += 1) {
    const name = `View ${String(n)}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

/**
 * The editor's draft and the stored View it was taken from (`base`, by reference). `base` is what
 * tells "the stored View changed" apart from "the user changed the draft".
 */
export interface DraftState {
  readonly base: View
  readonly draft: View
}

/** A fresh, clean draft of `saved`. */
export function startDraft(saved: View): DraftState {
  return { base: saved, draft: saved }
}

/**
 * Brings the draft up to date with the stored View `saved` (the editing model: "if the stored View
 * changes while the draft is clean, the draft follows it").
 *
 *  - `saved` is still `base`: nothing happened, the same state comes back (so a caller can compare
 *    by reference and skip a render).
 *  - The draft was clean against the old `base`, or already equals the new `saved` (a save that has
 *    just landed): the draft becomes `saved`.
 *  - Otherwise the user has unsaved changes and the stored View changed under them: the draft is
 *    kept, `base` moves on, and the draft now counts as dirty against what is stored.
 */
export function syncDraft(state: DraftState, saved: View): DraftState {
  if (state.base === saved) return state
  if (!isDraftDirty(state.base, state.draft) || !isDraftDirty(saved, state.draft)) {
    return startDraft(saved)
  }
  return { base: saved, draft: state.draft }
}

/**
 * How many cells with cameras `resizeGrid(view, cols, rows)` would drop: those whose top-left slot
 * falls outside the new grid (a clipped span keeps its cameras). The editor says so after resizing.
 */
export function resizeDropsCameras(view: Pick<View, 'cells'>, cols: number, rows: number): number {
  return view.cells.filter(
    (cell) => cell.cameraIds.length > 0 && (cell.col >= cols || cell.row >= rows),
  ).length
}

/** A dragged cell's index from its `CELL_DRAG_TYPE` text, or `null` unless it names a cell. */
export function parseCellIndex(text: string, cellCount: number): number | null {
  if (!/^\d+$/.test(text)) return null
  const index = Number(text)
  return index < cellCount ? index : null
}

/** "1 other cell lost its cameras." / "3 other cells lost their cameras." — the note after a merge. */
export function mergeLossNote(count: number): string {
  return count === 1
    ? '1 other cell lost its cameras.'
    : `${String(count)} other cells lost their cameras.`
}

/**
 * The note after a layout change (preset or grid size) left `count` camera cells nowhere to go,
 * or `null` when nothing was lost.
 */
export function layoutLossNote(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? '1 cell with cameras did not fit the new layout and lost them.'
    : `${String(count)} cells with cameras did not fit the new layout and lost them.`
}

/** What the Cell tab's cell actions need to know about the selection (`selectionActions`, the draft). */
export interface ToolbarSelection {
  /** How many cells are selected. */
  readonly count: number
  readonly canMerge: boolean
  readonly canSplit: boolean
  /** Whether any selected cell has a camera. */
  readonly hasCameras: boolean
}

/**
 * The tooltips of Merge, Split and Clear cameras (UX polish 2026-11-17): what the button does when
 * it can act on the selection, and otherwise why it cannot, so a dimmed button explains itself.
 */
export function toolbarTitles(selection: ToolbarSelection): {
  readonly merge: string
  readonly split: string
  readonly clear: string
} {
  const { count, canMerge, canSplit, hasCameras } = selection
  const merge = canMerge
    ? 'Merge the selected cells into one'
    : count < 2
      ? 'Select two or more cells to merge them (drag across cells, or Shift-click)'
      : 'These cells cannot be merged'
  const split = canSplit
    ? 'Split the selected cell back into single cells'
    : count === 0
      ? 'Select a merged cell to split it'
      : count === 1
        ? 'This cell is not merged, so there is nothing to split'
        : 'Select one merged cell to split it'
  const clear = hasCameras
    ? count === 1
      ? 'Remove the cameras from the selected cell'
      : 'Remove the cameras from the selected cells'
    : count === 0
      ? 'Select cells to remove their cameras'
      : count === 1
        ? 'The selected cell has no cameras'
        : 'The selected cells have no cameras'
  return { merge, split, clear }
}
