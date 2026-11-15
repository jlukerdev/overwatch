// App shell (P1.5): the one place that loads `AppState`, subscribes to main's pushes, and switches
// between the screens. Routing is a piece of state rather than a router — the prototype has two
// screens in Phase 1 and the Views come in Phase 3 (VIEW-1), so a URL would buy nothing.
//
// The third screen is Live (`LiveScreen`, P3.2): the View switcher and the active View. It is never
// the default screen — nothing connects on launch (CON-4), so it would open on "No cameras".
//
// The connection indicator lives in the header, outside the switch: CON-5 asks for it to be visible
// at all times, not only on the Settings screen.
import { useEffect, useState, type JSX } from 'react'
import { CameraList } from './features/cameras/CameraList'
import { LiveScreen } from './features/grid/LiveScreen'
import { SettingsPage } from './features/settings/SettingsPage'
import { ConnectionBadge } from './features/status/ConnectionBadge'
import { navClass } from './navClass'
import { useAppStore } from './state/appStore'

type Screen = 'cameras' | 'grid' | 'settings'

export function App(): JSX.Element {
  const phase = useAppStore((s) => s.phase)
  const loadError = useAppStore((s) => s.loadError)
  const version = useAppStore((s) => s.version)
  const load = useAppStore((s) => s.load)
  const subscribe = useAppStore((s) => s.subscribe)

  const [screen, setScreen] = useState<Screen | null>(null)

  useEffect(() => {
    // Subscribe before loading, so a status change that arrives during the load is not missed: the
    // store counts the pushes and keeps the newer of the two.
    const unsubscribe = subscribe()
    void (async () => {
      await load()
      // A fresh install has no host yet (CON-1), so there is nothing to show on the camera screen:
      // open Settings instead. Decided **once**, here, from the state that just landed — deriving it
      // from `host` on every render would move the user off Settings the moment they saved a host,
      // unmounting the form, the certificate panel and the re-pin confirmation mid-setup. The
      // updater keeps a choice the user managed to make while the load was still running.
      const host = useAppStore.getState().settings?.console.host ?? ''
      setScreen((chosen) => chosen ?? (host === '' ? 'settings' : 'cameras'))
    })()
    return unsubscribe
  }, [load, subscribe])

  // Settings until the load says otherwise (see the effect above).
  const current = screen ?? 'settings'

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
        <button type="button" className="button" onClick={() => void load()}>
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
              setScreen('cameras')
            }}
          >
            Cameras
          </button>
          <button
            type="button"
            className={navClass(current === 'grid')}
            aria-current={current === 'grid' ? 'page' : undefined}
            onClick={() => {
              setScreen('grid')
            }}
          >
            Live
          </button>
          <button
            type="button"
            className={navClass(current === 'settings')}
            aria-current={current === 'settings' ? 'page' : undefined}
            onClick={() => {
              setScreen('settings')
            }}
          >
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
              setScreen('settings')
            }}
          />
        ) : current === 'grid' ? (
          <LiveScreen
            onOpenSettings={() => {
              setScreen('settings')
            }}
            onOpenCameras={() => {
              setScreen('cameras')
            }}
          />
        ) : (
          <SettingsPage />
        )}
      </main>
    </div>
  )
}
