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
//  - **A multi-camera cell shows the camera its scheduler picks** (P4.2; CELL-2, FILL-3). Which one
//    is `shown` — slot key → position in the cell's `cameraIds`, from `useCellSchedulers` — and a
//    cell without an entry (one camera, or no scheduler yet) shows its first. A position out of
//    range falls back to the first too, so a stale map can never draw nothing. The chosen ref then
//    goes through exactly the camera / missing / package rules below: a camera in the cell that is
//    no longer on the console simply takes its turn in the rotation as "Camera not found", because
//    the scheduler runs over the View's `cameraIds` as stored. Every camera and missing slot
//    carries its `position` (`index` of `count`) for the overlay's `2/4` and next / previous
//    (P4.3), so a missing camera in a multi-camera cell can be stepped past too.
//  - **Keys follow the cell's first camera, not the one shown.** A camera slot is keyed by its
//    **first** ref plus how many times that ref has already been some cell's first in the View
//    (`<ref>#<n>`, {@link cellSlotKeys}). Not the shown camera: then every rotation would change the
//    key and remount the cell, and the scheduler — keyed the same way (`schedulerEntries`, one
//    helper so the two cannot drift) — would lose its state with it. Following a camera still keeps
//    a View switch cheap: a camera that leads a cell in both Views keeps its `<LivePlayer>` mounted
//    — React moves it to its new rectangle instead of closing one stream and opening another — and
//    the same camera leading two cells in one View still gets two distinct keys. Empty slots have
//    no identity of their own and are keyed by position.
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
//    cell gets with it cleared (`resolveGridQuality` with a `null` cell level — the "Default
//    (X)" option). The persisted cell is named by `placement`'s top-left slot (`setCellQuality`,
//    features/quality/qualityChoice.ts). A package ref has no picker (`qualityChoice: null`): the
//    package channel is a source, not a quality, so there is nothing to pick.
//  - **…and the camera to pre-warm, if any** (P4.4; ARCHITECTURE §3): the ref the cell's next
//    rotation step will show (`prewarm`, from `useCellSchedulers`), resolved by the same camera /
//    missing / package rules, to the camera id and the quality it will play at once shown — the
//    package channel for a package ref, else the cell's grid quality — so the hidden player is
//    asked for exactly the stream the visible one will want, and the switch needs no swap. No
//    pre-warm for a ref that would be a `missing` slot (it asks for no stream), nor for the camera
//    already shown (`<id>` and `<id>:package` side by side: that switch is the player's own quality
//    swap, QUAL-6). A missing slot carries none: its placeholder has no player to hand over.
//  - **…and whether it can be heard** (P5.1; AUD-1): the camera has a mic, it is on and the camera
//    is connected (`cameraCanBeHeard`, features/audio/cameraAudio.ts; user decision 2026-11-16), which
//    is what shows the cell's mute toggle — and a heard cell whose camera drops is muted. Never for a
//    package ref: the package channel is a picture source (like its missing quality picker says),
//    the mic flags belong to the doorbell's main camera, and whether the package stream carries that
//    audio at all is unverified — so the doorbell is heard from its own cell. This also keeps the
//    audio rule's identity (slot + camera id) exact, since a package ref shares its camera's id: a
//    switch between `<id>` and `<id>:package` in one cell still mutes, because the package side is
//    never an audio source.
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
import { cameraCanBeHeard } from '../audio/cameraAudio'
import type { SchedulerEntry } from '../cells/schedulerSet'

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
      /** Which of the cell's cameras this is (CELL-2; the overlay's `2/4`, P4.3). */
      readonly position: SlotPosition
      /** P4.4: the camera the next rotation step will show, to open hidden now; `null` for none. */
      readonly prewarm: SlotPrewarm | null
      /** AUD-1: a mic, on, and the camera connected; never for a package ref (header). */
      readonly audio: boolean
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
      /** Which of the cell's cameras this is (CELL-2; the overlay's `2/4`, P4.3). */
      readonly position: SlotPosition
    }
  | { readonly kind: 'empty'; readonly key: string; readonly placement: CellPlacement }

/** The shown ref's place in its cell: `index` into `cameraIds`, of `count` (1 for a one-camera cell). */
export interface SlotPosition {
  readonly index: number
  readonly count: number
}

/** A camera to open hidden in a slot ahead of its rotation step (P4.4, header). */
export interface SlotPrewarm {
  readonly cameraId: string
  /** What it will play once shown in the grid: the cell's grid quality, or the package channel. */
  readonly quality: StreamQuality
}

/** What a camera slot's quality picker shows (QUAL-3/4). */
export interface SlotQualityChoice {
  /** The cell's own `quality`: `null` when it inherits (the picker's "Default" option). */
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

/**
 * The key of each of `view.cells`' slots, in order: {@link cameraSlotKey} of the cell's **first**
 * ref and that ref's occurrence as a first ref so far, or `null` for a cell without cameras (keyed
 * by {@link emptySlotKey} instead). The one place the key is computed, for both
 * {@link buildViewSlots} and {@link schedulerEntries} (header).
 */
export function cellSlotKeys(view: Pick<View, 'cells'>): (string | null)[] {
  const seen = new Map<string, number>()
  return view.cells.map((cell) => {
    const first = cell.cameraIds[0]
    if (first === undefined) return null
    const occurrence = seen.get(first) ?? 0
    seen.set(first, occurrence + 1)
    return cameraSlotKey(first, occurrence)
  })
}

/**
 * The View's camera cells as scheduler entries (P4.2; CELL-2): each cell with cameras under its slot
 * key. `syncSchedulerSet` gives the ones with two or more cameras a scheduler.
 */
export function schedulerEntries(view: Pick<View, 'cells'>): SchedulerEntry[] {
  const keys = cellSlotKeys(view)
  const entries: SchedulerEntry[] = []
  view.cells.forEach((cell, i) => {
    const key = keys[i]
    if (key !== undefined && key !== null) entries.push({ key, cell })
  })
  return entries
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
  /**
   * CELL-2: slot key → position in that cell's `cameraIds` to draw (`useCellSchedulers`). A slot
   * not in it, or a position out of range, draws the first camera (header).
   */
  readonly shown?: ReadonlyMap<string, number>
  /**
   * P4.4: slot key → the ref its next rotation step shows (`useCellSchedulers`' `prewarm`). Absent,
   * or a ref that cannot play, pre-warms nothing (header).
   */
  readonly prewarm?: ReadonlyMap<string, string>
}): GridSlot[] {
  const { view, cameras, streams, shown, prewarm } = input
  const byId = new Map(cameras.map((camera) => [camera.id, camera]))
  const keys = cellSlotKeys(view)
  return view.cells.map((cell, i): GridSlot => {
    const placement: CellPlacement = {
      col: cell.col,
      row: cell.row,
      colSpan: cell.colSpan,
      rowSpan: cell.rowSpan,
    }
    const key = keys[i] ?? null
    if (key === null) return { kind: 'empty', key: emptySlotKey(placement), placement }

    const count = cell.cameraIds.length
    const wanted = shown?.get(key) ?? 0
    const index = Number.isInteger(wanted) && wanted >= 0 && wanted < count ? wanted : 0
    const position: SlotPosition = { index, count }
    // `key` is non-null only for a cell with cameras, so the shown ref exists.
    const refText = cell.cameraIds[index] ?? ''

    const ref = parseCameraRef(refText)
    const camera = byId.get(ref.cameraId)
    const gridQuality = (r: CameraRef): StreamQuality =>
      r.packageChannel ? PACKAGE_CHANNEL : resolveGridQuality({ cell, view, streams })
    if (camera === undefined) {
      return {
        kind: 'missing',
        key,
        placement,
        ref: refText,
        label: `Camera not found (${refText})`,
        position,
      }
    }
    if (ref.packageChannel && !camera.hasPackageCamera) {
      const label = `No package camera (${cameraDisplayName(camera)})`
      return { kind: 'missing', key, placement, ref: refText, label, position }
    }

    return {
      kind: 'camera',
      key,
      placement,
      cameraId: ref.cameraId,
      name: slotName(camera, ref),
      quality: gridQuality(ref),
      fillQuality: ref.packageChannel ? PACKAGE_CHANNEL : resolveFillQuality({ view, streams }),
      fit: view.fit,
      qualityChoice: ref.packageChannel
        ? null
        : {
            override: cell.quality,
            inherited: resolveGridQuality({ cell: { quality: null }, view, streams }),
          },
      position,
      prewarm: slotPrewarm(prewarm?.get(key), ref.cameraId, byId, gridQuality),
      audio: !ref.packageChannel && cameraCanBeHeard(camera),
    }
  })
}

/**
 * The pre-warm of a camera slot showing `shownCameraId` (header): `wanted` resolved like a shown
 * ref, or `null` when there is none, it would be a missing slot, or it is the camera already shown.
 */
function slotPrewarm(
  wanted: string | undefined,
  shownCameraId: string,
  byId: ReadonlyMap<string, Camera>,
  gridQuality: (ref: CameraRef) => StreamQuality,
): SlotPrewarm | null {
  if (wanted === undefined) return null
  const ref = parseCameraRef(wanted)
  if (ref.cameraId === shownCameraId) return null
  const camera = byId.get(ref.cameraId)
  if (camera === undefined || (ref.packageChannel && !camera.hasPackageCamera)) return null
  return { cameraId: ref.cameraId, quality: gridQuality(ref) }
}
