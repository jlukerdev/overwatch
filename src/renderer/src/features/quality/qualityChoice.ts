// The quality pickers' shared vocabulary (P3.7; QUAL-2/3/4/5): how a `Quality | null` level is
// written as a `<select>` value and read back, what the options are called, and the one edit a
// picker makes to a stored View (`setCellQuality`). Pure, so it is tested in the node environment
// (no jsdom here; CLAUDE.md), and every picker — Settings' two defaults, the editor's two View
// selects and its cell select, the overlay's cell picker and the fill picker — agrees on all of it.
// Their `<option>`s are drawn by one component, ./QualityOptions.
//
// Decisions made here, each for a reason:
//
//  - **No quality literal** (QUAL preamble). The options are {@link QUALITIES} in their order, best
//    first, and the "inherit" option names what inheriting gives using `qualityBadgeLabel`, the same
//    short labels the QUAL-7 badge used — "Default (LOW)" (the overlay) or "View default (LOW)" (the
//    editor's inspector) names the quality in the same words everywhere.
//  - **`null` is the empty string.** A native select's value is a string, and `''` can never be a
//    quality, so "inherit" round-trips without a sentinel that could one day collide with one. Any
//    value that is not a quality reads back as `null`, i.e. inherit.
//  - **The fill picker's Save is a button beside the select**, not an option in it (the user's
//    call on review): an action is not a quality, and a select whose value can be "an
//    action" is one a keyboard user can trigger just by arrowing through it.
//  - **A cell is addressed by its top-left slot.** That is unique in a tiled View, survives the
//    canonical reordering a save does, and is what a grid slot's `placement` carries — so the
//    overlay can name the persisted cell without knowing its index.
//  - **RTSP mode plays what has a URL** (RTSP-3). A stream's {@link QualityAvailability} (the
//    booleans main tells the renderer, `secretsStored.rtspUrls`) maps every quality handed to a
//    player through `fallbackQuality` ({@link servedQuality}), because main serves that quality and
//    the player treats a handle of another quality as a contract violation. Settings and saved
//    overrides stay on the quality *asked for*; only what plays, and the picker's colour and badge
//    that show it (QUAL-7), use the served one. Protect mode has no availability (`null`): every
//    quality exists on every camera, and nothing is mapped. The overlay's pickers list a quality
//    with no URL disabled, "High (not set)" ({@link qualityOptionItems}).
import type { View } from '@shared/models'
import type { RtspQualitiesStored, RtspUrlsStored } from '@shared/rtsp'
import {
  fallbackQuality,
  isQuality,
  PACKAGE_CHANNEL,
  qualityBadgeLabel,
  QUALITIES,
  type Quality,
  type StreamQuality,
} from '@shared/quality'

/** The select value of the "inherit" option (`null`). */
export const INHERIT_OPTION = ''

/** The qualities a picker offers, best first (QUAL-4). */
export const QUALITY_OPTIONS: readonly Quality[] = QUALITIES

/** What a picker calls each quality. A `Record`, so a new quality without a name is a type error. */
const QUALITY_NAMES: Readonly<Record<Quality, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export function qualityName(quality: Quality): string {
  return QUALITY_NAMES[quality]
}

/**
 * Which qualities of one stream have a URL (RTSP-3), or `null` when every quality exists — Protect
 * mode (header).
 */
export type QualityAvailability = RtspQualitiesStored | null

/** A stream with no URL stored at all: main leaves it out of `rtspUrls` (src/shared/rtsp.ts). */
const NO_URLS: RtspQualitiesStored = { high: false, medium: false, low: false }

/**
 * The availability of `cameraId`'s qualities: `null` outside RTSP mode (`rtspUrls` `null`), else the
 * stream's booleans — the very object from the store, so a memo comparing it by identity holds — or
 * all `false` for a stream with no entry.
 */
export function streamAvailability(
  rtspUrls: RtspUrlsStored | null,
  cameraId: string,
): QualityAvailability {
  if (rtspUrls === null) return null
  return rtspUrls[cameraId] ?? NO_URLS
}

/**
 * The quality a player is handed for `quality` (RTSP-3, header): the closest one with a URL, lower
 * on a tie (`fallbackQuality`, the same rule main serves by). Unchanged in Protect mode
 * (`availability` `null`), for the package channel (a source, not a quality), and when the stream
 * has no URL at all — main then refuses and the cell shows its error.
 */
export function servedQuality(
  quality: StreamQuality,
  availability: QualityAvailability,
): StreamQuality {
  if (availability === null || quality === PACKAGE_CHANNEL) return quality
  return fallbackQuality(quality, (q) => availability[q]) ?? quality
}

/** One quality `<option>`: its value, its text and whether it can be picked. */
export interface QualityOptionItem {
  readonly value: Quality
  readonly label: string
  readonly disabled: boolean
}

/**
 * The quality options of a picker, best first (QUAL-4). With an RTSP stream's availability, a
 * quality with no URL is listed but disabled and named "High (not set)" (RTSP-3); without one
 * (Protect mode, or a View-wide select) every quality is enabled.
 */
export function qualityOptionItems(availability: QualityAvailability = null): QualityOptionItem[] {
  return QUALITY_OPTIONS.map((quality) => {
    const disabled = availability !== null && !availability[quality]
    const name = qualityName(quality)
    return { value: quality, label: disabled ? `${name} (not set)` : name, disabled }
  })
}

/** A level as a select value: the quality itself, or {@link INHERIT_OPTION} for `null`. */
export function qualityOptionValue(quality: Quality | null): string {
  return quality ?? INHERIT_OPTION
}

/** A select value back as a level: a quality, or `null` (inherit) for anything else (header). */
export function parseQualityOption(value: string): Quality | null {
  return isQuality(value) ? value : null
}

/**
 * The "inherit" option's text, naming what inheriting gives: `View default (LOW)`. Without a
 * quality (settings not loaded yet) it is just the prefix, rather than a guess.
 */
export function inheritOptionLabel(prefix: string, inherited: Quality | null | undefined): string {
  return inherited == null ? prefix : `${prefix} (${qualityBadgeLabel(inherited)})`
}

/**
 * `view` with the quality override of the cell whose top-left slot is `(col, row)` set to `quality`
 * (`null` clears it, QUAL-4's "View default"). The View itself comes back when there is no such
 * cell (it was edited away meanwhile) or the override is already that, so a caller holding the
 * View can tell nothing changed with `===` — the editor's draft, or the grid checking the stored
 * View *before* it queues a save. Inside a `viewsActions.updateView` updater that tells nothing:
 * the updater is handed a `structuredClone`, so the save is sent whatever this returns.
 */
export function setCellQuality<V extends View>(
  view: V,
  col: number,
  row: number,
  quality: Quality | null,
): V {
  const index = view.cells.findIndex((cell) => cell.col === col && cell.row === row)
  const cell = view.cells[index]
  if (cell === undefined || cell.quality === quality) return view
  return { ...view, cells: view.cells.map((c, i) => (i === index ? { ...cell, quality } : c)) }
}
