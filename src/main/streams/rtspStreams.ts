// RTSP-1/2: the rules main applies to a stream save or delete (`vp:rtsp/streams/save`,
// `vp:rtsp/streams/delete`) that are not the IPC handler's plumbing: how a save's per-quality
// changes combine with what is stored, and the refusals with their fixed sentences.
//
// CON-2: a stream URL is a secret. Every message here is a fixed sentence: none quotes a URL, a
// stream id or any part of either, so a refusal is safe to show and to log as is.
//
// No Electron and no I/O: a plain module the tests import as is.
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
