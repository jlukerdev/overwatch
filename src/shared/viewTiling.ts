// The geometry of a View's grid (P3.1; VIEW-1, SPEC §6): where a cell sits, whether a set of cells
// tiles the grid, and the canonical order cells are kept in. Pure functions over plain numbers.
//
// This is the half of the layout logic that ./models needs — `ViewSchema` calls
// {@link tilingIssues} to reject a View whose cells do not tile its grid — so it imports
// **nothing**, not even ./models. ./viewLayout holds the other half (the editor's operations, the
// on-screen math, the presets), which needs `CellSchema` to build empty cells; putting both halves
// in one module would make ./models and that module import each other. ./viewLayout re-exports
// everything here, so callers outside ./models import from there.

/**
 * Where a cell sits in its View's grid: the top-left slot (0-based) and how many slots it spans.
 * A `Cell` (./models) is one of these plus its cameras and settings.
 */
export interface CellPlacement {
  readonly col: number
  readonly row: number
  readonly colSpan: number
  readonly rowSpan: number
}

/** The part of a View the tiling rules look at. */
export interface TilingInput {
  readonly cols: number
  readonly rows: number
  readonly cells: readonly CellPlacement[]
}

/**
 * One reason a View's cells do not tile its grid. `cellIndex` names the offending cell, or is
 * `null` when the problem is a slot no cell covers (there is no cell to blame for a hole).
 */
export interface TilingIssue {
  readonly cellIndex: number | null
  readonly message: string
}

/**
 * Every reason `cells` does not tile `cols × rows` exactly, or `[]` when it does (SPEC §6).
 *
 * "Tiles" means three things, each reported separately so the message says what to fix:
 *  1. every cell lies **inside** the grid,
 *  2. no two cells **overlap** (reported against the later cell, in array order), and
 *  3. every slot is **covered** — an empty slot is an explicit cell with `cameraIds: []`, never a
 *     gap. That keeps "where is cell N" and "what is at slot (c, r)" answerable from the data alone,
 *     with no implied cells for the renderer or the editor to invent.
 *
 * Expects whole numbers (`ViewSchema` has checked them by the time it calls this); a cell whose
 * numbers are not positive integers is reported as out of bounds rather than trusted.
 */
export function tilingIssues(view: TilingInput): TilingIssue[] {
  const { cols, rows, cells } = view
  const issues: TilingIssue[] = []
  // owner[row][col] = index of the cell covering that slot, or -1.
  const owner: number[][] = Array.from({ length: Math.max(0, rows) }, () =>
    Array.from({ length: Math.max(0, cols) }, () => -1),
  )

  cells.forEach((cell, index) => {
    if (!placementFits(cell, cols, rows)) {
      issues.push({
        cellIndex: index,
        message:
          `cell ${String(index)} (col ${String(cell.col)}, row ${String(cell.row)}, ` +
          `${String(cell.colSpan)}×${String(cell.rowSpan)}) does not fit inside the ` +
          `${String(cols)}×${String(rows)} grid`,
      })
      return
    }
    // One issue per cell, naming the first cell it collides with: a cell that overlaps three others
    // is one mistake, not three.
    // Plain loops rather than `forEachSlot`, so the compiler can see `clash` being assigned.
    let clash: number | null = null
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      const line = owner[row]
      if (line === undefined) continue
      for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
        const current = line[col] ?? -1
        if (current === -1) line[col] = index
        else clash ??= current
      }
    }
    if (clash !== null) {
      issues.push({
        cellIndex: index,
        message: `cell ${String(index)} overlaps cell ${String(clash)}`,
      })
    }
  })

  owner.forEach((line, row) => {
    line.forEach((current, col) => {
      if (current === -1) {
        issues.push({
          cellIndex: null,
          message:
            `slot (col ${String(col)}, row ${String(row)}) is not covered by any cell; an empty ` +
            'slot is a cell with no cameras',
        })
      }
    })
  })
  return issues
}

/** Whether a placement is whole numbers, at least 1×1, and entirely inside `cols × rows`. */
export function placementFits(cell: CellPlacement, cols: number, rows: number): boolean {
  const { col, row, colSpan, rowSpan } = cell
  return (
    [col, row, colSpan, rowSpan].every(Number.isInteger) &&
    col >= 0 &&
    row >= 0 &&
    colSpan >= 1 &&
    rowSpan >= 1 &&
    col + colSpan <= cols &&
    row + rowSpan <= rows
  )
}

/** Calls `visit` for every slot a placement covers, row by row. */
export function forEachSlot(cell: CellPlacement, visit: (col: number, row: number) => void): void {
  for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
    for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) visit(col, row)
  }
}

/**
 * Cells in canonical order: by the row of their top-left slot, then its column — reading order for
 * a left-to-right script, and exactly the old row-major order when every cell is 1×1 (which is what
 * makes the v1 → v2 migration an identity on order).
 *
 * The order carries no layout meaning — a cell's place is its `col`/`row` — but keeping one order
 * means a cell's index (what `splitCell` and the editor address cells by) is stable across a save
 * round trip, and two Views with the same layout serialise identically. A copy; stable for ties,
 * which only an invalid (overlapping) list can have.
 */
export function normalizeCells<C extends CellPlacement>(cells: readonly C[]): C[] {
  return [...cells].sort((a, b) => a.row - b.row || a.col - b.col)
}
