// RTSP streams (RTSP-2, RTSP-5): the rules for a user-entered stream URL, the qualities a stream can
// have a URL for, and the booleans-only shape the renderer is told about them.
//
// Pure and renderer-safe: **no Node and no Electron imports**, only zod and ./quality. The Add/Edit
// stream dialog (F1.0.2-5) runs the same `validateRtspUrl` as main, so the form and the store can
// never disagree about what is acceptable; main validates again on every write and on every read of
// secrets.bin (RTSP-5: main registers only URLs it read from its own secrets, validated here).
//
// Why the rules are this narrow (RTSP-2): go2rtc treats some source schemes as **commands to run**
// (`exec:`, `ffmpeg:`, `echo:`, `expr:` …), and others make it reach out over protocols this app has
// no business with (`http:`, `rtmp:`, `webrtc:` …). Only `rtsp://` and `rtsps://` are accepted.
// `rtspx://` (go2rtc's "rtsps without certificate checks") is refused as *input*: main produces it
// itself from `rtsps://` when it registers a source (RTSP-3), and a user should never type it.
// Whitespace and control characters are refused anywhere in the string, so a URL cannot smuggle a
// second line into go2rtc's YAML config or a log line, and nothing is trimmed for the user: a
// leading space is an error to fix, not something silently changed in a secret.
//
// CON-2: a stream URL is a secret (it usually carries a username and password). Every `reason`
// here is a fixed sentence and **never echoes the URL or any part of it**.
import { z } from 'zod'
import { MAX_RTSP_STREAM_NAME_LENGTH } from './models'
import { QUALITIES, type Quality } from './quality'

/** RTSP-2: longest URL accepted, in UTF-16 code units (`String.length`). */
export const MAX_RTSP_URL_LENGTH = 2048

/**
 * The qualities an RTSP stream can have a URL for (RTSP-2). The same three as the quality picker
 * (QUAL preamble: no quality is hard-coded outside ./quality), so a stream's quality and a cell's
 * quality are the same type and QUAL-1…5 apply unchanged (RTSP-3).
 */
export const RTSP_QUALITIES = QUALITIES
export type RtspQuality = Quality

export type RtspUrlCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Schemes a stream URL may use (RTSP-2). Compared lower-cased: `RTSP://` is the same scheme. */
const ALLOWED_SCHEMES = ['rtsp:', 'rtsps:'] as const

/** Any whitespace (including Unicode spaces and line separators) or C0/C1 control character. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/u

/**
 * RTSP-2's validation, shared by the Add/Edit stream dialog and main. `reason` is one short
 * sentence a homeowner can act on and never contains the URL (CON-2).
 */
export function validateRtspUrl(url: string): RtspUrlCheck {
  if (url.length === 0) return { ok: false, reason: 'Enter the camera’s RTSP address.' }
  if (url.length > MAX_RTSP_URL_LENGTH) {
    return {
      ok: false,
      reason: `The address is too long (at most ${String(MAX_RTSP_URL_LENGTH)} characters).`,
    }
  }
  if (FORBIDDEN_CHARACTERS.test(url)) {
    return { ok: false, reason: 'The address cannot contain spaces or line breaks.' }
  }
  // Checked on the raw text before parsing, so `rtsp:host` (no `//`) is refused rather than left to
  // WHATWG's lenient handling of non-special schemes.
  const schemeEnd = url.indexOf('://')
  const scheme = schemeEnd === -1 ? '' : url.slice(0, schemeEnd + 1).toLowerCase()
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, reason: 'The address must start with rtsp:// or rtsps://.' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'This is not a valid RTSP address.' }
  }
  if (parsed.hostname === '') {
    return { ok: false, reason: 'The address needs a camera host name or IP address.' }
  }
  return { ok: true }
}

/** `validateRtspUrl(url).ok`, for callers that only need the verdict. */
export function isValidRtspUrl(url: string): boolean {
  return validateRtspUrl(url).ok
}

/**
 * RTSP-2, CON-2: which qualities of a stream have a URL, as booleans. This is everything the
 * renderer is ever told about a stream URL (`AppState.secretsStored.rtspUrls`).
 */
export const RtspQualitiesStoredSchema = z.object({
  high: z.boolean(),
  medium: z.boolean(),
  low: z.boolean(),
})
export type RtspQualitiesStored = z.infer<typeof RtspQualitiesStoredSchema>

/** `{ "<streamId>": { high, medium, low } }` for every stream that has at least one URL stored. */
export const RtspUrlsStoredSchema = z.record(z.string().min(1), RtspQualitiesStoredSchema)
export type RtspUrlsStored = z.infer<typeof RtspUrlsStoredSchema>

/** One stream's URLs as main holds them: a quality is present or absent, never an empty string. */
export type RtspStreamUrls = Partial<Record<RtspQuality, string>>

/**
 * Maps main's stored URLs to the booleans the renderer may see (CON-2, RTSP-2). A stream whose
 * entries are all empty is left out, matching what secrets.bin stores (a stream with no URL has no
 * entry). The result never holds a URL, only `true` / `false`.
 */
export function rtspUrlsStored(
  urls: Readonly<Record<string, RtspStreamUrls>> | undefined,
): RtspUrlsStored {
  const out: RtspUrlsStored = {}
  for (const [streamId, stream] of Object.entries(urls ?? {})) {
    const stored: RtspQualitiesStored = {
      high: (stream.high ?? '') !== '',
      medium: (stream.medium ?? '') !== '',
      low: (stream.low ?? '') !== '',
    }
    if (stored.high || stored.medium || stored.low) out[streamId] = stored
  }
  return out
}

export type RtspNameCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * RTSP-1: a stream's name is 1–64 characters once trimmed and unique among `streams` ignoring case.
 * `exceptId` is the stream being edited, so keeping its own name is not a clash. Shared by the
 * Add/Edit dialog and main's `vp:rtsp/streams/save`, so the two can never disagree.
 */
export function validateRtspStreamName(
  name: string,
  streams: readonly { readonly id: string; readonly name: string }[],
  exceptId?: string,
): RtspNameCheck {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'Enter a name for the camera.' }
  if (trimmed.length > MAX_RTSP_STREAM_NAME_LENGTH) {
    return {
      ok: false,
      reason: `The name is too long (at most ${String(MAX_RTSP_STREAM_NAME_LENGTH)} characters).`,
    }
  }
  const lower = trimmed.toLowerCase()
  if (
    streams.some((stream) => stream.id !== exceptId && stream.name.trim().toLowerCase() === lower)
  ) {
    return { ok: false, reason: 'Another stream already has this name.' }
  }
  return { ok: true }
}
