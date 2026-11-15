// P3.1: a View's layout (src/shared/viewTiling.ts + src/shared/viewLayout.ts; VIEW-1, VIEW-5).
//
// Three groups, each holding down a promise the rest of Phase 3 builds on:
//  - the **tiling rule** the schema enforces (every slot covered once, nothing outside), with the
//    offending cell named;
//  - the **editor operations** (resize, merge, split), each of which takes a tiled View to a tiled
//    View and keeps cameras where the brief says they go;
//  - the **letterbox geometry**: unit cells exactly the View's aspect, centred, gaps only between
//    cells, never NaN and never outside the box.
import { CellSchema, type Cell, type View } from '@shared/models'
import {
  DEFAULT_LAYOUT_PRESET,
  LAYOUT_PRESETS,
  cellRect,
  layoutGrid,
  mergeCells,
  normalizeCells,
  presetCells,
  resizeGrid,
  splitCell,
  tilingIssues,
  uniformCells,
  type CellPlacement,
  type LayoutResult,
} from '@shared/viewLayout'
import { describe, expect, it } from 'vitest'

/** A full cell at a placement, optionally with cameras. */
function cell(col: number, row: number, colSpan = 1, rowSpan = 1, cameraIds: string[] = []): Cell {
  return CellSchema.parse({ col, row, colSpan, rowSpan, cameraIds })
}

function view(cols: number, rows: number, cells: Cell[] = uniformCells(cols, rows)): View {
  return {
    id: 'v1',
    name: 'Test',
    cols,
    rows,
    fit: 'contain',
    aspect: { w: 16, h: 9 },
    gap: 0,
    gridQuality: null,
    fillQuality: 'high',
    cells,
  }
}

/** `[col, row, colSpan, rowSpan]` per cell, for assertions that read as a picture of the grid. */
function shape(cells: readonly CellPlacement[]): number[][] {
  return cells.map((c) => [c.col, c.row, c.colSpan, c.rowSpan])
}

function ok<V>(result: LayoutResult<V>): V {
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
  return result.view
}

function reason<V>(result: LayoutResult<V>): string {
  if (result.ok) throw new Error('expected a refusal')
  return result.reason
}

// -------------------------------------------------------------------------------------------------

describe('tilingIssues (SPEC §6)', () => {
  it('accepts a uniform grid and a grid with spans', () => {
    expect(tilingIssues(view(3, 3))).toEqual([])
    expect(
      tilingIssues(view(3, 3, [cell(0, 0, 2, 2), cell(2, 0, 1, 3), cell(0, 2), cell(1, 2)])),
    ).toEqual([])
    expect(tilingIssues(view(1, 1, [cell(0, 0)]))).toEqual([])
    expect(tilingIssues(view(4, 4, [cell(0, 0, 4, 4)]))).toEqual([])
  })

  it('reports every uncovered slot, with no cell to blame', () => {
    const issues = tilingIssues(view(2, 2, [cell(0, 0), cell(1, 1)]))
    expect(issues.map((i) => i.cellIndex)).toEqual([null, null])
    expect(issues[0]?.message).toContain('slot (col 1, row 0) is not covered')
    expect(issues[1]?.message).toContain('slot (col 0, row 1) is not covered')
    expect(tilingIssues(view(2, 1, []))).toHaveLength(2)
  })

  it('reports an overlap once, against the later cell, naming the earlier one', () => {
    const issues = tilingIssues(view(2, 2, [cell(0, 0, 2, 2), cell(1, 1), cell(0, 1)]))
    expect(issues).toEqual([
      { cellIndex: 1, message: 'cell 1 overlaps cell 0' },
      { cellIndex: 2, message: 'cell 2 overlaps cell 0' },
    ])
  })

  it('reports a cell that crosses or starts outside the edge', () => {
    const crossing = tilingIssues(view(2, 1, [cell(0, 0), cell(1, 0, 2, 1)]))
    // A cell that does not fit covers nothing, so the slot it would have taken is a hole as well.
    expect(crossing.map((i) => i.cellIndex)).toEqual([1, null])
    expect(crossing[0]?.message).toContain('does not fit inside the 2×1 grid')
    expect(crossing[1]?.message).toContain('col 1, row 0')
    const outside = tilingIssues(view(2, 1, [cell(0, 0), cell(1, 0), cell(0, 1)]))
    expect(outside.map((i) => i.cellIndex)).toEqual([2])
  })

  it('treats non-integer or non-positive numbers as not fitting, not as trusted', () => {
    const issues = tilingIssues({
      cols: 1,
      rows: 1,
      cells: [{ col: 0, row: 0, colSpan: 0.5, rowSpan: 1 }],
    })
    expect(issues.map((i) => i.cellIndex)).toEqual([0, null])
    expect(
      tilingIssues({ cols: 1, rows: 1, cells: [{ col: -1, row: 0, colSpan: 2, rowSpan: 1 }] }),
    ).toHaveLength(2)
  })
})

describe('normalizeCells', () => {
  it('sorts by the top-left slot, row first, and returns a copy', () => {
    const cells = [cell(2, 0, 1, 2), cell(0, 2), cell(0, 0, 2, 2), cell(1, 2), cell(2, 2)]
    const sorted = normalizeCells(cells)
    expect(shape(sorted)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 2],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ])
    expect(sorted).not.toBe(cells)
    expect(shape(cells)[0]).toEqual([2, 0, 1, 2])
  })
})

describe('uniformCells', () => {
  it('makes cols × rows empty 1×1 cells in row-major order, with every default', () => {
    const cells = uniformCells(3, 2)
    expect(shape(cells)).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
    ])
    expect(cells[0]).toEqual(CellSchema.parse({ col: 0, row: 0 }))
  })
})

// -------------------------------------------------------------------------------------------------

describe('resizeGrid (VIEW-1)', () => {
  it('grows: keeps every cell and fills the new slots with empty 1×1 cells', () => {
    const before = view(2, 2, [cell(0, 0, 2, 1, ['camA']), cell(0, 1), cell(1, 1, 1, 1, ['camB'])])
    const after = ok(resizeGrid(before, 3, 3))
    expect(after).toMatchObject({ cols: 3, rows: 3, id: 'v1', fillQuality: 'high' })
    expect(shape(after.cells)).toEqual([
      [0, 0, 2, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ])
    expect(after.cells[0]?.cameraIds).toEqual(['camA'])
    expect(after.cells[3]?.cameraIds).toEqual(['camB'])
    expect(tilingIssues(after)).toEqual([])
  })

  it('shrinks: clips a span that crosses the new edge instead of dropping its camera', () => {
    // A 1 + 5: the 2×2 feature, then a 2-column shrink cuts through it... and a 1-row shrink too.
    const before = view(3, 3, [
      { ...cell(0, 0, 2, 2, ['front-door']), quality: 'high' },
      cell(2, 0, 1, 1, ['side']),
      cell(2, 1),
      cell(0, 2, 1, 1, ['yard']),
      cell(1, 2),
      cell(2, 2),
    ])
    const after = ok(resizeGrid(before, 1, 1))
    expect(shape(after.cells)).toEqual([[0, 0, 1, 1]])
    expect(after.cells[0]).toMatchObject({ cameraIds: ['front-door'], quality: 'high' })

    const narrower = ok(resizeGrid(before, 3, 1))
    expect(shape(narrower.cells)).toEqual([
      [0, 0, 2, 1],
      [2, 0, 1, 1],
    ])
    expect(narrower.cells.map((c) => c.cameraIds)).toEqual([['front-door'], ['side']])
  })

  it('drops a cell whose top-left slot is outside the new grid, and re-fills its slots', () => {
    const before = view(2, 2, [cell(0, 0), cell(1, 0, 1, 2, ['camB']), cell(0, 1)])
    const after = ok(resizeGrid(before, 1, 2))
    expect(shape(after.cells)).toEqual([
      [0, 0, 1, 1],
      [0, 1, 1, 1],
    ])
    expect(after.cells.flatMap((c) => c.cameraIds)).toEqual([])
  })

  it('is a no-op for the same size, and refuses a size VIEW-1 does not allow', () => {
    const before = view(2, 2)
    expect(ok(resizeGrid(before, 2, 2)).cells).toEqual(before.cells)
    for (const [cols, rows] of [
      [0, 2],
      [5, 1],
      [2, 1.5],
      [Number.NaN, 2],
    ] as const) {
      expect(reason(resizeGrid(before, cols, rows))).toContain('1 to 4')
    }
  })

  it('does not mutate its input', () => {
    const before = view(2, 2, [cell(0, 0, 2, 2, ['camA'])])
    const snapshot = structuredClone(before)
    resizeGrid(before, 1, 1)
    expect(before).toEqual(snapshot)
  })
})

describe('mergeCells (VIEW-1)', () => {
  it('merges whole cells into one covering exactly the rectangle', () => {
    const after = ok(mergeCells(view(3, 3), { col: 0, row: 0, colSpan: 2, rowSpan: 2 }))
    expect(shape(after.cells)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ])
    expect(tilingIssues(after)).toEqual([])
  })

  it('keeps the top-left-most cell that has cameras, with all its settings', () => {
    const before = view(2, 2, [
      cell(0, 0),
      { ...cell(1, 0, 1, 1, ['camB']), quality: 'medium', rotateIntervalSec: 10 },
      cell(0, 1, 1, 1, ['camC']),
      cell(1, 1),
    ])
    const after = ok(mergeCells(before, { col: 0, row: 0, colSpan: 2, rowSpan: 2 }))
    expect(after.cells).toEqual([{ ...before.cells[1], col: 0, row: 0, colSpan: 2, rowSpan: 2 }])
    // camC was in a later cell: it is dropped, not folded into a rotation.
    expect(after.cells[0]?.cameraIds).toEqual(['camB'])
  })

  it('keeps the top-left cell when none of the merged cells has a camera', () => {
    const before = view(2, 1, [{ ...cell(0, 0), motionSwitch: true }, cell(1, 0)])
    const after = ok(mergeCells(before, { col: 0, row: 0, colSpan: 2, rowSpan: 1 }))
    expect(after.cells).toEqual([{ ...before.cells[0], colSpan: 2 }])
  })

  it('can merge an existing span with its neighbours', () => {
    const before = ok(mergeCells(view(3, 3), { col: 0, row: 0, colSpan: 2, rowSpan: 2 }))
    const after = ok(mergeCells(before, { col: 0, row: 0, colSpan: 3, rowSpan: 3 }))
    expect(shape(after.cells)).toEqual([[0, 0, 3, 3]])
  })

  it('refuses a rectangle that covers only part of a cell, naming it', () => {
    const before = view(3, 3, [
      cell(0, 0, 2, 2),
      cell(2, 0),
      cell(2, 1),
      cell(0, 2),
      cell(1, 2),
      cell(2, 2),
    ])
    const r = reason(mergeCells(before, { col: 1, row: 0, colSpan: 2, rowSpan: 1 }))
    expect(r).toContain('Cell 0 is only partly inside')
    // The input is returned untouched in spirit: nothing to apply on a refusal.
    expect(tilingIssues(before)).toEqual([])
  })

  it('refuses a rectangle outside the grid or with a bad span', () => {
    for (const rect of [
      { col: 2, row: 0, colSpan: 2, rowSpan: 1 },
      { col: -1, row: 0, colSpan: 1, rowSpan: 1 },
      { col: 0, row: 0, colSpan: 0, rowSpan: 1 },
      { col: 0, row: 0, colSpan: 1.5, rowSpan: 1 },
    ]) {
      expect(reason(mergeCells(view(3, 3), rect))).toContain('is not inside')
    }
  })

  it('treats a rectangle that is exactly one cell as a no-op', () => {
    const before = view(2, 2)
    expect(ok(mergeCells(before, { col: 1, row: 1, colSpan: 1, rowSpan: 1 })).cells).toEqual(
      before.cells,
    )
  })

  it('refuses rather than repairs a View that was not tiled to begin with', () => {
    const broken = view(2, 1, [cell(0, 0)])
    expect(reason(mergeCells(broken, { col: 0, row: 0, colSpan: 1, rowSpan: 1 }))).toContain(
      'did not tile',
    )
  })
})

describe('splitCell (VIEW-1)', () => {
  it('shrinks a span to its top-left slot with its settings, and fills the rest', () => {
    const before = view(3, 3, [
      { ...cell(0, 0, 2, 2, ['front-door']), quality: 'high', motionSwitch: true },
      cell(2, 0),
      cell(2, 1),
      cell(0, 2),
      cell(1, 2),
      cell(2, 2),
    ])
    const after = ok(splitCell(before, 0))
    expect(shape(after.cells)).toEqual(shape(view(3, 3).cells))
    expect(after.cells[0]).toEqual({ ...before.cells[0], colSpan: 1, rowSpan: 1 })
    expect(after.cells[1]?.cameraIds).toEqual([])
    expect(after.cells[3]).toEqual(CellSchema.parse({ col: 0, row: 1 }))
  })

  it('round-trips with mergeCells for an empty region', () => {
    const merged = ok(mergeCells(view(4, 4), { col: 1, row: 1, colSpan: 2, rowSpan: 2 }))
    const index = merged.cells.findIndex((c) => c.colSpan === 2)
    expect(ok(splitCell(merged, index)).cells).toEqual(view(4, 4).cells)
  })

  it('is a no-op on a 1×1 cell, and refuses an index that is not a cell', () => {
    const before = view(2, 2)
    expect(ok(splitCell(before, 3)).cells).toEqual(before.cells)
    for (const index of [4, -1, 0.5, Number.NaN]) {
      expect(reason(splitCell(before, index))).toContain('There is no cell')
    }
  })
})

// -------------------------------------------------------------------------------------------------

describe('layoutGrid (VIEW-5)', () => {
  const aspect = { w: 16, h: 9 }

  it('fills a box of exactly the grid shape with no bars', () => {
    const layout = layoutGrid({ width: 1600, height: 900, cols: 1, rows: 1, aspect, gap: 0 })
    expect(layout).toEqual({
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
      unitWidth: 1600,
      unitHeight: 900,
      gap: 0,
    })
  })

  it('centres horizontally in a box wider than the grid (bars left and right)', () => {
    // 2×2 of 16:9 in 2000×900: height-bound, so unit = 800×450 and the grid is 1600×900.
    const layout = layoutGrid({ width: 2000, height: 900, cols: 2, rows: 2, aspect, gap: 0 })
    expect(layout).toMatchObject({ x: 200, y: 0, width: 1600, height: 900 })
    expect(layout.unitWidth / layout.unitHeight).toBeCloseTo(16 / 9, 10)
  })

  it('centres vertically in a box taller than the grid (bars top and bottom)', () => {
    // 2×2 of 16:9 in 1600×1200: width-bound, so unit = 800×450 and the grid is 1600×900.
    const layout = layoutGrid({ width: 1600, height: 1200, cols: 2, rows: 2, aspect, gap: 0 })
    expect(layout).toMatchObject({ x: 0, y: 150, width: 1600, height: 900 })
  })

  it('puts the gap only between cells, and keeps unit cells exactly the aspect', () => {
    // 3×2 with an 8 px gap in 1936×1000. Width-bound: h = (1936 − 16) / (3·16/9) = 360, w = 640.
    // Grid: 3·640 + 2·8 = 1936 wide, 2·360 + 8 = 728 tall, so it sits (1000 − 728) / 2 = 136 down.
    const layout = layoutGrid({ width: 1936, height: 1000, cols: 3, rows: 2, aspect, gap: 8 })
    expect(layout).toEqual({
      x: 0,
      y: 136,
      width: 1936,
      height: 728,
      unitWidth: 640,
      unitHeight: 360,
      gap: 8,
    })
    // The first cell starts at the grid's edge: no gap around the outside.
    expect(cellRect(layout, { col: 0, row: 0, colSpan: 1, rowSpan: 1 })).toEqual({
      x: 0,
      y: 136,
      width: 640,
      height: 360,
    })
    // The last cell ends at the grid's far edge.
    const last = cellRect(layout, { col: 2, row: 1, colSpan: 1, rowSpan: 1 })
    expect(last.x + last.width).toBe(layout.x + layout.width)
    expect(last.y + last.height).toBe(layout.y + layout.height)
  })

  it('makes a spanned cell absorb the gaps it crosses (and so be a few px off the aspect)', () => {
    const layout = layoutGrid({ width: 1936, height: 1000, cols: 3, rows: 2, aspect, gap: 8 })
    const rect = cellRect(layout, { col: 1, row: 0, colSpan: 2, rowSpan: 2 })
    expect(rect).toEqual({ x: 648, y: 136, width: 2 * 640 + 8, height: 2 * 360 + 8 })
    // 1288×728 is not 16:9 (that would be 1294.2×728): the camera's `fit` absorbs it.
    expect(rect.width / rect.height).not.toBeCloseTo(16 / 9, 2)
  })

  it('honours a non-16:9 aspect', () => {
    const layout = layoutGrid({
      width: 1000,
      height: 1000,
      cols: 2,
      rows: 1,
      aspect: { w: 4, h: 3 },
      gap: 0,
    })
    expect(layout).toMatchObject({ unitWidth: 500, unitHeight: 375, x: 0, y: 312.5 })
  })

  it('never overflows the box, whatever the numbers', () => {
    for (const [width, height, cols, rows, gap] of [
      [1000, 1000, 3, 3, 7],
      [333.3, 777.7, 4, 3, 13],
      [1920, 1080, 4, 4, 64],
      [101, 57, 3, 1, 0],
    ] as const) {
      const layout = layoutGrid({ width, height, cols, rows, aspect, gap })
      expect(layout.x).toBeGreaterThanOrEqual(0)
      expect(layout.y).toBeGreaterThanOrEqual(0)
      expect(layout.x + layout.width).toBeLessThanOrEqual(width)
      expect(layout.y + layout.height).toBeLessThanOrEqual(height)
      const corner = cellRect(layout, { col: cols - 1, row: rows - 1, colSpan: 1, rowSpan: 1 })
      expect(corner.x + corner.width).toBeLessThanOrEqual(width + 1e-9)
      expect(corner.y + corner.height).toBeLessThanOrEqual(height + 1e-9)
    }
  })

  it('gives a zero-size layout, never NaN, for a box that cannot hold the grid', () => {
    const zero = { x: 0, y: 0, width: 0, height: 0, unitWidth: 0, unitHeight: 0, gap: 0 }
    for (const input of [
      { width: 0, height: 900 },
      { width: 1600, height: 0 },
      { width: -10, height: 900 },
      { width: Number.NaN, height: 900 },
      { width: Number.POSITIVE_INFINITY, height: 900 },
      // The gaps alone are wider than the box.
      { width: 20, height: 900, gap: 16 },
      { width: 1600, height: 900, cols: 0 },
      { width: 1600, height: 900, rows: 1.5 },
      { width: 1600, height: 900, aspect: { w: 0, h: 9 } },
      { width: 1600, height: 900, aspect: { w: 16, h: 0 } },
    ]) {
      const layout = layoutGrid({ cols: 3, rows: 3, aspect, gap: 0, ...input })
      expect(layout, JSON.stringify(input)).toEqual(zero)
      const rect = cellRect(layout, { col: 2, row: 2, colSpan: 1, rowSpan: 1 })
      expect(Object.values(rect).every((n) => n === 0)).toBe(true)
    }
  })

  it('treats a negative or non-finite gap as no gap', () => {
    const base = layoutGrid({ width: 1600, height: 900, cols: 2, rows: 2, aspect, gap: 0 })
    expect(layoutGrid({ width: 1600, height: 900, cols: 2, rows: 2, aspect, gap: -4 })).toEqual(
      base,
    )
    expect(
      layoutGrid({ width: 1600, height: 900, cols: 2, rows: 2, aspect, gap: Number.NaN }),
    ).toEqual(base)
  })
})

// -------------------------------------------------------------------------------------------------

describe('LAYOUT_PRESETS (P3.3)', () => {
  it('starts with the VIEW-1 uniform presets, in its order', () => {
    expect(LAYOUT_PRESETS.slice(0, 6).map((p) => p.id)).toEqual([
      '1x1',
      '2x2',
      '3x2',
      '3x3',
      '4x3',
      '4x4',
    ])
    expect(LAYOUT_PRESETS.find((p) => p.id === '3x2')).toMatchObject({ cols: 3, rows: 2 })
  })

  it('has unique ids, and the default is one of them', () => {
    const ids = LAYOUT_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(LAYOUT_PRESETS).toContain(DEFAULT_LAYOUT_PRESET)
    expect(DEFAULT_LAYOUT_PRESET).toMatchObject({ id: '2x2', cols: 2, rows: 2 })
  })

  it('has spanned presets whose label counts their cells', () => {
    const counts = Object.fromEntries(
      LAYOUT_PRESETS.filter((p) => p.cells.some((c) => c.colSpan > 1)).map((p) => [
        p.id,
        p.cells.length,
      ]),
    )
    expect(counts).toEqual({ '1+5': 6, '1+7': 8, '2+8': 10 })
  })

  for (const preset of LAYOUT_PRESETS) {
    it(`${preset.label} tiles its grid, in canonical order, within 4×4`, () => {
      expect(preset.cols).toBeLessThanOrEqual(4)
      expect(preset.rows).toBeLessThanOrEqual(4)
      expect(tilingIssues(preset)).toEqual([])
      expect(shape(preset.cells)).toEqual(shape(normalizeCells(preset.cells)))
      // presetCells makes valid empty cells with every default.
      const cells = presetCells(preset)
      expect(cells.every((c) => c.cameraIds.length === 0)).toBe(true)
      expect(tilingIssues(view(preset.cols, preset.rows, cells))).toEqual([])
    })
  }
})
