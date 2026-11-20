// The Live screen (P3.2; VIEW-4/5/6/7): the View switcher in a sidebar and the active View, drawn
// letterboxed, filling the rest. Replaces P2.4's temporary preset grid.
//
// The active View is `useActiveView()`, i.e. the stored `lastViewId` with VIEW-6's fallback to the
// first View when it names nothing, so the app reopens where the user left it. It is read once,
// here, and handed to both the switcher and the grid (`LiveBody` takes it as a prop rather than
// subscribing again), so they cannot disagree.
//
// What the grid area shows, first match wins:
//  1. "Loading…" until the settings have landed, then (Protect) "Reading the console status…"
//     until the first status has.
//  2. The setup / no-cameras empty states, by the camera list's own rules (`setupGaps`,
//     `cameraListBody`), so this screen and that one never disagree about why there is nothing to
//     show. "Not set up yet" lists the setup steps with the done ones ticked (`setupChecklist`).
//     Nothing connects on launch unless a previous session's connect worked (CON-4), so "No
//     cameras" is also what a launch shows until the user connects from the Cameras screen — or,
//     for the launch auto-connect, until its inventory lands. The switcher stays, so a View can
//     still be picked (and remembered) before the console is reached.
//  3. "No Views yet", with a button that makes a first View of the cameras (`starterPreset`).
//  4. The active View.
// In **RTSP mode** (MODE-3) there is no console, so neither the console wait in 1 nor 2 applies: the camera list is the
// streams' (main's inventory in that mode), and while it is empty the screen says "No streams" and
// points to the Streams screen (`onOpenCameras`, which App routes there) instead of Settings.
// 1–3 are the shared centred empty state (styles.css `.emptyState`): an icon or a spinner, a
// title, a line of help and one action labelled for what it does.
//
// **Editing** (P3.3; VIEW-3). "New View" / "Edit View" in the switcher put the screen in editing
// mode: the View editor replaces the switcher and the grid until it is closed. Unmounting the
// switcher is what turns the `1`–`9` shortcuts off while editing (typing a name must not switch
// Views). The editor is shown whatever the console state, since editing needs only the Views;
// without cameras its palette is simply empty. Which View is being edited is the app shell's state
// (`editingViewId`), not this screen's, so it survives a trip to another screen (App).
//
// **Focus mode** (UX polish 2026-11-17; features/viewSwitcher/focusMode.ts has the rules). The
// switcher's focus-mode button or `F` hides the app header (App, which owns the state) and the
// switcher, so the wall has the whole window. The switcher stays mounted, drawing nothing, so
// `1`–`9` still switch Views. A small "Exit focus mode" control floats at the bottom-left of the
// Live area: it fades in when the pointer moves over the screen and hides again after the cell
// overlay's own idle delay (`ui.overlayAutoHideSec`, CELL-4), but it is always in the tab order
// and shows while it has keyboard focus. Beside it, always visible, is a badge for every endpoint
// that is not connected (`ConnectionAlerts`), because the header that normally carries the
// connection indicator is hidden and CON-5 wants it on screen at all times. `Esc` is untouched:
// it leaves fill (FILL-1) and never focus mode. A press of either button moves the keyboard focus
// to its counterpart, since the pressed one has just left the screen.
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ConnectionStatus } from '@shared/ipc'
import type { View } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { cameraListBody, setupGaps, sortCameras } from '../../state/camerasStore'
import {
  starterPreset,
  STARTER_VIEW_NAME,
  useActiveView,
  useViews,
  viewsActions,
} from '../../state/viewsStore'
import {
  CameraIcon,
  CameraOffIcon,
  CollapseIcon,
  GearIcon,
  GridIcon,
  PlusIcon,
} from '../../ui/icons'
import { overlayAutoHideMs } from '../cells/overlayVisibility'
import { useDoorWatch } from '../door/useDoorWatch'
import { ConnectionAlerts } from '../status/ConnectionBadge'
import { SetupChecklist } from '../../ui/SetupChecklist'
import { StatusLine } from '../../ui/StatusLine'
import { ViewEditor } from '../viewEditor/ViewEditor'
import { isFocusModeKey } from '../viewSwitcher/focusMode'
import { ViewSwitcher } from '../viewSwitcher/ViewSwitcher'
import { keyEventTarget } from '../viewSwitcher/viewShortcut'
import { GridView } from './GridView'
import { openSetupSteps, setupChecklist } from '../../state/setupChecklist'
import './grid.css'

export interface LiveScreenProps {
  /** The id of the View the editor is on, or `null` when not editing. Owned by App. */
  readonly editingViewId: string | null
  readonly onEditingChange: (id: string | null) => void
  /** Focus mode is on: the header is hidden (App) and so is the switcher. Owned by App. */
  readonly focusMode: boolean
  readonly onFocusModeChange: (on: boolean) => void
  readonly onOpenSettings: () => void
  /**
   * The Cameras screen is where the console is connected and its list is refreshed; in RTSP mode
   * App sends this to the Streams screen instead (MODE-3).
   */
  readonly onOpenCameras: () => void
}

export function LiveScreen({
  editingViewId,
  onEditingChange,
  ...wall
}: LiveScreenProps): JSX.Element {
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
  return <LiveWall {...wall} onEditView={onEditingChange} />
}

interface LiveWallProps extends Omit<LiveScreenProps, 'editingViewId' | 'onEditingChange'> {
  readonly onEditView: (id: string) => void
}

/** The screen when not editing: the switcher, the grid area, and focus mode's keys and control. */
function LiveWall({
  focusMode,
  onFocusModeChange,
  onEditView,
  onOpenSettings,
  onOpenCameras,
}: LiveWallProps): JSX.Element {
  const views = useViews()
  const activeView = useActiveView()
  // DOOR-6: main watches the linked doors only while this wall shows a View with a linked camera.
  useDoorWatch(activeView)
  const autoHideMs = useAppStore((s) => overlayAutoHideMs(s.settings?.ui.overlayAutoHideSec))
  const [exitRevealed, revealExit] = useIdleReveal(autoHideMs)

  const enterButton = useRef<HTMLButtonElement>(null)
  const exitButton = useRef<HTMLButtonElement>(null)
  // Set by a press of either button: its counterpart takes the focus once it is on screen.
  const handFocus = useRef(false)
  useEffect(() => {
    if (!handFocus.current) return
    handFocus.current = false
    ;(focusMode ? exitButton : enterButton).current?.focus()
  }, [focusMode])

  // `F` toggles. Installed once; the latest state is read through a ref (as the View shortcuts do).
  const latest = useRef({ focusMode, onFocusModeChange, revealExit })
  useEffect(() => {
    latest.current = { focusMode, onFocusModeChange, revealExit }
  }, [focusMode, onFocusModeChange, revealExit])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFocusModeKey(event, keyEventTarget(event.target))) return
      event.preventDefault()
      const next = !latest.current.focusMode
      // Entering shows the exit control for one idle delay, so the way back is seen once.
      if (next) latest.current.revealExit()
      latest.current.onFocusModeChange(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const setFocusModeByButton = (on: boolean): void => {
    handFocus.current = true
    if (on) revealExit()
    onFocusModeChange(on)
  }

  return (
    <section
      className={focusMode ? 'liveScreen liveScreen--focus' : 'liveScreen'}
      onPointerMove={focusMode ? revealExit : undefined}
    >
      <ViewSwitcher
        views={views}
        activeViewId={activeView?.id ?? null}
        onEditView={onEditView}
        hidden={focusMode}
        onEnterFocusMode={() => {
          setFocusModeByButton(true)
        }}
        focusModeButtonRef={enterButton}
      />
      <div className="liveScreen__main">
        <LiveBody
          activeView={activeView}
          onOpenSettings={onOpenSettings}
          onOpenCameras={onOpenCameras}
        />
        {focusMode ? (
          <div className={exitRevealed ? 'focusBar focusBar--revealed' : 'focusBar'}>
            <ConnectionAlerts onOpenSettings={onOpenSettings} />
            <button
              ref={exitButton}
              type="button"
              className="focusBar__exit"
              aria-label="Exit focus mode"
              aria-keyshortcuts="F"
              title="Exit focus mode (F)"
              onClick={() => {
                setFocusModeByButton(false)
              }}
            >
              <CollapseIcon />
              Exit focus mode
              <kbd className="focusBar__key" aria-hidden="true">
                F
              </kbd>
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * "Shown for a while after the last poke": `reveal()` shows and (re)starts the idle delay, after
 * which it hides again. Used for focus mode's exit control, poked by pointer movement.
 */
function useIdleReveal(idleMs: number): readonly [revealed: boolean, reveal: () => void] {
  const [revealed, setRevealed] = useState(false)
  const timer = useRef<number | null>(null)
  const delay = useRef(idleMs)
  useEffect(() => {
    delay.current = idleMs
  }, [idleMs])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  // Stable (it reads only refs and a state setter), so it can sit in a listener installed once.
  const [reveal] = useState(() => (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setRevealed(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setRevealed(false)
    }, delay.current)
  })
  return [revealed, reveal]
}

interface LiveBodyProps extends Pick<LiveScreenProps, 'onOpenSettings' | 'onOpenCameras'> {
  /** The one active View LiveScreen read, also the one the switcher marks. */
  readonly activeView: View | null
}

function LiveBody({ activeView, onOpenSettings, onOpenCameras }: LiveBodyProps): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const connection = useAppStore((s) => s.connection)
  const streams = useAppStore((s) => s.settings?.streams ?? null)
  const rtsp = useAppStore((s) => s.settings?.mode === 'rtsp')

  // Only until the first state lands (the shell waits for it); Protect's wait for its status is
  // `consoleNotReady`'s.
  if (streams === null) return <EmptyState busy title="Loading…" />

  const notReady = rtsp
    ? noStreams(cameras.length, onOpenCameras)
    : consoleNotReady(connection, cameras.length, onOpenSettings, onOpenCameras)
  if (notReady !== null) return notReady

  if (activeView === null) {
    return <NoViews cameraIds={sortCameras(cameras).map((camera) => camera.id)} />
  }

  // Not keyed by View: one GridView across switches keeps the players of shared cameras (GridView).
  return <GridView view={activeView} cameras={cameras} streams={streams} />
}

/** RTSP mode (MODE-3): with no streams there is nothing to show, and Streams is where to add one. */
function noStreams(cameraCount: number, onOpenStreams: () => void): JSX.Element | null {
  if (cameraCount > 0) return null
  return (
    <EmptyState
      icon={<CameraOffIcon />}
      title="No streams"
      hint="Add your cameras’ RTSP addresses on the Streams screen; the Views fill from its list."
      action={{ label: 'Open Streams', icon: <CameraIcon />, onClick: onOpenStreams }}
    />
  )
}

/** Protect mode: the setup and no-cameras states, by the camera list's own rules (header). */
function consoleNotReady(
  connection: ConnectionStatus | null,
  cameraCount: number,
  onOpenSettings: () => void,
  onOpenCameras: () => void,
): JSX.Element | null {
  if (connection === null) return <EmptyState busy title="Reading the console status…" />
  const gaps = setupGaps(connection.protect)
  const body = cameraListBody(cameraCount, gaps)
  if (body === 'setup') {
    const steps = setupChecklist(connection.protect)
    const open = openSetupSteps(steps)
    return (
      <EmptyState
        icon={<GearIcon />}
        title="Not set up yet"
        hint={`${String(open)} ${open === 1 ? 'step' : 'steps'} left before the wall can show live video.`}
        action={{ label: 'Open settings', icon: <GearIcon />, onClick: onOpenSettings }}
      >
        <SetupChecklist steps={steps} />
      </EmptyState>
    )
  }
  if (
    body === 'empty' &&
    (connection.protect.phase === 'connecting' || connection.protect.phase === 'reconnecting')
  ) {
    // CON-4: a launch connect opens on Live before the inventory has landed; "No cameras" with a
    // pointer to the Cameras screen would be a false setup prompt for that moment.
    return <EmptyState busy title="Connecting to the console…" />
  }
  if (body === 'empty') {
    return (
      <EmptyState
        icon={<CameraOffIcon />}
        title="No cameras"
        hint="Connect to the console from the Cameras screen; the Views fill from its list."
        action={{ label: 'Open cameras', icon: <CameraIcon />, onClick: onOpenCameras }}
      />
    )
  }
  return null
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
    <EmptyState
      icon={<GridIcon />}
      title="No Views yet"
      hint="A View is a grid of cameras. Start with one that shows all of them; you can change its layout later."
      action={{ label: 'Create a View', icon: <PlusIcon />, onClick: create, disabled: pending }}
      error={error}
    />
  )
}

/**
 * The centred empty state (styles.css `.emptyState`). `busy` draws a spinner in place of the icon
 * and makes the whole thing a polite status. `action` is the one button, labelled for what it
 * actually does; `children` go between the hint and the action (the setup checklist).
 */
function EmptyState({
  title,
  icon,
  busy = false,
  hint,
  action,
  error,
  children,
}: {
  readonly title: string
  /** Shown in the round badge above the title; ignored while `busy`. */
  readonly icon?: JSX.Element
  readonly busy?: boolean
  readonly hint?: string
  readonly action?: {
    readonly label: string
    /** Shown before the label (ui/icons.tsx). */
    readonly icon: JSX.Element
    readonly onClick: () => void
    readonly disabled?: boolean
  }
  readonly error?: string | null
  readonly children?: ReactNode
}): JSX.Element {
  return (
    <div className="emptyState" role={busy ? 'status' : undefined}>
      {busy ? (
        <span className="spinner emptyState__spinner" aria-hidden="true" />
      ) : icon === undefined ? null : (
        <span className="emptyState__icon">{icon}</span>
      )}
      <h2 className="emptyState__title">{title}</h2>
      {hint === undefined ? null : <p className="emptyState__hint">{hint}</p>}
      {children}
      {action === undefined ? null : (
        <div className="emptyState__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={action.disabled === true}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </button>
        </div>
      )}
      {error === undefined || error === null ? null : (
        <StatusLine kind="error" role="alert">
          {error}
        </StatusLine>
      )}
    </div>
  )
}
