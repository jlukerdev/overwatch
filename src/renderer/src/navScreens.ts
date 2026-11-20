// Which screens the header's nav offers (MODE-3, DOOR-0), as a pure rule App.tsx draws and the
// tests call without React. Settings is not here: it is the gear button at the header's end and
// exists in both modes.
//
//  - **Protect mode:** Cameras, then Doors while the **saved** Access switch is on (DOOR-0: with
//    Access off there is no Doors screen at all), then Live.
//  - **RTSP mode:** Streams, then Live. Cameras and Doors are UniFi features and do not exist.
//
// A screen that is not in the list for the current mode is not reachable either: App.tsx moves a
// stale choice (Doors after Access goes off, Cameras or Streams after a mode switch) to Settings.
import type { AppMode } from '@shared/models'
import type { Screen } from './initialScreen'

/** A screen the nav has a button for: every one but Settings. */
export type NavScreen = Exclude<Screen, 'settings'>

/** The nav buttons, in header order, for `mode` and the saved Access switch. */
export function navScreens(mode: AppMode, accessEnabled: boolean): NavScreen[] {
  if (mode === 'rtsp') return ['streams', 'grid']
  return accessEnabled ? ['cameras', 'doors', 'grid'] : ['cameras', 'grid']
}

/** Whether `screen` can show in `mode`: Settings always, anything else only from the nav. */
export function screenAvailable(screen: Screen, mode: AppMode, accessEnabled: boolean): boolean {
  return screen === 'settings' || navScreens(mode, accessEnabled).includes(screen)
}
