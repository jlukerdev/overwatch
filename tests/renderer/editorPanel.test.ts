// VIEW-3: the View editor's side panel and cell-action decisions
// (src/renderer/src/features/viewEditor/editorTabs.ts, editorThumbnails.ts `paletteSnapshots`,
// viewEditorHelpers.ts `toolbarTitles`, CellActions.tsx `selectionCaption`, `focusAfterAction`).
//
// What these tests protect: the arrow keys walk the View | Cell tabs and wrap; every change to a
// non-empty selection brings the Cell tab forward, while the same selection or a cleared one leaves
// the tab where the user put it (F1.0.2-2); the palette draws a thumbnail only from what the cache
// already holds, for a camera that can have one; a cell action that cannot act on the selection
// says why, under a caption counting the selected cells; and the View tab's Display and Quality
// groups start folded and fold independently (P7.1, F1.0.2-2).
import type { Camera } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { ThumbnailEntry } from '../../src/renderer/src/state/camerasStore'
import {
  EDITOR_TABS,
  INITIAL_GROUPS,
  tabAfterSelect,
  tabForKey,
  toggleGroup,
} from '../../src/renderer/src/features/viewEditor/editorTabs'
import {
  paletteSnapshots,
  refSnapshot,
} from '../../src/renderer/src/features/viewEditor/editorThumbnails'
import { toolbarTitles } from '../../src/renderer/src/features/viewEditor/viewEditorHelpers'
import {
  focusAfterAction,
  selectionCaption,
} from '../../src/renderer/src/features/viewEditor/CellActions'

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

function ready(byte: number): ThumbnailEntry {
  return { status: 'ready', bytes: new Uint8Array([byte]), mimeType: 'image/jpeg', capturedAt: 1 }
}

describe('tabForKey', () => {
  it('lists View before Cell', () => {
    expect(EDITOR_TABS).toEqual(['view', 'cell'])
  })

  it('steps right and left, wrapping at both ends', () => {
    expect(tabForKey('view', 'ArrowRight')).toBe('cell')
    expect(tabForKey('cell', 'ArrowRight')).toBe('view')
    expect(tabForKey('cell', 'ArrowLeft')).toBe('view')
    expect(tabForKey('view', 'ArrowLeft')).toBe('cell')
  })

  it('jumps to the first and last tab on Home and End', () => {
    expect(tabForKey('cell', 'Home')).toBe('view')
    expect(tabForKey('view', 'End')).toBe('cell')
  })

  it('leaves every other key alone', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab', 'a']) {
      expect(tabForKey('view', key)).toBeNull()
    }
  })
})

describe('tabAfterSelect (F1.0.2-2)', () => {
  const at = (col: number, row: number, colSpan = 1, rowSpan = 1) => ({
    col,
    row,
    colSpan,
    rowSpan,
  })

  it('brings the Cell tab forward on the first pick', () => {
    expect(tabAfterSelect('view', null, at(0, 0))).toBe('cell')
    expect(tabAfterSelect('cell', null, at(0, 0))).toBe('cell')
  })

  it('brings the Cell tab forward when another cell is picked from the View tab', () => {
    expect(tabAfterSelect('view', at(0, 0), at(1, 0))).toBe('cell')
  })

  it('brings the Cell tab forward when a drag or Shift-click grows the selection', () => {
    expect(tabAfterSelect('view', at(0, 0), at(0, 0, 2, 1))).toBe('cell')
    expect(tabAfterSelect('view', at(0, 0, 2, 1), at(0, 0, 2, 2))).toBe('cell')
  })

  it('leaves the tab alone when the selection stays the same', () => {
    expect(tabAfterSelect('view', at(1, 1, 2, 1), at(1, 1, 2, 1))).toBe('view')
    expect(tabAfterSelect('cell', at(1, 1), at(1, 1))).toBe('cell')
  })

  it('leaves the tab alone when the selection is cleared', () => {
    expect(tabAfterSelect('view', at(0, 0), null)).toBe('view')
    expect(tabAfterSelect('cell', at(0, 0), null)).toBe('cell')
    expect(tabAfterSelect('view', null, null)).toBe('view')
  })
})

describe('selectionCaption (F1.0.2-2)', () => {
  it('counts the selected cells, and has nothing to say for none', () => {
    expect(selectionCaption(0)).toBeNull()
    expect(selectionCaption(1)).toBe('1 cell selected')
    expect(selectionCaption(4)).toBe('4 cells selected')
  })
})

describe('toggleGroup (P7.1)', () => {
  const allOpen = { display: true, quality: true } as const

  it('starts with both groups folded (F1.0.2-2)', () => {
    expect(INITIAL_GROUPS).toEqual({ display: false, quality: false })
  })

  it('opens one group and leaves the other alone', () => {
    const opened = toggleGroup(INITIAL_GROUPS, 'display')
    expect(opened).toEqual({ display: true, quality: false })
    expect(toggleGroup(opened, 'quality')).toEqual(allOpen)
  })

  it('folds an open group again, without changing what it was given', () => {
    const folded = toggleGroup(allOpen, 'quality')
    expect(folded).toEqual({ display: true, quality: false })
    expect(toggleGroup(folded, 'quality')).toEqual(allOpen)
    expect(allOpen).toEqual({ display: true, quality: true })
    expect(INITIAL_GROUPS).toEqual({ display: false, quality: false })
  })
})

describe('paletteSnapshots', () => {
  const cameras = [
    camera({ id: 'a' }),
    camera({ id: 'b' }),
    camera({ id: 'off', state: 'DISCONNECTED' }),
    camera({ id: 'bell', hasPackageCamera: true }),
  ]
  const entries: Record<string, ThumbnailEntry> = {
    a: ready(1),
    b: { status: 'loading', requestId: 1 },
    off: ready(3),
    bell: ready(4),
  }
  const packages: Record<string, ThumbnailEntry> = { bell: ready(5), a: ready(6) }

  it('gives each ref with a ready image that image, and nothing for the rest', () => {
    const images = paletteSnapshots(
      ['a', 'b', 'off', 'bell', 'bell:package', 'gone'],
      cameras,
      entries,
      packages,
    )
    expect([...images.keys()]).toEqual(['a', 'bell', 'bell:package'])
    expect(images.get('a')).toBe(entries.a)
    expect(images.get('bell')).toBe(entries.bell)
    expect(images.get('bell:package')).toBe(packages.bell)
  })

  it('is empty for an empty cache', () => {
    expect(paletteSnapshots(['a', 'bell:package'], cameras, {}, {}).size).toBe(0)
  })

  it('refSnapshot ignores a package image of a camera without a package camera', () => {
    expect(refSnapshot('a:package', cameras, entries, packages)).toBeNull()
    expect(refSnapshot('a', cameras, entries, packages)).toBe(entries.a)
  })
})

describe('toolbarTitles', () => {
  it('says how to get a selection when there is none', () => {
    const titles = toolbarTitles({ count: 0, canMerge: false, canSplit: false, hasCameras: false })
    expect(titles.merge).toMatch(/^Select two or more cells/)
    expect(titles.split).toBe('Select a merged cell to split it')
    expect(titles.clear).toBe('Select cells to remove their cameras')
  })

  it('explains each button for one plain, empty cell', () => {
    const titles = toolbarTitles({ count: 1, canMerge: false, canSplit: false, hasCameras: false })
    expect(titles.merge).toMatch(/^Select two or more cells/)
    expect(titles.split).toBe('This cell is not merged, so there is nothing to split')
    expect(titles.clear).toBe('The selected cell has no cameras')
  })

  it('describes the action when the button can act', () => {
    expect(
      toolbarTitles({ count: 1, canMerge: false, canSplit: true, hasCameras: true }),
    ).toMatchObject({
      split: 'Split the selected cell back into single cells',
      clear: 'Remove the cameras from the selected cell',
    })
    expect(toolbarTitles({ count: 3, canMerge: true, canSplit: false, hasCameras: true })).toEqual({
      merge: 'Merge the selected cells into one',
      split: 'Select one merged cell to split it',
      clear: 'Remove the cameras from the selected cells',
    })
  })

  it('covers several cells that cannot merge or have no cameras', () => {
    const titles = toolbarTitles({ count: 2, canMerge: false, canSplit: false, hasCameras: false })
    expect(titles.merge).toBe('These cells cannot be merged')
    expect(titles.clear).toBe('The selected cells have no cameras')
  })
})

describe('focusAfterAction (F1.0.2-2)', () => {
  it('stays on the clicked action while it can still act', () => {
    expect(focusAfterAction([true, true, true], 0)).toBe(0)
  })

  it('moves to the next action that can act, wrapping around', () => {
    // Merge went disabled after a merge: Split is next.
    expect(focusAfterAction([false, true, true], 0)).toBe(1)
    // Clear cameras went disabled and only Merge can act: wrap to the start.
    expect(focusAfterAction([true, false, false], 2)).toBe(0)
  })

  it('answers null when no action can act', () => {
    expect(focusAfterAction([false, false, false], 1)).toBeNull()
  })
})
