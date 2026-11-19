// NFR-8 (P6.2): the shell around ./viewVisibility for the one place a View is drawn. `<GridView>`
// calls it, so "the wall is shown" is simply "this hook is mounted" (viewVisibility.ts header): it
// reports on mount, on every `visibilitychange`, and `false` on unmount. No rule lives here.
import { useEffect } from 'react'
import { createViewVisibleReporter, viewOnScreen } from './viewVisibility'

export function useViewVisibleReport(): void {
  useEffect(() => {
    const reporter = createViewVisibleReporter({
      send: (visible) => window.viewProtect.setViewVisible({ visible }),
      warn: (message, detail) => {
        console.warn(message, detail)
      },
    })
    const update = (): void => {
      reporter.update(viewOnScreen({ wallShown: true, visibilityState: document.visibilityState }))
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      reporter.dispose()
    }
  }, [])
}
