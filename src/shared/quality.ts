// Stream quality. QUAL preamble: **no quality is hard-coded** anywhere in the app, so every module
// that needs one imports its type and values from here (config schema, IPC contract, registry,
// player). Pure types and zod enums: no Node and no Electron imports, the renderer imports this.
//
// Two sets, deliberately distinct:
//   Quality       — the three the user can pick (QUAL-1…5). Protect exposes `high`, `medium` and
//                   `low` on every camera (SPEC §5.1), so any of them is always a legal choice.
//   StreamQuality — `Quality` plus `package`, the doorbell package channel (CAM-4, QUAL-8). It is a
//                   stream *source*, not something the quality picker offers: it exists only on
//                   cameras with `hasPackageCamera`, and a cell addresses it as its own source
//                   (`<cameraId>:package`). Keeping it out of `Quality` means a quality picker,
//                   a View default or `streams.default*Quality` can never be set to `package`.
//
// The bottom half of the file is `resolveQuality()` (P2.2): the "most specific setting wins" chains
// of QUAL-2/3/5. docs/ARCHITECTURE.md §3 calls it one function; it is two here —
// {@link resolveGridQuality} and {@link resolveFillQuality} — because the two chains have different
// lengths and a single function would need either a mode flag or a nullable cell argument, both of
// which a caller can get wrong silently.
import { z } from 'zod'

/** User-selectable qualities, best first. The order is the one the quality picker shows (QUAL-4). */
export const QUALITIES = ['high', 'medium', 'low'] as const

export const QualitySchema = z.enum(QUALITIES)
export type Quality = z.infer<typeof QualitySchema>

/** The doorbell package channel (CAM-4). Unexercised: no doorbell on the dev network (SPEC §1). */
export const PACKAGE_CHANNEL = 'package'

/** Everything go2rtc can be asked to stream for a camera: a quality, or the package channel. */
export const STREAM_QUALITIES = [...QUALITIES, PACKAGE_CHANNEL] as const

export const StreamQualitySchema = z.enum(STREAM_QUALITIES)
export type StreamQuality = z.infer<typeof StreamQualitySchema>

/** Narrows an arbitrary string (IPC payload, persisted value) to a user-selectable quality. */
export function isQuality(value: string): value is Quality {
  return QualitySchema.safeParse(value).success
}

/** Narrows an arbitrary string to a quality or the package channel. */
export function isStreamQuality(value: string): value is StreamQuality {
  return StreamQualitySchema.safeParse(value).success
}

/**
 * RTSP-3's quality fallback: the quality actually played when `wanted` may have no stream. `wanted`
 * itself when `has(wanted)`, otherwise the closest quality in {@link QUALITIES} order that `has`,
 * the **lower** one on a tie — so low → medium → high, medium → low → high, high → medium → low.
 * `null` when no quality has a stream at all.
 *
 * Main serves this quality (`ensureStream` names it in the handle) and the renderer asks for it and
 * shows it, from the same booleans, so the picker's colour and the badge are what really plays.
 * Derived from the order of {@link QUALITIES} rather than spelled out (QUAL preamble).
 */
export function fallbackQuality(
  wanted: Quality,
  has: (quality: Quality) => boolean,
): Quality | null {
  const at = QUALITIES.indexOf(wanted)
  for (let distance = 0; distance < QUALITIES.length; distance += 1) {
    // QUALITIES is best first, so `at + distance` is the lower quality and is tried first.
    for (const index of distance === 0 ? [at] : [at + distance, at - distance]) {
      const quality = QUALITIES[index]
      if (quality !== undefined && has(quality)) return quality
    }
  }
  return null
}

/**
 * The short badge text for a stream, e.g. `MED` (QUAL-7: "the app shows the effective quality on
 * hover"). A `Record` over every {@link StreamQuality}, so adding a quality without a label is a
 * type error rather than a blank badge. `PKG` is the doorbell package channel (CAM-4), which a cell
 * plays as its own source and so also shows.
 */
const QUALITY_BADGE_LABELS: Readonly<Record<StreamQuality, string>> = {
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  package: 'PKG',
}

export function qualityBadgeLabel(quality: StreamQuality): string {
  return QUALITY_BADGE_LABELS[quality]
}

// -------------------------------------------------------------------------------------------------
// resolveQuality (QUAL-2/3/5, docs/ARCHITECTURE.md §3 "Streaming details")
//
// The rule is "the most specific setting wins", over two chains:
//
//   grid: cell.quality → view.gridQuality → settings.streams.defaultGridQuality   (QUAL-3)
//   fill:               view.fillQuality → settings.streams.defaultFillQuality    (QUAL-5)
//
// `null` at a level means **inherit** — exactly what `InheritedQualitySchema` in ./models encodes,
// and why an absent key there parses to an explicit `null`: every level is `Quality | null` and
// nobody has to tell `undefined` from `null`.
//
// Both functions take **one named object** whose keys are the levels, not a positional argument
// list. Three `Quality | null` parameters in a row are impossible to pass in the wrong order
// *visibly*: `resolveGridQuality(view.gridQuality, cell.quality, …)` would type-check and quietly
// invert QUAL-3. With named levels, and with each level typed as the shape it comes from, the only
// way to call these is with the real `Cell`, `View` and `StreamsConfig` objects.
//
// The transient fill-mode picker (QUAL-5, "applies until you leave fill mode") is deliberately
// **not** a level here: it is not persisted, so it has no home in the config chain. P3.7 applies it
// above the chain (`sessionPick ?? resolveFillQuality(...)`), which keeps this module about the
// persisted model and still hard-codes nothing.

/**
 * Last resort, used only if every level is missing or malformed — which the types forbid and
 * `SettingsSchema` prevents, but a `Quality` has to come out of here no matter what, because the
 * player's alternative to a quality is no video at all.
 *
 * The *cheapest* quality, taken from the end of {@link QUALITIES} (they are listed best first)
 * rather than written out: the QUAL preamble's "no quality is hard-coded" applies to this file most
 * of all. Degrading downwards is the safe direction — a wrong `high` for every cell of a 4×4 View
 * would hammer the console and the decoder (NFR-2/4). Parsed rather than cast so that a change to
 * `QUALITIES` that broke this assumption would fail at import, not at the first stalled stream.
 */
const CHEAPEST_QUALITY: Quality = QualitySchema.parse(QUALITIES[QUALITIES.length - 1])

/**
 * First level that actually has a quality set, cheapest quality if none has.
 *
 * Levels are `unknown`, not `Quality | null`, on purpose: this is the one place that decides what
 * "set" means, and it has to hold for values the type system did not get to see — a config field
 * that an older schema version left `undefined`, a quality string from a hand-edited file that
 * reached a caller without going through zod, a `''`. Anything that is not one of {@link QUALITIES}
 * inherits, which is the same thing `null` does, instead of being passed on as a quality go2rtc
 * would reject.
 */
function firstSetQuality(levels: readonly unknown[]): Quality {
  for (const level of levels) {
    if (typeof level === 'string' && isQuality(level)) return level
  }
  return CHEAPEST_QUALITY
}

/**
 * A cell's quality override (QUAL-3). A structural subset of `Cell` (./models), so a whole `Cell`
 * is accepted as is while this module stays free of the domain model — ./models imports *this* file
 * for `QualitySchema`, and the reverse import would be a cycle.
 */
export interface CellQualityOverride {
  /** `null` = use the View's grid quality. */
  readonly quality: Quality | null
}

/** A View's two overrides (QUAL-2, QUAL-5). Structural subset of `View` (./models). */
export interface ViewQualityOverrides {
  /** `null` = use `settings.streams.defaultGridQuality`. */
  readonly gridQuality: Quality | null
  /** `null` = use `settings.streams.defaultFillQuality`. */
  readonly fillQuality: Quality | null
}

/**
 * The two app-wide defaults (QUAL-1). Structural subset of `StreamsConfig` (./models), i.e. exactly
 * `settings.streams`. Both are non-nullable: this is where inheriting stops.
 */
export interface QualityDefaults {
  readonly defaultGridQuality: Quality
  readonly defaultFillQuality: Quality
}

/**
 * The effective quality for one grid cell: `cell.quality ?? view.gridQuality ??
 * streams.defaultGridQuality` (QUAL-3).
 *
 * Call it with the real objects — `resolveGridQuality({ cell, view, streams: settings.streams })`.
 */
export function resolveGridQuality(levels: {
  readonly cell: CellQualityOverride
  readonly view: ViewQualityOverrides
  readonly streams: QualityDefaults
}): Quality {
  return firstSetQuality([
    levels.cell.quality,
    levels.view.gridQuality,
    levels.streams.defaultGridQuality,
  ])
}

/**
 * The effective quality in fill mode: `view.fillQuality ?? streams.defaultFillQuality` (QUAL-5).
 *
 * There is no cell level on purpose. Fill mode shows one camera full-window, so a per-cell grid
 * override (typically a *lower* quality, QUAL-1) must not follow the camera into fill — that is the
 * whole point of FILL-2's low→high swap.
 */
export function resolveFillQuality(levels: {
  readonly view: ViewQualityOverrides
  readonly streams: QualityDefaults
}): Quality {
  return firstSetQuality([levels.view.fillQuality, levels.streams.defaultFillQuality])
}
