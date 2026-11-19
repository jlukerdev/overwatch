// P5.6 (DOOR-6 extended): tells main while the Doors screen is open, so main reads every door, the
// lock rules and the emergency status only then. Mounted once, by `<DoorsScreen>`: opening the
// screen sends `watchDoorsScreen(true)`, leaving it sends `watchDoorsScreen(false)`. Under React
// StrictMode's mount–unmount–mount that is true, false, true: the last word is the right one, and
// the store folds in only the latest call's answer (state/appStore.ts), which is also what keeps a
// late answer from overwriting a newer push.
//
// An open that fails (main still starting answers `not-ready`; a bridge error) is asked again
// while the screen is still showing: after 2 s, then every 5 s. That is the Live screen's door
// watch session, reused as it is (features/door/doorWatchRetry.ts, with its tests) — it only needs
// a "start / stop" call that answers `ok`. The close is never retried.
//
// **Refresh** is the returned function: it ends the session and starts a new one, i.e.
// `open: false` then `open: true`. Main forgets what it knew on the close and reads everything
// again at once on the open, so there is no separate "read now" channel; the screen shows its
// loading state for the moment in between.
//
// This only reads. Nothing here, and no pushed state, can act on a door (DOOR-4).
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { startDoorWatch } from '../door/doorWatchRetry'

/** Keeps main's Doors screen watch open while mounted; returns Refresh (header). */
export function useDoorsScreenWatch(): () => void {
  const watchDoorsScreen = useAppStore((s) => s.watchDoorsScreen)
  // Bumped by Refresh: the effect below closes its session and opens the next.
  const [session, setSession] = useState(0)
  useEffect(
    () =>
      startDoorWatch({
        watchDoors: watchDoorsScreen,
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (timer) => {
          window.clearTimeout(timer)
        },
      }),
    [watchDoorsScreen, session],
  )
  return useCallback(() => {
    setSession((current) => current + 1)
  }, [])
}
