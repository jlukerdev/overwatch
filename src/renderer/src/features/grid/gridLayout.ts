// The grid's decisions (P2.4; VIEW-1, VIEW-5, CELL-1, QUAL-3), as pure functions over plain data,
// so they can be tested without a DOM (this project has no jsdom; CLAUDE.md).
//
// Two halves, deliberately separate:
//
//  - **Reusable** — a `cols × rows` size, the CSS template that makes it fill its box (VIEW-5), and
//    the slot list a `<GridView>` renders. Phase 3's Views feed these from `View.layout` and
//    `View.cells`; nothing in them knows about presets.
//  - **TEMPORARY (P2.4 only)** — the two hard-coded presets and the "first N cameras in list order"
//    assignment. They exist so Phase 2 can run many `<LivePlayer>`s at once for the P2.5 perf
//    harness and gate G2. Phase 3 (P3.x, VIEW-1/2) replaces them with real, persisted Views; delete
//    this half then rather than growing it.
import type { Camera } from '@shared/ipc'
import { resolveGridQuality, type QualityDefaults, type StreamQuality } from '@shared/quality'
import { cameraDisplayName, sortCameras } from '../../state/camerasStore'

// -------------------------------------------------------------------------------------------------
// Reusable: size, template, slots

/** A uniform grid, `cols × rows` (VIEW-1). */
export interface GridSize {
  readonly cols: number
  readonly rows: number
}

/** VIEW-1: custom sizes go up to 4×4. */
export const MAX_GRID_DIMENSION = 4

/** Whether a size is one VIEW-1 allows: whole numbers from 1 to {@link MAX_GRID_DIMENSION}. */
export function isValidGridSize(size: GridSize): boolean {
  const ok = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_GRID_DIMENSION
  return ok(size.cols) && ok(size.rows)
}

/** How many cells a size has. */
export function slotCount(size: GridSize): number {
  return size.cols * size.rows
}

/**
 * The CSS-grid template for a size (VIEW-5). `minmax(0, 1fr)` and not plain `1fr`: a `1fr` track
 * has an automatic minimum of its content's min-content size, so a `<video>` with a large intrinsic
 * size would push its track wider than its share and the grid would overflow the window. With a
 * zero minimum every track is exactly its share of the box, whatever is inside it.
 */
export function gridTemplate(size: GridSize): {
  readonly gridTemplateColumns: string
  readonly gridTemplateRows: string
} {
  return {
    gridTemplateColumns: `repeat(${String(size.cols)}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${String(size.rows)}, minmax(0, 1fr))`,
  }
}

/** One cell of a grid: a camera to show live (CELL-1), or nothing. */
export type GridSlot =
  | {
      readonly kind: 'camera'
      /** React key. The camera id, so a player survives a reflow or a size change (see below). */
      readonly key: string
      readonly cameraId: string
      readonly name: string
      /** The **effective** quality, already resolved (QUAL-3). Never a literal. */
      readonly quality: StreamQuality
    }
  | { readonly kind: 'empty'; readonly key: string }

/**
 * The key of an empty slot. Positional, because an empty slot has no identity of its own; it can
 * never collide with a camera key since camera keys are bare ids and this one is prefixed.
 */
export function emptySlotKey(index: number): string {
  return `empty:${String(index)}`
}

// -------------------------------------------------------------------------------------------------
// TEMPORARY (P2.4): hard-coded presets and assignment. Replaced by real Views in Phase 3.

export interface TempGridPreset extends GridSize {
  readonly id: string
  readonly label: string
}

/**
 * The two sizes P2.4 asks for. 3×3 is nine streams and 4×3 twelve, which brackets the "10 streams"
 * P2.5 measures. Both are VIEW-1 presets, so the numbers are not invented here.
 */
export const TEMP_GRID_PRESETS: readonly TempGridPreset[] = [
  { id: '3x3', label: '3×3', cols: 3, rows: 3 },
  { id: '4x3', label: '4×3', cols: 4, rows: 3 },
]

/**
 * The effective grid quality while there are no Views: QUAL-3's chain with no cell and no View
 * override, i.e. `settings.streams.defaultGridQuality`. Goes through `resolveGridQuality` rather
 * than reading the setting directly, so the QUAL preamble's "no quality is hard-coded" holds and
 * Phase 3 only has to swap the `null`s for the real `Cell` and `View`.
 */
export function tempGridQuality(streams: QualityDefaults): StreamQuality {
  return resolveGridQuality({
    cell: { quality: null },
    view: { gridQuality: null, fillQuality: null },
    streams,
  })
}

/**
 * Fills a `cols × rows` grid with the first `cols × rows` cameras in the camera list's order
 * (`sortCameras`), left to right, top to bottom. Slots beyond the camera count are empty; cameras
 * beyond the slot count are not shown.
 *
 * Offline cameras are not skipped: a cell for a camera that is down shows the player's offline
 * placeholder (CAM-3), and skipping it would shift every later camera to a new cell each time one
 * drops off — the same reason the camera list does not reorder on state.
 *
 * Keys are camera ids, so going from 3×3 to 4×3 keeps the first nine players mounted (React moves
 * them to their new grid positions) instead of reconnecting nine streams.
 */
export function assignTempGridSlots(
  cameras: readonly Camera[],
  size: GridSize,
  quality: StreamQuality,
): GridSlot[] {
  const count = isValidGridSize(size) ? slotCount(size) : 0
  const shown = sortCameras(cameras).slice(0, count)
  return Array.from({ length: count }, (_, index): GridSlot => {
    const camera = shown[index]
    if (camera === undefined) return { kind: 'empty', key: emptySlotKey(index) }
    return {
      kind: 'camera',
      key: camera.id,
      cameraId: camera.id,
      name: cameraDisplayName(camera),
      quality,
    }
  })
}
