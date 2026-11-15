// The screen the app opens on (CON-1, CON-4, VIEW-6), decided once by App.tsx after the first load.
// Its own module so the rule is a pure function the tests can call without React.
//
//  - **Settings** while there is no console address: a fresh install has nothing to show anywhere
//    else (CON-1).
//  - **Live** when main is connecting by itself at this launch (`console.connectOnLaunch`, CON-4)
//    and there is a View to show: the user left a working wall, so they get it back. Live shows the
//    stored `lastViewId` with VIEW-6's fallback to the first View (`useActiveView`), so "the last
//    grid" needs nothing more here.
//  - **Cameras** otherwise: nothing is live yet, or there is no View to open, and the camera list is
//    where both a connect and a first View start.
//
// The flag is the stored one, read before main's launch connect has had its answer. A launch connect
// that then fails still leaves the user on Live, where the setup notices and the badge say why —
// the same place a later outage would leave them.
import type { SecretsStored } from '@shared/ipc'
import type { Settings } from '@shared/models'

export type Screen = 'cameras' | 'grid' | 'settings'

/**
 * The first screen for `settings` as loaded; `null` (no settings) is treated as a fresh install.
 *
 * Live needs the same offline preconditions main's launch connect checks besides the flag — a
 * stored Protect key and an accepted Protect pin — so a launch that main skips (a keystore reset, a
 * hand-cleared pin) opens on Cameras, where the setup gap is explained, not on an empty Live.
 */
export function initialScreen(settings: Settings | null, secretsStored: SecretsStored): Screen {
  if (settings === null || settings.console.host === '') return 'settings'
  const launchConnects =
    settings.console.connectOnLaunch &&
    secretsStored.protectApiKey &&
    settings.console.certFingerprint !== null
  if (launchConnects) return settings.views.length > 0 ? 'grid' : 'cameras'
  return 'cameras'
}
