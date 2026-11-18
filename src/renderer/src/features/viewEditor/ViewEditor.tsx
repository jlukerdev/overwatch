// The View editor (P3.3; VIEW-1, VIEW-2, VIEW-3, VIEW-5, VIEW-7; P3.7, QUAL-2/3/5): create, rename,
// duplicate, delete and reorder Views, change a View's layout, aspect, gap, fit and grid / fill
// quality, assign cameras to its cells by drag-and-drop or a picker, and set a cell's quality. The Live screen shows it in place of the switcher and grid
// while editing (`LiveScreen`), so the `1`–`9` shortcuts are off while it is up.
//
// **Editing model.** The editor edits a *draft* copy of one View in React state; every change to
// layout, cells or settings is a pure function on the draft (./editorModel, @shared/viewLayout).
//  - **Save** validates the draft (`validateDraft`: name trimmed, `ViewSchema`) and sends it with
//    `viewsActions.updateView`; a refusal is shown inline (role=alert). **Discard** resets the draft
//    to the stored View.
//  - If the stored View changes while the draft is clean, the draft follows it (`syncDraft`).
//  - Leaving the View (another View in the list, New View, Close) with unsaved changes asks first,
//    in the app's own dialog (ui/ConfirmDialog; "Discard changes" / "Keep editing"). The dialog is
//    asynchronous, so the answer is acted on only if this editor is still the one on screen
//    (`alive`: it is keyed by View, so a View that went away meanwhile drops the answer).
//    So does leaving the Live screen: the draft reports its dirty flag to `unsavedGuard`, which the
//    app's nav and a `beforeunload` listener consult (App). Which View is open is App's state
//    (`viewId` / `onOpen`), so coming back to Live reopens the editor on it.
//  - List operations — new, duplicate, delete, reorder — act on the stored Views at once through
//    `viewsActions`. Duplicate is disabled while the draft is dirty (it would copy the stored View,
//    not what is on screen); Delete asks for confirmation (the same dialog), and moves the editor
//    to the neighbour (`neighbourAfterDelete`) as it sends the delete, so it never lands on the
//    first View meanwhile.
//
// Layout (P3.8: each action sits by what it acts on; UX polish 2026-11-17: the canvas is the hero).
// On the left, the list of Views (reorder on each row) with a footer pinned under it: New View, and
// Duplicate / Delete for the View being edited. In the middle, only what the canvas needs around
// it: a compact header (the name, the Grid controls — Layout, Columns, Rows — and Close at the far
// right), the selection toolbar (Merge, Split, Clear cameras at the left, then the count of the
// selected cells; a button that cannot act says why in its tooltip, `toolbarTitles`), the canvas,
// and the save bar under it — the draft's state ("Unsaved changes" / "All changes saved", and the
// last error beside it) with Discard and Save. The save bar is always rendered so the canvas never
// jumps. It is also where every failure is reported — a refused Save, a merge or split, and the
// list footer's New / Duplicate / Delete and the reorder buttons — next to the status, on one line
// (full text in its tooltip).
// On the right, a tabbed panel over the camera palette. **View** holds the View's Display and
// Quality settings; **Cell** holds the cell inspector. Both panels stay mounted (the inactive one
// `hidden`), so a change of tab loses no local state. Picking a cell when nothing was selected
// brings the Cell tab forward (`tabAfterSelect`, ./editorTabs); after that the tab is the user's.
// The palette stays under the tabs in both, since it is the drag source, and scrolls on its own.
// Each cell with a camera shows its head camera's snapshot behind the name (P5.2, VIEW-3), read
// from and fetched into the cache the Cameras tab shares (state/thumbnailsStore); which image and
// what to fetch are ./editorThumbnails.
// So does each palette entry, from the same cache, without fetching anything for it.
// The subcomponents (EditorCanvas, EditorSettings, EditorTabList, CellInspector, CameraPalette)
// only turn events into calls; the decisions are in ./editorModel, ./editorThumbnails,
// ./editorTabs and ./viewEditorHelpers, pure and tested.
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { AppState, Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import { resolveGridQuality } from '@shared/quality'
import { mergeCells, splitCell } from '@shared/viewLayout'
import { useAppStore } from '../../state/appStore'
import {
  forgetFailed,
  requestCameras,
  requestPackages,
  useThumbnails,
} from '../../state/thumbnailsStore'
import { setUnsaved } from '../../state/unsavedGuard'
import {
  neighbourAfterDelete,
  useViews,
  viewsActions,
  type ViewResult,
} from '../../state/viewsStore'
import { confirmDialog } from '../../ui/ConfirmDialog'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  EraserIcon,
  GridIcon,
  MergeIcon,
  PlusIcon,
  SplitIcon,
  TrashIcon,
  UndoIcon,
  XIcon,
} from '../../ui/icons'
import { setCellQuality } from '../quality/qualityChoice'
import { CameraPalette } from './CameraPalette'
import { CellInspector } from './CellInspector'
import { isTextEntryTarget, keyEventTarget } from '../viewSwitcher/viewShortcut'
import { EditorCanvas } from './EditorCanvas'
import { editorPanelId, EditorTabList, editorTabId } from './EditorTabList'
import { tabAfterSelect, type EditorTab } from './editorTabs'
import {
  cellSnapshot,
  editorRetryPlan,
  editorSnapshotPlan,
  inUseRefs,
  paletteSnapshots,
} from './editorThumbnails'
import {
  addCellCamera,
  cameraChoices,
  dropCameraOnCell,
  isDraftDirty,
  mergeDropsCameras,
  moveCellCamera,
  removeCellCamera,
  selectionActions,
  selectionRect,
  setCellCameras,
  setCellMotionHold,
  setCellMotionSwitch,
  setCellMotionTriggers,
  setCellRotation,
  setCellSmartDetectTypes,
  swapCellContents,
  validateDraft,
  type Slot,
} from './editorModel'
import { EditorGridSettings, EditorViewSettings } from './EditorSettings'
import {
  layoutLossNote,
  mergeLossNote,
  nextViewName,
  startDraft,
  syncDraft,
  toolbarTitles,
  type DraftState,
} from './viewEditorHelpers'
import './viewEditor.css'

export interface ViewEditorProps {
  /** The View being edited. If it no longer exists, the first View is shown instead. */
  readonly viewId: string
  /** Switch the editor to another View (the id is kept by App, see the header). */
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
}

export function ViewEditor({ viewId, onOpen, onClose }: ViewEditorProps): JSX.Element {
  const views = useViews()
  const cameras = useAppStore((s) => s.cameras)
  // A failed Delete, shown by the editor it moved back to (`initialError`).
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A View deleted elsewhere falls back to the first one rather than leaving the editor on nothing.
  const saved = views.find((view) => view.id === viewId) ?? views[0] ?? null

  const open = (id: string): void => {
    setDeleteError(null)
    onOpen(id)
  }

  /**
   * Deletes `id` (already confirmed). The editor moves to the neighbour first, so the list never
   * briefly falls back to the first View; a refusal moves it back and shows why. Nothing happens
   * after the answer if the editor has gone meanwhile (closed, or the user left Live).
   */
  const remove = (id: string): void => {
    open(neighbourAfterDelete(views, id) ?? id)
    void viewsActions.deleteView(id).then((result) => {
      if (!mounted.current || result.ok) return
      onOpen(id)
      setDeleteError(result.error.message)
    })
  }

  if (saved === null) {
    return <NoViewsToEdit views={views} onOpen={open} onClose={onClose} />
  }
  // Keyed by View: switching Views starts a fresh draft, selection and messages.
  return (
    <DraftEditor
      key={saved.id}
      saved={saved}
      views={views}
      cameras={cameras}
      initialError={deleteError}
      onOpen={open}
      onDelete={remove}
      onClose={onClose}
    />
  )
}

/** The editor with every View deleted: only New View and Close make sense. */
function NoViewsToEdit({
  views,
  onOpen,
  onClose,
}: {
  readonly views: readonly View[]
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  // Guards against a double click making two Views; on success this unmounts (there is a View).
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const create = (): void => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    void viewsActions.createView(nextViewName(views)).then((result) => {
      if (!result.ok) {
        busy.current = false
        setPending(false)
        setError(result.error.message)
        return
      }
      const id = result.value.settings.lastViewId
      if (id !== null) onOpen(id)
    })
  }
  return (
    <section className="viewEditor" aria-label="View editor">
      <div className="emptyState">
        <span className="emptyState__icon" aria-hidden="true">
          <GridIcon />
        </span>
        <h3 className="emptyState__title">No Views</h3>
        <p className="emptyState__hint">
          Every View has been deleted. Make a new one to start again, or close the editor.
        </p>
        <div className="emptyState__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={create}
          >
            <PlusIcon />
            New View
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            <XIcon />
            Close
          </button>
        </div>
        {error === null ? null : (
          <p className="status status--error" role="alert">
            <AlertIcon />
            <span>{error}</span>
          </p>
        )}
      </div>
    </section>
  )
}

interface DraftEditorProps {
  /** The stored View being edited. */
  readonly saved: View
  readonly views: readonly View[]
  readonly cameras: readonly Camera[]
  /** An error to open with (a failed Delete of this View). */
  readonly initialError: string | null
  /** Switch the editor to another View (no questions asked; the caller already asked). */
  readonly onOpen: (id: string) => void
  /** Delete this View (already confirmed); the caller moves the editor and reports a refusal. */
  readonly onDelete: (id: string) => void
  readonly onClose: () => void
}

/** The anchor and the current corner of a selection, both slots; the rect is `selectionRect`. */
interface Selection {
  readonly anchor: Slot
  readonly focus: Slot
}

function DraftEditor({
  saved,
  views,
  cameras,
  initialError,
  onOpen,
  onDelete,
  onClose,
}: DraftEditorProps): JSX.Element {
  const nameId = useId()
  const panelId = useId()
  // Which side panel tab is open (./editorTabs). A fresh editor (another View) starts on View.
  const [tab, setTab] = useState<EditorTab>('view')
  // Whether this editor — keyed by View — is still on screen, for answers that arrive later (the
  // confirm dialog's): the View may have been deleted, or the editor closed, while it was open.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [state, setState] = useState<DraftState>(() => startDraft(saved))
  const [selection, setSelection] = useState<Selection | null>(null)
  // `Esc` clears the selection, so the next pick is a first pick again and brings the Cell tab
  // forward (./editorTabs). Not while typing in a field, and not while a dialog is open: there
  // `Esc` is the field's or the dialog's.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return
      if (isTextEntryTarget(keyEventTarget(event.target))) return
      if (document.querySelector('dialog[open]') !== null) return
      setSelection(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  // A non-error remark about the last edit (cameras lost to a merge or a layout change).
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(initialError)
  // A failed Delete of the only View does not remount this editor (the key stays), so a new
  // `initialError` is picked up here too.
  const [seenInitialError, setSeenInitialError] = useState(initialError)
  if (initialError !== seenInitialError) {
    setSeenInitialError(initialError)
    if (initialError !== null) setError(initialError)
  }
  const [pending, setPending] = useState(false)
  // Bumped whenever the draft goes back to the stored View (Discard, or following it), so the
  // View tab's settings drop local state such as their custom-aspect mode.
  const [resetCount, setResetCount] = useState(0)

  // Follow the stored View while the draft is clean (header). Adjusting state during render, not
  // in an effect, so the stale draft is never painted.
  const synced = syncDraft(state, saved)
  if (synced !== state) {
    setState(synced)
    if (synced.draft === saved) setResetCount((n) => n + 1)
  }
  const draft = synced.draft
  const dirty = useMemo(() => isDraftDirty(saved, draft), [saved, draft])
  const choices = useMemo(() => cameraChoices(cameras), [cameras])
  // QUAL-1's defaults, for the inspector's "View default (X)". `undefined` before settings load.
  const streams = useAppStore((s) => s.settings?.streams)

  // VIEW-3 (P5.2): each cell's head camera's snapshot, from the cache the Cameras tab shares. The
  // plan is every head camera with no entry yet; it re-runs whenever the cells, the cameras or the
  // cache change (opening a View, a drop, a picker change, a swap, a layout change), and marking
  // the cameras in flight first is what keeps it from asking twice. Nothing on a timer, never
  // `highQuality`, never a stream (QUAL-8).
  // A camera a Cameras-tab load in flight covers is left to it. The editor asks for the snapshot
  // only, never the feed state. Opening the editor tries each failed / unavailable head camera once
  // more (`editorRetryPlan`, computed once per mount, so a draft change never retries).
  const thumbnailEntries = useThumbnails((s) => s.thumbnails.entries)
  const thumbnailLoad = useThumbnails((s) => s.thumbnails.load)
  const packageSnapshots = useThumbnails((s) => s.packages)
  const [retryPlan] = useState(() => {
    const { thumbnails, packages } = useThumbnails.getState()
    return editorRetryPlan(saved.cells, cameras, thumbnails.entries, packages)
  })
  useEffect(() => {
    forgetFailed(retryPlan)
  }, [retryPlan])
  const snapshotPlan = useMemo(
    () =>
      editorSnapshotPlan(draft.cells, cameras, thumbnailEntries, packageSnapshots, thumbnailLoad),
    [draft.cells, cameras, thumbnailEntries, packageSnapshots, thumbnailLoad],
  )
  useEffect(() => {
    requestCameras(snapshotPlan.cameraIds, { streams: false })
    requestPackages(snapshotPlan.packageIds)
  }, [snapshotPlan])
  // Palette entries heading a cell are marked with a green check (VIEW-3), live with every draft change.
  const inUse = useMemo(() => inUseRefs(draft.cells), [draft.cells])
  const cellSnapshots = useMemo(
    () =>
      draft.cells.map((cell) => cellSnapshot(cell, cameras, thumbnailEntries, packageSnapshots)),
    [draft.cells, cameras, thumbnailEntries, packageSnapshots],
  )
  // The palette's thumbnails: whatever the cache holds already, nothing fetched for them.
  const paletteImages = useMemo(
    () =>
      paletteSnapshots(
        choices.map((choice) => choice.ref),
        cameras,
        thumbnailEntries,
        packageSnapshots,
      ),
    [choices, cameras, thumbnailEntries, packageSnapshots],
  )

  // Tell the app shell, so leaving Live or closing the window asks first (unsavedGuard).
  useEffect(() => {
    setUnsaved(dirty)
  }, [dirty])
  useEffect(
    () => () => {
      setUnsaved(false)
    },
    [],
  )

  const rect =
    selection !== null && inGrid(draft, selection.anchor) && inGrid(draft, selection.focus)
      ? selectionRect(draft, selection.anchor, selection.focus)
      : null
  const actions = rect === null ? null : selectionActions(draft, rect)
  const selectedIndexes = actions?.cellIndexes ?? []
  const inspected =
    selectedIndexes.length === 1 ? (draft.cells[selectedIndexes[0] ?? -1] ?? null) : null
  const inspectedIndex = inspected === null ? -1 : (selectedIndexes[0] ?? -1)

  /** Replace the draft. Every edit clears the last note and error: they were about something else. */
  const edit = (next: View): void => {
    setState({ base: synced.base, draft: next })
    setNote(null)
    setError(null)
  }

  /** A layout change: the old selection no longer names the same cells. */
  const editLayout = (next: View, lost: number): void => {
    edit(next)
    setSelection(null)
    setNote(layoutLossNote(lost))
  }

  /** Runs a stored-Views action, showing its failure; `then` gets the new state on success. */
  const run = (action: ViewResult, then?: (state: AppState) => void): void => {
    setPending(true)
    setError(null)
    void action.then((result) => {
      setPending(false)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      then?.(result.value)
    })
  }

  /**
   * Whether it is fine to leave this draft: clean, or the user agrees to lose the changes. `false`
   * too when this editor went away while the dialog was open (the View was deleted underneath, or
   * something else closed the editor): there is nothing left to leave.
   */
  const mayLeave = async (): Promise<boolean> => {
    if (!dirty) return true
    const agreed = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: `Your changes to "${saved.name}" have not been saved.`,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    })
    return agreed && alive.current
  }

  /** Runs `then` once it is fine to leave the draft (asking first when it is dirty). */
  const leaveThen = (then: () => void): void => {
    void mayLeave().then((ok) => {
      if (ok) then()
    })
  }

  const openOther = (id: string): void => {
    if (id === saved.id) return
    leaveThen(() => {
      onOpen(id)
    })
  }

  const openNewState = (next: AppState): void => {
    if (next.settings.lastViewId !== null) onOpen(next.settings.lastViewId)
  }

  const save = (): void => {
    const result = validateDraft(draft)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    // The normalised draft, so the store's answer matches it and the draft follows (`syncDraft`).
    setState({ base: synced.base, draft: result.view })
    run(viewsActions.updateView(saved.id, () => result.view))
  }

  const discard = (): void => {
    setState(startDraft(saved))
    setResetCount((n) => n + 1)
    setSelection(null)
    setNote(null)
    setError(null)
  }

  const remove = (): void => {
    void confirmDialog({
      title: `Delete "${saved.name}"?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete View',
      danger: true,
    }).then((agreed) => {
      // Still this View's editor: not deleted elsewhere or closed while the dialog was open.
      if (agreed && alive.current) onDelete(saved.id)
    })
  }

  const merge = (): void => {
    if (rect === null) return
    const lost = mergeDropsCameras(draft, rect)
    const result = mergeCells(draft, rect)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    edit(result.view)
    setNote(lost > 0 ? mergeLossNote(lost) : null)
  }

  const split = (): void => {
    const index = selectedIndexes[0]
    if (index === undefined) return
    const result = splitCell(draft, index)
    if (result.ok) edit(result.view)
    else setError(result.reason)
  }

  const clearCameras = (): void => {
    edit(selectedIndexes.reduce((view, index) => setCellCameras(view, index, []), draft))
  }

  const select = (slot: Slot, extend: boolean): void => {
    // The first pick brings the Cell tab forward; later ones leave the tab alone (./editorTabs).
    setTab((current) => tabAfterSelect(current, rect !== null))
    setSelection((current) =>
      extend && current !== null && inGrid(draft, current.anchor)
        ? { anchor: current.anchor, focus: slot }
        : { anchor: slot, focus: slot },
    )
  }

  const selectedCount = selectedIndexes.length
  const selectionHasCameras = selectedIndexes.some(
    (i) => (draft.cells[i]?.cameraIds.length ?? 0) > 0,
  )
  const titles = toolbarTitles({
    count: selectedCount,
    canMerge: actions?.canMerge === true,
    canSplit: actions?.canSplit === true,
    hasCameras: selectionHasCameras,
  })

  return (
    <section className="viewEditor" aria-label="View editor">
      <nav className="viewEditor__list" aria-label="Views to edit">
        <h3 className="viewEditor__panelTitle viewEditor__listTitle">Views</h3>
        <ol className="viewEditor__listItems">
          {views.map((view, index) => (
            <li key={view.id} className="viewEditor__listRow">
              <button
                type="button"
                className="sideItem viewEditor__listItem"
                aria-pressed={view.id === saved.id}
                title={view.name}
                onClick={() => {
                  openOther(view.id)
                }}
              >
                {view.id === saved.id && dirty ? `${draft.name} •` : view.name}
              </button>
              <button
                type="button"
                className="button button--icon button--ghost button--sm"
                aria-label={`Move ${view.name} up`}
                title={`Move ${view.name} up`}
                disabled={index === 0 || pending}
                onClick={() => {
                  run(viewsActions.reorderViews(index, index - 1))
                }}
              >
                <ChevronUpIcon />
              </button>
              <button
                type="button"
                className="button button--icon button--ghost button--sm"
                aria-label={`Move ${view.name} down`}
                title={`Move ${view.name} down`}
                disabled={index === views.length - 1 || pending}
                onClick={() => {
                  run(viewsActions.reorderViews(index, index + 1))
                }}
              >
                <ChevronDownIcon />
              </button>
            </li>
          ))}
        </ol>
        {/* Pinned under the list: making a View, and the two that act on the one being edited. */}
        <div className="viewEditor__listFooter">
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={() => {
              leaveThen(() => {
                run(viewsActions.createView(nextViewName(views)), openNewState)
              })
            }}
          >
            <PlusIcon />
            New View
          </button>
          <p className="viewEditor__listCaption" title={saved.name}>
            This View: <span className="viewEditor__listCaptionName">{saved.name}</span>
          </p>
          <div className="viewEditor__listFooterRow">
            <button
              type="button"
              className="button"
              disabled={dirty || pending}
              title={
                dirty ? 'Save or discard your changes first' : `Make a copy of "${saved.name}"`
              }
              onClick={() => {
                run(viewsActions.duplicateView(saved.id), openNewState)
              }}
            >
              <CopyIcon />
              <span className="viewEditor__listFooterLabel">Duplicate</span>
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={pending}
              title={`Delete "${saved.name}"`}
              onClick={remove}
            >
              <TrashIcon />
              <span className="viewEditor__listFooterLabel">Delete</span>
            </button>
          </div>
        </div>
      </nav>

      <div className="viewEditor__main">
        <header className="viewEditor__header">
          <div className="viewEditor__nameField">
            <label className="field__label" htmlFor={nameId}>
              Name
            </label>
            <input
              id={nameId}
              className="field__input viewEditor__name"
              value={draft.name}
              onChange={(event) => {
                edit({ ...draft, name: event.target.value })
              }}
            />
          </div>
          <EditorGridSettings draft={draft} onLayout={editLayout} onError={setError} />
          <button
            type="button"
            className="button button--ghost viewEditor__close"
            title="Close the editor"
            onClick={() => {
              leaveThen(onClose)
            }}
          >
            <XIcon />
            Close
          </button>
        </header>

        <div className="viewEditor__toolbar" role="toolbar" aria-label="Selected cells">
          <button
            type="button"
            className="button button--sm"
            disabled={actions?.canMerge !== true}
            title={titles.merge}
            onClick={merge}
          >
            <MergeIcon />
            Merge
          </button>
          <button
            type="button"
            className="button button--sm"
            disabled={actions?.canSplit !== true}
            title={titles.split}
            onClick={split}
          >
            <SplitIcon />
            Split
          </button>
          <button
            type="button"
            className="button button--sm"
            disabled={!selectionHasCameras}
            title={titles.clear}
            onClick={clearCameras}
          >
            <EraserIcon />
            Clear cameras
          </button>
          <span
            className="viewEditor__selectionCount"
            title={selectedCount === 0 ? undefined : 'Press Esc to clear the selection'}
          >
            {selectedCount === 0
              ? 'No cells selected'
              : selectedCount === 1
                ? '1 cell selected'
                : `${String(selectedCount)} cells selected`}
          </span>
          {note === null ? null : (
            <p className="status status--warn viewEditor__note" role="status">
              <AlertIcon />
              <span>{note}</span>
            </p>
          )}
        </div>

        <div className="viewEditor__canvasBox">
          <EditorCanvas
            view={draft}
            cameras={cameras}
            snapshots={cellSnapshots}
            selection={rect}
            onSelect={select}
            onExtend={(slot) => {
              select(slot, true)
            }}
            onDropCamera={(index, ref) => {
              edit(dropCameraOnCell(draft, index, ref))
            }}
            onSwapCells={(from, to) => {
              edit(swapCellContents(draft, from, to))
            }}
          />
        </div>

        {/* Always rendered, so the canvas above does not jump when the first edit is made. */}
        <footer className="viewEditor__saveBar">
          <span
            className={
              dirty
                ? 'viewEditor__saveStatus viewEditor__saveStatus--dirty'
                : 'viewEditor__saveStatus'
            }
          >
            <span className="viewEditor__saveDot" aria-hidden="true" />
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          {/* One line, so the bar's height never changes; the whole message is in the tooltip. */}
          {error === null ? null : (
            <p className="status status--error viewEditor__message" role="alert" title={error}>
              <AlertIcon />
              <span className="viewEditor__messageText">{error}</span>
            </p>
          )}
          <div className="viewEditor__saveActions">
            <button
              type="button"
              className="button button--ghost"
              disabled={!dirty}
              title="Go back to the stored View"
              onClick={discard}
            >
              <UndoIcon />
              Discard
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!dirty || pending}
              onClick={save}
            >
              <CheckIcon />
              Save
            </button>
          </div>
        </footer>
      </div>

      <aside className="viewEditor__side">
        <EditorTabList idPrefix={panelId} tab={tab} onChange={setTab} />
        <div
          className="viewEditor__tabPanel"
          role="tabpanel"
          id={editorPanelId(panelId, 'view')}
          aria-labelledby={editorTabId(panelId, 'view')}
          hidden={tab !== 'view'}
        >
          <EditorViewSettings key={resetCount} draft={draft} onEdit={edit} />
        </div>
        <div
          className="viewEditor__tabPanel"
          role="tabpanel"
          id={editorPanelId(panelId, 'cell')}
          aria-labelledby={editorTabId(panelId, 'cell')}
          hidden={tab !== 'cell'}
        >
          <CellInspector
            cell={inspected}
            selectedCount={selectedIndexes.length}
            cameras={cameras}
            choices={choices}
            onAdd={(ref) => {
              edit(addCellCamera(draft, inspectedIndex, ref))
            }}
            onRemove={(position) => {
              edit(removeCellCamera(draft, inspectedIndex, position))
            }}
            onMove={(position, delta) => {
              edit(moveCellCamera(draft, inspectedIndex, position, delta))
            }}
            viewDefaultQuality={
              streams === undefined
                ? draft.gridQuality
                : resolveGridQuality({ cell: { quality: null }, view: draft, streams })
            }
            onQualityChange={(quality) => {
              if (inspected !== null)
                edit(setCellQuality(draft, inspected.col, inspected.row, quality))
            }}
            onRotateChange={(sec) => {
              edit(setCellRotation(draft, inspectedIndex, sec))
            }}
            onMotionSwitchChange={(on) => {
              edit(setCellMotionSwitch(draft, inspectedIndex, on))
            }}
            onMotionTriggersChange={(triggers) => {
              edit(setCellMotionTriggers(draft, inspectedIndex, triggers))
            }}
            onSmartDetectTypesChange={(types) => {
              edit(setCellSmartDetectTypes(draft, inspectedIndex, types))
            }}
            onMotionHoldChange={(sec) => {
              edit(setCellMotionHold(draft, inspectedIndex, sec))
            }}
          />
        </div>
        <CameraPalette choices={choices} inUse={inUse} snapshots={paletteImages} />
      </aside>
    </section>
  )
}

/** Whether `slot` is inside the draft's grid (a selection taken before a resize may not be). */
function inGrid(view: Pick<View, 'cols' | 'rows'>, slot: Slot): boolean {
  return slot.col < view.cols && slot.row < view.rows
}
