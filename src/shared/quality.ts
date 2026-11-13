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
// `resolveQuality()` (cell → view → settings for the grid, view → settings for fill; QUAL-3/5)
// lands in **P2.2** per docs/DEV_PLAN.md, together with its unit tests.
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
