// What a View puts on screen (P3.2; VIEW-1/2/5/7, CELL-1, CAM-4, QUAL-3): one positioned slot per
// cell, with the camera, the effective quality, the name and the fit already decided. Pure, so it is
// tested in the node environment (this project has no jsdom; CLAUDE.md) and `<GridView>` only has
// to measure its box and place what comes back.
//
// The geometry itself — the letterboxed grid and each cell's rectangle — is `layoutGrid` /
// `cellRect` in @shared/viewLayout. This module decides *what* goes in each rectangle; the component
// decides *where*, from the placement carried on each slot.
//
// Decisions made here, each for a reason:
//
//  - **One camera per cell, for now.** A cell shows `cameraIds[0]`. Multi-camera cells (rotation and
//    motion switching, CELL-2) are Phase 4's `cellScheduler`; until then the other cameras in a cell
//    are kept in the View and simply not shown.
//  - **Keys follow the camera, not the cell.** A camera slot is keyed by its ref plus how many times
//    that ref has already appeared in the View (`<ref>#<n>`), so switching to another View that also
//    shows the camera keeps its `<LivePlayer>` mounted — React moves it to its new rectangle instead
//    of closing one stream and opening another — and the same camera twice in one View still gets
//    two distinct keys. Empty slots have no identity of their own and are keyed by position.
//  - **A camera that is no longer on the console** (removed or unadopted since the View was built,
//    CAM-2) gets a `missing` slot: drawn as an empty cell with a label naming the id, and **no
//    player**. A player would ask main for a stream that cannot exist and retry it forever, and its
//    placeholder would say "Connecting…" about a camera that is never coming back. The Live screen
//    only draws a View once the inventory has loaded (`cameraListBody`), so "not in the inventory"
//    really does mean gone, not "not fetched yet". If the camera comes back, the slot becomes a
//    camera slot again on the next inventory push.
//  - **A package ref to a camera without a package camera** (`<id>:package` where the camera's
//    `hasPackageCamera` is false — the doorbell was replaced, or the View was hand-edited) is a
//    `missing` slot too, for the same reason: main refuses a package stream for that camera
//    (streams/registry.ts), so a player would only ever show an error. It keeps its camera key, so
//    it becomes a player again if the flag comes back.
//  - **Every camera slot carries its fill quality too** (P3.5; FILL-2, QUAL-5), so the grid can
//    flip a filled cell's `quality` prop without resolving anything itself: `resolveFillQuality`
//    (View, then settings — fill has no per-cell level) for a camera, and the package channel again
//    for a package ref, because that is a different source rather than a quality to upgrade.
//  - **…and what its quality picker needs** (P3.7; QUAL-4): the cell's own override and what the
//    cell gets with it cleared (`resolveGridQuality` with a `null` cell level — the "View default
//    (X)" option). The persisted cell is named by `placement`'s top-left slot (`setCellQuality`,
//    features/quality/qualityChoice.ts). A package ref has no picker (`qualityChoice: null`): the
//    package channel is a source, not a quality, so there is nothing to pick.
import type { Camera } from '@shared/ipc'
import type { Fit, View } from '@shared/models'
import {
  PACKAGE_CHANNEL,
  resolveFillQuality,
  resolveGridQuality,
  type Quality,
  type QualityDefaults,
  type StreamQuality,
} from '@shared/quality'
import type { CellPlacement } from '@shared/viewLayout'
import { cameraDisplayName } from '../../state/camerasStore'

// -------------------------------------------------------------------------------------------------
// Camera refs (CAM-4)

/** What a `cameraIds` entry points at: a camera, or a doorbell's package channel. */
export interface CameraRef {
  /** The Protect camera id — the one the inventory and `ensureStream` know. */
  readonly cameraId: string
  /** `true` for `<cameraId>:package` (CAM-4): play the camera's {@link PACKAGE_CHANNEL} stream. */
  readonly packageChannel: boolean
}

const PACKAGE_SUFFIX = `:${PACKAGE_CHANNEL}`

/** The ref of a camera's package channel (CAM-4): `<cameraId>:package`, as `parseCameraRef` reads it. */
export function packageRef(cameraId: string): string {
  return `${cameraId}${PACKAGE_SUFFIX}`
}

/**
 * Splits a cell's camera ref. Only the exact suffix `:package` with a non-empty id before it is the
 * package channel; anything else is a plain camera id, passed through as is (Protect ids are hex and
 * never contain a colon, so nothing real is misread).
 */
export function parseCameraRef(ref: string): CameraRef {
  if (ref.length > PACKAGE_SUFFIX.length && ref.endsWith(PACKAGE_SUFFIX)) {
    return { cameraId: ref.slice(0, -PACKAGE_SUFFIX.length), packageChannel: true }
  }
  return { cameraId: ref, packageChannel: false }
}

// -------------------------------------------------------------------------------------------------
// Slots

/** One cell of the active View, ready to draw. `placement` is what `cellRect` positions. */
export type GridSlot =
  | {
      readonly kind: 'camera'
      readonly key: string
      readonly placement: CellPlacement
      readonly cameraId: string
      readonly name: string
      /** The **effective** stream: QUAL-3's chain, or the package channel (CAM-4). Never a literal. */
      readonly quality: StreamQuality
      /**
       * The stream when this cell is filled (FILL-2): QUAL-5's chain, or the package channel again
       * for a package ref. Never a literal.
       */
      readonly fillQuality: StreamQuality
      /** VIEW-5: how the camera sits in its cell when its shape is not the View's `aspect`. */
      readonly fit: Fit
      /** QUAL-4's picker for this cell, or `null` for a package ref, which has none (header). */
      readonly qualityChoice: SlotQualityChoice | null
    }
  | {
      /**
       * Nothing to play: the cell names a camera the inventory no longer has, or the package
       * channel of a camera without one (see the header).
       */
      readonly kind: 'missing'
      readonly key: string
      readonly placement: CellPlacement
      readonly ref: string
      /** What the cell says instead of a picture, e.g. `Camera not found (<ref>)`. */
      readonly label: string
    }
  | { readonly kind: 'empty'; readonly key: string; readonly placement: CellPlacement }

/** What a camera slot's quality picker shows (QUAL-3/4). */
export interface SlotQualityChoice {
  /** The cell's own `quality`: `null` when it inherits (the picker's "View default" option). */
  readonly override: Quality | null
  /** What the cell plays with its override cleared: `view.gridQuality ?? streams.defaultGridQuality`. */
  readonly inherited: Quality
}

/**
 * The key of a camera (or missing-camera) slot: the ref and its occurrence index in the View. The
 * prefix keeps it apart from {@link emptySlotKey}, whatever a ref contains.
 */
export function cameraSlotKey(ref: string, occurrence: number): string {
  return `cam:${ref}#${String(occurrence)}`
}

/** The key of an empty slot: its top-left slot, which is unique within a tiled View. */
export function emptySlotKey(placement: Pick<CellPlacement, 'col' | 'row'>): string {
  return `empty:${String(placement.col)},${String(placement.row)}`
}

/** A package-channel cell is labelled as such, so it cannot be mistaken for the main camera. */
function slotName(camera: Camera, ref: CameraRef): string {
  const name = cameraDisplayName(camera)
  return ref.packageChannel ? `${name} (package)` : name
}

/**
 * The View's cells as slots, in the View's own cell order (canonical: row, then column).
 *
 * Quality is `resolveGridQuality({ cell, view, streams })` for a camera, and the package channel
 * for a `<cameraId>:package` ref — the package camera is a separate source, not a quality setting,
 * so the quality chain does not apply to it (src/shared/quality.ts). `fillQuality` is the same with
 * `resolveFillQuality({ view, streams })` (FILL-2, QUAL-5).
 */
export function buildViewSlots(input: {
  readonly view: View
  readonly cameras: readonly Camera[]
  readonly streams: QualityDefaults
}): GridSlot[] {
  const { view, cameras, streams } = input
  const byId = new Map(cameras.map((camera) => [camera.id, camera]))
  const seen = new Map<string, number>()
  return view.cells.map((cell): GridSlot => {
    const placement: CellPlacement = {
      col: cell.col,
      row: cell.row,
      colSpan: cell.colSpan,
      rowSpan: cell.rowSpan,
    }
    // Phase 4 (CELL-2) rotates through the rest; until then a cell shows its first camera.
    const first = cell.cameraIds[0]
    if (first === undefined) return { kind: 'empty', key: emptySlotKey(placement), placement }

    const occurrence = seen.get(first) ?? 0
    seen.set(first, occurrence + 1)
    const key = cameraSlotKey(first, occurrence)

    const ref = parseCameraRef(first)
    const camera = byId.get(ref.cameraId)
    if (camera === undefined) {
      return { kind: 'missing', key, placement, ref: first, label: `Camera not found (${first})` }
    }
    if (ref.packageChannel && !camera.hasPackageCamera) {
      const label = `No package camera (${cameraDisplayName(camera)})`
      return { kind: 'missing', key, placement, ref: first, label }
    }

    return {
      kind: 'camera',
      key,
      placement,
      cameraId: ref.cameraId,
      name: slotName(camera, ref),
      quality: ref.packageChannel ? PACKAGE_CHANNEL : resolveGridQuality({ cell, view, streams }),
      fillQuality: ref.packageChannel ? PACKAGE_CHANNEL : resolveFillQuality({ view, streams }),
      fit: view.fit,
      qualityChoice: ref.packageChannel
        ? null
        : {
            override: cell.quality,
            inherited: resolveGridQuality({ cell: { quality: null }, view, streams }),
          },
    }
  })
}
