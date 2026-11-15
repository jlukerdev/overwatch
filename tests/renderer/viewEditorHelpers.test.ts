// P3.3: the View editor's small helpers (src/renderer/src/features/viewEditor/viewEditorHelpers.ts).
//
// What these tests protect: "New View" never reuses a taken name; the draft follows the stored View
// only while it holds no unsaved changes (and adopts a save that has just landed); the loss counts
// and notes the editor shows after a layout change; and a dropped cell index is only trusted when it
// names a cell.
import { describe, expect, it } from 'vitest'
import { ViewSchema, type View } from '@shared/models'
import { uniformCells } from '@shared/viewLayout'
import {
  layoutLossNote,
  mergeLossNote,
  nextViewName,
  parseCellIndex,
  resizeDropsCameras,
  startDraft,
  syncDraft,
} from '../../src/renderer/src/features/viewEditor/viewEditorHelpers'

function view(name = 'Front', cols = 2, rows = 2): View {
  return ViewSchema.parse({ id: 'v1', name, cols, rows, cells: uniformCells(cols, rows) })
}

describe('nextViewName', () => {
  it('starts at View 1', () => {
    expect(nextViewName([])).toBe('View 1')
  })

  it('takes the smallest free number, filling gaps', () => {
    expect(nextViewName([{ name: 'View 1' }, { name: 'View 3' }])).toBe('View 2')
    expect(nextViewName([{ name: 'View 1' }, { name: 'View 2' }])).toBe('View 3')
  })

  it('compares trimmed and case-insensitively, and ignores other names', () => {
    expect(nextViewName([{ name: ' view 1 ' }, { name: 'Garage' }])).toBe('View 2')
  })
})

describe('syncDraft', () => {
  it('returns the same state while the stored View is unchanged', () => {
    const saved = view()
    const state = { base: saved, draft: { ...saved, name: 'Edited' } }
    expect(syncDraft(state, saved)).toBe(state)
  })

  it('follows a stored change while the draft is clean', () => {
    const before = view()
    const after = { ...before, gap: 8 }
    expect(syncDraft(startDraft(before), after)).toEqual({ base: after, draft: after })
  })

  it('keeps unsaved changes when the stored View changes under them', () => {
    const before = view()
    const draft = { ...before, name: 'Edited' }
    const after = { ...before, gap: 8 }
    const next = syncDraft({ base: before, draft }, after)
    expect(next.base).toBe(after)
    expect(next.draft).toBe(draft)
  })

  it('adopts a save that has just landed (the stored View now equals the draft)', () => {
    const before = view()
    const draft = { ...before, gap: 4 }
    const stored = structuredClone(draft)
    const next = syncDraft({ base: before, draft }, stored)
    expect(next).toEqual({ base: stored, draft: stored })
    expect(next.draft).toBe(stored)
  })
})

describe('resizeDropsCameras', () => {
  it('counts camera cells whose top-left slot leaves the grid, not empty or clipped ones', () => {
    const v = view('Front', 3, 3)
    const cells = v.cells.map((cell) =>
      (cell.col === 2 && cell.row === 0) || (cell.col === 0 && cell.row === 2)
        ? { ...cell, cameraIds: ['cam'] }
        : cell,
    )
    expect(resizeDropsCameras({ cells }, 2, 3)).toBe(1)
    expect(resizeDropsCameras({ cells }, 2, 2)).toBe(2)
    expect(resizeDropsCameras({ cells }, 3, 3)).toBe(0)
  })
})

describe('parseCellIndex', () => {
  it('accepts a whole number that names a cell', () => {
    expect(parseCellIndex('0', 4)).toBe(0)
    expect(parseCellIndex('3', 4)).toBe(3)
  })

  it('refuses anything else', () => {
    for (const text of ['', '4', '-1', '1.5', ' 1', 'abc', '1e0']) {
      expect(parseCellIndex(text, 4)).toBeNull()
    }
  })
})

describe('notes', () => {
  it('words the merge note for one and several cells', () => {
    expect(mergeLossNote(1)).toBe('1 other cell lost its cameras.')
    expect(mergeLossNote(3)).toBe('3 other cells lost their cameras.')
  })

  it('has no layout note when nothing was lost', () => {
    expect(layoutLossNote(0)).toBeNull()
    expect(layoutLossNote(1)).toContain('1 cell with cameras')
    expect(layoutLossNote(2)).toContain('2 cells with cameras')
  })
})
