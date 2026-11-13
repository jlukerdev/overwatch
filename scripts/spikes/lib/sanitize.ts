// Fixture sanitizer for Protect API captures (P0.3). Pure: no I/O, no globals.
//
// Redacts by key name (mac, host, ip, url, guid, token, email, owner, user ids, secrets) and by
// value pattern (IPv4, MAC, rtsps:// URLs, 24-hex Protect ids, UUIDs, explicit secrets), and maps
// every identifier to a stable fake one (e.g. `cam-001`) so references stay consistent across
// all fixtures written with the same sanitizer instance.

/** camelCase / snake_case words that mark a key whose value must be redacted. */
const SENSITIVE_WORDS = new Set([
  'mac',
  'host',
  'hostname',
  'ip',
  'ips',
  'url',
  'urls',
  'uri',
  'guid',
  'token',
  'email',
  'owner',
  'user',
  'users',
  'password',
  'secret',
  'serial',
])
/** Keys whose (lowercased) name contains one of these are always redacted. */
const SENSITIVE_SUBSTRINGS = ['apikey', 'password', 'secret', 'token']
/** Keys whose redacted values get a consistent fake id instead of a blank placeholder. */
const MAPPED_KEY_WORDS = new Map([
  ['mac', 'mac'],
  ['guid', 'guid'],
  ['user', 'user'],
  ['owner', 'user'],
])

const PROTECT_ID = /\b[0-9a-f]{24}\b/gi
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g
const MAC_SEPARATED = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi
const MAC_BARE = /\b[0-9a-f]{12}\b/gi
const EMAIL = /\b[^\s@"]+@[^\s@"]+\.[a-z]{2,}\b/gi
const RTSPS_URL = /\brtsps?:\/\/[^\s"]+/gi
/** A whole value that is only a dotted quad, e.g. `4.74.30.67`. */
const DOTTED_QUAD_ONLY = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** Key words that mark a version number, whose dotted quads are not IP addresses. */
const VERSION_KEY_WORDS = new Set(['version', 'firmware', 'fw'])

/** Fake RTSPS host used in fixtures (`.invalid` is reserved, RFC 2606). */
export const FAKE_HOST = 'console.invalid'

/** Short prefixes for well-known Protect model keys. */
const MODEL_PREFIX: Readonly<Record<string, string>> = {
  camera: 'cam',
  event: 'evt',
  nvr: 'nvr',
  user: 'user',
}

export interface SanitizerOptions {
  /** Literal secrets (API key, console host, ...) replaced wherever they appear in a string. */
  secrets?: readonly string[]
}

export interface Sanitizer {
  /** Returns a sanitized deep copy of `value`. The input is not modified. */
  sanitize(value: unknown): unknown
  /** Maps a raw identifier to its stable fake id, registering it under `prefix` if new. */
  mapId(raw: string, prefix?: string): string
  /** Redacts a single string using the value-pattern rules. `hint` labels RTSPS placeholders. */
  sanitizeString(value: string, hint?: string): string
}

/** Splits `macAddress` / `host_name` / `X-API-KEY` into lowercase words. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
}

/** True if a property with this name must never keep its real value. */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s))) return true
  return keyWords(key).some((w) => SENSITIVE_WORDS.has(w))
}

/** True for keys such as `firmwareVersion`, `fwVersion` or `version`. */
export function isVersionKey(key: string | undefined): boolean {
  return key !== undefined && keyWords(key).some((w) => VERSION_KEY_WORDS.has(w))
}

/** Shape-preserving placeholder for an RTSPS URL: keeps scheme, port and query, drops host and path. */
export function redactRtspsUrl(url: string, label = 'redacted'): string {
  const m = /^(rtsps?):\/\/[^/:?#\s]+(?::(\d+))?(?:\/[^?#\s]*)?(\?[^#\s]*)?/i.exec(url)
  if (!m) return `<${label}>`
  const [, scheme = 'rtsps', port, query = ''] = m
  return `${scheme.toLowerCase()}://${FAKE_HOST}${port ? `:${port}` : ''}/<${label}>${query}`
}

export function createSanitizer(options: SanitizerOptions = {}): Sanitizer {
  const secrets = (options.secrets ?? []).filter((s) => s.length > 0)
  const ids = new Map<string, string>()
  const counters = new Map<string, number>()

  function mapId(raw: string, prefix = 'id'): string {
    const key = raw.toLowerCase()
    const existing = ids.get(key)
    if (existing !== undefined) return existing
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)
    const fake = `${prefix}-${String(n).padStart(3, '0')}`
    ids.set(key, fake)
    return fake
  }

  function sanitizeString(value: string, hint?: string): string {
    // A bare dotted quad under a version key (`firmwareVersion: '4.74.30.67'`) is a version, not
    // an IP. Free text under such a key still gets the IPv4 rule.
    const keepDottedQuad = isVersionKey(hint) && DOTTED_QUAD_ONLY.test(value)
    let out = value
    for (const s of secrets) out = out.split(s).join('<redacted>')
    out = out.replace(RTSPS_URL, (url) =>
      redactRtspsUrl(url, hint ? `redacted-${hint}` : 'redacted'),
    )
    out = out.replace(EMAIL, '<redacted-email>')
    out = out.replace(UUID, (id) => mapId(id, 'uuid'))
    out = out.replace(PROTECT_ID, (id) => mapId(id))
    out = out.replace(MAC_SEPARATED, (mac) => mapId(mac.replace(/[:-]/g, ''), 'mac'))
    out = out.replace(MAC_BARE, (mac) => mapId(mac, 'mac'))
    if (!keepDottedQuad) out = out.replace(IPV4, '<redacted-ip>')
    return out
  }

  /** Redacts a value under a sensitive key, keeping its JSON type. */
  function redactKeyValue(key: string, value: unknown): unknown {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return 0
    if (typeof value === 'object') return walk(value, key)
    if (typeof value !== 'string') return null
    const raw = value
    if (raw.length === 0) return raw
    if (/^rtsps?:\/\//i.test(raw)) return redactRtspsUrl(raw, `redacted-${key}`)
    const mapped = keyWords(key).find((w) => MAPPED_KEY_WORDS.has(w))
    if (mapped !== undefined) return mapId(raw, MAPPED_KEY_WORDS.get(mapped))
    return `<redacted-${key}>`
  }

  function walk(value: unknown, parentKey?: string): unknown {
    if (typeof value === 'string') return sanitizeString(value, parentKey)
    if (Array.isArray(value)) return value.map((v) => walk(v, parentKey))
    if (value === null || typeof value !== 'object') return value
    const obj = value as Record<string, unknown>
    // Register ids by model kind first so a camera id becomes `cam-NNN` wherever it appears.
    const id = obj.id
    const modelKey = obj.modelKey
    if (typeof id === 'string' && typeof modelKey === 'string') {
      mapId(id, MODEL_PREFIX[modelKey] ?? modelKey)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const safeKey = sanitizeString(k)
      out[safeKey] = isSensitiveKey(k) ? redactKeyValue(k, v) : walk(v, k)
    }
    return out
  }

  return { sanitize: (value) => walk(value), mapId, sanitizeString }
}
