// Safe logging of the Protect rate-limit headers (SPEC §5.1, R9).
//
// The console answers every request with `ratelimit: "10-in-1sec"; r=<remaining>; t=<reset s>` and
// `ratelimit-policy: "10-in-1sec"; q=10; w=1; pk=:<partition key>:`. The `pk` value is an opaque
// per-client key and **must never be logged**, so these headers go through an allowlist rather than
// a blocklist: anything this filter does not recognise is dropped, including a parameter a console
// upgrade might add.
//
// It lived in `scripts/spikes/lib/sanitize.ts` for the P0.3 spike and moved here in P1.3 so the app's
// Protect client and the spike share one implementation (the spike imports it from this path;
// `src/main` must not import from `scripts/`). Node runs those scripts directly with type
// stripping, so: erasable syntax only, and no imports that pull in anything Electron.

/** Parameter names worth logging from `ratelimit` / `ratelimit-policy` style headers. */
const RATE_LIMIT_PARAMS = new Set(['q', 'w', 'r', 't', 'limit', 'remaining', 'reset'])

/**
 * Allowlist filter for rate-limit headers (structured-field style: `"10-in-1sec"; q=10; w=1`).
 * Keeps each list member's policy name and only the known numeric parameters; drops everything
 * else, including the per-client partition key `pk`. A plain number (e.g. `retry-after: 1`) is
 * kept as is. Returns '' when nothing is safe to log.
 */
export function filterRateLimitHeader(value: string): string {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  return trimmed
    .split(',')
    .map((member) => {
      const parts = member.split(';').map((p) => p.trim())
      const kept: string[] = []
      // The first segment is the policy name (`"10-in-1sec"`) unless it is already a parameter.
      const first = parts[0] ?? ''
      if (!first.includes('=')) {
        parts.shift()
        // Only a **quoted** policy name is kept (`"10-in-1sec"`, the form the console sends). A
        // bare token is dropped: the name is cosmetic, and accepting arbitrary tokens is how a
        // value that is not a policy name at all would reach the log.
        if (/^"[\w.-]+"$/.test(first)) kept.push(first)
      }
      for (const p of parts) {
        const m = /^([a-z][\w-]*)=(\d+(?:\.\d+)?)$/i.exec(p)
        if (m?.[1] !== undefined && RATE_LIMIT_PARAMS.has(m[1].toLowerCase())) kept.push(p)
      }
      return kept.join('; ')
    })
    .filter((m) => m.length > 0)
    .join(', ')
}

/**
 * The header names worth inspecting, matched **exactly**. An earlier version used a substring
 * pattern (`/rate|retry|limit/i`), which also matched unrelated names — `x-corporate-id` contains
 * "rate" — and so copied their values into the log. An allowlist of names cannot do that, and the
 * cost of missing a header a console upgrade invents is only a less informative log line.
 */
const RATE_LIMIT_HEADER_NAMES = new Set([
  // What the console actually sends (P0.3 §7).
  'ratelimit',
  'ratelimit-policy',
  // The same family as standardised and as other proxies send it.
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
])

/** The subset of a response's headers this module can read (a fetch `Headers` satisfies it). */
export interface RateLimitHeaderSource {
  keys(): Iterable<string>
  get(name: string): string | null
}

/**
 * Every rate-limit header of a response, filtered through {@link filterRateLimitHeader} and with
 * the ones that have nothing safe left dropped. Safe to log as is.
 */
export function collectRateLimitHeaders(headers: RateLimitHeaderSource): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of headers.keys()) {
    if (!RATE_LIMIT_HEADER_NAMES.has(name.toLowerCase())) continue
    const value = filterRateLimitHeader(headers.get(name) ?? '')
    if (value) out[name.toLowerCase()] = value
  }
  return out
}
