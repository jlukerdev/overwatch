// A View's layout (P3.1; VIEW-1, VIEW-5): the operations the View editor applies to a grid, the
// on-screen geometry of the letterboxed grid, and the layout presets. Pure functions over plain
// data — no DOM, no Electron, no React — so all of it runs in the node test environment and the
// renderer, the editor (P3.3) and main can share one definition.
//
// The layout model, decided for Phase 3:
//
//  - **Spanning cells.** A View is a `cols × rows` grid of slots (1..4 each, VIEW-1) and a cell is
//    any rectangle of slots. The cells always tile the grid exactly; an empty slot is an explicit
//    cell with no cameras (see `tilingIssues`). The editor changes a layout only through the three
//    operations below, each of which takes a tiled View and returns a tiled View.
//  - **Letterboxed grid.** The whole grid is scaled and centred in the box it is given so that a
//    1×1 cell has exactly the View's `aspect` (16:9 by default). Whatever is left over is bars on
//    two sides — left/right in a wide window, top/bottom in a tall one — never stretched cells.
//  - **Gap.** `gap` CSS px between adjacent cells, none around the outer edge.
//
// One consequence of the gap is accepted rather than worked around: a cell spanning k columns is
// `k·w + (k−1)·g` wide and one spanning k rows `k·h + (k−1)·g` tall, so with `g > 0` a spanned cell
// is a few px off `aspect` (a 2×2 cell is `2w+g` by `2h+g`, not `2w` by `2h`). Unit cells are exact,
// and a spanned cell's camera absorbs the difference through the View's `fit` — a few px of
// letterbox with `contain`, a few px of crop with `cover`. The alternative, sizing tracks unevenly
// so that every span is exact, cannot work for every layout at once and would make unit cells in
// the same View differ in size.
//
// The operations return a result value rather than throwing, like the IPC contract (rule 2 in
// ./ipc): an impossible merge is something the editor shows the user, not a crash.
import { CellSchema, MAX_GRID_DIMENSION, type Aspect, type Cell, type View } from './models'
import {
  forEachSlot,
  normalizeCells,
  placementFits,
  tilingIssues,
  type CellPlacement,
} from './viewTiling'

export {
  forEachSlot,
  normalizeCells,
  placementFits,
  tilingIssues,
  type CellPlacement,
  type TilingInput,
  type TilingIssue,
} from './viewTiling'

/** The part of a View the layout operations read and rewrite. Everything else is carried over. */
export type LayoutView = Pick<View, 'cols' | 'rows' | 'cells'>

/** What a layout operation answers with. `reason` is one sentence the editor can show as is. */
export type LayoutResult<V> =
  { readonly ok: true; readonly view: V } | { readonly ok: false; readonly reason: string }

// -------------------------------------------------------------------------------------------------
// Building cells

/** An empty 1×1 cell at a slot, with every default from `CellSchema` (one home for defaults). */
export function emptyCell(col: number, row: number): Cell {
  return CellSchema.parse({ col, row })
}

/** `cols × rows` empty 1×1 cells, in canonical order — a uniform VIEW-1 grid. */
export function uniformCells(cols: number, rows: number): Cell[] {
  return uniformPlacements(cols, rows).map((p) => emptyCell(p.col, p.row))
}

/**
 * `cells` with one camera each from `cameraIds`, first cell first. Cells past the last camera keep
 * whatever they had (empty, for a fresh layout); cameras past the last cell are dropped. Shared by
 * the starter View (renderer) and the perf View (main) so "fill in order" means one thing.
 */
export function assignCameras(cells: readonly Cell[], cameraIds: readonly string[]): Cell[] {
  return cells.map((cell, index) => {
    const id = cameraIds[index]
    return id === undefined ? cell : { ...cell, cameraIds: [id] }
  })
}

function uniformPlacements(cols: number, rows: number): CellPlacement[] {
  const out: CellPlacement[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) out.push({ col, row, colSpan: 1, rowSpan: 1 })
  }
  return out
}

/**
 * Empty 1×1 cells for every slot of `cols × rows` that none of `cells` covers. What fills the hole
 * a resize, a split or a preset leaves; `cells` are assumed not to overlap.
 */
function fillUncovered(cells: readonly CellPlacement[], cols: number, rows: number): Cell[] {
  const covered = new Set<string>()
  for (const cell of cells) {
    forEachSlot(cell, (col, row) => covered.add(slotKey(col, row)))
  }
  return uniformPlacements(cols, rows)
    .filter((p) => !covered.has(slotKey(p.col, p.row)))
    .map((p) => emptyCell(p.col, p.row))
}

function slotKey(col: number, row: number): string {
  return `${String(col)},${String(row)}`
}

/**
 * The last step of every operation: canonical order, and a tiling check on the way out. The
 * operations are written so that a tiled View in gives a tiled View out; the check is what turns
 * an **untiled** View in (a bug elsewhere) into a refusal here, instead of an editor that saves a
 * layout the IPC boundary then rejects with a less useful message.
 */
function finish<V extends LayoutView>(
  view: V,
  cols: number,
  rows: number,
  cells: Cell[],
): LayoutResult<V> {
  const next = { ...view, cols, rows, cells: normalizeCells(cells) }
  const issues = tilingIssues(next)
  if (issues.length > 0) {
    return {
      ok: false,
      reason: `The View's cells did not tile its grid to begin with (${issues[0]?.message ?? ''}).`,
    }
  }
  return { ok: true, view: next }
}

function isGridDimension(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_GRID_DIMENSION
}

// -------------------------------------------------------------------------------------------------
// Editor operations (P3.3 calls these; VIEW-1/3)

/**
 * Changes the grid to `cols × rows` (VIEW-1), keeping as much of the layout as fits:
 *
 *  - a cell whose top-left slot is still inside the grid **stays**, with its cameras and settings;
 *  - a span that now crosses the new right or bottom edge is **clipped** to it, not dropped, so a
 *    camera assigned to a 2×2 cell is still there after shrinking a 3×3 to 2×2 (as a 1×1 or 1×2);
 *  - a cell whose top-left slot is outside the new grid is dropped, cameras and all — there is
 *    nowhere left to put it;
 *  - every slot left uncovered — a new row or column, or a slot a dropped cell used to cover —
 *    becomes an empty 1×1 cell. Clipping trims only the far edge of a span, so it never opens a
 *    hole inside the grid.
 */
export function resizeGrid<V extends LayoutView>(
  view: V,
  cols: number,
  rows: number,
): LayoutResult<V> {
  if (!isGridDimension(cols) || !isGridDimension(rows)) {
    return {
      ok: false,
      reason:
        `A grid is 1 to ${String(MAX_GRID_DIMENSION)} cells in each direction ` +
        `(got ${String(cols)}×${String(rows)}).`,
    }
  }
  const kept = view.cells
    .filter((cell) => cell.col < cols && cell.row < rows)
    .map((cell) => {
      const colSpan = Math.min(cell.colSpan, cols - cell.col)
      const rowSpan = Math.min(cell.rowSpan, rows - cell.row)
      return colSpan === cell.colSpan && rowSpan === cell.rowSpan
        ? cell
        : { ...cell, colSpan, rowSpan }
    })
  return finish(view, cols, rows, [...kept, ...fillUncovered(kept, cols, rows)])
}

/**
 * Merges every cell inside `rect` into one cell covering exactly `rect` (VIEW-1).
 *
 * The rectangle has to lie inside the grid and cover **whole** cells: a cell that is only partly
 * inside it is refused (with the cell named), because merging it would mean either cutting that
 * cell in two or growing the result past what the user selected.
 *
 * **Which cell survives.** The merged cell is the cell, among those inside `rect`, that comes first
 * in reading order (top-left-most) *among the ones with at least one camera* — or simply the
 * top-left one when none has a camera. It keeps that cell's cameras and every setting (quality,
 * rotation, motion switching) and takes `rect` as its placement. The other cells' cameras are
 * dropped: picking the first assigned one means merging an empty region into a camera keeps the
 * camera wherever it sat, which is the common case ("make this camera bigger"), and a merge never
 * silently turns several single-camera cells into a rotating one. The editor should say so when
 * more than one of the merged cells has cameras.
 *
 * Merging a rectangle that is exactly one cell is a no-op success.
 */
export function mergeCells<V extends LayoutView>(view: V, rect: CellPlacement): LayoutResult<V> {
  if (!placementFits(rect, view.cols, view.rows)) {
    return {
      ok: false,
      reason:
        `The selection (col ${String(rect.col)}, row ${String(rect.row)}, ` +
        `${String(rect.colSpan)}×${String(rect.rowSpan)}) is not inside the ` +
        `${String(view.cols)}×${String(view.rows)} grid.`,
    }
  }
  const inside: Cell[] = []
  const outside: Cell[] = []
  for (const [index, cell] of view.cells.entries()) {
    if (!intersects(cell, rect)) {
      outside.push(cell)
    } else if (contains(rect, cell)) {
      inside.push(cell)
    } else {
      return {
        ok: false,
        reason:
          `Cell ${String(index)} is only partly inside the selection. Select whole cells to ` +
          'merge, or split that cell first.',
      }
    }
  }
  const ordered = normalizeCells(inside)
  const survivor = ordered.find((cell) => cell.cameraIds.length > 0) ?? ordered[0]
  if (survivor === undefined) {
    // Only reachable for an untiled View: a tiled one has a cell on every slot of `rect`.
    return { ok: false, reason: 'There are no cells inside the selection to merge.' }
  }
  const merged: Cell = {
    ...survivor,
    col: rect.col,
    row: rect.row,
    colSpan: rect.colSpan,
    rowSpan: rect.rowSpan,
  }
  return finish(view, view.cols, view.rows, [...outside, merged])
}

/**
 * Splits a spanned cell back into 1×1 cells (VIEW-1). The cell keeps its cameras and settings and
 * shrinks to its top-left slot; every other slot it covered becomes an empty 1×1 cell. Splitting a
 * cell that is already 1×1 is a no-op success.
 *
 * `cellIndex` is an index into `view.cells`, which is in canonical order after any parse or
 * operation (see `normalizeCells`).
 */
export function splitCell<V extends LayoutView>(view: V, cellIndex: number): LayoutResult<V> {
  const target = Number.isInteger(cellIndex) ? view.cells[cellIndex] : undefined
  if (target === undefined) {
    return {
      ok: false,
      reason: `There is no cell ${String(cellIndex)} (the View has ${String(view.cells.length)}).`,
    }
  }
  const shrunk: Cell = { ...target, colSpan: 1, rowSpan: 1 }
  const others = view.cells.filter((_cell, index) => index !== cellIndex)
  const kept = [...others, shrunk]
  return finish(view, view.cols, view.rows, [...kept, ...fillUncovered(kept, view.cols, view.rows)])
}

/** Whether two placements share at least one slot. */
export function intersects(a: CellPlacement, b: CellPlacement): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  )
}

/** Whether `inner` lies entirely within `outer`. */
export function contains(outer: CellPlacement, inner: CellPlacement): boolean {
  return (
    inner.col >= outer.col &&
    inner.row >= outer.row &&
    inner.col + inner.colSpan <= outer.col + outer.colSpan &&
    inner.row + inner.rowSpan <= outer.row + outer.rowSpan
  )
}

// -------------------------------------------------------------------------------------------------
// On-screen geometry (VIEW-5)

export interface GridLayoutInput {
  /** The box the grid is drawn in, in CSS px — normally the grid element's content box. */
  readonly width: number
  readonly height: number
  readonly cols: number
  readonly rows: number
  readonly aspect: Aspect
  /** CSS px between adjacent cells. */
  readonly gap: number
}

/** A rectangle in CSS px, relative to the top-left of the box `layoutGrid` was given. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The letterboxed grid: its box inside the available one, plus what `cellRect` needs. */
export interface GridLayout extends Rect {
  /** Size of one 1×1 cell. `unitWidth / unitHeight` is the View's aspect. */
  readonly unitWidth: number
  readonly unitHeight: number
  /** The gap actually used (a negative or non-finite one is treated as 0). */
  readonly gap: number
}

/** What a box that cannot hold the grid lays out as: nothing, at the origin, and never `NaN`. */
const EMPTY_LAYOUT: GridLayout = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  unitWidth: 0,
  unitHeight: 0,
  gap: 0,
}

/**
 * Fits the grid into a `width × height` box (VIEW-5): the largest grid whose 1×1 cells are exactly
 * `aspect`, with `gap` between adjacent cells, centred so the spare space is split evenly between
 * the two bars (left/right when the box is wider than the grid, top/bottom when it is taller).
 *
 * With `r = aspect.w / aspect.h`, the unit height is the largest `h` for which both directions fit:
 *
 *     h = min( (W − (cols−1)·g) / (cols·r),  (H − (rows−1)·g) / rows ),   w = h·r
 *
 * **No rounding.** The numbers are left fractional and CSS lays them out at subpixel precision;
 * rounding each unit to whole px would make the grid up to `cols` px narrower than it could be, or
 * — rounding up — overflow the box, and the rounding error would accumulate across spans. The
 * result is clamped to the box, so floating-point error cannot push the grid past an edge either.
 *
 * Safe for any input: a zero, negative or non-finite box, a gap that leaves no room for cells, an
 * invalid grid size or aspect all give a zero-size layout at the origin rather than `NaN` or a
 * negative size, so a component can render whatever comes back (e.g. before its first measure).
 */
export function layoutGrid(input: GridLayoutInput): GridLayout {
  const { width, height, cols, rows, aspect } = input
  const gap = Number.isFinite(input.gap) && input.gap > 0 ? input.gap : 0
  const ratio = aspect.w / aspect.h
  if (
    !(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) ||
    !(Number.isInteger(cols) && cols >= 1 && Number.isInteger(rows) && rows >= 1) ||
    !(Number.isFinite(ratio) && ratio > 0)
  ) {
    return EMPTY_LAYOUT
  }
  const unitHeight = Math.min(
    (width - (cols - 1) * gap) / (cols * ratio),
    (height - (rows - 1) * gap) / rows,
  )
  // `!(> 0)` rather than `<= 0` so that a NaN lands here too.
  if (!(unitHeight > 0) || !Number.isFinite(unitHeight)) return EMPTY_LAYOUT
  const unitWidth = unitHeight * ratio
  const gridWidth = Math.min(width, cols * unitWidth + (cols - 1) * gap)
  const gridHeight = Math.min(height, rows * unitHeight + (rows - 1) * gap)
  return {
    x: (width - gridWidth) / 2,
    y: (height - gridHeight) / 2,
    width: gridWidth,
    height: gridHeight,
    unitWidth,
    unitHeight,
    gap,
  }
}

/**
 * Where a cell is drawn, relative to the same box as the layout: its top-left slot's corner, and
 * `span·unit + (span−1)·gap` in each direction (the gaps it spans over become part of the cell). See
 * the header for why a spanned cell is slightly off `aspect` when `gap > 0`.
 */
export function cellRect(layout: GridLayout, cell: CellPlacement): Rect {
  const { unitWidth, unitHeight, gap } = layout
  return {
    x: layout.x + cell.col * (unitWidth + gap),
    y: layout.y + cell.row * (unitHeight + gap),
    width: cell.colSpan * unitWidth + (cell.colSpan - 1) * gap,
    height: cell.rowSpan * unitHeight + (cell.rowSpan - 1) * gap,
  }
}

// -------------------------------------------------------------------------------------------------
// Presets (the View editor's layout picker, P3.3)

/**
 * A starting layout: a grid size and the placements of its cells, as plain data. Picking one gives
 * a View empty cells in this arrangement (`presetCells`); the user then assigns cameras.
 */
export interface LayoutPreset {
  readonly id: string
  /** What the picker shows. */
  readonly label: string
  readonly cols: number
  readonly rows: number
  /** Tiles `cols × rows` exactly, in canonical order (checked by the unit test). */
  readonly cells: readonly CellPlacement[]
}

function uniformPreset(cols: number, rows: number): LayoutPreset {
  return {
    id: `${String(cols)}x${String(rows)}`,
    label: `${String(cols)}×${String(rows)}`,
    cols,
    rows,
    cells: uniformPlacements(cols, rows),
  }
}

/** A preset with some spanned cells; every slot they leave uncovered becomes a 1×1 cell. */
function spannedPreset(
  id: string,
  label: string,
  cols: number,
  rows: number,
  spans: readonly CellPlacement[],
): LayoutPreset {
  const cells = normalizeCells([...spans, ...fillUncovered(spans, cols, rows)]).map(
    ({ col, row, colSpan, rowSpan }) => ({ col, row, colSpan, rowSpan }),
  )
  return { id, label, cols, rows, cells }
}

/** The preset a new View starts from when none is chosen: 2×2, the smallest real wall. */
export const DEFAULT_LAYOUT_PRESET: LayoutPreset = uniformPreset(2, 2)

/**
 * The layouts the editor offers. First the uniform sizes VIEW-1 names, in its order; then three
 * spanned ones, each answering a real wall layout rather than a geometric curiosity:
 *
 *  - **1 + 5** (3×3, a 2×2 top-left): one camera that matters most — the front door — large, with
 *    five around it. The smallest "featured camera" layout that still shows a useful number.
 *  - **1 + 7** (4×4, a 3×3 top-left): the same idea for a bigger wall, where the feature is large
 *    enough to read faces and the seven around the edge are for glancing at.
 *  - **2 + 8** (4×4, two 2×2 across the top): two cameras of equal weight — a doorbell and the
 *    driveway, or front and back — with eight smaller below.
 *
 * Every one of these keeps the 4×4 cap and stays expressible by the editor's own merge/split, so a
 * preset is only ever a shortcut, never a layout the user could not have built by hand.
 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  uniformPreset(1, 1),
  DEFAULT_LAYOUT_PRESET,
  uniformPreset(3, 2),
  uniformPreset(3, 3),
  uniformPreset(4, 3),
  uniformPreset(4, 4),
  spannedPreset('1+5', '1 + 5', 3, 3, [{ col: 0, row: 0, colSpan: 2, rowSpan: 2 }]),
  spannedPreset('1+7', '1 + 7', 4, 4, [{ col: 0, row: 0, colSpan: 3, rowSpan: 3 }]),
  spannedPreset('2+8', '2 + 8', 4, 4, [
    { col: 0, row: 0, colSpan: 2, rowSpan: 2 },
    { col: 2, row: 0, colSpan: 2, rowSpan: 2 },
  ]),
]

/** A preset's cells as empty `Cell`s with every default, ready to put in a View. */
export function presetCells(preset: LayoutPreset): Cell[] {
  return preset.cells.map((placement) => ({
    ...emptyCell(placement.col, placement.row),
    colSpan: placement.colSpan,
    rowSpan: placement.rowSpan,
  }))
}
