// UX polish 2026-11-17 (VIEW-3): the View editor's side panel and toolbar decisions
// (src/renderer/src/features/viewEditor/editorTabs.ts, editorThumbnails.ts `paletteSnapshots`,
// viewEditorHelpers.ts `toolbarTitles`).
//
// What these tests protect: the arrow keys walk the View | Cell tabs and wrap; only the first pick
// of a cell brings the Cell tab forward, so the user is never yanked off the View tab afterwards;
// the palette draws a thumbnail only from what the cache already holds, for a camera that can have
// one; a toolbar button that cannot act on the selection says why; and the View tab's Display and
// Quality groups start open and fold independently (P7.1).
import type { Camera } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { ThumbnailEntry } from '../../src/renderer/src/state/camerasStore'
import {
  ALL_GROUPS_OPEN,
  EDITOR_TABS,
  tabAfterSelect,
  tabForKey,
  toggleGroup,
} from '../../src/renderer/src/features/viewEditor/editorTabs'
import {
  paletteSnapshots,
  refSnapshot,
} from '../../src/renderer/src/features/viewEditor/editorThumbnails'
import { toolbarTitles } from '../../src/renderer/src/features/viewEditor/viewEditorHelpers'

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

describe('tabAfterSelect', () => {
  it('brings the Cell tab forward on the first pick', () => {
    expect(tabAfterSelect('view', false)).toBe('cell')
    expect(tabAfterSelect('cell', false)).toBe('cell')
  })

  it('leaves the tab alone when something was selected already', () => {
    expect(tabAfterSelect('view', true)).toBe('view')
    expect(tabAfterSelect('cell', true)).toBe('cell')
  })
})

describe('toggleGroup (P7.1)', () => {
  it('starts with both groups open', () => {
    expect(ALL_GROUPS_OPEN).toEqual({ display: true, quality: true })
  })

  it('folds one group and leaves the other alone', () => {
    const folded = toggleGroup(ALL_GROUPS_OPEN, 'display')
    expect(folded).toEqual({ display: false, quality: true })
    expect(toggleGroup(folded, 'quality')).toEqual({ display: false, quality: false })
  })

  it('opens a folded group again, without changing what it was given', () => {
    const folded = toggleGroup(ALL_GROUPS_OPEN, 'quality')
    expect(toggleGroup(folded, 'quality')).toEqual(ALL_GROUPS_OPEN)
    expect(ALL_GROUPS_OPEN).toEqual({ display: true, quality: true })
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
