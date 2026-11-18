// P3.1: the renderer's View store (src/renderer/src/state/viewsStore.ts; VIEW-3, VIEW-4, VIEW-6).
//
// The pure list operations are tested directly. The actions are tested against a fake bridge that
// behaves like main — it validates with the real `SetViewsInputSchema`, stores the pair and answers
// with the whole `AppState` — because the point of the store is that it keeps no copy of its own:
// what a test reads back must be what came back over the bridge and was folded into the app store.
//
// No jsdom (vitest.config.mts): the fake is installed on `globalThis.window`, as in
// appStore.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SetViewsInputSchema,
  ipcFail,
  type AppState,
  type IpcResult,
  type ViewProtectApi,
} from '@shared/ipc'
import { CellSchema, type View } from '@shared/models'
import { LAYOUT_PRESETS, mergeCells, uniformCells } from '@shared/viewLayout'
import { useAppStore } from '../../src/renderer/src/state/appStore'
import {
  activeAfterDelete,
  createViewFromPreset,
  deleteViewIn,
  duplicateViewIn,
  neighbourAfterDelete,
  renameViewIn,
  reorderViewsIn,
  resolveActiveView,
  selectionNeedsStore,
  selectActiveView,
  selectViews,
  STARTER_VIEW_NAME,
  starterPreset,
  viewsActions,
} from '../../src/renderer/src/state/viewsStore'

function view(id: string, cols = 2, rows = 2): View {
  return {
    id,
    name: `View ${id}`,
    cols,
    rows,
    fit: 'contain',
    aspect: { w: 16, h: 9 },
    gap: 0,
    gridQuality: null,
    fillQuality: null,
    showNames: true,
    cells: uniformCells(cols, rows),
  }
}

const ids = (views: readonly View[]): string[] => views.map((v) => v.id)

function appState(views: View[], lastViewId: string | null): AppState {
  return {
    version: '0.1.0',
    settings: {
      console: {
        host: 'udm.local',
        certFingerprint: null,
        accessEnabled: false,
        accessBaseUrl: null,
        accessCertFingerprint: null,
        connectOnLaunch: false,
      },
      doorLinks: {},
      views,
      lastViewId,
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      ui: { overlayAutoHideSec: 3 },
      accessPolling: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 },
    },
    keystoreAvailable: true,
    secretsStored: { protectApiKey: true, accessToken: false },
    connection: null as unknown as AppState['connection'],
    cameras: [],
  }
}

// -------------------------------------------------------------------------------------------------
// Pure list operations

describe('resolveActiveView (VIEW-6)', () => {
  const views = [view('a'), view('b'), view('c')]

  it('finds the View lastViewId names', () => {
    expect(resolveActiveView(views, 'b')?.id).toBe('b')
  })

  it('falls back to the first View for a dangling or null id', () => {
    expect(resolveActiveView(views, 'deleted-elsewhere')?.id).toBe('a')
    expect(resolveActiveView(views, null)?.id).toBe('a')
  })

  it('is null only when there are no Views', () => {
    expect(resolveActiveView([], 'a')).toBeNull()
    expect(resolveActiveView([], null)).toBeNull()
  })
})

describe('selectionNeedsStore (VIEW-6)', () => {
  it('skips only a View that is already the stored lastViewId', () => {
    expect(selectionNeedsStore('a', 'a')).toBe(false)
    expect(selectionNeedsStore('a', 'b')).toBe(true)
  })

  it('stores the fallback View when lastViewId is null or dangling', () => {
    // resolveActiveView shows 'a' for both, yet choosing 'a' must still be written.
    expect(selectionNeedsStore(null, 'a')).toBe(true)
    expect(selectionNeedsStore('deleted-elsewhere', 'a')).toBe(true)
  })
})

describe('list operations (VIEW-3)', () => {
  const views = [view('a'), view('b'), view('c')]

  it('renames one View and leaves the others as the same objects', () => {
    const next = renameViewIn(views, 'b', 'Driveway')
    expect(next.map((v) => v.name)).toEqual(['View a', 'Driveway', 'View c'])
    expect(next[0]).toBe(views[0])
  })

  it('duplicates right after the original, as a deep copy under a new id', () => {
    const next = duplicateViewIn(views, 'a', 'a2')
    expect(ids(next)).toEqual(['a', 'a2', 'b', 'c'])
    expect(next[1]?.name).toBe('View a copy')
    expect(next[1]?.cells).toEqual(views[0]?.cells)
    expect(next[1]?.cells).not.toBe(views[0]?.cells)
    expect(next[1]?.cells[0]).not.toBe(views[0]?.cells[0])
    expect(ids(duplicateViewIn(views, 'nope', 'x'))).toEqual(['a', 'b', 'c'])
  })

  it('deletes one View', () => {
    expect(ids(deleteViewIn(views, 'b'))).toEqual(['a', 'c'])
  })

  it('reorders by index, and refuses an index out of range', () => {
    expect(ids(reorderViewsIn(views, 0, 2) ?? [])).toEqual(['b', 'c', 'a'])
    expect(ids(reorderViewsIn(views, 2, 0) ?? [])).toEqual(['c', 'a', 'b'])
    expect(ids(reorderViewsIn(views, 1, 1) ?? [])).toEqual(['a', 'b', 'c'])
    expect(reorderViewsIn(views, 0, 3)).toBeNull()
    expect(reorderViewsIn(views, -1, 0)).toBeNull()
    expect(reorderViewsIn(views, 0.5, 1)).toBeNull()
  })

  it('picks the next View as the neighbour, or the previous one for the last', () => {
    expect(neighbourAfterDelete(views, 'a')).toBe('b')
    expect(neighbourAfterDelete(views, 'b')).toBe('c')
    expect(neighbourAfterDelete(views, 'c')).toBe('b')
    expect(neighbourAfterDelete([view('only')], 'only')).toBeNull()
    expect(neighbourAfterDelete(views, 'nope')).toBeNull()
  })

  it('moves the active View only when the effective active one is deleted', () => {
    expect(activeAfterDelete(views, 'b', 'b')).toBe('c')
    expect(activeAfterDelete(views, 'b', 'a')).toBe('b')
    // A dangling id means the user is looking at the first View: deleting it moves them on...
    expect(activeAfterDelete(views, 'gone', 'a')).toBe('b')
    // ...and deleting another one heals the dangling id to what they were looking at.
    expect(activeAfterDelete(views, 'gone', 'c')).toBe('a')
    expect(activeAfterDelete([view('only')], 'only', 'only')).toBeNull()
  })

  it('creates a valid empty View from any preset', () => {
    for (const preset of LAYOUT_PRESETS) {
      const created = createViewFromPreset('id-1', 'New', preset)
      expect(created).toMatchObject({ cols: preset.cols, rows: preset.rows, gap: 0 })
      expect(SetViewsInputSchema.safeParse({ views: [created], lastViewId: 'id-1' }).success).toBe(
        true,
      )
    }
  })
})

describe('starter View (the Live screen’s "Create a View")', () => {
  const cameraIds = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `c${String(i + 1)}`)

  it('picks the smallest uniform preset with a slot per camera', () => {
    const sizes = [0, 1, 2, 4, 5, 6, 7, 9, 10, 12, 13, 16].map((n) => {
      const preset = starterPreset(n)
      return [n, `${String(preset.cols)}x${String(preset.rows)}`]
    })
    expect(sizes).toEqual([
      [0, '1x1'],
      [1, '1x1'],
      [2, '2x2'],
      [4, '2x2'],
      [5, '3x2'],
      [6, '3x2'],
      [7, '3x3'],
      [9, '3x3'],
      [10, '4x3'],
      [12, '4x3'],
      [13, '4x4'],
      [16, '4x4'],
    ])
  })

  it('caps at 4×4 for more cameras than any preset holds, and never picks a spanned preset', () => {
    expect(starterPreset(40)).toMatchObject({ cols: 4, rows: 4 })
    for (let n = 0; n <= 20; n += 1) {
      expect(starterPreset(n).cells.every((c) => c.colSpan === 1 && c.rowSpan === 1)).toBe(true)
    }
  })

  it('createViewFromPreset fills the cells in reading order and stays a valid View', () => {
    const ids5 = cameraIds(5)
    const created = createViewFromPreset('id-1', STARTER_VIEW_NAME, starterPreset(5), ids5)
    expect(created).toMatchObject({ name: 'View 1', cols: 3, rows: 2 })
    expect(created.cells.map((c) => [c.row, c.col, c.cameraIds])).toEqual([
      [0, 0, ['c1']],
      [0, 1, ['c2']],
      [0, 2, ['c3']],
      [1, 0, ['c4']],
      [1, 1, ['c5']],
      [1, 2, []],
    ])
    expect(SetViewsInputSchema.safeParse({ views: [created], lastViewId: 'id-1' }).success).toBe(
      true,
    )
  })

  it('a starter View for 20 cameras shows the first 16', () => {
    const created = createViewFromPreset(
      'id-1',
      STARTER_VIEW_NAME,
      starterPreset(20),
      cameraIds(20),
    )
    expect(created.cells.flatMap((c) => c.cameraIds)).toEqual(cameraIds(16))
  })
})

// -------------------------------------------------------------------------------------------------
// Selectors and actions against a main-like fake bridge

interface FakeMain {
  views: View[]
  lastViewId: string | null
  setViews: ReturnType<typeof vi.fn<ViewProtectApi['setViews']>>
  setLastView: ReturnType<typeof vi.fn<ViewProtectApi['setLastView']>>
}

/** A bridge that does what main's handlers do: validate, store, answer with the whole state. */
function installFakeMain(initial: View[], lastViewId: string | null): FakeMain {
  const main: FakeMain = {
    views: initial,
    lastViewId,
    setViews: vi.fn<ViewProtectApi['setViews']>(),
    setLastView: vi.fn<ViewProtectApi['setLastView']>(),
  }
  main.setViews.mockImplementation((input): Promise<IpcResult<AppState>> => {
    const parsed = SetViewsInputSchema.safeParse(input)
    if (!parsed.success) {
      return Promise.resolve(ipcFail('invalid-request', parsed.error.issues[0]?.message ?? ''))
    }
    main.views = parsed.data.views
    main.lastViewId = parsed.data.lastViewId
    return Promise.resolve({ ok: true, value: appState(main.views, main.lastViewId) })
  })
  main.setLastView.mockImplementation((input): Promise<IpcResult<AppState>> => {
    main.lastViewId = input.viewId
    return Promise.resolve({ ok: true, value: appState(main.views, main.lastViewId) })
  })
  const api = {
    setViews: main.setViews,
    setLastView: main.setLastView,
  } as unknown as ViewProtectApi
  Object.defineProperty(globalThis, 'window', {
    value: { viewProtect: api },
    configurable: true,
    writable: true,
  })
  useAppStore.setState({ phase: 'ready', settings: appState(initial, lastViewId).settings })
  return main
}

const initialStore = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(initialStore, true)
})

const storeViews = (): readonly View[] => selectViews(useAppStore.getState())
const storeActive = (): View | null => selectActiveView(useAppStore.getState())

describe('selectors', () => {
  it('are empty / null before the first load', () => {
    expect(storeViews()).toEqual([])
    expect(storeViews()).toBe(storeViews())
    expect(storeActive()).toBeNull()
  })

  it('read the app store, with the VIEW-6 fallback for a dangling lastViewId', () => {
    installFakeMain([view('a'), view('b')], 'gone')
    expect(ids(storeViews())).toEqual(['a', 'b'])
    expect(storeActive()?.id).toBe('a')
  })
})

describe('viewsActions', () => {
  it('refuses with not-ready before the first load, and sends nothing', async () => {
    const result = await viewsActions.renameView('a', 'x')
    expect(result).toMatchObject({ ok: false, error: { kind: 'not-ready', retryable: true } })
  })

  it('createView appends a View from the preset and makes it active', async () => {
    const main = installFakeMain([view('a')], 'a')
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
    const preset = LAYOUT_PRESETS.find((p) => p.id === '1+5')
    const result = await viewsActions.createView('  Front  ', preset)
    expect(result.ok).toBe(true)
    expect(main.setViews).toHaveBeenCalledTimes(1)
    expect(ids(storeViews())).toEqual(['a', '00000000-0000-4000-8000-000000000001'])
    expect(storeActive()).toMatchObject({ name: 'Front', cols: 3, rows: 3 })
    expect(storeActive()?.cells).toHaveLength(6)
  })

  it('createView fills the cells from cameraIds when given', async () => {
    installFakeMain([], null)
    await viewsActions.createView(STARTER_VIEW_NAME, starterPreset(3), ['x', 'y', 'z'])
    expect(storeActive()?.cells.map((c) => c.cameraIds)).toEqual([['x'], ['y'], ['z'], []])
    expect(useAppStore.getState().settings?.lastViewId).toBe(storeActive()?.id)
  })

  it('createView defaults to the 2×2 preset', async () => {
    installFakeMain([], null)
    await viewsActions.createView('First')
    expect(storeActive()).toMatchObject({ name: 'First', cols: 2, rows: 2 })
  })

  it('folds what main answered, not what it sent: a refusal leaves the store unchanged', async () => {
    const main = installFakeMain([view('a')], 'a')
    // An empty name fails ViewSchema at the boundary.
    const result = await viewsActions.renameView('a', '   ')
    expect(result.ok).toBe(false)
    expect(main.setViews).toHaveBeenCalledTimes(1)
    expect(storeViews()[0]?.name).toBe('View a')
  })

  it('renameView / reorderViews keep the active View', async () => {
    installFakeMain([view('a'), view('b'), view('c')], 'b')
    await viewsActions.renameView('b', 'Garage')
    await viewsActions.reorderViews(1, 0)
    expect(ids(storeViews())).toEqual(['b', 'a', 'c'])
    expect(storeActive()).toMatchObject({ id: 'b', name: 'Garage' })
  })

  it('reorderViews refuses an index out of range without a round trip', async () => {
    const main = installFakeMain([view('a')], 'a')
    const result = await viewsActions.reorderViews(0, 1)
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
    expect(main.setViews).not.toHaveBeenCalled()
  })

  it('duplicateView inserts the copy after the original and switches to it', async () => {
    installFakeMain([view('a'), view('b')], 'a')
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    await viewsActions.duplicateView('a')
    expect(ids(storeViews())).toEqual(['a', '00000000-0000-4000-8000-000000000002', 'b'])
    expect(storeActive()?.name).toBe('View a copy')
  })

  it('deleteView of the active View moves to its neighbour', async () => {
    installFakeMain([view('a'), view('b'), view('c')], 'b')
    await viewsActions.deleteView('b')
    expect(ids(storeViews())).toEqual(['a', 'c'])
    expect(useAppStore.getState().settings?.lastViewId).toBe('c')
    await viewsActions.deleteView('c')
    expect(useAppStore.getState().settings?.lastViewId).toBe('a')
    await viewsActions.deleteView('a')
    expect(useAppStore.getState().settings?.lastViewId).toBeNull()
    expect(storeActive()).toBeNull()
  })

  it('deleteView of another View keeps the active one', async () => {
    installFakeMain([view('a'), view('b'), view('c')], 'c')
    await viewsActions.deleteView('a')
    expect(storeActive()?.id).toBe('c')
  })

  it('answers not-found for an unknown id, without a round trip', async () => {
    const main = installFakeMain([view('a')], 'a')
    for (const result of [
      await viewsActions.renameView('nope', 'x'),
      await viewsActions.duplicateView('nope'),
      await viewsActions.deleteView('nope'),
      await viewsActions.updateView('nope', (v) => v),
      await viewsActions.setActiveView('nope'),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    }
    expect(main.setViews).not.toHaveBeenCalled()
    expect(main.setLastView).not.toHaveBeenCalled()
  })

  it('updateView applies a layout operation, and keeps the id', async () => {
    installFakeMain([view('a', 3, 3)], 'a')
    const result = await viewsActions.updateView('a', (v) => ({
      ...v,
      id: 'sneaky',
      gap: 4,
      cells: v.cells.map((c, i) => (i === 0 ? { ...c, cameraIds: ['camA'] } : c)),
    }))
    expect(result.ok).toBe(true)
    expect(storeActive()).toMatchObject({ id: 'a', gap: 4 })

    await viewsActions.updateView('a', (v) =>
      mergeCells(v, { col: 0, row: 0, colSpan: 2, rowSpan: 2 }),
    )
    expect(storeActive()?.cells[0]).toMatchObject({ colSpan: 2, rowSpan: 2, cameraIds: ['camA'] })
  })

  it('updateView passes a refused layout operation back as bad-request, sending nothing', async () => {
    const main = installFakeMain([view('a', 3, 3)], 'a')
    await viewsActions.updateView('a', (v) =>
      mergeCells(v, { col: 0, row: 0, colSpan: 2, rowSpan: 2 }),
    )
    main.setViews.mockClear()
    const result = await viewsActions.updateView('a', (v) =>
      mergeCells(v, { col: 1, row: 0, colSpan: 2, rowSpan: 1 }),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
    if (!result.ok) expect(result.error.message).toContain('only partly inside')
    expect(main.setViews).not.toHaveBeenCalled()
  })

  it('updateView cannot save a View that breaks the tiling rule', async () => {
    installFakeMain([view('a')], 'a')
    const result = await viewsActions.updateView('a', (v) => ({
      ...v,
      cells: [...v.cells, CellSchema.parse({ col: 0, row: 0 })],
    }))
    expect(result.ok).toBe(false)
    expect(storeActive()?.cells).toHaveLength(4)
  })

  it('updateView hands the updater a copy, so editing it in place changes nothing until main accepts', async () => {
    installFakeMain([view('a')], 'a')
    const before = structuredClone(storeActive())
    const result = await viewsActions.updateView('a', (v) => {
      // In place, and into a layout main refuses (an overlapping cell).
      v.name = 'Mutated'
      v.cells.push(CellSchema.parse({ col: 0, row: 0 }))
      return v
    })
    expect(result.ok).toBe(false)
    expect(storeActive()).toEqual(before)
  })

  it('setActiveView sends only the id', async () => {
    const main = installFakeMain([view('a'), view('b')], 'a')
    const result = await viewsActions.setActiveView('b')
    expect(result.ok).toBe(true)
    expect(main.setLastView).toHaveBeenCalledWith({ viewId: 'b' })
    expect(main.setViews).not.toHaveBeenCalled()
    expect(storeActive()?.id).toBe('b')
  })

  it('runs mutations one at a time, each on the result of the one before', async () => {
    const main = installFakeMain([view('a'), view('b')], 'a')
    // Fired without awaiting in between, as two quick clicks would be.
    const rename = viewsActions.renameView('a', 'Renamed')
    const reorder = viewsActions.reorderViews(0, 1)
    const remove = viewsActions.deleteView('b')
    const switchTo = viewsActions.setActiveView('b')
    const results = await Promise.all([rename, reorder, remove, switchTo])
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false])
    // Without the queue the reorder would have saved the old name back over the rename.
    expect(storeViews().map((v) => v.name)).toEqual(['Renamed'])
    expect(main.views.map((v) => v.name)).toEqual(['Renamed'])
  })
})
