// The Live screen (P3.2; VIEW-4/5/6/7): the View switcher in a sidebar and the active View, drawn
// letterboxed, filling the rest. Replaces P2.4's temporary preset grid.
//
// The active View is `useActiveView()`, i.e. the stored `lastViewId` with VIEW-6's fallback to the
// first View when it names nothing, so the app reopens where the user left it. It is read once,
// here, and handed to both the switcher and the grid (`LiveBody` takes it as a prop rather than
// subscribing again), so they cannot disagree.
//
// What the grid area shows, first match wins:
//  1. "Reading the console status…" until the first status and settings have landed.
//  2. The setup / no-cameras notices, by the camera list's own rules (`setupGaps`,
//     `cameraListBody`), so this screen and that one never disagree about why there is nothing to
//     show. Nothing connects on launch (CON-4), so "No cameras" is also what a fresh start shows
//     until the user connects from the Cameras screen. The switcher stays, so a View can still be
//     picked (and remembered) before the console is reached.
//  3. "No Views yet", with a button that makes a first View of the cameras (`starterPreset`).
//  4. The active View.
//
// **Editing** (P3.3; VIEW-3). "New View" / "Edit View" in the switcher put the screen in editing
// mode: the View editor replaces the switcher and the grid until it is closed. Unmounting the
// switcher is what turns the `1`–`9` shortcuts off while editing (typing a name must not switch
// Views). The editor is shown whatever the console state, since editing needs only the Views;
// without cameras its palette is simply empty. Which View is being edited is the app shell's state
// (`editingViewId`), not this screen's, so it survives a trip to another screen (App).
import { useState, type JSX } from 'react'
import type { View } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { cameraListBody, setupGaps, sortCameras, SETUP_GAP_LABELS } from '../../state/camerasStore'
import {
  starterPreset,
  STARTER_VIEW_NAME,
  useActiveView,
  useViews,
  viewsActions,
} from '../../state/viewsStore'
import { CameraIcon, GearIcon, PlusIcon } from '../../ui/icons'
import { ViewEditor } from '../viewEditor/ViewEditor'
import { ViewSwitcher } from '../viewSwitcher/ViewSwitcher'
import { GridView } from './GridView'
import './grid.css'

export interface LiveScreenProps {
  /** The id of the View the editor is on, or `null` when not editing. Owned by App. */
  readonly editingViewId: string | null
  readonly onEditingChange: (id: string | null) => void
  readonly onOpenSettings: () => void
  /** The Cameras screen is where the console is connected and its list is refreshed. */
  readonly onOpenCameras: () => void
}

export function LiveScreen({
  editingViewId,
  onEditingChange,
  onOpenSettings,
  onOpenCameras,
}: LiveScreenProps): JSX.Element {
  const views = useViews()
  const activeView = useActiveView()
  if (editingViewId !== null) {
    return (
      <ViewEditor
        viewId={editingViewId}
        onOpen={onEditingChange}
        onClose={() => {
          onEditingChange(null)
        }}
      />
    )
  }
  return (
    <section className="liveScreen">
      <ViewSwitcher
        views={views}
        activeViewId={activeView?.id ?? null}
        onEditView={onEditingChange}
      />
      <div className="liveScreen__main">
        <LiveBody
          activeView={activeView}
          onOpenSettings={onOpenSettings}
          onOpenCameras={onOpenCameras}
        />
      </div>
    </section>
  )
}

interface LiveBodyProps extends Pick<LiveScreenProps, 'onOpenSettings' | 'onOpenCameras'> {
  /** The one active View LiveScreen read, also the one the switcher marks. */
  readonly activeView: View | null
}

function LiveBody({ activeView, onOpenSettings, onOpenCameras }: LiveBodyProps): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const connection = useAppStore((s) => s.connection)
  const streams = useAppStore((s) => s.settings?.streams ?? null)

  if (connection === null || streams === null) {
    return <Notice title="Reading the console status…" />
  }

  const gaps = setupGaps(connection.protect)
  const body = cameraListBody(cameras.length, gaps)
  if (body === 'setup') {
    return (
      <Notice
        title="Not set up yet"
        hint={`Nothing to stream until setup is done: ${gaps.map((g) => SETUP_GAP_LABELS[g]).join('; ')}.`}
        action={{ label: 'Open settings', icon: <GearIcon />, onClick: onOpenSettings }}
      />
    )
  }
  if (body === 'empty') {
    return (
      <Notice
        title="No cameras"
        hint="Connect to the console from the Cameras screen; the Views fill from its list."
        action={{ label: 'Open cameras', icon: <CameraIcon />, onClick: onOpenCameras }}
      />
    )
  }

  if (activeView === null) {
    return <NoViews cameraIds={sortCameras(cameras).map((camera) => camera.id)} />
  }

  // Not keyed by View: one GridView across switches keeps the players of shared cameras (GridView).
  return <GridView view={activeView} cameras={cameras} streams={streams} />
}

/**
 * VIEW-3 for a fresh install: one click makes a first View showing every camera (up to the 4×4
 * cap), in the camera list's order, on the smallest uniform layout that holds them.
 */
function NoViews({ cameraIds }: { readonly cameraIds: readonly string[] }): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = (): void => {
    setPending(true)
    setError(null)
    void viewsActions
      .createView(STARTER_VIEW_NAME, starterPreset(cameraIds.length), cameraIds)
      .then((result) => {
        // On success this component unmounts (there is a View now); only a failure stays to read.
        if (!result.ok) {
          setPending(false)
          setError(result.error.message)
        }
      })
  }
  return (
    <Notice
      title="No Views yet"
      hint="A View is a grid of cameras. Start with one that shows all of them; you can change its layout later."
      action={{ label: 'Create a View', icon: <PlusIcon />, onClick: create, disabled: pending }}
      error={error}
    />
  )
}

/** A notice card. `action` is the one button, labelled for what it actually does. */
function Notice({
  title,
  hint,
  action,
  error,
}: {
  readonly title: string
  readonly hint?: string
  readonly action?: {
    readonly label: string
    /** Shown before the label (ui/icons.tsx). */
    readonly icon: JSX.Element
    readonly onClick: () => void
    readonly disabled?: boolean
  }
  readonly error?: string | null
}): JSX.Element {
  return (
    <div className="card liveScreen__notice">
      <h3 className="card__title">{title}</h3>
      {hint === undefined ? null : <p className="card__hint">{hint}</p>}
      {action === undefined ? null : (
        <button
          type="button"
          className="button button--primary"
          disabled={action.disabled === true}
          onClick={action.onClick}
        >
          {action.icon}
          {action.label}
        </button>
      )}
      {error === undefined || error === null ? null : (
        <p className="app__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
