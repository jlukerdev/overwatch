// The Settings screen's decisions, as pure functions over plain data (P1.6; CON-1…5, DOOR-0).
//
// The components in this folder hold React state and render; everything that can be *wrong* about a
// console form lives here, because this project has no jsdom and no testing-library (see
// vitest.config.mts: node environment only), so a rule that lives in a component is a rule no test
// can reach. CLAUDE.md asks for exactly that split.
//
// Two boundaries this module deliberately does not cross:
//
//  1. **`parseConsoleHost` in main stays the authority on host syntax** (SPEC §6). Re-implementing
//     its IPv6 bracketing and port rules here would give the user two slightly different answers to
//     the same question. What is checked below is only what is *obviously* wrong before a round
//     trip: an empty host that something else depends on, a scheme typed into a bare-host field, an
//     Access base URL that is not a URL at all, and Access switched on with no token anywhere.
//  2. **Secrets are write-only** (CON-2, NFR-9). The draft's key fields start empty and are never
//     seeded from anything, because the renderer cannot read a stored credential back — it only
//     learns *whether* one exists (`SecretsStored`). That is also why they take no part in
//     `isConsoleDirty`: each secret has its own Save button and its own `setSecret` call, so the
//     console Save button must not light up because a password box has characters in it.
import type { CertInfo, EndpointStatus, ConsoleInput, SecretsStored, Settings } from '@shared/ipc'

/** The fields the form can report an error against. */
export const CONSOLE_FIELDS = ['host', 'accessBaseUrl', 'protectApiKey', 'accessToken'] as const
export type ConsoleField = (typeof CONSOLE_FIELDS)[number]
export type ConsoleFieldErrors = Partial<Record<ConsoleField, string>>

/**
 * The controlled draft the form edits. Strings rather than `string | null`, because an input's value
 * is always a string: the empty Access base URL is `''` here and becomes the `null` that SPEC §6
 * reads as "derive `https://<host>:12445/api/v1/developer`".
 */
export interface ConsoleDraft {
  host: string
  accessEnabled: boolean
  accessBaseUrl: string
  /** Typed, never loaded (CON-2). Empty means "leave whatever is in the keystore alone". */
  protectApiKey: string
  accessToken: string
}

export type ConsoleInputResult =
  | { readonly ok: true; readonly input: ConsoleInput }
  | { readonly ok: false; readonly errors: ConsoleFieldErrors }

/** A draft that matches what is saved, with both secret fields empty. */
export function consoleDraftFrom(settings: Settings): ConsoleDraft {
  return {
    host: settings.console.host,
    accessEnabled: settings.console.accessEnabled,
    accessBaseUrl: settings.console.accessBaseUrl ?? '',
    protectApiKey: '',
    accessToken: '',
  }
}

/**
 * The saved console values as one comparable string. The form resets its draft when this changes —
 * i.e. when a save actually landed — rather than on every `AppState` that crosses the bridge, since
 * every mutating channel answers with the whole state (ipc.ts rule 3) and storing an API key would
 * otherwise throw away a half-typed host.
 */
export function consoleSignature(settings: Settings): string {
  const { host, accessEnabled, accessBaseUrl } = settings.console
  return JSON.stringify([host, accessEnabled, accessBaseUrl])
}

/**
 * Whether Save should be enabled. Only the three fields `setConsole` carries count: the secrets have
 * their own buttons, and the fingerprints are written by `acceptCertificate`/`repinCertificate`
 * alone (ipc.ts, `ConsoleInputSchema`).
 */
export function isConsoleDirty(draft: ConsoleDraft, settings: Settings): boolean {
  const saved = settings.console
  return (
    draft.host.trim() !== saved.host ||
    draft.accessEnabled !== saved.accessEnabled ||
    normalizeBaseUrl(draft.accessBaseUrl) !== saved.accessBaseUrl
  )
}

/** Matches `ConsoleConfig.accessBaseUrl`: an empty field is `null`, i.e. "derive it" (SPEC §6). */
function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** `scheme://` at the start of the host field, which SPEC §6 wants entered as a bare address. */
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * Validates the draft and builds the `setConsole` payload.
 *
 * `secretsStored` is needed for one rule only: Access may be switched on with an empty token field
 * when a token is already in the keystore (DOOR-0's "turning it off keeps the saved token"), so the
 * check is "no token anywhere", not "the field is empty".
 */
export function consoleInputFrom(
  draft: ConsoleDraft,
  secretsStored: SecretsStored,
): ConsoleInputResult {
  const errors: ConsoleFieldErrors = {}
  const host = draft.host.trim()
  const accessBaseUrl = normalizeBaseUrl(draft.accessBaseUrl)

  const scheme = SCHEME_PREFIX.exec(host)
  if (scheme !== null) {
    // https:// is refused rather than stripped: the field is a bare address, and silently rewriting
    // what the user typed is how a wrong port or a stray path ends up pinned (SPEC §6, CON-3).
    errors.host =
      scheme[1]?.toLowerCase() === 'https'
        ? 'Enter the address only, with no https:// in front of it.'
        : 'Only https is supported, and the address is entered without a scheme.'
  } else if (host === '' && needsHost(draft, secretsStored)) {
    errors.host = 'Enter the console IP or host name.'
  }

  if (accessBaseUrl !== null && !isHttpsUrl(accessBaseUrl)) {
    errors.accessBaseUrl =
      'Enter the full Access API root as an https:// URL, or leave this empty to use port 12445.'
  }

  if (draft.accessEnabled && draft.accessToken.trim() === '' && !secretsStored.accessToken) {
    errors.accessToken = 'UniFi Access needs an API token. Enter one, or switch Access off.'
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, input: { host, accessEnabled: draft.accessEnabled, accessBaseUrl } }
}

/**
 * An empty host is a legitimate state — it is what a fresh install saves (`ConsoleInputSchema`
 * allows `''` and means "not configured yet") — so it is only an error once something that cannot
 * work without an address is in play.
 */
function needsHost(draft: ConsoleDraft, secretsStored: SecretsStored): boolean {
  return (
    draft.accessEnabled ||
    draft.protectApiKey.trim() !== '' ||
    draft.accessToken.trim() !== '' ||
    secretsStored.protectApiKey ||
    secretsStored.accessToken
  )
}

function isHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:'
}

/**
 * A fingerprint grouped for reading (CON-3). The pins arrive colon-separated and uppercase from
 * `CertInfo.fingerprint256`, which is 32 octets on one unbroken line — the shape in which two
 * different certificates look identical at a glance. Groups of four octets give the eye something
 * to hold on to while comparing it with the console's own screen.
 *
 * Only ever used for display. What gets sent to `acceptCertificate`/`repinCertificate` is the
 * original string, because main compares it with the leaf it re-reads (ipc.ts, `AcceptCertInput`).
 */
export function formatFingerprint(fingerprint: string): string {
  const octets = splitOctets(fingerprint)
  if (octets.length === 0) return ''

  const groups: string[] = []
  for (let i = 0; i < octets.length; i += 4) {
    groups.push(octets.slice(i, i + 4).join(':'))
  }
  return groups.join('  ')
}

/** Accepts the colon-separated form and a bare hex digest, since both are readable as a pin. */
function splitOctets(fingerprint: string): string[] {
  const trimmed = fingerprint.trim().toUpperCase()
  if (trimmed === '') return []
  if (trimmed.includes(':')) return trimmed.split(':').filter((part) => part !== '')
  return trimmed.match(/.{1,2}/g) ?? []
}

/**
 * The one-line description under a fingerprint: enough for the user to recognise the console they
 * are about to trust, which is the whole point of the TOFU step (CON-3).
 */
export function describeCert(cert: CertInfo): string {
  return [
    cert.subjectCommonName === null ? 'no subject name' : `subject ${cert.subjectCommonName}`,
    cert.issuerCommonName === null ? 'no issuer name' : `issued by ${cert.issuerCommonName}`,
    `valid ${formatDate(cert.validFrom)} to ${formatDate(cert.validTo)}`,
    // Expected for a UniFi console, so it is stated plainly rather than as a warning.
    cert.selfSigned ? 'self-signed' : 'signed by a certificate authority',
  ].join(' · ')
}

/** Dates come from the certificate as text; a date is enough and the time of day is noise. */
function formatDate(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toISOString().slice(0, 10)
}

/**
 * What is and is not set up for one endpoint (CON-5). This is the line that tells a user why nothing
 * connects: an address, a pin and a credential are three separate things to get wrong, and the
 * header badge has room for none of them.
 */
export function describeEndpointStatus(status: EndpointStatus): string {
  const parts = [
    status.hostPort ?? 'no address yet',
    status.pinned ? 'certificate pinned' : 'certificate not accepted yet',
    status.credentialStored ? 'credential stored' : 'no credential stored',
  ]
  if (status.version !== null) parts.push(`version ${status.version}`)
  return parts.join(' · ')
}
