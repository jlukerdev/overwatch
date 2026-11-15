// The renderer's View store (P3.1; VIEW-3, VIEW-4, VIEW-6): what the View switcher (P3.2) and the
// View editor (P3.3) read Views through and change them with.
//
// **It holds no Views of its own.** The one copy is `settings.views` / `settings.lastViewId` in the
// app store (appStore.ts), which is folded back from main's `AppState` after every mutation (rule 3
// in src/shared/ipc.ts). A second copy here would be a second truth to drift from the first — after
// a failed save, say, it would show a View main never stored. So this module is three things layered
// on that one copy:
//
//  1. **Pure list operations** (rename, duplicate, delete, reorder, the active-View fallback and the
//     neighbour a deletion moves to). Exported, so they are tested in the node environment without
//     a store or a window.
//  2. **Selectors and hooks** over the app store: the View list and the active View.
//  3. **Actions** that compute the next list with (1), send it with `setViews` / `setLastView`, and
//     let the app store fold the answer in. Each hands back the `IpcResult`, as the app store's own
//     actions do, so the control the user just used can show a failure next to itself.
//
// Mutations are **queued**, one at a time, and each computes its list from the store as it is when
// its turn comes, not when it was called. Two quick edits (a rename, then a drag) would otherwise both
// start from the same list, and the second save would silently undo the first.
import { type AppState, type IpcResult, ipcFail } from '@shared/ipc'
import { ViewSchema, type View } from '@shared/models'
import {
  DEFAULT_LAYOUT_PRESET,
  LAYOUT_PRESETS,
  assignCameras,
  presetCells,
  type LayoutPreset,
  type LayoutResult,
} from '@shared/viewLayout'
import { useAppStore, type AppStoreState } from './appStore'

// -------------------------------------------------------------------------------------------------
// Pure list operations

/**
 * VIEW-6: the View to show. The one `lastViewId` names, or — when it names nothing (the View was
 * deleted, the file was hand-edited) or is `null` — the first View. `null` only when there are no
 * Views at all.
 */
export function resolveActiveView(views: readonly View[], lastViewId: string | null): View | null {
  return views.find((view) => view.id === lastViewId) ?? views[0] ?? null
}

/**
 * Whether selecting View `id` has to be sent to main (`setLastView`). Compared with the **stored**
 * `lastViewId`, not the resolved active View: with a dangling or `null` id the first View is shown
 * by fallback (VIEW-6), and choosing it must still be stored, or the app would not reopen on it
 * once another View is added in front of it.
 */
export function selectionNeedsStore(lastViewId: string | null, id: string): boolean {
  return lastViewId !== id
}

/**
 * A new View laid out as `preset`, every other field at its schema default — parsed rather than
 * spelled out, so the defaults have one home (`ViewSchema`). Every cell is empty unless `cameraIds`
 * is given, in which case they fill the cells in order (see {@link assignCameras}).
 */
export function createViewFromPreset(
  id: string,
  name: string,
  preset: LayoutPreset,
  cameraIds: readonly string[] = [],
): View {
  const view = ViewSchema.parse({
    id,
    name,
    cols: preset.cols,
    rows: preset.rows,
    cells: presetCells(preset),
  })
  // Assigned after the parse, so the cells are already in canonical order (row, then column) and
  // "in order" means reading order whatever order the preset listed them in. Parsed again so the
  // result is still a View the schema vouches for.
  return ViewSchema.parse({ ...view, cells: assignCameras(view.cells, cameraIds) })
}

/** Presets whose cells are all 1×1, smallest first (by slot count, then list order). */
const UNIFORM_PRESETS: readonly LayoutPreset[] = LAYOUT_PRESETS.filter((preset) =>
  preset.cells.every((cell) => cell.colSpan === 1 && cell.rowSpan === 1),
).toSorted((a, b) => a.cols * a.rows - b.cols * b.rows)

/** The name the "Create a View" button gives the first View. */
export const STARTER_VIEW_NAME = 'View 1'

/**
 * The layout for a first View showing `cameraCount` cameras: the smallest uniform preset with a slot
 * for each of them, or the largest one (4×4) when there are more cameras than any preset has slots.
 * Spanned presets are left out — a starter View has no camera that matters more than the others.
 */
export function starterPreset(cameraCount: number): LayoutPreset {
  const fits = UNIFORM_PRESETS.find((preset) => preset.cols * preset.rows >= cameraCount)
  // `LAYOUT_PRESETS` always has uniform presets (the unit test checks it); the default is the belt.
  return fits ?? UNIFORM_PRESETS[UNIFORM_PRESETS.length - 1] ?? DEFAULT_LAYOUT_PRESET
}

/** The list with View `id` renamed. Unchanged when no View has that id. */
export function renameViewIn(views: readonly View[], id: string, name: string): View[] {
  return views.map((view) => (view.id === id ? { ...view, name } : view))
}

/**
 * The list with a copy of View `id` inserted **right after** it, under `newId` and `"<name> copy"`.
 * A deep copy, so editing the duplicate's cells can never reach the original's. Unchanged when no
 * View has that id.
 */
export function duplicateViewIn(views: readonly View[], id: string, newId: string): View[] {
  const index = views.findIndex((view) => view.id === id)
  const original = views[index]
  if (original === undefined) return [...views]
  const copy: View = { ...structuredClone(original), id: newId, name: `${original.name} copy` }
  return [...views.slice(0, index + 1), copy, ...views.slice(index + 1)]
}

/** The list without View `id`. */
export function deleteViewIn(views: readonly View[], id: string): View[] {
  return views.filter((view) => view.id !== id)
}

/**
 * VIEW-3: the list with the View at `from` moved to `to` (both indexes into the list as it is now),
 * or `null` when either index is out of range. `to` is where the View ends up, so moving index 0 to
 * the last index puts it last.
 */
export function reorderViewsIn(views: readonly View[], from: number, to: number): View[] | null {
  const inRange = (n: number): boolean => Number.isInteger(n) && n >= 0 && n < views.length
  if (!inRange(from) || !inRange(to)) return null
  const next = [...views]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return null
  next.splice(to, 0, moved)
  return next
}

/**
 * Where the active View goes when View `id` is deleted (VIEW-4/6): the View after it, or the one
 * before it when it was last, or `null` when it was the only one. The neighbour rather than the
 * first View, so deleting from the middle of a long list leaves the user where they were.
 */
export function neighbourAfterDelete(views: readonly View[], id: string): string | null {
  const index = views.findIndex((view) => view.id === id)
  if (index === -1) return null
  return (views[index + 1] ?? views[index - 1] ?? null)?.id ?? null
}

/**
 * The `lastViewId` to store once View `id` is deleted. The *effective* active View is what matters
 * (`resolveActiveView`), not the raw id: with a dangling `lastViewId` the user is looking at the
 * first View, so deleting that one has to move them too — and deleting any other View writes the
 * effective id back, which heals the dangling one as a side effect.
 */
export function activeAfterDelete(
  views: readonly View[],
  lastViewId: string | null,
  id: string,
): string | null {
  const active = resolveActiveView(views, lastViewId)
  if (active === null) return null
  return active.id === id ? neighbourAfterDelete(views, id) : active.id
}

// -------------------------------------------------------------------------------------------------
// Selectors and hooks

/** Stable empty list, so a selector cannot hand React a new `[]` on every render. */
const NO_VIEWS: readonly View[] = []

/** Every View, in the user's order. Empty until the first load. */
export function selectViews(state: Pick<AppStoreState, 'settings'>): readonly View[] {
  return state.settings?.views ?? NO_VIEWS
}

/** The View to show, with the VIEW-6 fallback. `null` before the first load or with no Views. */
export function selectActiveView(state: Pick<AppStoreState, 'settings'>): View | null {
  const settings = state.settings
  return settings === null ? null : resolveActiveView(settings.views, settings.lastViewId)
}

/** The stored `lastViewId`, as is (no fallback). `null` before the first load. */
export function selectLastViewId(state: Pick<AppStoreState, 'settings'>): string | null {
  return state.settings?.lastViewId ?? null
}

/** React hook: the stored `lastViewId` (see {@link selectLastViewId}). */
export function useLastViewId(): string | null {
  return useAppStore(selectLastViewId)
}

/** React hook: every View. Re-renders only when the list itself changes. */
export function useViews(): readonly View[] {
  return useAppStore(selectViews)
}

/** React hook: the active View (VIEW-6 fallback applied). */
export function useActiveView(): View | null {
  return useAppStore(selectActiveView)
}

// -------------------------------------------------------------------------------------------------
// Actions

/** What a View action answers with: the new `AppState`, or why nothing changed. */
export type ViewResult = Promise<IpcResult<AppState>>

/** What `updateView`'s updater may return: the new View, or a layout operation's result as is. */
export type ViewUpdate = View | LayoutResult<View>

const NOT_LOADED = 'Views are not loaded yet.'

let queue: Promise<unknown> = Promise.resolve()

/** Runs `task` after every mutation queued before it (see the header). Never rejects the chain. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** The persisted pair as it is right now, or `null` before the first load. */
function current(): { views: View[]; lastViewId: string | null } | null {
  const settings = useAppStore.getState().settings
  return settings === null ? null : { views: settings.views, lastViewId: settings.lastViewId }
}

function notFound(id: string): IpcResult<never> {
  return ipcFail('not-found', `There is no View with id ${JSON.stringify(id)}.`)
}

/**
 * One queued mutation: read the current pair, let `plan` compute the next one (or refuse), send
 * it. `plan` runs inside the queue, so it always sees the result of the mutation before it.
 */
function mutate(
  plan: (now: {
    views: View[]
    lastViewId: string | null
  }) => { views: View[]; lastViewId: string | null } | IpcResult<never>,
): ViewResult {
  return enqueue(async () => {
    const now = current()
    if (now === null) return ipcFail('not-ready', NOT_LOADED, { retryable: true })
    const next = plan(now)
    if ('ok' in next) return next
    return useAppStore.getState().setViews(next)
  })
}

export const viewsActions = {
  /**
   * VIEW-3: a new View laid out as `preset` (2×2 by default), appended to the list and made active —
   * creating a View is always followed by looking at it, or editing it. Its cells are empty, or
   * filled one camera each from `cameraIds` in order (`assignCameras`); the Live screen's "Create a
   * View" passes the inventory in the camera list's order to make a first View that shows something.
   */
  createView(name: string, preset?: LayoutPreset, cameraIds?: readonly string[]): ViewResult {
    return mutate(({ views }) => {
      const view = createViewFromPreset(
        crypto.randomUUID(),
        name.trim(),
        preset ?? DEFAULT_LAYOUT_PRESET,
        cameraIds,
      )
      return { views: [...views, view], lastViewId: view.id }
    })
  },

  /** VIEW-3. The name is trimmed; an empty one is refused at the IPC boundary (`ViewSchema`). */
  renameView(id: string, name: string): ViewResult {
    return mutate(({ views, lastViewId }) => {
      if (!views.some((view) => view.id === id)) return notFound(id)
      return { views: renameViewIn(views, id, name.trim()), lastViewId }
    })
  },

  /** VIEW-3: a copy right after the original, made active so the user is looking at the copy. */
  duplicateView(id: string): ViewResult {
    return mutate(({ views }) => {
      if (!views.some((view) => view.id === id)) return notFound(id)
      const newId = crypto.randomUUID()
      return { views: duplicateViewIn(views, id, newId), lastViewId: newId }
    })
  },

  /** VIEW-3. Deleting the active View moves to its neighbour (`activeAfterDelete`). */
  deleteView(id: string): ViewResult {
    return mutate(({ views, lastViewId }) => {
      if (!views.some((view) => view.id === id)) return notFound(id)
      return {
        views: deleteViewIn(views, id),
        lastViewId: activeAfterDelete(views, lastViewId, id),
      }
    })
  },

  /** VIEW-3: move the View at index `from` to index `to`. The active View does not change. */
  reorderViews(from: number, to: number): ViewResult {
    return mutate(({ views, lastViewId }) => {
      const next = reorderViewsIn(views, from, to)
      if (next === null) {
        return ipcFail(
          'bad-request',
          `Cannot move View ${String(from)} to ${String(to)}: there are ${String(views.length)}.`,
        )
      }
      return { views: next, lastViewId }
    })
  },

  /**
   * Any change to one View: a layout operation, a cell edit, the fit, the gap. `updater` gets a
   * copy of the View as stored now and returns the new one — or a `LayoutResult` straight from ./viewLayout, so
   * `updateView(id, (v) => mergeCells(v, rect))` works and a refused merge comes back as a
   * `bad-request` carrying the operation's own reason. The id cannot be changed through here.
   */
  updateView(id: string, updater: (view: View) => ViewUpdate): ViewResult {
    return mutate(({ views, lastViewId }) => {
      const existing = views.find((view) => view.id === id)
      if (existing === undefined) return notFound(id)
      // A copy: an updater that edits its argument in place must not change the app store's View
      // before main has accepted the result (rule 3 in src/shared/ipc.ts).
      const update = updater(structuredClone(existing))
      let next: View
      if ('ok' in update) {
        if (!update.ok) return ipcFail('bad-request', update.reason)
        next = update.view
      } else {
        next = update
      }
      const updated: View = { ...next, id }
      return { views: views.map((view) => (view === existing ? updated : view)), lastViewId }
    })
  },

  /**
   * VIEW-4/6: switch Views. Sends only the id (`setLastView`), not the list. Queued like the rest,
   * so a switch made right after a delete is checked against the list without the deleted View.
   */
  setActiveView(id: string): ViewResult {
    return enqueue(async () => {
      const now = current()
      if (now === null) return ipcFail('not-ready', NOT_LOADED, { retryable: true })
      if (!now.views.some((view) => view.id === id)) return notFound(id)
      return useAppStore.getState().setLastView(id)
    })
  },
} as const
