// Pure helpers for the P0.4 / P5.5 Access spike (scripts/spikes/access-spike.ts). No I/O.
// Unit-tested in tests/unit/accessTypes.test.ts. Erasable syntax only (Node type stripping).
import type { z } from 'zod'
import {
  ACCESS_API_PATH,
  ACCESS_DEFAULT_PORT,
  ACCESS_EVENT_REMOTE_UNLOCK,
  ACCESS_NOTIFICATIONS_PATH,
  AccessNotificationSchema,
  AccessRemoteUnlockDataSchema,
} from '../../../src/main/access/types.ts'
import { MOCK_HEADER, MOCK_HEADER_VALUE } from '../../mock-access/app.ts'

export type FixtureSource = 'mock' | 'console'

const HTTPS_ONLY = 'The Access API is HTTPS-only'

/**
 * The Access base URL: `VP_ACCESS_BASE_URL` if set, else `https://<VP_CONSOLE_HOST>:12445/api/v1/developer`.
 * Returned without a trailing slash. Anything but https:// is rejected (the API is HTTPS-only).
 */
export function resolveAccessBaseUrl(env: Readonly<Record<string, string | undefined>>): URL {
  const explicit = env.VP_ACCESS_BASE_URL?.trim()
  if (explicit) {
    const url = new URL(explicit)
    if (url.protocol !== 'https:')
      throw new Error(
        `${HTTPS_ONLY}: VP_ACCESS_BASE_URL must be an https:// URL (got ${url.protocol}//)`,
      )
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url
  }
  const raw = env.VP_CONSOLE_HOST?.trim() ?? ''
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== 'https')
    throw new Error(
      `${HTTPS_ONLY}: VP_CONSOLE_HOST must be a host name or https:// (got ${scheme}://)`,
    )
  const host = raw.replace(/^https:\/\//i, '').replace(/[:/].*$/, '')
  if (!host) throw new Error('Set VP_ACCESS_BASE_URL, or VP_CONSOLE_HOST for the default base URL')
  return new URL(`https://${host}:${String(ACCESS_DEFAULT_PORT)}${ACCESS_API_PATH}`)
}

/** The explicit port of an https URL, else 443. Throws for anything but https (HTTPS-only API). */
export function urlPort(url: URL): number {
  if (url.protocol !== 'https:') throw new Error(`${HTTPS_ONLY} (got ${url.protocol}//)`)
  return url.port ? Number(url.port) : 443
}

/** Read-only view of response headers (a fetch `Headers` satisfies it). */
export interface HeaderReader {
  get(name: string): string | null
}

/**
 * Positive mock identification: `mock` only when the response carries the mock-only header
 * (`x-view-protect-mock: 1`, sent by scripts/mock-access on every response). Anything else is
 * `console`, whatever the host: a loopback address is not proof of the mock.
 */
export function sourceFromHeaders(headers: HeaderReader): FixtureSource {
  return headers.get(MOCK_HEADER)?.trim() === MOCK_HEADER_VALUE ? 'mock' : 'console'
}

export const YES_REFUSED =
  '--yes is only allowed against the mock; on a real console type the door name to confirm (DOOR-3/4)'

/**
 * How the unlock is confirmed (DOOR-3/4): `skip` only for `--yes` against a positively identified
 * mock; `prompt` (type the door name) otherwise. Throws for `--yes` against anything but the mock,
 * and when a prompt is needed but there is no terminal.
 */
export function unlockConfirmation(opts: {
  source: FixtureSource
  yes: boolean
  isTTY: boolean
}): 'skip' | 'prompt' {
  if (opts.yes) {
    if (opts.source !== 'mock') throw new Error(YES_REFUSED)
    return 'skip'
  }
  if (!opts.isTTY)
    throw new Error(
      'Unlock needs an interactive terminal to type the door name (DOOR-3/4)' +
        (opts.source === 'mock' ? ', or --yes against the mock' : ''),
    )
  return 'prompt'
}

/**
 * Normalizations the lenient Access schemas would apply to a raw response (UNVERIFIED, OS-1):
 * `is_bind_hub` sent as the string 'true'/'false', and an envelope without `msg`. Run on the raw
 * JSON before parsing so the spike reports which form the console really uses.
 */
export function shapeNotes(json: unknown): string[] {
  const notes: string[] = []
  if (!isRecord(json)) return notes
  if (!('msg' in json)) notes.push('(envelope).msg absent (accepted: msg is optional)')
  const data = json.data
  const doors = Array.isArray(data) ? data : isRecord(data) ? [data] : []
  const forms = new Set<string>()
  for (const d of doors)
    if (isRecord(d) && typeof d.is_bind_hub === 'string') forms.add(JSON.stringify(d.is_bind_hub))
  for (const f of [...forms].sort())
    notes.push(`door.is_bind_hub sent as string ${f} (normalized to boolean)`)
  return notes
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Pin file name keyed by host and port, so the mock's pin and the site console's pin never
 * collide (and neither collides with the Protect spike's `console-pin.json`).
 */
export function accessPinFileName(url: URL): string {
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '_')
  return `access-pin-${host}-${String(urlPort(url))}.json`
}

/** Finds a door by exact name (case-insensitive). Throws listing the doors if none or several match. */
export function findDoorByName<T extends { name: string }>(doors: readonly T[], name: string): T {
  const want = name.trim().toLowerCase()
  const matches = doors.filter((d) => d.name.trim().toLowerCase() === want)
  const list = doors.map((d) => `"${d.name}"`).join(', ')
  const [match, ...rest] = matches
  if (match === undefined) throw new Error(`--unlock "${name}" matches no door. Doors: ${list}`)
  if (rest.length > 0) throw new Error(`--unlock "${name}" matches several doors: ${list}`)
  return match
}

/** The interactive confirmation passes only when the typed text is the door's exact name. */
export function confirmationMatches(typed: string, doorName: string): boolean {
  return typed.trim() === doorName.trim()
}

/** One `path: message` line per zod issue (array indices collapsed to `[]`), deduplicated. */
export function describeIssues(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((i) => {
        const path = i.path.map((p) => (typeof p === 'number' ? '[]' : String(p))).join('.')
        return `${path || '(root)'}: ${i.message}`
      }),
    ),
  ]
}

/** Keys of `obj` that are not in `known` (extra fields the community shape does not describe). */
export function extraKeys(obj: unknown, known: readonly string[]): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.keys(obj)
    .filter((k) => !known.includes(k))
    .sort()
}

/** `wss://` URL of the notifications WebSocket for an Access base URL (reference §11.1). */
export function notificationsUrl(baseUrl: URL): string {
  urlPort(baseUrl)
  return `wss://${baseUrl.host}${baseUrl.pathname.replace(/\/+$/, '')}${ACCESS_NOTIFICATIONS_PATH}`
}

/** What the spike records about one WebSocket frame: names only, never a value. */
export interface NotificationShape {
  /** The event name, or a placeholder when the frame is not a JSON object with one. */
  event: string
  /** Top-level field names, sorted. */
  keys: string[]
  /** Field names of `data`, sorted (empty when `data` is not an object). */
  dataKeys: string[]
  /** Whether the frame parses with the app's notification schema (and, for a remote unlock, its data schema). */
  schemaOk: boolean
  /** For a remote unlock: whether `data.unique_id` is `expectDoorId`. Absent otherwise. */
  doorIdMatches?: boolean
}

/**
 * Reduces a received WebSocket text frame to its event name and field names (OS-1 records which
 * events an unlock produces without recording anything about the site).
 */
export function describeNotification(raw: string, expectDoorId?: string): NotificationShape {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { event: '(not JSON)', keys: [], dataKeys: [], schemaOk: false }
  }
  if (!isRecord(json)) return { event: '(not an object)', keys: [], dataKeys: [], schemaOk: false }
  const frame = AccessNotificationSchema.safeParse(json)
  const shape: NotificationShape = {
    event: frame.success ? frame.data.event : '(no event)',
    keys: Object.keys(json).sort(),
    dataKeys: isRecord(json.data) ? Object.keys(json.data).sort() : [],
    schemaOk: frame.success,
  }
  if (frame.success && frame.data.event === ACCESS_EVENT_REMOTE_UNLOCK) {
    const data = AccessRemoteUnlockDataSchema.safeParse(frame.data.data)
    shape.schemaOk = data.success
    if (expectDoorId !== undefined)
      shape.doorIdMatches = data.success && data.data.unique_id === expectDoorId
  }
  return shape
}
