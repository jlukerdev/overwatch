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
  MAX_ASPECT_TERM,
  addCellCamera,
  applyPreset,
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
  swapCellContents,
  validateDraft,
} from '../../src/renderer/src/features/viewEditor/editorModel'
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
    expect(isDraftDirty(v, addCellCamera(v, 0, 'a'))).toBe(true)
    expect(isDraftDirty(v, applyPreset(v, preset('3x3')).view)).toBe(true)
    const withA = addCellCamera(v, 0, 'a')
    expect(isDraftDirty(withA, removeCellCamera(withA, 0, 0))).toBe(true)
  })

  it('compares drafts that do not parse as they are', () => {
    const v = view(2, 2)
    expect(isDraftDirty(v, { ...v, name: '' })).toBe(true)
    const blank = { ...v, name: '' }
    expect(isDraftDirty(blank, { ...blank })).toBe(false)
  })
})
