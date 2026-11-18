// Which cached snapshot, if any, a player's placeholder may draw behind its spinner (CAM-3, UX
// polish): pure and unit-tested (no jsdom here, CLAUDE.md); `<LivePlayer>` applies it against the
// shared cache (state/thumbnailsStore).
//
// The rules:
//  - **Only while connecting** (`kind: 'connecting'`: asking for the stream or waiting for its first
//    frame). The image is drawn dimmed and blurred *under* the spinner and its "Connecting…" label
//    (player.css), so the wall does not flash empty boxes and a still can never pass for live video.
//    Every other placeholder — offline, the console's own "camera connecting", the gateway down, an
//    error — stays an icon on the plain cell: an old picture behind "Camera offline" would say the
//    opposite of the label.
//  - **Only what is already cached.** Nothing is fetched for it, now or later: no request, no timer,
//    no polling (CAM-1). A camera nobody has opened the Cameras tab or the View editor for simply
//    has no image, and connects on the plain cell as before. The cache drops a camera's image when
//    it goes offline or leaves (CAM-3, thumbnailsStore's sync), so there is never one to show for a
//    camera that is not online.
//  - **The channel the cell plays.** A package-channel cell (CAM-4) shows the package snapshot, kept
//    in its own record; any other quality shows the main-channel thumbnail.
//  - A cached image is used **whatever its age**, like the View editor's (VIEW-3): it is a hint of
//    what is coming, replaced by the live picture within a second.
import { PACKAGE_CHANNEL, type StreamQuality } from '@shared/quality'
import type { PackageSnapshots, ThumbnailEntry } from '../state/camerasStore'
import type { PlayerPlaceholder } from './playerMachine'

/** A cached image, ready to draw. */
export type PlaceholderSnapshot = Extract<ThumbnailEntry, { status: 'ready' }>

/**
 * The cache entry to draw behind `placeholder`, or `null` for the plain cell. Returns the cache's
 * own object, so a store selector built on this is stable while the entry is.
 */
export function placeholderSnapshot(
  placeholder: PlayerPlaceholder | null,
  cameraId: string,
  quality: StreamQuality,
  entries: Readonly<Record<string, ThumbnailEntry>>,
  packages: PackageSnapshots,
): PlaceholderSnapshot | null {
  if (placeholder?.kind !== 'connecting') return null
  // The package channel has its own snapshots.
  const entry = quality === PACKAGE_CHANNEL ? packages[cameraId] : entries[cameraId]
  return entry?.status === 'ready' ? entry : null
}
