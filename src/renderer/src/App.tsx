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
// The connection indicator lives in the header, outside the switch: CON-5 asks for it to be visible
// at all times, not only on the Settings screen.
import { useEffect, useState, type JSX } from 'react'
import { CameraList } from './features/cameras/CameraList'
import { LiveScreen } from './features/grid/LiveScreen'
import { SettingsPage } from './features/settings/SettingsPage'
import { ConnectionBadge } from './features/status/ConnectionBadge'
import { initialScreen, type Screen } from './initialScreen'
import { navClass } from './navClass'
import { useAppStore } from './state/appStore'
import { blockUnload, confirmLeave } from './state/unsavedGuard'
import { ConfirmHost, confirmDialog } from './ui/ConfirmDialog'
import { CameraIcon, GearIcon, GridIcon, RefreshIcon } from './ui/icons'

export function App(): JSX.Element {
  const phase = useAppStore((s) => s.phase)
  const loadError = useAppStore((s) => s.loadError)
  const version = useAppStore((s) => s.version)
  const load = useAppStore((s) => s.load)
  const subscribe = useAppStore((s) => s.subscribe)

  const [screen, setScreen] = useState<Screen | null>(null)
  // The id of the View the editor is on, or `null` when not editing (see the header).
  const [editingViewId, setEditingViewId] = useState<string | null>(null)

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

  // Settings until the load says otherwise (see the effect above).
  const current = screen ?? 'settings'

  /** Switches screens, unless that would drop unsaved editor changes the user wants to keep. */
  const go = (next: Screen): void => {
    if (next === current) return
    void confirmLeave(confirmDialog).then((leave) => {
      if (leave) setScreen(next)
    })
  }

  if (phase === 'loading') {
    return (
      <main className="app app--centred">
        <p className="app__muted">Starting…</p>
      </main>
    )
  }

  if (phase === 'failed') {
    return (
      <main className="app app--centred">
        <h1 className="app__title">View Protect</h1>
        <p className="app__error">
          {loadError?.message ?? 'The app could not read its own state from the main process.'}
        </p>
        <button type="button" className="button button--primary" onClick={() => void load()}>
          <RefreshIcon />
          Try again
        </button>
      </main>
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__brand">View Protect</h1>
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
          <button
            type="button"
            className={navClass(current === 'settings')}
            aria-current={current === 'settings' ? 'page' : undefined}
            onClick={() => {
              go('settings')
            }}
          >
            <GearIcon />
            Settings
          </button>
        </nav>
        <ConnectionBadge />
        <span className="app__version">v{version}</span>
      </header>
      {/* The grid fills the body and must never scroll (VIEW-5); the other screens may. */}
      <main className={current === 'grid' ? 'app__body app__body--fill' : 'app__body'}>
        {current === 'cameras' ? (
          <CameraList
            onOpenSettings={() => {
              go('settings')
            }}
          />
        ) : current === 'grid' ? (
          <LiveScreen
            editingViewId={editingViewId}
            onEditingChange={setEditingViewId}
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
    </div>
  )
}
