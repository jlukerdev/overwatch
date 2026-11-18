// Camera snapshots in the View editor (P5.2; VIEW-3, CAM-1, CAM-4): which image a cell shows, and
// which snapshots the draft still needs fetched. Pure and unit-tested (no jsdom here, CLAUDE.md);
// the editor applies them against the shared cache (state/thumbnailsStore).
//
// The rules (SPEC VIEW-3):
//  - A cell shows the camera at the **head** of its `cameraIds`, only that one: a multi-camera cell
//    is not cycled through, and nothing is fetched for the others.
//  - A plain ref shows the camera's main-channel thumbnail, the very entry the Cameras tab shows; a
//    package ref (`<id>:package`) shows the package-channel snapshot (CAM-4), kept in its own record.
//  - A cached image is reused **whatever its age**; only a camera with no entry at all is fetched,
//    and not while a Cameras-tab load in flight covers it. A `failed` or `unavailable` answer is
//    tried once more each time the editor opens, never again while it stays open.
//  - The editor asks for the snapshot only, never the feed state (QUAL-7 is the Cameras tab's).
//  - Nothing is fetched (and no image shown) for a camera that is missing, not online (CAM-3), or —
//    for a package ref — has no package camera. Those cells stay text-only, as do cells whose
//    snapshot is loading, unavailable or failed.
import type { Camera } from '@shared/ipc'
import { isCameraOnline } from '@shared/models'
import type { ListLoad, PackageSnapshots, ThumbnailEntry } from '../../state/camerasStore'
import { parseCameraRef } from '../grid/gridLayout'

/** The ref a cell shows in the editor: the head of its list, or `null` for an empty cell. */
export function cellShownRef(cell: { readonly cameraIds: readonly string[] }): string | null {
  return cell.cameraIds[0] ?? null
}

/**
 * Which palette entries are in use (P5.2, VIEW-3; user request 2026-11-17): each ref that heads at
 * least one cell, with how many cells it heads. Exact refs, so a doorbell's `<id>` and
 * `<id>:package` count separately; a camera only 2nd or later in a cell's list does not count.
 */
export function inUseRefs(
  cells: readonly { readonly cameraIds: readonly string[] }[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const cell of cells) {
    const ref = cellShownRef(cell)
    if (ref !== null) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  }
  return counts
}

/** A cached image, ready to draw. */
export type ReadySnapshot = Extract<ThumbnailEntry, { status: 'ready' }>

/** Where a ref's snapshot lives, or `null` when it gets none (missing, offline, no package camera). */
interface SnapshotSlot {
  readonly cameraId: string
  readonly packageChannel: boolean
}

function snapshotSlot(ref: string, cameras: readonly Camera[]): SnapshotSlot | null {
  const { cameraId, packageChannel } = parseCameraRef(ref)
  const camera = cameras.find((c) => c.id === cameraId)
  if (camera === undefined || !isCameraOnline(camera.state)) return null
  if (packageChannel && !camera.hasPackageCamera) return null
  return { cameraId, packageChannel }
}

/** What the editor still has to fetch for the draft, split by channel. Each id once, in cell order. */
export interface EditorSnapshotPlan {
  /** Main-channel thumbnails, through the Cameras tab's own request path. */
  readonly cameraIds: readonly string[]
  /** Package-channel snapshots (CAM-4). */
  readonly packageIds: readonly string[]
}

/** Each distinct head ref's snapshot slot, in cell order, for the cells that can have one. */
function headSlots(
  cells: readonly { readonly cameraIds: readonly string[] }[],
  cameras: readonly Camera[],
): SnapshotSlot[] {
  const seen = new Set<string>()
  const slots: SnapshotSlot[] = []
  for (const cell of cells) {
    const ref = cellShownRef(cell)
    if (ref === null) continue
    const slot = snapshotSlot(ref, cameras)
    if (slot === null) continue
    const key = `${slot.cameraId}|${String(slot.packageChannel)}`
    if (seen.has(key)) continue
    seen.add(key)
    slots.push(slot)
  }
  return slots
}

/**
 * Whether a Cameras-tab load in flight (P4.5) covers a main-channel camera, so the editor leaves it
 * to the load rather than ask for it a second time: the load is still reading the inventory (its
 * plan is not known yet, so every camera waits), or its plan includes the camera. Once the load
 * settles, its sheet becomes the committed one, with the camera in it.
 */
function coveredByLoad(load: ListLoad | null, cameraId: string): boolean {
  if (load === null) return false
  return load.outstanding === null || cameraId in load.sheet.entries
}

/**
 * Every distinct head ref of `cells` that can have a snapshot and has **no entry yet** — loading,
 * ready, unavailable and failed all count as an entry, so nothing is asked twice and a failure is
 * not retried on every render (only once, when the editor opens: {@link editorRetryPlan}).
 * `entries` is the committed sheet; a main-channel camera a load in flight covers is skipped.
 */
export function editorSnapshotPlan(
  cells: readonly { readonly cameraIds: readonly string[] }[],
  cameras: readonly Camera[],
  entries: Readonly<Record<string, ThumbnailEntry>>,
  packages: PackageSnapshots,
  load: ListLoad | null = null,
): EditorSnapshotPlan {
  const cameraIds: string[] = []
  const packageIds: string[] = []
  for (const { cameraId, packageChannel } of headSlots(cells, cameras)) {
    if (packageChannel) {
      if (!(cameraId in packages)) packageIds.push(cameraId)
    } else if (!(cameraId in entries) && !coveredByLoad(load, cameraId)) {
      cameraIds.push(cameraId)
    }
  }
  return { cameraIds, packageIds }
}

/**
 * The editor's one retry, when it opens (P5.2): the head cameras of `cells` whose cached answer is
 * `failed` or `unavailable`, per channel. Their entries are forgotten, so {@link editorSnapshotPlan}
 * asks for them again. Only on opening: a failure met while editing is not retried.
 */
export function editorRetryPlan(
  cells: readonly { readonly cameraIds: readonly string[] }[],
  cameras: readonly Camera[],
  entries: Readonly<Record<string, ThumbnailEntry>>,
  packages: PackageSnapshots,
): EditorSnapshotPlan {
  const failed = (entry: ThumbnailEntry | undefined): boolean =>
    entry?.status === 'failed' || entry?.status === 'unavailable'
  const cameraIds: string[] = []
  const packageIds: string[] = []
  for (const { cameraId, packageChannel } of headSlots(cells, cameras)) {
    if (packageChannel) {
      if (failed(packages[cameraId])) packageIds.push(cameraId)
    } else if (failed(entries[cameraId])) {
      cameraIds.push(cameraId)
    }
  }
  return { cameraIds, packageIds }
}

/** The image a cell shows behind its name, or `null` for a text-only cell. */
export function cellSnapshot(
  cell: { readonly cameraIds: readonly string[] },
  cameras: readonly Camera[],
  entries: Readonly<Record<string, ThumbnailEntry>>,
  packages: PackageSnapshots,
): ReadySnapshot | null {
  const ref = cellShownRef(cell)
  if (ref === null) return null
  const slot = snapshotSlot(ref, cameras)
  if (slot === null) return null
  const entry = slot.packageChannel ? packages[slot.cameraId] : entries[slot.cameraId]
  return entry?.status === 'ready' ? entry : null
}
