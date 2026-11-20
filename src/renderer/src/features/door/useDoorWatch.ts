// DOOR-6 (P5.5): tells main when the Live screen has door state to show, so main reads the doors
// only then. Mounted once, by the Live wall (features/grid/LiveScreen.tsx `LiveWall`): not by
// Settings, the Cameras screen or the View editor, which replace the wall and so stop the watch.
//
// The rule is ./doorLink's `shouldWatchDoors`, computed inside the store selector so this hook sees
// one boolean: an unrelated store change (a camera's state, the connection status) or a re-render
// does not re-run the effect. It calls `watchDoors(true)` when the answer becomes true, and
// `watchDoors(false)` when it becomes false or the wall unmounts. Under React StrictMode's
// mount–unmount–mount that is true, false, true: the last word is the right one, and the store
// folds in only the latest call's answer (state/appStore.ts).
//
// A start that fails (main still starting, a bridge error) is retried while the hook still wants
// to watch — ./doorWatchRetry has the policy and its tests; the stop is never retried.
//
// This only reads. Nothing here, and no pushed state, can send an unlock (DOOR-4).
import { useEffect } from 'react'
import type { View } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { accessActive, shouldWatchDoors, viewCameraRefs } from './doorLink'
import { startDoorWatch } from './doorWatchRetry'

/** `activeView`: the View the wall is showing (`useActiveView()`, read once by the Live screen). */
export function useDoorWatch(activeView: View | null): void {
  const watch = useAppStore((s) =>
    shouldWatchDoors({
      // Never in RTSP mode (MODE-4): no Access call of any kind there.
      accessEnabled: accessActive(s.settings),
      doorLinks: s.settings?.doorLinks,
      viewCameraRefs: viewCameraRefs(activeView),
    }),
  )
  const watchDoors = useAppStore((s) => s.watchDoors)
  useEffect(() => {
    if (!watch) return undefined
    // The store turns a failure into an empty map (every door neutral); the session asks again.
    return startDoorWatch({
      watchDoors,
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (timer) => {
        window.clearTimeout(timer)
      },
    })
  }, [watch, watchDoors])
}
