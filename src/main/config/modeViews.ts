// Per-mode Views (MODE-4): each app mode keeps its own View list and its own last View, so a
// Protect View never names an RTSP stream and an RTSP View never names a Protect camera.
//
// Where they are stored (SPEC §6): the Protect mode's pair is the top-level `views` / `lastViewId`
// (where they were before modes existed, so an existing install loads unchanged, MODE-1), and the
// RTSP mode's pair is `rtsp.views` / `rtsp.lastViewId`.
//
// What the renderer sees: **only the active mode's pair**, under the top-level names. The View
// switcher, editor and grid were written for `settings.views` / `settings.lastViewId` and work on
// either list unchanged. The other mode's list never crosses IPC — and neither does a duplicate of
// the active RTSP list under `rtsp.views`: `settingsForRenderer` sends the `rtsp` block with an
// empty list and a null last View, so the renderer has exactly one place to read Views from.
//
// Pure, no Electron, no I/O: generic over anything shaped like `Settings`, so it serves both the
// stored `Config` (which adds `schemaVersion`) and the `Settings` the renderer is shown.
import type { AppMode, Settings, View } from '@shared/models'

/** One mode's Views and the View it last showed (VIEW-3/6). */
export interface ModeViews {
  readonly views: View[]
  readonly lastViewId: string | null
}

/** The fields this module reads and writes. `mode` decides which pair is meant. */
type ModeViewsHolder = Pick<Settings, 'mode' | 'views' | 'lastViewId' | 'rtsp'>

/** The Views and last View of `mode`, whatever mode is active. */
export function viewsOf(config: ModeViewsHolder, mode: AppMode): ModeViews {
  return mode === 'rtsp'
    ? { views: config.rtsp.views, lastViewId: config.rtsp.lastViewId }
    : { views: config.views, lastViewId: config.lastViewId }
}

/** The active mode's Views and last View (MODE-4). */
export function activeViews(config: ModeViewsHolder): ModeViews {
  return viewsOf(config, config.mode)
}

/**
 * `config` with `patch` written into `mode`'s pair, and only the fields `patch` has: an absent
 * field keeps its stored value (a `setLastView` writes `lastViewId` alone). The other mode's pair is
 * never touched. A new object; `config` is not mutated.
 */
export function withViewsOf<T extends ModeViewsHolder>(
  config: T,
  mode: AppMode,
  patch: Partial<ModeViews>,
): T {
  const fields = {
    ...(patch.views === undefined ? {} : { views: patch.views }),
    ...(patch.lastViewId === undefined ? {} : { lastViewId: patch.lastViewId }),
  }
  if (mode === 'rtsp') return { ...config, rtsp: { ...config.rtsp, ...fields } }
  return { ...config, ...fields }
}

/** {@link withViewsOf} for the active mode: where `vp:views/*` writes go (MODE-4). */
export function withActiveViews<T extends ModeViewsHolder>(
  config: T,
  patch: Partial<ModeViews>,
): T {
  return withViewsOf(config, config.mode, patch)
}

/**
 * What `AppState.settings` carries (MODE-4): the active mode's Views and last View under the
 * top-level names, and the `rtsp` block with **no** Views (`views: []`, `lastViewId: null`), so the
 * inactive list never crosses IPC and the active RTSP list does not cross twice. `rtsp.streams`
 * goes as it is: names and ids only, the URLs are in secrets.bin (RTSP-2). Everything else is
 * unchanged. A new object; `settings` is not mutated.
 */
export function settingsForRenderer(settings: Settings): Settings {
  const active = activeViews(settings)
  return {
    ...settings,
    views: active.views,
    lastViewId: active.lastViewId,
    rtsp: { ...settings.rtsp, views: [], lastViewId: null },
  }
}
