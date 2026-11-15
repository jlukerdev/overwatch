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
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { View } from '@shared/models'
import { selectionNeedsStore, useLastViewId, viewsActions } from '../../state/viewsStore'
import { PencilIcon, PlusIcon } from '../../ui/icons'
import { nextViewName } from '../viewEditor/viewEditorHelpers'
import { keyEventTarget, viewShortcutIndex } from './viewShortcut'

/** Views 1–9 have a key; a tenth and later are reachable by click only. */
const SHORTCUT_COUNT = 9

export interface ViewSwitcherProps {
  readonly views: readonly View[]
  /** `null` only when there are no Views. */
  readonly activeViewId: string | null
  /** Opens the View editor on View `id`. */
  readonly onEditView: (id: string) => void
}

export function ViewSwitcher({ views, activeViewId, onEditView }: ViewSwitcherProps): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
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

  return (
    <nav className="viewSwitcher" aria-label="Views">
      <div className="viewSwitcher__list">
        {views.length === 0 ? <p className="viewSwitcher__empty">No Views</p> : null}
        {views.map((view, index) => {
          const active = view.id === activeViewId
          const key = index < SHORTCUT_COUNT ? String(index + 1) : null
          return (
            <button
              key={view.id}
              type="button"
              className="viewSwitcher__item"
              data-view-id={view.id}
              aria-pressed={active}
              aria-keyshortcuts={key ?? undefined}
              title={key === null ? view.name : `${view.name} (${key})`}
              onClick={() => {
                select(view.id)
              }}
            >
              <span className="viewSwitcher__key" aria-hidden="true">
                {key ?? ''}
              </span>
              <span className="viewSwitcher__name">{view.name}</span>
            </button>
          )
        })}
      </div>
      {error === null ? null : (
        <p className="viewSwitcher__error" role="alert">
          {error}
        </p>
      )}
      <div className="viewSwitcher__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={creating}
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
          New View
        </button>
        <button
          type="button"
          className="button"
          disabled={activeViewId === null}
          onClick={() => {
            if (activeViewId !== null) onEditView(activeViewId)
          }}
        >
          <PencilIcon />
          Edit View
        </button>
      </div>
    </nav>
  )
}

/**
 * VIEW-4: `1`–`9` select View N while the switcher is mounted, i.e. while the Live screen is up.
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
