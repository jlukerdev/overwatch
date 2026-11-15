// The View editor's logic (P3.3; VIEW-1/2/3/5, CAM-4): every change the editor makes to its draft
// View, plus the small decisions its controls need (which layout preset is showing, what the
// selection buttons may do, what a camera ref is called). Pure functions over plain data — no DOM,
// no React — so all of it is tested in vitest's node environment (vitest.config.mts) and, per
// CLAUDE.md's "keep logic that has no UI pure and unit-tested", `<ViewEditor>` only wires events to
// these functions and renders what comes back.
//
// Decisions made here, each for a reason:
//
//  - **The draft is always a valid View.** Every operation takes a tiled View and returns a tiled
//    View in canonical cell order, with camera lists free of duplicates and empty strings, so the
//    draft passes `ViewSchema` at every step and Save can only fail on the name. An operation that
//    cannot apply (an index out of range, a move past the end of a list) returns the View it was
//    given, unchanged, rather than throwing: a stale index from a re-render is not a crash.
//  - **A selection is always mergeable.** `selectionRect` grows the rectangle the pointer spans
//    until no cell sticks out of it, so the Merge button never offers a merge `mergeCells` would
//    refuse. Growing is repeated until nothing changes, because taking in one spanned cell can
//    reach another (two 2×2 cells side by side, the 2 + 8 preset).
//  - **Cell contents move as a unit.** A cell's contents are its cameras *and* its settings
//    (quality, rotation, motion switching). A preset change, a merge, and a cell-onto-cell drag all
//    move contents between placements as a whole, so a cell's 10 s rotation is not left behind on an
//    empty cell when its cameras move. Contents are copied by spreading the cell and overwriting its
//    placement, so a field added to `CellSchema` later moves with them without touching this file.
//  - **Labels match the Live screen.** A ref the inventory cannot resolve is labelled exactly as
//    `buildViewSlots` (../grid/gridLayout) labels its `missing` slot, so the editor and the wall
//    describe the same broken cell in the same words.
import type { Camera } from '@shared/ipc'
import {
  MIN_ROTATE_INTERVAL_SEC,
  MOTION_TRIGGERS,
  ViewSchema,
  type Aspect,
  type Cell,
  type MotionTrigger,
  type View,
} from '@shared/models'
import {
  contains,
  intersects,
  LAYOUT_PRESETS,
  normalizeCells,
  presetCells,
  type CellPlacement,
  type LayoutPreset,
  type LayoutResult,
} from '@shared/viewLayout'
import { cameraDisplayName, sortCameras } from '../../state/camerasStore'
import { packageRef, parseCameraRef } from '../grid/gridLayout'

// -------------------------------------------------------------------------------------------------
// Slots and selection

/** One slot of the grid, 0-based. */
export interface Slot {
  readonly col: number
  readonly row: number
}

/** Whether a placement covers the slot. */
function covers(cell: CellPlacement, slot: Slot): boolean {
  return (
    slot.col >= cell.col &&
    slot.col < cell.col + cell.colSpan &&
    slot.row >= cell.row &&
    slot.row < cell.row + cell.rowSpan
  )
}

/** Whether `a` exists and sits exactly where `b` does. */
function samePlacement(a: CellPlacement | undefined, b: CellPlacement): boolean {
  return a?.col === b.col && a.row === b.row && a.colSpan === b.colSpan && a.rowSpan === b.rowSpan
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Index into `view.cells` of the cell covering slot `(col, row)`, or -1. */
export function cellIndexAt(view: Pick<View, 'cells'>, slot: Slot): number {
  return view.cells.findIndex((cell) => covers(cell, slot))
}

/**
 * The bounding rectangle of slots `a` and `b`, grown until every cell it touches lies wholly
 * inside it — so `mergeCells` can never refuse it. The slots are clamped into the grid first, so
 * the result is always inside the grid for a tiled View (a tiled View's cells are all inside it).
 */
export function selectionRect(
  view: Pick<View, 'cols' | 'rows' | 'cells'>,
  a: Slot,
  b: Slot,
): CellPlacement {
  const maxCol = Math.max(0, view.cols - 1)
  const maxRow = Math.max(0, view.rows - 1)
  const ac = clamp(Math.floor(a.col), 0, maxCol)
  const ar = clamp(Math.floor(a.row), 0, maxRow)
  const bc = clamp(Math.floor(b.col), 0, maxCol)
  const br = clamp(Math.floor(b.row), 0, maxRow)
  let left = Math.min(ac, bc)
  let top = Math.min(ar, br)
  let right = Math.max(ac, bc) + 1 // exclusive
  let bottom = Math.max(ar, br) + 1 // exclusive

  // Each pass can only grow the rectangle and it is bounded by the grid, so this terminates.
  let grew = true
  while (grew) {
    grew = false
    const rect = { col: left, row: top, colSpan: right - left, rowSpan: bottom - top }
    for (const cell of view.cells) {
      if (!intersects(cell, rect)) continue
      if (cell.col < left) [left, grew] = [cell.col, true]
      if (cell.row < top) [top, grew] = [cell.row, true]
      if (cell.col + cell.colSpan > right) [right, grew] = [cell.col + cell.colSpan, true]
      if (cell.row + cell.rowSpan > bottom) [bottom, grew] = [cell.row + cell.rowSpan, true]
    }
  }
  return { col: left, row: top, colSpan: right - left, rowSpan: bottom - top }
}

/** Indexes (ascending) of the cells wholly inside `rect`. */
export function cellsInRect(view: Pick<View, 'cells'>, rect: CellPlacement): number[] {
  const out: number[] = []
  view.cells.forEach((cell, index) => {
    if (contains(rect, cell)) out.push(index)
  })
  return out
}

/**
 * What the selection buttons may do with `rect`. **Merge** needs at least two cells inside it and
 * no cell sticking out of it (always true of a `selectionRect`); **Split** needs the rectangle to
 * be exactly one cell that spans more than one slot.
 */
export function selectionActions(
  view: Pick<View, 'cells'>,
  rect: CellPlacement,
): {
  readonly canMerge: boolean
  readonly canSplit: boolean
  readonly cellIndexes: readonly number[]
} {
  const cellIndexes = cellsInRect(view, rect)
  const clean = view.cells.every((cell) => !intersects(cell, rect) || contains(rect, cell))
  const only = cellIndexes.length === 1 ? view.cells[cellIndexes[0] ?? -1] : undefined
  const canSplit = clean && samePlacement(only, rect) && rect.colSpan * rect.rowSpan > 1
  return { canMerge: clean && cellIndexes.length >= 2, canSplit, cellIndexes }
}

/**
 * How many cells inside `rect`, other than the one `mergeCells` keeps (the first in reading order
 * that has cameras, else the top-left one), have cameras that a merge would drop. The editor warns
 * when this is above 0.
 */
export function mergeDropsCameras(view: Pick<View, 'cells'>, rect: CellPlacement): number {
  const inside = normalizeCells(view.cells.filter((cell) => contains(rect, cell)))
  const withCameras = inside.filter((cell) => cell.cameraIds.length > 0)
  // The survivor is the first of `withCameras` when there is one; nothing is dropped otherwise.
  return Math.max(0, withCameras.length - 1)
}

// -------------------------------------------------------------------------------------------------
// Presets

/**
 * The id of the preset whose `cols`, `rows` and placements equal the View's exactly, or `null`
 * when none does (the picker shows "Custom"). Cameras and settings are not compared.
 */
export function matchingPresetId(
  view: Pick<View, 'cols' | 'rows' | 'cells'>,
  presets: readonly LayoutPreset[] = LAYOUT_PRESETS,
): string | null {
  const cells = normalizeCells(view.cells)
  const match = presets.find((preset) => {
    if (preset.cols !== view.cols || preset.rows !== view.rows) return false
    if (preset.cells.length !== cells.length) return false
    const placements = normalizeCells(preset.cells)
    return placements.every((p, i) => samePlacement(cells[i], p))
  })
  return match?.id ?? null
}

/** `source`'s contents (cameras and every setting) at `placement`. */
function withPlacement(source: Cell, placement: CellPlacement): Cell {
  return {
    ...source,
    col: placement.col,
    row: placement.row,
    colSpan: placement.colSpan,
    rowSpan: placement.rowSpan,
  }
}

/**
 * Re-lays the View as `preset`. The old View's cells that have cameras, in reading order, hand their
 * cameras **and** settings to the new cells in reading order; new cells past them are empty with
 * `CellSchema`'s defaults. `dropped` counts the old camera cells there was no new cell left for.
 * Every other View field is kept.
 */
export function applyPreset<V extends View>(
  view: V,
  preset: LayoutPreset,
): { readonly view: V; readonly dropped: number } {
  const sources = normalizeCells(view.cells).filter((cell) => cell.cameraIds.length > 0)
  const fresh = normalizeCells(presetCells(preset))
  const cells = fresh.map((cell, index) => {
    const source = sources[index]
    return source === undefined ? cell : withPlacement(source, cell)
  })
  return {
    view: { ...view, cols: preset.cols, rows: preset.rows, cells },
    dropped: Math.max(0, sources.length - fresh.length),
  }
}

// -------------------------------------------------------------------------------------------------
// Cell cameras

/** `view` with cell `index` replaced by `update(cell)`, or `view` itself for a bad index. */
function updateCell<V extends View>(view: V, index: number, update: (cell: Cell) => Cell): V {
  const cell = Number.isInteger(index) ? view.cells[index] : undefined
  if (cell === undefined) return view
  const next = update(cell)
  if (next === cell) return view
  return { ...view, cells: view.cells.map((c, i) => (i === index ? next : c)) }
}

/** Distinct non-empty refs, first occurrence kept. */
function dedupeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.filter((ref) => ref.length > 0))]
}

/**
 * Cell `index` holding exactly `cameraIds`, deduplicated with order kept (empty strings, which
 * `CellSchema` rejects, are dropped). An out-of-range index leaves the View unchanged.
 */
export function setCellCameras<V extends View>(
  view: V,
  index: number,
  cameraIds: readonly string[],
): V {
  return updateCell(view, index, (cell) => ({ ...cell, cameraIds: dedupeRefs(cameraIds) }))
}

/** Appends `ref` to cell `index`'s cameras unless it is already there (or empty). */
export function addCellCamera<V extends View>(view: V, index: number, ref: string): V {
  return updateCell(view, index, (cell) =>
    ref.length === 0 || cell.cameraIds.includes(ref)
      ? cell
      : { ...cell, cameraIds: [...cell.cameraIds, ref] },
  )
}

/** Removes the entry at `position` of cell `index`'s cameras. A bad position changes nothing. */
export function removeCellCamera<V extends View>(view: V, index: number, position: number): V {
  return updateCell(view, index, (cell) =>
    Number.isInteger(position) && position >= 0 && position < cell.cameraIds.length
      ? { ...cell, cameraIds: cell.cameraIds.filter((_ref, i) => i !== position) }
      : cell,
  )
}

/**
 * Moves entry `position` of cell `index`'s cameras one place up (`-1`) or down (`+1`). A move past
 * either end, or a bad position, changes nothing.
 */
export function moveCellCamera<V extends View>(
  view: V,
  index: number,
  position: number,
  delta: -1 | 1,
): V {
  return updateCell(view, index, (cell) => {
    const target = position + delta
    const ids = cell.cameraIds
    if (!Number.isInteger(position) || position < 0 || position >= ids.length) return cell
    if (target < 0 || target >= ids.length) return cell
    const next = [...ids]
    const moving = next[position]
    const other = next[target]
    if (moving === undefined || other === undefined) return cell
    next[position] = other
    next[target] = moving
    return { ...cell, cameraIds: next }
  })
}

/** A camera dragged from the palette onto cell `index`: the cell shows that camera alone. */
export function dropCameraOnCell<V extends View>(view: V, index: number, ref: string): V {
  if (ref.length === 0) return view
  return setCellCameras(view, index, [ref])
}

/**
 * Cell `a` dragged onto cell `b`: they swap cameras and settings, each keeping its placement.
 * `a === b`, or either index out of range, leaves the View unchanged.
 */
export function swapCellContents<V extends View>(view: V, a: number, b: number): V {
  if (a === b || !Number.isInteger(a) || !Number.isInteger(b)) return view
  const cellA = view.cells[a]
  const cellB = view.cells[b]
  if (cellA === undefined || cellB === undefined) return view
  const cells = view.cells.map((cell, i) => {
    if (i === a) return withPlacement(cellB, cellA)
    if (i === b) return withPlacement(cellA, cellB)
    return cell
  })
  return { ...view, cells }
}

// -------------------------------------------------------------------------------------------------
// Multi-camera settings (CELL-2)
//
// The inspector's "Multi-camera" group edits these. Like the camera edits above, each returns the
// View itself when nothing changes, and never writes a value `CellSchema` would reject, so the draft
// stays savable. None of them turns anything on by itself: the schema's defaults (no rotation,
// motion switch off) are what a new cell gets.

/**
 * Upper bound of the rotate interval input, in seconds (one day; the lower bound is CELL-2's 5 s).
 * `CellSchema` has no upper bound, so only the input applies it: a stored longer interval is kept,
 * and changes only when the user edits that field.
 */
export const MAX_ROTATE_INTERVAL_SEC = 86_400

/** What the rotate interval starts at when the user turns rotation on. */
export const DEFAULT_ROTATE_INTERVAL_SEC = 10

/** Upper bound of the hold input, in seconds (one day; the lower bound is 0), like the interval's. */
export const MAX_MOTION_HOLD_SEC = 86_400

/** The inspector's label for each trigger, in `MOTION_TRIGGERS` order. */
export const MOTION_TRIGGER_LABELS: Readonly<Record<MotionTrigger, string>> = {
  motion: 'Motion',
  smartDetect: 'Smart detection',
  ring: 'Ring',
}

/**
 * Protect's smart-detection types today, in the order the filter lists them. `CellSchema` keeps the
 * field a plain string list (a console upgrade can add types), so a type not in here — reported by
 * a camera, or already in a stored View — is kept and shown under its own name
 * ({@link smartDetectTypeLabel}). The filter offers what the cell's cameras report
 * ({@link smartDetectFilterChoices}); this whole list only when none of them reports any.
 */
export const KNOWN_SMART_DETECT_TYPES: readonly {
  readonly type: string
  readonly label: string
}[] = [
  { type: 'person', label: 'Person' },
  { type: 'vehicle', label: 'Vehicle' },
  { type: 'package', label: 'Package' },
  { type: 'licensePlate', label: 'License plate' },
  { type: 'face', label: 'Face' },
  { type: 'animal', label: 'Animal' },
]

/** The filter checkbox's label for `type`: the known label, else the type as Protect names it. */
export function smartDetectTypeLabel(type: string): string {
  return KNOWN_SMART_DETECT_TYPES.find((known) => known.type === type)?.label ?? type
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/** `cell` with no `rotateIntervalSec` key at all, rather than one holding `undefined`. */
function withoutRotation(cell: Cell): Cell {
  const next = { ...cell }
  delete next.rotateIntervalSec
  return next
}

/** `cell` with no `smartDetectTypes` key at all, rather than one holding `undefined`. */
function withoutSmartFilter(cell: Cell): Cell {
  const next = { ...cell }
  delete next.smartDetectTypes
  return next
}

/**
 * A whole number of at least `min`, or `null` for something that is not a finite number. Only the
 * schema's lower bound: the editor's upper bounds belong to its inputs, so a stored value above
 * them is never lowered by a setter.
 */
function wholeAtLeast(n: number, min: number): number | null {
  return Number.isFinite(n) ? Math.max(min, Math.round(n)) : null
}

/**
 * Cell `index` rotating every `sec` seconds (rounded, at least `MIN_ROTATE_INTERVAL_SEC`; the input
 * caps it at {@link MAX_ROTATE_INTERVAL_SEC}), or not rotating for `undefined` (the field is
 * removed). A value that is not a finite number changes nothing.
 */
export function setCellRotation<V extends View>(
  view: V,
  index: number,
  sec: number | undefined,
): V {
  return updateCell(view, index, (cell) => {
    if (sec === undefined) {
      return cell.rotateIntervalSec === undefined ? cell : withoutRotation(cell)
    }
    const next = wholeAtLeast(sec, MIN_ROTATE_INTERVAL_SEC)
    if (next === null || next === cell.rotateIntervalSec) return cell
    return { ...cell, rotateIntervalSec: next }
  })
}

/** Cell `index` with its motion switch `on` or off. */
export function setCellMotionSwitch<V extends View>(view: V, index: number, on: boolean): V {
  return updateCell(view, index, (cell) =>
    cell.motionSwitch === on ? cell : { ...cell, motionSwitch: on },
  )
}

/**
 * Cell `index` triggered by exactly `triggers`, in `MOTION_TRIGGERS` order with duplicates and
 * anything that is not a trigger dropped. An empty list is allowed (nothing switches the cell).
 */
export function setCellMotionTriggers<V extends View>(
  view: V,
  index: number,
  triggers: readonly string[],
): V {
  const next = MOTION_TRIGGERS.filter((trigger) => triggers.includes(trigger))
  return updateCell(view, index, (cell) =>
    sameList(cell.motionTriggers, next) ? cell : { ...cell, motionTriggers: next },
  )
}

/** `triggers` with `trigger` added (`on`) or removed, for a trigger checkbox. */
export function toggleMotionTrigger(
  triggers: readonly MotionTrigger[],
  trigger: MotionTrigger,
  on: boolean,
): MotionTrigger[] {
  const rest = triggers.filter((t) => t !== trigger)
  return MOTION_TRIGGERS.filter((t) => (t === trigger ? on : rest.includes(t)))
}

/**
 * Distinct non-empty smart-detection types, known ones in {@link KNOWN_SMART_DETECT_TYPES} order,
 * then any others in the order given (kept, never dropped: a newer console's type is valid). The
 * one ordering rule for both the stored filter and the checkboxes.
 */
function orderSmartDetectTypes(types: readonly string[]): string[] {
  const distinct = dedupeRefs(types)
  const known = KNOWN_SMART_DETECT_TYPES.map((k) => k.type).filter((t) => distinct.includes(t))
  return [...known, ...distinct.filter((t) => !known.includes(t))]
}

/**
 * The smart-detection types the cell's cameras report (`Camera.smartDetectTypes`, from Protect's
 * `featureFlags`), in the order found, duplicates kept (the ordering is
 * {@link smartDetectFilterChoices}'). A package ref (`<id>:package`) counts as its camera; a ref to
 * a camera the inventory does not have adds nothing.
 */
export function cellCameraSmartDetectTypes(
  cameraIds: readonly string[],
  cameras: readonly Camera[],
): string[] {
  return cameraIds.flatMap((ref) => {
    const { cameraId } = parseCameraRef(ref)
    return cameras.find((camera) => camera.id === cameraId)?.smartDetectTypes ?? []
  })
}

/**
 * The filter's checkboxes: the types the cell's cameras report (`cellCameraTypes`,
 * {@link cellCameraSmartDetectTypes}) plus any already `stored` in the cell — so a type no camera
 * reports any more stays visible, checked and removable — ordered as the filter is stored (known
 * types first). When no camera reports any type (an inventory without `featureFlags`, or cameras
 * not loaded yet), all of {@link KNOWN_SMART_DETECT_TYPES} instead.
 */
export function smartDetectFilterChoices(
  cellCameraTypes: readonly string[],
  stored: readonly string[] | undefined,
): string[] {
  const reported = cellCameraTypes.filter((type) => type.length > 0)
  const offered = reported.length > 0 ? reported : KNOWN_SMART_DETECT_TYPES.map((k) => k.type)
  return orderSmartDetectTypes([...offered, ...(stored ?? [])])
}

/**
 * Cell `index` filtering smart detections to `types`, ordered by the filter's rule (distinct,
 * non-empty, known types in {@link KNOWN_SMART_DETECT_TYPES} order, then the others as given). An
 * empty list, or `undefined`, removes the filter — CELL-2's "no filter", i.e. any type triggers.
 */
export function setCellSmartDetectTypes<V extends View>(
  view: V,
  index: number,
  types: readonly string[] | undefined,
): V {
  const next = orderSmartDetectTypes(types ?? [])
  return updateCell(view, index, (cell) => {
    if (next.length === 0) {
      return cell.smartDetectTypes === undefined ? cell : withoutSmartFilter(cell)
    }
    return cell.smartDetectTypes !== undefined && sameList(cell.smartDetectTypes, next)
      ? cell
      : { ...cell, smartDetectTypes: next }
  })
}

/**
 * `types` with `type` added (`on`) or removed, for a filter checkbox. Every other entry, a type the
 * checkboxes do not know included, is kept.
 */
export function toggleSmartDetectType(
  types: readonly string[] | undefined,
  type: string,
  on: boolean,
): string[] {
  const rest = (types ?? []).filter((t) => t !== type)
  return on ? [...rest, type] : rest
}

/**
 * Cell `index` holding a triggered camera `sec` seconds after its event ends (rounded, at least 0;
 * the input caps it at {@link MAX_MOTION_HOLD_SEC}). A value that is not a finite number changes
 * nothing.
 */
export function setCellMotionHold<V extends View>(view: V, index: number, sec: number): V {
  return updateCell(view, index, (cell) => {
    const next = wholeAtLeast(sec, 0)
    return next === null || next === cell.motionHoldSec ? cell : { ...cell, motionHoldSec: next }
  })
}

// -------------------------------------------------------------------------------------------------
// Aspect and number inputs (VIEW-5)

/** The aspect choices the select offers, in this order. Anything else is "Custom…". */
export const ASPECT_CHOICES: readonly { readonly label: string; readonly aspect: Aspect }[] = [
  { label: '16:9', aspect: { w: 16, h: 9 } },
  { label: '4:3', aspect: { w: 4, h: 3 } },
  { label: '1:1', aspect: { w: 1, h: 1 } },
  { label: '9:16', aspect: { w: 9, h: 16 } },
  { label: '21:9', aspect: { w: 21, h: 9 } },
]

/** Upper bound of the custom aspect's `w` and `h` inputs (the lower bound is 1). */
export const MAX_ASPECT_TERM = 99

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) [x, y] = [y, x % y]
  return x
}

function reduceAspect(aspect: Aspect): Aspect | null {
  const { w, h } = aspect
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  const d = gcd(w, h)
  return { w: w / d, h: h / d }
}

/**
 * The label of the choice with the same ratio as `aspect`, or `null` for a custom one. The ratio
 * is compared reduced, so `32:18` is "16:9".
 */
export function aspectChoiceLabel(aspect: Aspect): string | null {
  const reduced = reduceAspect(aspect)
  if (reduced === null) return null
  const match = ASPECT_CHOICES.find((choice) => {
    const r = reduceAspect(choice.aspect)
    return r !== null && r.w === reduced.w && r.h === reduced.h
  })
  return match?.label ?? null
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const WHOLE = /^[+-]?\d+$/

/**
 * A number input's text as a whole number in `[min, max]`: rounded, then clamped. `null` when the
 * text is not a plain decimal number (empty, `abc`, `1e3`, `0x10`), so the input can keep the last
 * good value instead of jumping to a bound.
 */
export function parseBoundedInt(text: string, min: number, max: number): number | null {
  const trimmed = text.trim()
  if (!DECIMAL.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  return clamp(Math.round(n), min, max)
}

/**
 * What a bounded number input commits while the user types `text`: the typed whole number (digits
 * only), only when it is already within `[min, max]` and differs from `value`; else `null`, and the
 * text stays as typed. Clamping here would commit a bound on the first keystroke (with min 5, the
 * "3" of "30" would commit 5) and the resync would then turn "30" into "50".
 */
export function boundedInputCommit(
  text: string,
  min: number,
  max: number,
  value: number,
): number | null {
  const trimmed = text.trim()
  // Digits only: "1." is a decimal being typed, and committing 1 would resync the text to "1".
  if (!WHOLE.test(trimmed)) return null
  const n = Number(trimmed)
  if (n < min || n > max) return null
  return n === value ? null : n
}

/**
 * What a bounded number input commits on blur: {@link parseBoundedInt}'s rounded, clamped number
 * when it differs from `value`, else `null` (the field then shows `value` again). Text that still
 * reads as `value` commits nothing, so a stored value outside `[min, max]` (the schema may allow
 * more than the input) survives a focus and blur the user did not type in.
 */
export function boundedInputBlurCommit(
  text: string,
  min: number,
  max: number,
  value: number,
): number | null {
  const parsed = parseBoundedInt(text, min, max)
  if (parsed === null || parsed === value) return null
  return Math.round(Number(text.trim())) === value ? null : parsed
}

// -------------------------------------------------------------------------------------------------
// Camera choices and labels (CAM-1, CAM-4)

/** One entry of the palette and the "Add camera" picker. */
export interface CameraChoice {
  readonly ref: string
  readonly label: string
}

/**
 * The palette's and the "Add camera" picker's entries: every camera in `sortCameras` order labelled
 * with `cameraDisplayName`, each followed — when it has a package camera — by its `<id>:package`
 * entry labelled `<name> (package)`.
 */
export function cameraChoices(cameras: readonly Camera[]): readonly CameraChoice[] {
  const out: CameraChoice[] = []
  for (const camera of sortCameras(cameras)) {
    const name = cameraDisplayName(camera)
    out.push({ ref: camera.id, label: name })
    if (camera.hasPackageCamera) {
      out.push({ ref: packageRef(camera.id), label: `${name} (package)` })
    }
  }
  return out
}

/**
 * How a ref in a cell is labelled: the camera's name (with " (package)" for its package channel),
 * or the Live screen's wording for a ref it cannot play — `Camera not found (<ref>)`, or
 * `No package camera (<name>)` for a package ref to a camera without one.
 */
export function cameraRefLabel(ref: string, cameras: readonly Camera[]): string {
  const parsed = parseCameraRef(ref)
  const camera = cameras.find((c) => c.id === parsed.cameraId)
  if (camera === undefined) return `Camera not found (${ref})`
  const name = cameraDisplayName(camera)
  if (!parsed.packageChannel) return name
  return camera.hasPackageCamera ? `${name} (package)` : `No package camera (${name})`
}

// -------------------------------------------------------------------------------------------------
// Save and dirty state

/**
 * The draft as a View ready to save: name trimmed, then `ViewSchema` (defaults, canonical cell
 * order, the tiling check). An empty name, or the first schema issue, is the refusal's reason.
 */
export function validateDraft(draft: View): LayoutResult<View> {
  const name = draft.name.trim()
  if (name === '') return { ok: false, reason: 'A View needs a name.' }
  const parsed = ViewSchema.safeParse({ ...draft, name })
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'The View is not valid.' }
  }
  return { ok: true, view: parsed.data }
}

/** `ViewSchema`'s output for `view`, or `view` as is when it does not parse. */
function normalised(view: View): unknown {
  const parsed = ViewSchema.safeParse(view)
  return parsed.success ? parsed.data : view
}

/** Structural equality of JSON-like data; a key holding `undefined` counts as absent. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  for (const key of keys) {
    if (!deepEqual(ra[key], rb[key])) return false
  }
  return true
}

/**
 * Whether the draft differs from the saved View, compared after `ViewSchema` normalisation (so cell
 * order and defaults do not count) but **without** trimming the name: a trailing space is a change
 * the user can still Save or Discard.
 */
export function isDraftDirty(saved: View, draft: View): boolean {
  return !deepEqual(normalised(saved), normalised(draft))
}
