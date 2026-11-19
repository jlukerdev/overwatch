// App shell (P1.5): the one place that loads `AppState`, subscribes to main's pushes, and switches
// between the screens. Routing is a piece of state rather than a router — the prototype has two
// screens in Phase 1 and the Views come in Phase 3 (VIEW-1), so a URL would buy nothing.
//
// The third screen is Live (`LiveScreen`, P3.2): the View switcher and the active View. It is the
// first screen only when main is connecting by itself at this launch (CON-4's exception, a previous
// session's connect worked) and there is a View to show; otherwise nothing is live, and Live would
// open on "No cameras". The rule is `initialScreen` (Settings / Live / Cameras).
//
// The View editor (P3.3) is part of Live, but which View it is editing is kept here, so leaving Live
// for another screen and coming back reopens the editor rather than dropping it. Leaving with
// unsaved changes asks first (VIEW-3): the nav buttons consult `confirmLeave`, and a `beforeunload`
// listener (`blockUnload`) holds a window close or reload (main asks the user, src/main/index.ts).
//
// **Doors** (P5.6) is the fourth screen, between Cameras and Live in the nav. Its button and the
// screen itself exist only while the **saved** Access switch is on (DOOR-0): with Access off there
// is no button, no screen and so no Access call. If the switch goes off while Doors is the chosen
// screen, the app moves to Settings (where the switch is); unmounting the screen is what tells
// main to stop reading (`watchDoorsScreen(false)`, features/doors/useDoorsScreenWatch.ts).
//
// The connection indicator lives in the header, outside the switch: CON-5 asks for it to be visible
// at all times, not only on the Settings screen. Each badge is also a way into Settings.
//
// **Settings** (P5.8) is not a nav tab: it holds only the console connection, and is opened by the
// gear button at the header's very end, after the badges. That button goes through the same `go`,
// so the unsaved-editor guard applies, and it is marked `aria-current` and drawn active like a nav
// button while Settings shows. A first run with no console still opens on Settings (`initialScreen`).
//
// **Focus mode** (UX polish 2026-11-17; features/viewSwitcher/focusMode.ts). The Live screen can ask
// for the whole window: the header is then not drawn (and Live hides its switcher). The request is
// state here because the header is; it applies only while Live is showing and the editor is closed
// (`focusModeApplies`), and it is dropped on leaving Live or opening the editor, so the chrome is
// back for good. It is never stored: a launch always has its header. While the header is hidden,
// Live shows the endpoints that are not connected itself (CON-5).
import { useEffect, useState, type JSX } from 'react'
import { CameraList } from './features/cameras/CameraList'
import { DoorsScreen } from './features/doors/DoorsScreen'
import { LiveScreen } from './features/grid/LiveScreen'
import { SettingsPage } from './features/settings/SettingsPage'
import { ConnectionBadge } from './features/status/ConnectionBadge'
import { focusModeApplies } from './features/viewSwitcher/focusMode'
import { initialScreen, type Screen } from './initialScreen'
import { navClass } from './navClass'
import { useAppStore } from './state/appStore'
import { blockUnload, confirmLeave } from './state/unsavedGuard'
import { ConfirmHost, confirmDialog } from './ui/ConfirmDialog'
import { AlertIcon, CameraIcon, DoorIcon, GearIcon, GridIcon, RefreshIcon } from './ui/icons'
import { ToastHost } from './ui/Toast'

export function App(): JSX.Element {
  const phase = useAppStore((s) => s.phase)
  const loadError = useAppStore((s) => s.loadError)
  const load = useAppStore((s) => s.load)
  const subscribe = useAppStore((s) => s.subscribe)
  // DOOR-0: the saved switch, not Settings' unsaved checkbox.
  const accessEnabled = useAppStore((s) => s.settings?.console.accessEnabled ?? false)

  const [screen, setScreen] = useState<Screen | null>(null)
  // The id of the View the editor is on, or `null` when not editing (see the header).
  const [editingViewId, setEditingViewId] = useState<string | null>(null)
  // The user asked for focus mode; whether it applies right now is `focusMode` below.
  const [focusRequested, setFocusRequested] = useState(false)

  useEffect(() => {
    window.addEventListener('beforeunload', blockUnload)
    return () => {
      window.removeEventListener('beforeunload', blockUnload)
    }
  }, [])

  useEffect(() => {
    // Subscribe before loading, so a status change that arrives during the load is not missed: the
    // store counts the pushes and keeps the newer of the two.
    const unsubscribe = subscribe()
    void (async () => {
      await load()
      // Settings for a fresh install (no host yet, CON-1), Live when main is reconnecting a console
      // that worked last session and there is a View (CON-4, VIEW-6), Cameras otherwise — see
      // `initialScreen`. Decided **once**, here, from the state that just landed — deriving it on
      // every render would move the user off Settings the moment they saved a host, unmounting the
      // form, the certificate panel and the re-pin confirmation mid-setup. The updater keeps a
      // choice the user managed to make while the load was still running.
      const { settings, secretsStored } = useAppStore.getState()
      const first = initialScreen(settings, secretsStored)
      setScreen((chosen) => chosen ?? first)
    })()
    return unsubscribe
  }, [load, subscribe])

  // DOOR-0: Doors cannot stay the chosen screen once Access is saved as off (header). Adjusted
  // during render, so the Doors screen is not drawn even once more.
  if (screen === 'doors' && !accessEnabled && phase === 'ready') setScreen('settings')

  // Settings until the load says otherwise (see the effect above).
  const current = screen === 'doors' && !accessEnabled ? 'settings' : (screen ?? 'settings')
  const focusMode = focusModeApplies(focusRequested, current === 'grid', editingViewId !== null)

  /** Switches screens, unless that would drop unsaved editor changes the user wants to keep. */
  const go = (next: Screen): void => {
    if (next === current) return
    void confirmLeave(confirmDialog).then((leave) => {
      if (!leave) return
      setScreen(next)
      // Leaving Live ends focus mode, so coming back shows the chrome.
      setFocusRequested(false)
    })
  }

  /** Opens or closes the View editor; opening it ends focus mode. */
  const setEditing = (id: string | null): void => {
    setEditingViewId(id)
    if (id !== null) setFocusRequested(false)
  }

  if (phase === 'loading') {
    return (
      <main className="app app--centred">
        <div className="emptyState" role="status">
          <span className="spinner emptyState__spinner" aria-hidden="true" />
          <h1 className="emptyState__title">Starting…</h1>
        </div>
      </main>
    )
  }

  if (phase === 'failed') {
    return (
      <main className="app app--centred">
        <div className="emptyState">
          <span className="emptyState__icon emptyState__icon--error">
            <AlertIcon />
          </span>
          <h1 className="app__title">OverWatch could not start</h1>
          <p className="emptyState__hint" role="alert">
            {loadError?.message ?? 'The app could not read its own state from the main process.'}
          </p>
          <div className="emptyState__actions">
            <button type="button" className="button button--primary" onClick={() => void load()}>
              <RefreshIcon />
              Try again
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <div className="app">
      {/* Focus mode: no header at all, so nothing hidden is still reachable by Tab. */}
      {focusMode ? null : (
        <header className="app__header">
          <h1 className="app__brand">OverWatch</h1>
          <nav className="app__nav">
            <button
              type="button"
              className={navClass(current === 'cameras')}
              aria-current={current === 'cameras' ? 'page' : undefined}
              onClick={() => {
                go('cameras')
              }}
            >
              <CameraIcon />
              Cameras
            </button>
            {accessEnabled ? (
              <button
                type="button"
                className={navClass(current === 'doors')}
                aria-current={current === 'doors' ? 'page' : undefined}
                onClick={() => {
                  go('doors')
                }}
              >
                <DoorIcon />
                Doors
              </button>
            ) : null}
            <button
              type="button"
              className={navClass(current === 'grid')}
              aria-current={current === 'grid' ? 'page' : undefined}
              onClick={() => {
                go('grid')
              }}
            >
              <GridIcon />
              Live
            </button>
          </nav>
          <ConnectionBadge
            onOpenSettings={() => {
              go('settings')
            }}
          />
          {/* Settings is not a nav tab (P5.8): an icon-only button at the header's very end. */}
          <button
            type="button"
            className={`${navClass(current === 'settings')} app__navButton--icon`}
            aria-label="Settings"
            title="Settings"
            aria-current={current === 'settings' ? 'page' : undefined}
            onClick={() => {
              go('settings')
            }}
          >
            <GearIcon />
          </button>
        </header>
      )}
      {/* The grid fills the body and must never scroll (VIEW-5); the other screens may. */}
      {/* Keyed by screen, so each screen opens scrolled to the top rather than where the last one
          was left (Settings scrolls with the body since P5.8). */}
      <main
        key={current}
        className={current === 'grid' ? 'app__body app__body--fill' : 'app__body'}
      >
        {current === 'cameras' ? (
          <CameraList
            onOpenSettings={() => {
              go('settings')
            }}
          />
        ) : current === 'doors' ? (
          <DoorsScreen
            onOpenSettings={() => {
              go('settings')
            }}
          />
        ) : current === 'grid' ? (
          <LiveScreen
            editingViewId={editingViewId}
            onEditingChange={setEditing}
            focusMode={focusMode}
            onFocusModeChange={setFocusRequested}
            onOpenSettings={() => {
              go('settings')
            }}
            onOpenCameras={() => {
              go('cameras')
            }}
          />
        ) : (
          <SettingsPage />
        )}
      </main>
      <ConfirmHost />
      {/* Outcomes of actions away from any form, e.g. a cell's unlock (P5.4). */}
      <ToastHost />
    </div>
  )
}
