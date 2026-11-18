// The View switcher (P3.2; VIEW-4, VIEW-6): the sidebar list of Views beside the Live grid, and the
// `1`–`9` keyboard shortcut. Selecting a View goes through `viewsActions.setActiveView`, which
// stores it as `lastViewId`, so the app reopens on it after a restart (VIEW-6).
//
// **DOM contract.** The P2.5 perf harness drives this screen from main by selector:
// `nav[aria-label="Views"] button[data-view-id=…][aria-pressed]`. Keep the label, the attribute and
// `aria-pressed` on every button.
//
// The active View is passed in rather than read here, so the switcher and the grid beside it can
// never disagree about which View is showing (both come from `useActiveView` in the Live screen).
// The key rules are `viewShortcutIndex` (./viewShortcut), pure and tested; the hook below only
// listens and calls it.
//
// Pinned to the bottom of the pane (P3.8), under the list, "New View" and "Edit View" open the
// View editor (P3.3; VIEW-3): New View first creates `View N` (the next free name,
// `nextViewName`) and then edits it, Edit View edits the active View. They are plain buttons with
// **no** `data-view-id`, so the harness selector above still matches View buttons only. The list
// scrolls in its own region (`viewSwitcher__list`) so the actions, and an error above them, stay
// in view however many Views there are.
//
// **Collapsed** (UX polish 2026-11-17). The toggle in the pane's head folds the sidebar to a slim
// rail: each View is its number alone (a dot from the tenth on) with the name as its accessible
// name and tooltip, and New View / Edit View are icon-only. It is the same tree with another
// class, so the buttons — the harness's selector, `aria-pressed`, the keyboard focus — are the
// same elements in both states. The choice is remembered per machine (`switcherPrefs.ts`,
// localStorage), not in the config.
//
// **Focus mode** (./focusMode). The head's other button asks the Live screen to hide the header
// and this switcher. The screen then passes `hidden`: the component stays mounted and draws
// nothing, so the `1`–`9` shortcuts keep working without a sidebar to click.
import { useCallback, useEffect, useRef, useState, type JSX, type Ref } from 'react'
import type { View } from '@shared/models'
import { selectionNeedsStore, useLastViewId, viewsActions } from '../../state/viewsStore'
import { ExpandIcon, PencilIcon, PlusIcon, SidebarIcon } from '../../ui/icons'
import { StatusLine } from '../../ui/StatusLine'
import { nextViewName } from '../viewEditor/viewEditorHelpers'
import {
  readSwitcherCollapsed,
  switcherStorage,
  viewItemTitle,
  viewShortcutKey,
  writeSwitcherCollapsed,
} from './switcherPrefs'
import { keyEventTarget, viewShortcutIndex } from './viewShortcut'

export interface ViewSwitcherProps {
  readonly views: readonly View[]
  /** `null` only when there are no Views. */
  readonly activeViewId: string | null
  /** Opens the View editor on View `id`. */
  readonly onEditView: (id: string) => void
  /** Focus mode is on: draw nothing, keep the `1`–`9` shortcuts (see the header). */
  readonly hidden: boolean
  /** The focus-mode button was pressed. */
  readonly onEnterFocusMode: () => void
  /** The focus-mode button, so the screen can hand the focus back to it on the way out. */
  readonly focusModeButtonRef?: Ref<HTMLButtonElement>
}

export function ViewSwitcher({
  views,
  activeViewId,
  onEditView,
  hidden,
  onEnterFocusMode,
  focusModeButtonRef,
}: ViewSwitcherProps): JSX.Element | null {
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [collapsed, setCollapsed] = useState(() => readSwitcherCollapsed(switcherStorage()))
  // The stored id, not `activeViewId`: the latter may be a fallback that was never stored, and
  // choosing it must still be written (`selectionNeedsStore`). Only the skip reads it; which button
  // is marked still comes from `activeViewId`.
  const lastViewId = useLastViewId()

  const select = useCallback(
    (id: string): void => {
      // Already stored: nothing to send.
      if (!selectionNeedsStore(lastViewId, id)) return
      void viewsActions.setActiveView(id).then((result) => {
        setError(result.ok ? null : result.error.message)
      })
    },
    [lastViewId],
  )

  useViewShortcuts(views, select)

  // Focus mode: no switcher, but a failed `1`–`9` switch must still be seen (grid.css).
  if (hidden) {
    return error === null ? null : (
      <StatusLine kind="error" role="alert" className="viewSwitcher__floatingError">
        {error}
      </StatusLine>
    )
  }

  const toggleCollapsed = (): void => {
    const next = !collapsed
    setCollapsed(next)
    writeSwitcherCollapsed(switcherStorage(), next)
  }
  const toggleLabel = collapsed ? 'Expand the View list' : 'Collapse the View list'

  return (
    <nav
      className={collapsed ? 'viewSwitcher viewSwitcher--collapsed' : 'viewSwitcher'}
      aria-label="Views"
    >
      <div className="viewSwitcher__head">
        {collapsed ? null : <span className="viewSwitcher__caption">Views</span>}
        <button
          ref={focusModeButtonRef}
          type="button"
          className="button button--ghost button--icon button--sm"
          aria-label="Focus mode: hide the header and the View list"
          aria-keyshortcuts="F"
          title="Focus mode (F)"
          onClick={onEnterFocusMode}
        >
          <ExpandIcon />
        </button>
        <button
          type="button"
          className="button button--ghost button--icon button--sm"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          title={toggleLabel}
          onClick={toggleCollapsed}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="viewSwitcher__list">
        {views.length === 0 && !collapsed ? <p className="viewSwitcher__empty">No Views</p> : null}
        {views.map((view, index) => {
          const key = viewShortcutKey(index)
          return (
            <button
              key={view.id}
              type="button"
              className="sideItem viewSwitcher__item"
              data-view-id={view.id}
              aria-pressed={view.id === activeViewId}
              aria-keyshortcuts={key ?? undefined}
              // Collapsed, the name is not drawn, so it is the label; expanded, it is the content.
              aria-label={collapsed ? view.name : undefined}
              title={viewItemTitle(view.name, index)}
              onClick={() => {
                select(view.id)
              }}
            >
              <span className="viewSwitcher__key" aria-hidden="true">
                {key ?? (collapsed ? '•' : '')}
              </span>
              {collapsed ? null : <span className="viewSwitcher__name">{view.name}</span>}
            </button>
          )
        })}
      </div>
      {error === null ? null : (
        <p className="viewSwitcher__error" role="alert" title={collapsed ? error : undefined}>
          {collapsed ? (
            <>
              <span aria-hidden="true">!</span>
              <span className="visuallyHidden">{error}</span>
            </>
          ) : (
            error
          )}
        </p>
      )}
      <div className="viewSwitcher__actions">
        <button
          type="button"
          className={collapsed ? 'button button--primary button--icon' : 'button button--primary'}
          disabled={creating}
          aria-label={collapsed ? 'New View' : undefined}
          title={collapsed ? 'New View' : undefined}
          onClick={() => {
            setCreating(true)
            void viewsActions.createView(nextViewName(views)).then((result) => {
              setCreating(false)
              if (!result.ok) {
                setError(result.error.message)
                return
              }
              setError(null)
              // createView makes the new View active, so lastViewId is its id.
              const id = result.value.settings.lastViewId
              if (id !== null) onEditView(id)
            })
          }}
        >
          <PlusIcon />
          {collapsed ? null : 'New View'}
        </button>
        <button
          type="button"
          className={collapsed ? 'button button--icon' : 'button'}
          disabled={activeViewId === null}
          aria-label={collapsed ? 'Edit View' : undefined}
          title={collapsed ? 'Edit View' : undefined}
          onClick={() => {
            if (activeViewId !== null) onEditView(activeViewId)
          }}
        >
          <PencilIcon />
          {collapsed ? null : 'Edit View'}
        </button>
      </div>
    </nav>
  )
}

/**
 * VIEW-4: `1`–`9` select View N while the switcher is mounted, i.e. while the Live screen is up
 * (drawn or not: focus mode hides it and keeps it mounted).
 * The listener is installed once; the latest Views and `select` are read through a ref, so a View
 * switch does not remove and re-add a window listener.
 */
function useViewShortcuts(views: readonly View[], select: (id: string) => void): void {
  const latest = useRef({ views, select })
  useEffect(() => {
    latest.current = { views, select }
  }, [views, select])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const index = viewShortcutIndex(event, keyEventTarget(event.target))
      if (index === null) return
      const view = latest.current.views[index]
      if (view === undefined) return
      event.preventDefault()
      latest.current.select(view.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
