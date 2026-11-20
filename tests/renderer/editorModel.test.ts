// P3.3: the View editor's pure model (src/renderer/src/features/viewEditor/editorModel.ts; VIEW-1/2/
// 3/5, CAM-4).
//
// Every operation is checked twice over: for what it does, and for leaving a View that still passes
// `ViewSchema` — the editor saves its draft as is, so an operation that produced an untiled or
// duplicate-laden View would only surface as a refused Save. `valid()` is that second check.
//
// No jsdom (vitest.config.mts): everything here is plain data.
import { describe, expect, it } from 'vitest'
import type { Camera } from '@shared/ipc'
import { CellSchema, ViewSchema, type Cell, type View } from '@shared/models'
import {
  LAYOUT_PRESETS,
  mergeCells,
  presetCells,
  uniformCells,
  type CellPlacement,
  type LayoutPreset,
} from '@shared/viewLayout'
import {
  ASPECT_CHOICES,
  KNOWN_SMART_DETECT_TYPES,
  MAX_ASPECT_TERM,
  MAX_MOTION_HOLD_SEC,
  MAX_ROTATE_INTERVAL_SEC,
  addCellCamera,
  applyPreset,
  boundedInputBlurCommit,
  boundedInputCommit,
  cellCameraSmartDetectTypes,
  multiCameraHint,
  aspectChoiceLabel,
  cameraChoices,
  cameraRefLabel,
  cellIndexAt,
  cellsInRect,
  dropCameraOnCell,
  isDraftDirty,
  matchingPresetId,
  mergeDropsCameras,
  moveCellCamera,
  parseBoundedInt,
  removeCellCamera,
  selectionActions,
  selectionRect,
  setCellCameras,
  setCellMotionHold,
  setCellMotionSwitch,
  setCellMotionTriggers,
  setCellRotation,
  setCellSmartDetectTypes,
  smartDetectFilterChoices,
  smartDetectTypeLabel,
  swapCellContents,
  toggleMotionTrigger,
  toggleSmartDetectType,
  validateDraft,
} from '../../src/renderer/src/features/viewEditor/editorModel'
import { setCellQuality } from '../../src/renderer/src/features/quality/qualityChoice'
import { buildViewSlots } from '../../src/renderer/src/features/grid/gridLayout'

function preset(id: string): LayoutPreset {
  const found = LAYOUT_PRESETS.find((p) => p.id === id)
  if (found === undefined) throw new Error(`no preset ${id}`)
  return found
}

function view(cols = 2, rows = 2, cells: Cell[] = uniformCells(cols, rows)): View {
  return {
    id: 'v1',
    name: 'Main',
    cols,
    rows,
    fit: 'contain',
    aspect: { w: 16, h: 9 },
    gap: 0,
    gridQuality: null,
    fillQuality: null,
    showNames: true,
    cells,
  }
}

function presetView(id: string): View {
  const p = preset(id)
  return view(p.cols, p.rows, presetCells(p))
}

/** The View passes ViewSchema, and parsing does not reorder or change it. */
function valid(v: View): View {
  const parsed = ViewSchema.parse(v)
  expect(parsed.cells.map(place)).toEqual(v.cells.map(place))
  return v
}

function place(c: CellPlacement): CellPlacement {
  return { col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan }
}

function rect(col: number, row: number, colSpan: number, rowSpan: number): CellPlacement {
  return { col, row, colSpan, rowSpan }
}

function withCameras(v: View, byIndex: Record<number, string[]>): View {
  return {
    ...v,
    cells: v.cells.map((cell, i) => {
      const ids = byIndex[i]
      return ids === undefined ? cell : { ...cell, cameraIds: ids }
    }),
  }
}

function camera(overrides: Partial<Camera> & { id: string }): Camera {
  return {
    name: null,
    model: '',
    state: 'CONNECTED',
    hasMic: false,
    micEnabled: false,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: false,
    hasPackageCamera: false,
    ...overrides,
  }
}

const INVENTORY: Camera[] = [
  camera({ id: 'a', name: 'Front' }),
  camera({ id: 'b', name: 'Back' }),
  camera({ id: 'd', name: 'Doorbell', hasPackageCamera: true }),
  camera({ id: 'm', model: 'G4 Bullet' }),
  camera({ id: 'c10', name: 'Cam 10' }),
  camera({ id: 'c2', name: 'Cam 2' }),
]

// -------------------------------------------------------------------------------------------------

describe('cellIndexAt', () => {
  it('finds the cell covering a slot, spanned cells included', () => {
    const v = presetView('1+5') // [0] 2×2 at (0,0), then (2,0), (2,1), (0,2), (1,2), (2,2)
    expect(cellIndexAt(v, { col: 0, row: 0 })).toBe(0)
    expect(cellIndexAt(v, { col: 1, row: 1 })).toBe(0)
    expect(cellIndexAt(v, { col: 2, row: 0 })).toBe(1)
    expect(cellIndexAt(v, { col: 2, row: 1 })).toBe(2)
    expect(cellIndexAt(v, { col: 2, row: 2 })).toBe(5)
  })

  it('answers -1 outside the grid', () => {
    const v = view(2, 2)
    expect(cellIndexAt(v, { col: 2, row: 0 })).toBe(-1)
    expect(cellIndexAt(v, { col: 0, row: -1 })).toBe(-1)
  })
})

describe('selectionRect', () => {
  it('is the bounding box of two slots in a uniform grid, whichever order they come in', () => {
    const v = view(4, 4)
    expect(selectionRect(v, { col: 1, row: 1 }, { col: 1, row: 1 })).toEqual(rect(1, 1, 1, 1))
    expect(selectionRect(v, { col: 3, row: 2 }, { col: 1, row: 0 })).toEqual(rect(1, 0, 3, 3))
  })

  it('grows to take in a spanned cell it only touches (1 + 5)', () => {
    const v = presetView('1+5')
    expect(selectionRect(v, { col: 1, row: 1 }, { col: 1, row: 1 })).toEqual(rect(0, 0, 2, 2))
    expect(selectionRect(v, { col: 1, row: 1 }, { col: 1, row: 2 })).toEqual(rect(0, 0, 2, 3))
    expect(selectionRect(v, { col: 2, row: 1 }, { col: 1, row: 1 })).toEqual(rect(0, 0, 3, 2))
  })

  it('cascades: taking in one spanned cell can reach the next (2 + 8)', () => {
    const v = presetView('2+8')
    // (1,2)..(2,2) is the row under both 2×2 cells; selecting up from (1,1) to (2,1) touches both.
    expect(selectionRect(v, { col: 1, row: 1 }, { col: 2, row: 1 })).toEqual(rect(0, 0, 4, 2))
    expect(selectionRect(v, { col: 1, row: 2 }, { col: 2, row: 1 })).toEqual(rect(0, 0, 4, 3))
  })

  it('cascades through growth in two directions', () => {
    // 3×3 with a 1×2 at (0,1) and a 2×1 at (1,0), built by merging so it is a reachable layout.
    let v = view(3, 3)
    const tall = mergeCells(v, rect(0, 1, 1, 2))
    if (!tall.ok) throw new Error(tall.reason)
    const wide = mergeCells(tall.view, rect(1, 0, 2, 1))
    if (!wide.ok) throw new Error(wide.reason)
    v = wide.view
    // Selecting (0,0)–(1,1) touches the 2×1 at (1,0) → right edge 3; and the 1×2 at (0,1) → bottom 3.
    const r = selectionRect(v, { col: 0, row: 0 }, { col: 1, row: 1 })
    expect(r).toEqual(rect(0, 0, 3, 3))
  })

  it('clamps slots outside the grid into it', () => {
    const v = view(2, 2)
    expect(selectionRect(v, { col: -3, row: -1 }, { col: 9, row: 9 })).toEqual(rect(0, 0, 2, 2))
  })

  it('always gives a rectangle mergeCells accepts, for every pair of slots in every preset', () => {
    for (const p of LAYOUT_PRESETS) {
      const v = view(p.cols, p.rows, presetCells(p))
      for (let a = 0; a < p.cols * p.rows; a += 1) {
        for (let b = 0; b < p.cols * p.rows; b += 1) {
          const sa = { col: a % p.cols, row: Math.floor(a / p.cols) }
          const sb = { col: b % p.cols, row: Math.floor(b / p.cols) }
          const r = selectionRect(v, sa, sb)
          const merged = mergeCells(v, r)
          expect(merged.ok, `${p.id} ${JSON.stringify([sa, sb])}`).toBe(true)
          if (merged.ok) valid(merged.view)
        }
      }
    }
  })
})

describe('cellsInRect / selectionActions', () => {
  it('lists the cells wholly inside, ascending', () => {
    const v = presetView('1+5')
    expect(cellsInRect(v, rect(0, 0, 3, 3))).toEqual([0, 1, 2, 3, 4, 5])
    expect(cellsInRect(v, rect(2, 0, 1, 3))).toEqual([1, 2, 5])
    // The 2×2 is only partly inside this one.
    expect(cellsInRect(v, rect(1, 0, 2, 3))).toEqual([1, 2, 4, 5])
  })

  it('offers merge for two or more cells and split for one spanned cell', () => {
    const v = presetView('1+5')
    expect(selectionActions(v, rect(0, 0, 2, 2))).toEqual({
      canMerge: false,
      canSplit: true,
      cellIndexes: [0],
    })
    expect(selectionActions(v, rect(0, 0, 3, 2))).toMatchObject({ canMerge: true, canSplit: false })
    expect(selectionActions(v, rect(2, 2, 1, 1))).toEqual({
      canMerge: false,
      canSplit: false,
      cellIndexes: [5],
    })
  })

  it('offers neither when a cell sticks out of the rectangle', () => {
    const v = presetView('1+5')
    expect(selectionActions(v, rect(1, 0, 2, 3))).toMatchObject({
      canMerge: false,
      canSplit: false,
    })
    expect(selectionActions(v, rect(1, 1, 1, 1))).toEqual({
      canMerge: false,
      canSplit: false,
      cellIndexes: [],
    })
  })
})

describe('mergeDropsCameras', () => {
  it('is 0 when at most one cell inside has cameras', () => {
    const v = withCameras(view(2, 2), { 3: ['a'] })
    expect(mergeDropsCameras(v, rect(0, 0, 2, 2))).toBe(0)
    expect(mergeDropsCameras(view(2, 2), rect(0, 0, 2, 2))).toBe(0)
  })

  it('counts the camera cells other than the survivor, and agrees with mergeCells', () => {
    const v = withCameras(view(2, 2), { 1: ['a'], 2: ['b', 'c'], 3: ['d'] })
    expect(mergeDropsCameras(v, rect(0, 0, 2, 2))).toBe(2)
    expect(mergeDropsCameras(v, rect(0, 1, 2, 1))).toBe(1)
    expect(mergeDropsCameras(v, rect(0, 0, 1, 2))).toBe(0)
    const merged = mergeCells(v, rect(0, 0, 2, 2))
    expect(merged.ok && merged.view.cells[0]?.cameraIds).toEqual(['a'])
  })

  it('ignores cells outside the rectangle', () => {
    const v = withCameras(view(2, 2), { 0: ['a'], 1: ['b'] })
    expect(mergeDropsCameras(v, rect(0, 1, 2, 1))).toBe(0)
  })
})

describe('matchingPresetId', () => {
  it('names every preset laid out as itself', () => {
    for (const p of LAYOUT_PRESETS) expect(matchingPresetId(presetView(p.id))).toBe(p.id)
  })

  it('ignores cameras and cell order', () => {
    const v = withCameras(presetView('2+8'), { 0: ['a'], 5: ['b'] })
    expect(matchingPresetId({ ...v, cells: [...v.cells].reverse() })).toBe('2+8')
  })

  it('is null for a custom layout', () => {
    const merged = mergeCells(view(3, 3), rect(1, 1, 2, 2))
    if (!merged.ok) throw new Error(merged.reason)
    expect(matchingPresetId(merged.view)).toBeNull()
    // Same grid size as 3x2's columns but 3×1 is no preset.
    expect(matchingPresetId(view(3, 1))).toBeNull()
  })

  it('takes its own preset list', () => {
    const only: LayoutPreset[] = [
      { id: 'x', label: 'X', cols: 1, rows: 1, cells: [rect(0, 0, 1, 1)] },
    ]
    expect(matchingPresetId(view(1, 1), only)).toBe('x')
    expect(matchingPresetId(view(2, 2), only)).toBeNull()
    expect(matchingPresetId(view(2, 2), [])).toBeNull()
  })
})

describe('applyPreset', () => {
  it('re-lays the View and keeps every other field', () => {
    const v: View = { ...view(2, 2), gap: 8, fit: 'cover', aspect: { w: 4, h: 3 }, name: 'Wall' }
    const { view: next, dropped } = applyPreset(v, preset('1+5'))
    valid(next)
    expect(dropped).toBe(0)
    expect(next).toMatchObject({ id: 'v1', name: 'Wall', gap: 8, fit: 'cover', cols: 3, rows: 3 })
    expect(next.aspect).toEqual({ w: 4, h: 3 })
    expect(next.cells.map(place)).toEqual(preset('1+5').cells)
    expect(matchingPresetId(next)).toBe('1+5')
  })

  it('hands camera cells, settings included, to the new cells in reading order', () => {
    const base = view(2, 2)
    const v: View = {
      ...base,
      cells: base.cells.map((cell, i) => {
        if (i === 1) {
          return {
            ...cell,
            cameraIds: ['a', 'b'],
            quality: 'high',
            rotateIntervalSec: 10,
            motionSwitch: true,
            motionTriggers: ['ring'],
            smartDetectTypes: ['person'],
            motionHoldSec: 30,
          }
        }
        if (i === 3) return { ...cell, cameraIds: ['c'] }
        return cell
      }),
    }
    const { view: next, dropped } = applyPreset(v, preset('1+5'))
    valid(next)
    expect(dropped).toBe(0)
    expect(next.cells[0]).toEqual({
      ...CellSchema.parse({ col: 0, row: 0, colSpan: 2, rowSpan: 2 }),
      cameraIds: ['a', 'b'],
      quality: 'high',
      rotateIntervalSec: 10,
      motionSwitch: true,
      motionTriggers: ['ring'],
      smartDetectTypes: ['person'],
      motionHoldSec: 30,
    })
    expect(next.cells[1]).toEqual({ ...CellSchema.parse({ col: 2, row: 0 }), cameraIds: ['c'] })
    // The rest are fresh, with CellSchema's defaults.
    for (const cell of next.cells.slice(2)) {
      expect(cell).toEqual(CellSchema.parse(place(cell)))
    }
  })

  it('counts camera cells that did not fit', () => {
    const v = withCameras(view(2, 2), { 0: ['a'], 1: ['b'], 2: ['c'], 3: ['d'] })
    const { view: next, dropped } = applyPreset(v, preset('1x1'))
    valid(next)
    expect(dropped).toBe(3)
    expect(next.cells).toHaveLength(1)
    expect(next.cells[0]?.cameraIds).toEqual(['a'])
  })

  it('reads the old cells in reading order even when they are stored out of order', () => {
    const v = withCameras(view(2, 2), { 0: ['a'], 3: ['d'] })
    const shuffled = { ...v, cells: [...v.cells].reverse() }
    const { view: next } = applyPreset(shuffled, preset('2x2'))
    valid(next)
    expect(next.cells.map((c) => c.cameraIds)).toEqual([['a'], ['d'], [], []])
  })

  it('compacts empty cells away (cameras move up)', () => {
    const v = withCameras(view(2, 2), { 3: ['d'] })
    const { view: next } = applyPreset(v, preset('2x2'))
    expect(next.cells.map((c) => c.cameraIds)).toEqual([['d'], [], [], []])
  })
})

describe('cell camera edits', () => {
  const base = withCameras(view(2, 2), { 0: ['a', 'b', 'c'] })

  it('setCellCameras deduplicates, keeps order and drops empty refs', () => {
    const next = valid(setCellCameras(base, 1, ['d', 'a', 'd', '', 'b', 'a']))
    expect(next.cells[1]?.cameraIds).toEqual(['d', 'a', 'b'])
    expect(next.cells[0]?.cameraIds).toEqual(['a', 'b', 'c'])
    expect(base.cells[1]?.cameraIds).toEqual([]) // not mutated
    expect(valid(setCellCameras(base, 0, [])).cells[0]?.cameraIds).toEqual([])
  })

  it('out-of-range or non-integer indexes leave the View unchanged', () => {
    for (const index of [-1, 4, 1.5, Number.NaN]) {
      expect(setCellCameras(base, index, ['x'])).toBe(base)
      expect(addCellCamera(base, index, 'x')).toBe(base)
      expect(removeCellCamera(base, index, 0)).toBe(base)
      expect(moveCellCamera(base, index, 0, 1)).toBe(base)
      expect(dropCameraOnCell(base, index, 'x')).toBe(base)
    }
  })

  it('addCellCamera appends once', () => {
    const next = valid(addCellCamera(base, 0, 'd'))
    expect(next.cells[0]?.cameraIds).toEqual(['a', 'b', 'c', 'd'])
    expect(addCellCamera(base, 0, 'b')).toBe(base)
    expect(addCellCamera(base, 0, '')).toBe(base)
    expect(valid(addCellCamera(base, 3, 'd:package')).cells[3]?.cameraIds).toEqual(['d:package'])
  })

  it('removeCellCamera removes by position', () => {
    expect(valid(removeCellCamera(base, 0, 1)).cells[0]?.cameraIds).toEqual(['a', 'c'])
    expect(removeCellCamera(base, 0, 3)).toBe(base)
    expect(removeCellCamera(base, 0, -1)).toBe(base)
    expect(removeCellCamera(base, 1, 0)).toBe(base)
  })

  it('moveCellCamera swaps with a neighbour and stops at either end', () => {
    expect(valid(moveCellCamera(base, 0, 0, 1)).cells[0]?.cameraIds).toEqual(['b', 'a', 'c'])
    expect(valid(moveCellCamera(base, 0, 2, -1)).cells[0]?.cameraIds).toEqual(['a', 'c', 'b'])
    expect(moveCellCamera(base, 0, 0, -1)).toBe(base)
    expect(moveCellCamera(base, 0, 2, 1)).toBe(base)
    expect(moveCellCamera(base, 0, 5, -1)).toBe(base)
  })

  it('dropCameraOnCell replaces the cell’s cameras with that one', () => {
    expect(valid(dropCameraOnCell(base, 0, 'z')).cells[0]?.cameraIds).toEqual(['z'])
    expect(valid(dropCameraOnCell(base, 2, 'a')).cells[2]?.cameraIds).toEqual(['a'])
    expect(dropCameraOnCell(base, 0, '')).toBe(base)
  })

  it('keeps the other View fields and the cell settings', () => {
    const v: View = {
      ...base,
      gap: 4,
      cells: base.cells.map((c, i) => (i === 0 ? { ...c, rotateIntervalSec: 8 } : c)),
    }
    const next = valid(addCellCamera(v, 0, 'z'))
    expect(next.gap).toBe(4)
    expect(next.cells[0]?.rotateIntervalSec).toBe(8)
  })
})

describe('swapCellContents', () => {
  it('swaps cameras and settings, placements stay', () => {
    const v0 = presetView('1+5')
    const v: View = {
      ...v0,
      cells: v0.cells.map((c, i) => {
        if (i === 0) return { ...c, cameraIds: ['a'], quality: 'high', motionHoldSec: 5 }
        if (i === 5) return { ...c, cameraIds: ['b', 'c'], rotateIntervalSec: 12 }
        return c
      }),
    }
    const next = valid(swapCellContents(v, 0, 5))
    expect(next.cells.map(place)).toEqual(v.cells.map(place))
    expect(next.cells[0]).toMatchObject({ cameraIds: ['b', 'c'], rotateIntervalSec: 12 })
    expect(next.cells[0]?.quality).toBeNull()
    expect(next.cells[0]?.colSpan).toBe(2)
    expect(next.cells[5]).toMatchObject({ cameraIds: ['a'], quality: 'high', motionHoldSec: 5 })
    expect(next.cells[5]?.rotateIntervalSec).toBeUndefined()
    expect(swapCellContents(next, 0, 5)).toEqual(v)
  })

  it('swaps with an empty cell', () => {
    const v = withCameras(view(2, 2), { 0: ['a'] })
    const next = valid(swapCellContents(v, 0, 3))
    expect(next.cells.map((c) => c.cameraIds)).toEqual([[], [], [], ['a']])
  })

  it('a === b, or a bad index, leaves the View unchanged', () => {
    const v = withCameras(view(2, 2), { 0: ['a'] })
    expect(swapCellContents(v, 1, 1)).toBe(v)
    expect(swapCellContents(v, 0, 4)).toBe(v)
    expect(swapCellContents(v, -1, 0)).toBe(v)
    expect(swapCellContents(v, 0.5, 1)).toBe(v)
  })
})

describe('aspect choices', () => {
  it('offers five choices in order, each labelled as its ratio', () => {
    expect(ASPECT_CHOICES.map((c) => c.label)).toEqual(['16:9', '4:3', '1:1', '9:16', '21:9'])
    for (const c of ASPECT_CHOICES) {
      expect(c.label).toBe(`${String(c.aspect.w)}:${String(c.aspect.h)}`)
    }
    expect(MAX_ASPECT_TERM).toBe(99)
  })

  it('matches on the reduced ratio', () => {
    expect(aspectChoiceLabel({ w: 16, h: 9 })).toBe('16:9')
    expect(aspectChoiceLabel({ w: 32, h: 18 })).toBe('16:9')
    expect(aspectChoiceLabel({ w: 8, h: 6 })).toBe('4:3')
    expect(aspectChoiceLabel({ w: 7, h: 7 })).toBe('1:1')
    expect(aspectChoiceLabel({ w: 18, h: 32 })).toBe('9:16')
    expect(aspectChoiceLabel({ w: 42, h: 18 })).toBe('21:9')
  })

  it('is null for a custom or nonsense ratio', () => {
    expect(aspectChoiceLabel({ w: 3, h: 2 })).toBeNull()
    expect(aspectChoiceLabel({ w: 64, h: 27 })).toBeNull()
    expect(aspectChoiceLabel({ w: 0, h: 9 })).toBeNull()
    expect(aspectChoiceLabel({ w: 1.5, h: 1 })).toBeNull()
  })
})

describe('parseBoundedInt', () => {
  it('rounds then clamps', () => {
    expect(parseBoundedInt('12', 0, 64)).toBe(12)
    expect(parseBoundedInt(' 7 ', 0, 64)).toBe(7)
    expect(parseBoundedInt('2.5', 0, 64)).toBe(3)
    expect(parseBoundedInt('2.4', 0, 64)).toBe(2)
    expect(parseBoundedInt('.6', 0, 64)).toBe(1)
    expect(parseBoundedInt('100', 0, 64)).toBe(64)
    expect(parseBoundedInt('-5', 0, 64)).toBe(0)
    expect(parseBoundedInt('0', 1, MAX_ASPECT_TERM)).toBe(1)
    expect(parseBoundedInt('+3', 1, 9)).toBe(3)
  })

  it('is null for text that is not a plain number', () => {
    for (const text of ['', '   ', 'abc', '1e3', '0x10', '12px', '1.2.3', '-', 'Infinity', 'NaN']) {
      expect(parseBoundedInt(text, 0, 64), text).toBeNull()
    }
  })
})

describe('boundedInputCommit (typing)', () => {
  it('commits a whole number already in range that differs from the value', () => {
    expect(boundedInputCommit('30', 5, 86_400, 10)).toBe(30)
    expect(boundedInputCommit(' 7 ', 0, 64, 4)).toBe(7)
    expect(boundedInputCommit('5', 5, 60, 10)).toBe(5)
    expect(boundedInputCommit('60', 5, 60, 10)).toBe(60)
  })

  it('does not commit the first digit of a number below min (the "30" ending as 50 bug)', () => {
    // With min 5, typing "30": the "3" commits nothing, the "30" commits 30.
    expect(boundedInputCommit('3', 5, 86_400, 10)).toBeNull()
    expect(boundedInputCommit('30', 5, 86_400, 10)).toBe(30)
  })

  it('commits nothing for out-of-range, partial, fractional or unchanged text', () => {
    for (const text of ['', '-', '.', '1.', '2.5', 'abc', '1e3', '-1', '100', '0']) {
      expect(boundedInputCommit(text, 1, 64, 8), text).toBeNull()
    }
    expect(boundedInputCommit('8', 1, 64, 8)).toBeNull()
  })
})

describe('boundedInputBlurCommit', () => {
  it('commits the rounded, clamped number when it differs from the value', () => {
    expect(boundedInputBlurCommit('3', 5, 86_400, 10)).toBe(5)
    expect(boundedInputBlurCommit('99999', 5, 86_400, 10)).toBe(86_400)
    expect(boundedInputBlurCommit('2.6', 0, 64, 8)).toBe(3)
    expect(boundedInputBlurCommit('-4', 0, 64, 8)).toBe(0)
  })

  it('commits nothing for text that does not parse, or that clamps to the value', () => {
    for (const text of ['', 'abc', '-', '1e3']) {
      expect(boundedInputBlurCommit(text, 0, 64, 8), text).toBeNull()
    }
    expect(boundedInputBlurCommit('8', 0, 64, 8)).toBeNull()
    expect(boundedInputBlurCommit('2', 5, 60, 5)).toBeNull()
  })

  it('keeps a stored value above the input max when the text still shows it', () => {
    expect(boundedInputBlurCommit('100000', 5, 86_400, 100_000)).toBeNull()
    // Edited, it is clamped like any other text.
    expect(boundedInputBlurCommit('100001', 5, 86_400, 100_000)).toBe(86_400)
  })
})

describe('cameraChoices', () => {
  it('lists cameras in sortCameras order, each package channel right after its camera', () => {
    expect(cameraChoices(INVENTORY)).toEqual([
      { ref: 'b', label: 'Back' },
      { ref: 'c2', label: 'Cam 2' },
      { ref: 'c10', label: 'Cam 10' },
      { ref: 'd', label: 'Doorbell' },
      { ref: 'd:package', label: 'Doorbell (package)' },
      { ref: 'a', label: 'Front' },
      { ref: 'm', label: 'G4 Bullet' },
    ])
  })

  it('is empty without cameras', () => {
    expect(cameraChoices([])).toEqual([])
  })
})

describe('cameraRefLabel', () => {
  it('labels a camera, and its package channel', () => {
    expect(cameraRefLabel('a', INVENTORY)).toBe('Front')
    expect(cameraRefLabel('m', INVENTORY)).toBe('G4 Bullet')
    expect(cameraRefLabel('d:package', INVENTORY)).toBe('Doorbell (package)')
  })

  it('labels refs it cannot play in the Live screen’s words', () => {
    expect(cameraRefLabel('gone', INVENTORY)).toBe('Camera not found (gone)')
    expect(cameraRefLabel('gone:package', INVENTORY)).toBe('Camera not found (gone:package)')
    expect(cameraRefLabel('a:package', INVENTORY)).toBe('No package camera (Front)')

    // Same wording as buildViewSlots' missing slots.
    for (const ref of ['gone', 'a:package']) {
      const v = setCellCameras(view(1, 1), 0, [ref])
      const slot = buildViewSlots({
        view: v,
        cameras: INVENTORY,
        streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      })[0]
      expect(slot?.kind === 'missing' && slot.label).toBe(cameraRefLabel(ref, INVENTORY))
    }
  })

  it('agrees with every cameraChoices label', () => {
    for (const choice of cameraChoices(INVENTORY)) {
      expect(cameraRefLabel(choice.ref, INVENTORY)).toBe(choice.label)
    }
  })
})

describe('validateDraft', () => {
  it('trims the name and returns the parsed View', () => {
    const result = validateDraft({ ...view(2, 2), name: '  Garage  ' })
    expect(result).toEqual({ ok: true, view: { ...view(2, 2), name: 'Garage' } })
  })

  it('refuses an empty or blank name', () => {
    expect(validateDraft({ ...view(), name: '' })).toEqual({
      ok: false,
      reason: 'A View needs a name.',
    })
    expect(validateDraft({ ...view(), name: '   ' })).toEqual({
      ok: false,
      reason: 'A View needs a name.',
    })
  })

  it('saves the multi-camera settings as edited (CELL-2)', () => {
    let v = setCellCameras(view(2, 2), 0, ['a', 'b'])
    v = setCellRotation(v, 0, 12)
    v = setCellMotionSwitch(v, 0, true)
    v = setCellMotionTriggers(v, 0, ['smartDetect', 'ring'])
    v = setCellSmartDetectTypes(v, 0, ['vehicle', 'newThing'])
    v = setCellMotionHold(v, 0, 5)
    const result = validateDraft(v)
    expect(result.ok && result.view.cells[0]).toMatchObject({
      rotateIntervalSec: 12,
      motionSwitch: true,
      motionTriggers: ['smartDetect', 'ring'],
      smartDetectTypes: ['vehicle', 'newThing'],
      motionHoldSec: 5,
    })
  })

  it('normalises cell order', () => {
    const v = view(2, 2)
    const result = validateDraft({ ...v, cells: [...v.cells].reverse() })
    expect(result.ok && result.view.cells.map(place)).toEqual(v.cells.map(place))
  })

  it('reports the first schema issue', () => {
    const v = view(2, 2)
    const untiled = validateDraft({ ...v, cells: v.cells.slice(0, 3) })
    expect(untiled.ok).toBe(false)
    if (!untiled.ok) expect(untiled.reason).toMatch(/slot \(col 1, row 1\) is not covered/)
    const badGap = validateDraft({ ...v, gap: 500 })
    expect(badGap.ok).toBe(false)
    if (!badGap.ok) expect(badGap.reason.length).toBeGreaterThan(0)
  })
})

describe('multi-camera settings (CELL-2)', () => {
  /** A 2×2 View whose first cell has two cameras. */
  function multi(): View {
    return setCellCameras(view(2, 2), 0, ['a', 'b'])
  }

  it('starts from the schema defaults: no rotation, switch off, all triggers, no filter', () => {
    const cell = multi().cells[0]
    expect(cell?.rotateIntervalSec).toBeUndefined()
    expect(cell?.motionSwitch).toBe(false)
    expect(cell?.motionTriggers).toEqual(['motion', 'smartDetect', 'ring'])
    expect(cell?.smartDetectTypes).toBeUndefined()
    expect(cell?.motionHoldSec).toBe(15)
  })

  describe('setCellRotation', () => {
    it('sets, clamps and rounds the interval', () => {
      const v = multi()
      expect(valid(setCellRotation(v, 0, 10)).cells[0]?.rotateIntervalSec).toBe(10)
      expect(setCellRotation(v, 0, 2).cells[0]?.rotateIntervalSec).toBe(5)
      expect(setCellRotation(v, 0, 7.6).cells[0]?.rotateIntervalSec).toBe(8)
      // Only cell 0 changed.
      expect(setCellRotation(v, 0, 10).cells.slice(1)).toEqual(v.cells.slice(1))
    })

    it('removes the field for undefined, so the cell does not rotate', () => {
      const on = setCellRotation(multi(), 0, 10)
      const off = valid(setCellRotation(on, 0, undefined))
      expect(off.cells[0]).not.toHaveProperty('rotateIntervalSec')
    })

    it('returns the same View on a no-op', () => {
      const v = multi()
      expect(setCellRotation(v, 0, undefined)).toBe(v)
      const on = setCellRotation(v, 0, 10)
      expect(setCellRotation(on, 0, 10)).toBe(on)
      expect(setCellRotation(on, 0, Number.NaN)).toBe(on)
      expect(setCellRotation(on, 9, 20)).toBe(on)
      expect(setCellRotation(on, -1, 20)).toBe(on)
    })

    it('clamps only to the schema minimum; the input applies its own max', () => {
      // A stored interval above the input's max (CellSchema has none) is kept as it is.
      expect(MAX_ROTATE_INTERVAL_SEC).toBe(86_400)
      const long = valid(setCellRotation(multi(), 0, 100_000))
      expect(long.cells[0]?.rotateIntervalSec).toBe(100_000)
      expect(setCellRotation(long, 0, 100_000)).toBe(long)
      expect(boundedInputBlurCommit('7200', 5, MAX_ROTATE_INTERVAL_SEC, 10)).toBe(7200)
      expect(boundedInputBlurCommit('3', 5, MAX_ROTATE_INTERVAL_SEC, 10)).toBe(5)
    })
  })

  describe('setCellMotionSwitch', () => {
    it('turns the switch on and off, same View on a no-op', () => {
      const v = multi()
      const on = valid(setCellMotionSwitch(v, 0, true))
      expect(on.cells[0]?.motionSwitch).toBe(true)
      expect(setCellMotionSwitch(on, 0, true)).toBe(on)
      expect(setCellMotionSwitch(on, 0, false).cells[0]?.motionSwitch).toBe(false)
      expect(setCellMotionSwitch(v, 0, false)).toBe(v)
      expect(setCellMotionSwitch(v, 7, true)).toBe(v)
    })
  })

  describe('setCellMotionTriggers', () => {
    it('keeps MOTION_TRIGGERS order and drops duplicates and non-triggers', () => {
      const v = multi()
      const next = valid(setCellMotionTriggers(v, 0, ['ring', 'motion', 'ring', 'bogus']))
      expect(next.cells[0]?.motionTriggers).toEqual(['motion', 'ring'])
    })

    it('allows an empty list', () => {
      expect(valid(setCellMotionTriggers(multi(), 0, [])).cells[0]?.motionTriggers).toEqual([])
    })

    it('returns the same View when the set is unchanged, in any order', () => {
      const v = multi()
      expect(setCellMotionTriggers(v, 0, ['ring', 'smartDetect', 'motion'])).toBe(v)
      expect(setCellMotionTriggers(v, 5, ['ring'])).toBe(v)
    })

    it('toggleMotionTrigger adds or removes one, in canonical order', () => {
      expect(toggleMotionTrigger(['ring'], 'motion', true)).toEqual(['motion', 'ring'])
      expect(toggleMotionTrigger(['motion', 'smartDetect', 'ring'], 'smartDetect', false)).toEqual([
        'motion',
        'ring',
      ])
      expect(toggleMotionTrigger(['motion'], 'motion', true)).toEqual(['motion'])
      expect(toggleMotionTrigger([], 'ring', false)).toEqual([])
    })
  })

  describe('setCellSmartDetectTypes', () => {
    it('sets the filter, known types in Protect order, deduplicated', () => {
      const next = valid(setCellSmartDetectTypes(multi(), 0, ['vehicle', 'person', 'vehicle', '']))
      expect(next.cells[0]?.smartDetectTypes).toEqual(['person', 'vehicle'])
    })

    it('removes the field for an empty list or undefined (no filter)', () => {
      const filtered = setCellSmartDetectTypes(multi(), 0, ['person'])
      expect(valid(setCellSmartDetectTypes(filtered, 0, [])).cells[0]).not.toHaveProperty(
        'smartDetectTypes',
      )
      expect(setCellSmartDetectTypes(filtered, 0, undefined).cells[0]).not.toHaveProperty(
        'smartDetectTypes',
      )
    })

    it('keeps types it does not know, after the known ones', () => {
      const next = valid(setCellSmartDetectTypes(multi(), 0, ['newThing', 'animal', 'otherThing']))
      expect(next.cells[0]?.smartDetectTypes).toEqual(['animal', 'newThing', 'otherThing'])
    })

    it('returns the same View on a no-op', () => {
      const v = multi()
      expect(setCellSmartDetectTypes(v, 0, [])).toBe(v)
      expect(setCellSmartDetectTypes(v, 0, undefined)).toBe(v)
      const filtered = setCellSmartDetectTypes(v, 0, ['person', 'vehicle'])
      expect(setCellSmartDetectTypes(filtered, 0, ['vehicle', 'person'])).toBe(filtered)
      expect(setCellSmartDetectTypes(filtered, 9, ['face'])).toBe(filtered)
    })

    it('toggleSmartDetectType keeps every other entry, unknown types included', () => {
      expect(toggleSmartDetectType(undefined, 'person', true)).toEqual(['person'])
      expect(toggleSmartDetectType(['newThing', 'person'], 'person', false)).toEqual(['newThing'])
      expect(toggleSmartDetectType(['newThing'], 'face', true)).toEqual(['newThing', 'face'])
      expect(toggleSmartDetectType(['person'], 'person', true)).toEqual(['person'])
      // Unchecking a known type on a cell that also has an unknown one keeps the unknown one.
      const v = setCellSmartDetectTypes(multi(), 0, ['person', 'newThing'])
      const types = toggleSmartDetectType(v.cells[0]?.smartDetectTypes, 'person', false)
      expect(setCellSmartDetectTypes(v, 0, types).cells[0]?.smartDetectTypes).toEqual(['newThing'])
    })

    it('cellCameraSmartDetectTypes reads each camera once per ref, package refs as their camera', () => {
      const cams = [
        camera({ id: 'x', smartDetectTypes: ['vehicle', 'person'] }),
        camera({ id: 'y', hasPackageCamera: true, smartDetectTypes: ['animal', 'newThing'] }),
      ]
      expect(cellCameraSmartDetectTypes(['x', 'y:package', 'missing'], cams)).toEqual([
        'vehicle',
        'person',
        'animal',
        'newThing',
      ])
      expect(cellCameraSmartDetectTypes(['missing'], cams)).toEqual([])
    })

    it("smartDetectFilterChoices offers the cameras' types plus stored ones, known first", () => {
      expect(
        smartDetectFilterChoices(['vehicle', 'newThing', 'person', 'vehicle'], undefined),
      ).toEqual(['person', 'vehicle', 'newThing'])
      expect(smartDetectFilterChoices(['animal'], ['otherThing', 'face'])).toEqual([
        'face',
        'animal',
        'otherThing',
      ])
    })

    it('smartDetectFilterChoices falls back to every known type when no camera reports one', () => {
      const known = KNOWN_SMART_DETECT_TYPES.map((k) => k.type)
      expect(smartDetectFilterChoices([], undefined)).toEqual(known)
      expect(smartDetectFilterChoices([], ['newThing'])).toEqual([...known, 'newThing'])
    })

    it('labels the known types, and an unknown one by its own name', () => {
      expect(KNOWN_SMART_DETECT_TYPES.map((k) => k.type)).toEqual([
        'person',
        'vehicle',
        'package',
        'licensePlate',
        'face',
        'animal',
      ])
      expect(smartDetectTypeLabel('licensePlate')).toBe('License plate')
      expect(smartDetectTypeLabel('newThing')).toBe('newThing')
    })
  })

  describe('setCellMotionHold', () => {
    it('sets, clamps and rounds the hold', () => {
      const v = multi()
      expect(valid(setCellMotionHold(v, 0, 30)).cells[0]?.motionHoldSec).toBe(30)
      expect(valid(setCellMotionHold(v, 0, 0)).cells[0]?.motionHoldSec).toBe(0)
      expect(setCellMotionHold(v, 0, -4).cells[0]?.motionHoldSec).toBe(0)
      // No upper clamp in the setter: the input caps at MAX_MOTION_HOLD_SEC (one day).
      expect(MAX_MOTION_HOLD_SEC).toBe(86_400)
      expect(valid(setCellMotionHold(v, 0, 100_000)).cells[0]?.motionHoldSec).toBe(100_000)
      expect(setCellMotionHold(v, 0, 2.4).cells[0]?.motionHoldSec).toBe(2)
    })

    it('returns the same View on a no-op', () => {
      const v = multi()
      expect(setCellMotionHold(v, 0, 15)).toBe(v)
      expect(setCellMotionHold(v, 0, Number.POSITIVE_INFINITY)).toBe(v)
      expect(setCellMotionHold(v, 4, 30)).toBe(v)
    })
  })

  it('moves with the cell on a swap and a preset change', () => {
    let v = setCellRotation(multi(), 0, 20)
    v = setCellMotionSwitch(v, 0, true)
    v = setCellSmartDetectTypes(v, 0, ['person'])
    const swapped = swapCellContents(v, 0, 3)
    expect(swapped.cells[3]).toMatchObject({
      rotateIntervalSec: 20,
      motionSwitch: true,
      smartDetectTypes: ['person'],
    })
    const relaid = applyPreset(v, preset('3x3')).view
    expect(relaid.cells[0]).toMatchObject({ rotateIntervalSec: 20, motionSwitch: true })
  })
})

describe('isDraftDirty', () => {
  it('is false for the same View, or a copy', () => {
    const v = view(2, 2)
    expect(isDraftDirty(v, v)).toBe(false)
    expect(isDraftDirty(v, structuredClone(v))).toBe(false)
  })

  it('ignores cell order and explicitly-undefined optional fields', () => {
    const v = view(2, 2)
    expect(isDraftDirty(v, { ...v, cells: [...v.cells].reverse() })).toBe(false)
    const withUndefined = {
      ...v,
      cells: v.cells.map((c) => ({ ...c, rotateIntervalSec: undefined })),
    } as unknown as View
    expect(isDraftDirty(v, withUndefined)).toBe(false)
  })

  it('sees every kind of edit', () => {
    const v = view(2, 2)
    expect(isDraftDirty(v, { ...v, name: 'Main ' })).toBe(true)
    expect(isDraftDirty(v, { ...v, gap: 2 })).toBe(true)
    expect(isDraftDirty(v, { ...v, aspect: { w: 4, h: 3 } })).toBe(true)
    expect(isDraftDirty(v, { ...v, fit: 'cover' })).toBe(true)
    // P4.3 (VIEW-8): the Show camera names checkbox.
    expect(isDraftDirty(v, { ...v, showNames: false })).toBe(true)
    // P3.7 (QUAL-2/3/5): the editor's quality selects.
    expect(isDraftDirty(v, { ...v, gridQuality: 'medium' })).toBe(true)
    expect(isDraftDirty(v, { ...v, fillQuality: 'medium' })).toBe(true)
    expect(isDraftDirty(v, setCellQuality(v, 0, 0, 'high'))).toBe(true)
    expect(isDraftDirty(v, setCellQuality(setCellQuality(v, 0, 0, 'high'), 0, 0, null))).toBe(false)
    expect(isDraftDirty(v, addCellCamera(v, 0, 'a'))).toBe(true)
    expect(isDraftDirty(v, applyPreset(v, preset('3x3')).view)).toBe(true)
    const withA = addCellCamera(v, 0, 'a')
    expect(isDraftDirty(withA, removeCellCamera(withA, 0, 0))).toBe(true)
    // P4.2 (CELL-2): the inspector's multi-camera settings.
    expect(isDraftDirty(v, setCellRotation(v, 0, 10))).toBe(true)
    expect(isDraftDirty(v, setCellRotation(setCellRotation(v, 0, 10), 0, undefined))).toBe(false)
    expect(isDraftDirty(v, setCellMotionSwitch(v, 0, true))).toBe(true)
    expect(isDraftDirty(v, setCellMotionTriggers(v, 0, ['ring']))).toBe(true)
    expect(isDraftDirty(v, setCellSmartDetectTypes(v, 0, ['person']))).toBe(true)
    const filtered = setCellSmartDetectTypes(v, 0, ['person'])
    expect(isDraftDirty(v, setCellSmartDetectTypes(filtered, 0, []))).toBe(false)
    expect(isDraftDirty(v, setCellMotionHold(v, 0, 30))).toBe(true)
  })

  it('compares drafts that do not parse as they are', () => {
    const v = view(2, 2)
    expect(isDraftDirty(v, { ...v, name: '' })).toBe(true)
    const blank = { ...v, name: '' }
    expect(isDraftDirty(blank, { ...blank })).toBe(false)
  })
})

describe('multiCameraHint (CELL-2, RTSP-4)', () => {
  it('names rotation and event switching in Protect mode', () => {
    expect(multiCameraHint({ rotateIntervalSec: 10, motionSwitch: true })).toBe(
      'With two or more cameras, the cell rotates through them in this order every 10 s, and switches to a camera on its events.',
    )
    expect(multiCameraHint({ rotateIntervalSec: undefined, motionSwitch: false }, true)).toBe(
      'With two or more cameras, the cell shows the first (rotation and event switching are off).',
    )
  })

  it('never mentions events without them (RTSP mode), even with Switch on events stored', () => {
    expect(multiCameraHint({ rotateIntervalSec: 10, motionSwitch: true }, false)).toBe(
      'With two or more cameras, the cell rotates through them in this order every 10 s.',
    )
    expect(multiCameraHint({ rotateIntervalSec: undefined, motionSwitch: true }, false)).toBe(
      'With two or more cameras, the cell shows the first (rotation is off).',
    )
  })
})
