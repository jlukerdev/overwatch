// The Add / Edit stream dialog's rules (RTSP-1, RTSP-2), kept out of the component so they can be
// unit-tested (the project has no jsdom: tests/renderer/streamForm.test.ts).
//
// **Write-only URLs (RTSP-2, CON-2).** The renderer never sees a stored URL, only which qualities
// have one (`secretsStored.rtspUrls`, booleans). So each quality's field is in one of four modes:
//
//   - `keep`:    a URL is stored and left alone. Sent **absent**, so main keeps it.
//   - `replace`: a URL is stored and the user opened an empty field for a new one. Sent as the
//                typed string; an open but **empty** Replace field is treated as `keep` (absent),
//                since that is what the user sees before typing — the "Saved" URL has not gone
//                anywhere — and the least surprising outcome of pressing Save.
//   - `clear`:   a URL is stored and the user cleared it. Sent as `null`.
//   - `new`:     nothing is stored for this quality. An empty field means nothing (absent); a typed
//                URL is sent as the string.
//
// The URL rules are `validateRtspUrl` from @shared/rtsp, the same function main runs, so the form
// and main can never disagree. Nothing here trims a URL: a leading space is an error to fix, not
// something silently changed in a secret.
import { sortByLabel } from '@shared/cameraOrder'
import type { SaveRtspStreamInput } from '@shared/ipc'
import {
  RTSP_QUALITIES,
  validateRtspStreamName,
  validateRtspUrl,
  type RtspQualitiesStored,
  type RtspQuality,
} from '@shared/rtsp'

export type UrlMode = 'keep' | 'replace' | 'clear' | 'new'

export interface UrlDraft {
  /** Main holds a URL for this quality (only ever a boolean, RTSP-2). */
  readonly stored: boolean
  readonly mode: UrlMode
  /** What is typed in the field, untrimmed. Only read in `replace` and `new`. */
  readonly value: string
}

export interface StreamForm {
  /** The stream being edited, `undefined` when adding one. */
  readonly id: string | undefined
  readonly name: string
  readonly urls: Readonly<Record<RtspQuality, UrlDraft>>
}

export type StreamField = 'name' | RtspQuality

export interface StreamFormCheck {
  /** Per field: a sentence for `.field__error`, or `null`. */
  readonly errors: Readonly<Record<StreamField, string | null>>
  /** The form would leave the stream with no URL at all (RTSP-2: at least one is needed). */
  readonly noUrl: boolean
  /** The save sets or clears a URL, which needs the system keystore (CON-2). */
  readonly writesUrl: boolean
  readonly canSave: boolean
}

/** Shown when no quality would have a URL after saving. */
export const NO_URL_MESSAGE = 'A stream needs at least one address.'

const NO_STORED: RtspQualitiesStored = { high: false, medium: false, low: false }

/** A fresh form: empty for Add, or seeded from a stored stream and its booleans for Edit. */
export function streamFormFrom(
  stream?: { readonly id: string; readonly name: string },
  stored: RtspQualitiesStored = NO_STORED,
): StreamForm {
  const urls = {} as Record<RtspQuality, UrlDraft>
  for (const quality of RTSP_QUALITIES) {
    const has = stream !== undefined && stored[quality]
    urls[quality] = { stored: has, mode: has ? 'keep' : 'new', value: '' }
  }
  return { id: stream?.id, name: stream?.name ?? '', urls }
}

export function setName(form: StreamForm, name: string): StreamForm {
  return { ...form, name }
}

function withUrl(form: StreamForm, quality: RtspQuality, draft: UrlDraft): StreamForm {
  return { ...form, urls: { ...form.urls, [quality]: draft } }
}

/** Types into a quality's field (`new` or `replace`; ignored otherwise). */
export function setUrl(form: StreamForm, quality: RtspQuality, value: string): StreamForm {
  const draft = form.urls[quality]
  if (draft.mode !== 'new' && draft.mode !== 'replace') return form
  return withUrl(form, quality, { ...draft, value })
}

/** Opens an empty field for a stored quality's new URL. */
export function replaceUrl(form: StreamForm, quality: RtspQuality): StreamForm {
  const draft = form.urls[quality]
  if (!draft.stored) return form
  return withUrl(form, quality, { ...draft, mode: 'replace', value: '' })
}

/** Marks a stored quality's URL to be removed on Save. */
export function clearUrl(form: StreamForm, quality: RtspQuality): StreamForm {
  const draft = form.urls[quality]
  if (!draft.stored) return form
  return withUrl(form, quality, { ...draft, mode: 'clear', value: '' })
}

/** Undoes Replace or Clear: the stored URL stays as it is. */
export function keepUrl(form: StreamForm, quality: RtspQuality): StreamForm {
  const draft = form.urls[quality]
  if (!draft.stored) return form
  return withUrl(form, quality, { ...draft, mode: 'keep', value: '' })
}

/** The quality's field holds something to send (a typed URL in `new` or `replace`). */
function typed(draft: UrlDraft): boolean {
  return (draft.mode === 'new' || draft.mode === 'replace') && draft.value !== ''
}

/** After saving, this quality would have a URL (valid typed text, or a stored one kept). */
function hasUrlAfterSave(draft: UrlDraft): boolean {
  if (typed(draft)) return validateRtspUrl(draft.value).ok
  // An empty Replace field keeps the stored URL (see the top of the file).
  return draft.stored && (draft.mode === 'keep' || draft.mode === 'replace')
}

export function validateStreamForm(
  form: StreamForm,
  streams: readonly { readonly id: string; readonly name: string }[],
): StreamFormCheck {
  const nameCheck = validateRtspStreamName(form.name, streams, form.id)
  const errors: Record<StreamField, string | null> = {
    name: nameCheck.ok ? null : nameCheck.reason,
    high: null,
    medium: null,
    low: null,
  }
  let anyUrl = false
  let writesUrl = false
  for (const quality of RTSP_QUALITIES) {
    const draft = form.urls[quality]
    if (typed(draft)) {
      writesUrl = true
      const check = validateRtspUrl(draft.value)
      if (!check.ok) errors[quality] = check.reason
    }
    if (draft.mode === 'clear') writesUrl = true
    if (hasUrlAfterSave(draft)) anyUrl = true
  }
  const fieldsOk = Object.values(errors).every((error) => error === null)
  return { errors, noUrl: !anyUrl, writesUrl, canSave: fieldsOk && anyUrl }
}

/**
 * The `vp:rtsp/streams/save` payload: per quality, **absent** to keep (or nothing to set), `null`
 * to clear, a string to set. `id` only when editing. Call only when `validateStreamForm` allows.
 */
export function toSaveInput(form: StreamForm): SaveRtspStreamInput {
  const urls: SaveRtspStreamInput['urls'] = {}
  for (const quality of RTSP_QUALITIES) {
    const draft = form.urls[quality]
    if (draft.mode === 'clear') urls[quality] = null
    else if (typed(draft)) urls[quality] = draft.value
  }
  const name = form.name.trim()
  return form.id === undefined ? { name, urls } : { id: form.id, name, urls }
}

// -------------------------------------------------------------------------------------------------
// The list (RTSP-1)

/**
 * Streams in name order, ignoring case, numbers as numbers ("Cam 2" before "Cam 10"; RTSP-1): the
 * collator every list in the app sorts by (`sortByLabel`, @shared/cameraOrder), ties in their
 * input order. Does not change its argument.
 */
export function sortStreams<T extends { readonly name: string }>(streams: readonly T[]): T[] {
  return sortByLabel(streams, (stream) => stream.name)
}

/** "1 stream", "3 streams". */
export function streamCountLabel(count: number): string {
  return count === 1 ? '1 stream' : `${String(count)} streams`
}
