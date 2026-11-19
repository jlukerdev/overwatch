// The log redactor (P6.3, CON-2, NFR-9): what keeps a secret out of `<userData>/logs/app.log` and
// out of the terminal. Every line main writes goes through `redactLogText` before it reaches either.
//
// Two layers, applied in this order:
//  1. **The live secret values**, passed in by the caller at write time (the Protect API key, the
//     Access token, go2rtc's per-launch API username and password and their Basic value), so a key
//     saved or cleared mid-session is covered from the next line on. Longest first, so a value is
//     never half-replaced through a substring of another. Also their URL-encoded form, for a value
//     that ends up in a query string.
//  2. **Patterns**, for a secret this process does not hold as a value (another launch's go2rtc
//     credential in a stale line, a header echoed back by a server, a token in a URL):
//     `Basic`/`Bearer` values, `Authorization:` / `X-API-KEY:` header values, RTSP(S) URLs (the
//     alias in a Protect RTSPS URL *is* the stream credential), URL userinfo, query parameters named
//     like a credential, and the rate-limit header's `pk=:…:` partition key (SPEC §5.1).
//
// Literal values shorter than 4 characters are ignored (the same rule as before): redacting those
// would mangle unrelated text without protecting anything.
//
// Pure: no Electron, no fs, no module state. `redactSecrets` and `redactSourceUrls` lived in
// `streams/go2rtcConfig.ts` (P2.1) and moved here so the app log can share them; go2rtcConfig
// re-exports both unchanged.

/**
 * Any RTSP / RTSPS / RTSPX URL, whole. Shared by `redactSourceUrls` (go2rtc's lines, which say
 * `<redacted-source-url>`) and `redactLogText` (which says `<redacted>`).
 */
const RTSP_URL = /\brtsp[sx]?:\/\/[^\s"',}]+/gi

/** What every redacted value is replaced with in the app log. */
export const REDACTED = '<redacted>'

/** Literal secret values shorter than this are not redacted. */
export const MIN_SECRET_LENGTH = 4

/**
 * Replaces each secret (longest first, so a token is not half-replaced through a substring of
 * another) and any `Basic`/`Bearer` value with `<redacted>`. Values shorter than 4 characters are
 * ignored: redacting those would mangle unrelated text without protecting anything.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, `$1 ${REDACTED}`)
  for (const s of [...secrets]
    .filter((x) => x.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length))
    out = out.split(s).join(REDACTED)
  return out
}

/**
 * Redacts anything that looks like an RTSP(S) URL. The alias in a Protect RTSPS URL *is* the
 * credential for that camera's stream, and go2rtc logs its sources on connect and on every
 * reconnect error, so this runs over every line of the child's output (CON-2, NFR-9).
 */
export function redactSourceUrls(line: string): string {
  return line.replace(RTSP_URL, '<redacted-source-url>')
}

/**
 * The username and password inside a `Basic …` header value, plus the base64 value itself: every
 * form of go2rtc's credential a line could carry. Empty for `null` or anything that is not Basic.
 */
export function basicHeaderSecrets(header: string | null | undefined): string[] {
  if (header === null || header === undefined) return []
  const match = /^Basic\s+(\S+)$/i.exec(header.trim())
  const encoded = match?.[1]
  if (encoded === undefined) return []
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return [encoded]
  return [encoded, decoded.slice(0, colon), decoded.slice(colon + 1)]
}

/** The literal values, deduplicated, too-short ones dropped, each with its URL-encoded form. */
function literalForms(secrets: readonly string[]): string[] {
  const out = new Set<string>()
  for (const s of secrets) {
    if (s.length < MIN_SECRET_LENGTH) continue
    out.add(s)
    let encoded: string
    try {
      encoded = encodeURIComponent(s)
    } catch {
      // A lone surrogate cannot be encoded; the raw value is still redacted.
      continue
    }
    if (encoded !== s) out.add(encoded)
  }
  return [...out]
}

/**
 * Header names whose value is always a credential (case-insensitive), in the shapes a log line
 * carries them: `Authorization: v`, `"authorization":"v"`, `{ 'x-api-key': 'v' }`, `name=v`, and
 * util.inspect's Map / Headers form `'x-api-key' => 'v'`. An optional auth scheme word stays
 * readable; the value is one token, so prose after it is left alone.
 */
const HEADER_VALUE =
  /\b(authorization|x-api-key)(["']?\s*(?:=>|:|=)\s*)(["']?)((?:basic|bearer|digest|token|apikey)\s+)?(?!<redacted>)(?!(?:basic|bearer|digest|token|apikey)\s+<redacted>)[^\s"',;}&]+/gi

/** `scheme://user:pass@host` (or `scheme://token@host`): the userinfo goes. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)(?!<redacted>@)[^\s/?#@"'<>]+@/gi

/**
 * A query parameter whose name contains a credential word: `token`, `key` (and `api_key`,
 * `apikey`), `password`/`passwd`, `secret`, `auth`. Matched by substring, so `access_token`,
 * `apiKey` and `authToken` are caught too; erring towards redacting a harmless value is the
 * intended direction.
 */
const QUERY_CREDENTIAL =
  /([?&][a-z0-9_.-]*(?:token|key|password|passwd|secret|auth)[a-z0-9_.-]*=)(?!<redacted>)[^&\s"'#<>]*/gi

/** The rate-limit header's partition key, `pk=:<base64>:` (SPEC §5.1). Never logged. */
const PARTITION_KEY = /\bpk=:[^:\s]*:/gi

/**
 * The app log's redactor: `text` with every live secret value and every credential-shaped
 * pattern replaced by `<redacted>`. Idempotent: redacting a redacted line changes nothing.
 */
export function redactLogText(text: string, secrets: readonly string[] = []): string {
  // 1. Live values first, before a pattern can split one (e.g. a key inside a URL).
  let out = text
  for (const s of literalForms(secrets).sort((a, b) => b.length - a.length))
    out = out.split(s).join(REDACTED)
  // 2. Patterns. RTSP URLs first: the whole URL goes, userinfo and query string included.
  out = out.replace(RTSP_URL, REDACTED)
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`)
  out = out.replace(QUERY_CREDENTIAL, `$1${REDACTED}`)
  out = out.replace(PARTITION_KEY, `pk=:${REDACTED}:`)
  out = out.replace(HEADER_VALUE, `$1$2$3$4${REDACTED}`)
  out = redactSecrets(out, [])
  return out
}
