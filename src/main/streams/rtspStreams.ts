// RTSP-1/2: the rules main applies to a stream save or delete (`vp:rtsp/streams/save`,
// `vp:rtsp/streams/delete`) that are not the IPC handler's plumbing: how a save's per-quality
// changes combine with what is stored, and the refusals with their fixed sentences.
//
// CON-2: a stream URL is a secret. Every message here is a fixed sentence: none quotes a URL, a
// stream id or any part of either, so a refusal is safe to show and to log as is.
//
// RTSP-3/5 (playback): the inventory main builds from the streams in RTSP mode, and the transform
// from a stored URL to the go2rtc source the registry registers.
//
// No Electron and no I/O: a plain module the tests import as is.
import type { Camera } from '@shared/models'
import { RTSP_QUALITIES, type RtspStreamUrls } from '@shared/rtsp'

/** The refusals, one sentence each, worded for the Streams screen. */
export const RTSP_STREAM_MESSAGES = {
  /** An edit or delete naming a stream that is not stored (deleted in between, or never was). */
  notFound: 'That stream no longer exists.',
  /** A new stream with no address at all. */
  createNeedsUrl: 'Add at least one stream address.',
  /** An edit that would clear the last address (RTSP-2). */
  lastUrl: 'A stream needs at least one address, so the last one cannot be cleared.',
  /** CON-2 allows no plaintext fallback. */
  keystore:
    'Secure storage (Keychain or DPAPI) is not available, so the stream address could not be ' +
    'saved. Addresses are never stored as plain text.',
  /** A stream asked to play that is not in the list (deleted, or never was). RTSP-3. */
  playNotFound: 'This stream is not in OverWatch’s stream list any more, so it cannot play.',
  /** The package channel asked of an RTSP stream: only a Protect doorbell has one (CAM-4). */
  playPackage: 'An RTSP stream has no package camera, so there is no package channel to play.',
  /** No quality of the stream has an address stored (RTSP-2, RTSP-3). */
  playNoUrl:
    'No address is saved for this stream, so there is nothing to play. Add one on the Streams ' +
    'screen.',
  /** The stored address fails RTSP-2's rules (a hand-edited or damaged secrets file). RTSP-5. */
  playInvalidUrl:
    'The saved address for this stream is not a valid RTSP address, so OverWatch will not open ' +
    'it. Replace it on the Streams screen.',
  /** `rtspStreamChanged` ran while this stream was being opened (RTSP-3). */
  playChanged: 'This stream was changed while it was being opened, so it was not opened.',
} as const

/**
 * A stream save or delete main will not make (RTSP-1/2). `toIpcError` maps it to its own `kind`,
 * never retryable: repeating the same request cannot help. Thrown from inside the config write when
 * the stored list changed under the request, so the write is abandoned and nothing is saved.
 */
export class RtspStreamError extends Error {
  readonly kind: 'bad-request' | 'not-found'

  constructor(kind: 'bad-request' | 'not-found', message: string) {
    super(message)
    this.name = 'RtspStreamError'
    this.kind = kind
  }
}

/** One quality's change in a save: absent keeps, `null` clears, a string sets (RTSP-2). */
export type RtspUrlChanges = { readonly [Q in keyof RtspStreamUrls]?: string | null | undefined }

/**
 * The URL set a stream has after a save: `stored` (empty for a new stream) with each quality in
 * `changes` applied. A fresh object; `stored` is not touched. A quality is present or absent in the
 * result, never an empty string or `null`, matching what secrets.bin holds.
 */
export function mergeRtspUrls(
  stored: RtspStreamUrls | undefined,
  changes: RtspUrlChanges,
): RtspStreamUrls {
  const out: RtspStreamUrls = {}
  for (const quality of RTSP_QUALITIES) {
    const change = changes[quality]
    const next = change === undefined ? stored?.[quality] : change
    if (typeof next === 'string' && next !== '') out[quality] = next
  }
  return out
}

/** Whether two URL sets hold the same URL for every quality. */
export function sameRtspUrls(
  a: RtspStreamUrls | undefined,
  b: RtspStreamUrls | undefined,
): boolean {
  return RTSP_QUALITIES.every((quality) => a?.[quality] === b?.[quality])
}

/** Whether a set holds any URL at all. */
export function hasRtspUrl(urls: RtspStreamUrls): boolean {
  return RTSP_QUALITIES.some((quality) => (urls[quality] ?? '') !== '')
}

// --- playback (RTSP-3, RTSP-5) ------------------------------------------------------------------

/** The `model` every RTSP stream shows in the inventory (RTSP-3). */
export const RTSP_STREAM_MODEL = 'RTSP stream'

/**
 * RTSP-3: main's camera inventory in RTSP mode, built from `config.rtsp.streams`. Each stream is a
 * {@link Camera} with its id and name, model {@link RTSP_STREAM_MODEL}, always `CONNECTED` (RTSP has
 * no presence feed: a stream that cannot connect shows "Stream could not start" instead), and every
 * Protect-only flag false or empty. In name order ignoring case, like the Streams screen. A fresh
 * array of fresh objects; `streams` is not touched.
 */
export function rtspInventory(
  streams: readonly { readonly id: string; readonly name: string }[],
): Camera[] {
  return [...streams]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((stream) => ({
      id: stream.id,
      name: stream.name,
      model: RTSP_STREAM_MODEL,
      state: 'CONNECTED',
      hasMic: false,
      micEnabled: false,
      hasSpeaker: false,
      smartDetectTypes: [],
      supportsFullHdSnapshot: false,
      hasPackageCamera: false,
    }))
}

/**
 * RTSP-3/5: a stored stream URL → its go2rtc source. `rtsps://` becomes go2rtc's `rtspx://` (TLS
 * without certificate verification: go2rtc cannot pin, SPEC R12); only the scheme changes, matched
 * ignoring case, and the rest is kept verbatim. `rtsp://` is passed as is. Anything else is
 * returned unchanged too: the caller has already validated the URL (`validateRtspUrl`), so this is
 * not a second validator.
 *
 * Unlike Protect's `toGo2rtcSource` nothing is stripped from the query: a user's camera expects its
 * own URL exactly as entered.
 */
export function toRtspGo2rtcSource(url: string): string {
  return /^rtsps:\/\//i.test(url) ? `rtspx://${url.slice('rtsps://'.length)}` : url
}
