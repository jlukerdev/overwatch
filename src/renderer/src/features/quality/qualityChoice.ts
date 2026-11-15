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
//    text the QUAL-7 badge shows — "View default (LOW)" reads as "you will see the LOW badge".
//  - **`null` is the empty string.** A native select's value is a string, and `''` can never be a
//    quality, so "inherit" round-trips without a sentinel that could one day collide with one. Any
//    value that is not a quality reads back as `null`, i.e. inherit: a select can only ever offer
//    its own options, so that only happens for {@link SAVE_FOR_VIEW_OPTION}, which the fill picker
//    handles before it gets here.
//  - **The fill picker's action is an option**, not a button next to it: the strip is a row of
//    compact chips and the action belongs with the qualities it saves. Its value is a word that
//    `isQuality` refuses (tested), so it can never be mistaken for a pick.
//  - **A cell is addressed by its top-left slot.** That is unique in a tiled View, survives the
//    canonical reordering a save does, and is what a grid slot's `placement` carries — so the
//    overlay can name the persisted cell without knowing its index.
import type { View } from '@shared/models'
import { isQuality, qualityBadgeLabel, QUALITIES, type Quality } from '@shared/quality'

/** The select value of the "inherit" option (`null`). */
export const INHERIT_OPTION = ''

/** The fill picker's "Save for this View" action (QUAL-5). Never a quality (header). */
export const SAVE_FOR_VIEW_OPTION = 'save-for-view'

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
