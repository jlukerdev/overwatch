// App shell: routing between Live, Settings, View Editor.
// P0.1: placeholder shell showing the app name and version from the preload bridge.
import type { JSX } from 'react'

export function App(): JSX.Element {
  return (
    <main className="app">
      <h1 className="app__title">View Protect</h1>
      <p className="app__version">v{window.viewProtect.version}</p>
    </main>
  )
}
