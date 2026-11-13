// One error taxonomy for everything that talks to the Protect Integration API: the REST client
// (P1.3) and both WebSocket subscriptions (P1.3) raise these, and Settings (P1.6) and the camera
// list (P1.7) branch on `kind` rather than re-reading HTTP statuses.
//
// Every non-2xx response carries `{ error, name, cause? }` (SPEC §5.1), and a 429 adds `windowMs`
// and `limit` (contract drift found in P0.3 §7; the override is in ./types.ts). `name` is the
// console's own machine-readable code, so it is kept as it arrived, and `error` is the text the user
// sees.
//
// **Nothing here may carry a secret.** The API key never appears in a message, and nor does an
// RTSPS URL (CON-2, NFR-9): a message built here can be logged and shown in the UI as is.
import { describeError, isTimeoutError, pinFailure, rootCause } from '../net/errorCause'
import type { ProtectErrorBody } from './types'

/**
 * What went wrong, in the terms a caller can act on:
 * - `auth` — the key is missing, wrong or not allowed (401/403). Settings must say so (CON-4).
 * - `rate-limit` — 429 or a WebSocket closed with 4500 (R9). `retryAfterMs` says how long to wait.
 * - `not-found` — 404: the camera is gone from the console.
 * - `bad-request` — 400, e.g. `highQuality=true` on a camera without full-HD snapshots (SPEC §5.1).
 * - `unavailable` — 503. The contract means "camera offline", but that is **unverified** (R11), so
 *   CAM-3 treats *any* failure of a camera's snapshot as offline, not this kind alone.
 * - `server` — any other 5xx.
 * - `timeout` — the request or handshake ran out of time.
 * - `network` — the connection failed (console down, wrong host, DNS, TCP reset).
 * - `pin` — the TLS pin is missing or did not match (CON-3). **Never retry this**, and never
 *   fall back to an unpinned connection; the user has to re-accept the certificate in Settings.
 * - `invalid-response` — a 2xx whose body is not what the contract describes.
 * - `closed` — the subscription was closed by the console or by us, with no better reason.
 */
export type ProtectErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'not-found'
  | 'bad-request'
  | 'unavailable'
  | 'server'
  | 'timeout'
  | 'network'
  | 'pin'
  | 'invalid-response'
  | 'closed'

export interface ProtectApiErrorInit {
  readonly kind: ProtectErrorKind
  /** HTTP status, or `null` for a failure that never got a response. */
  readonly status?: number | null
  /** The body's `name`, the console's machine-readable code (e.g. `TOO_MANY_REQUESTS_ERROR`). */
  readonly apiName?: string | null
  /** How long to wait before trying again (429's `windowMs`), or `null`. */
  readonly retryAfterMs?: number | null
  /** `host:port` the call was made to, for messages. Carries no credential. */
  readonly endpoint?: string | null
  readonly cause?: unknown
}

/** Every failure of a Protect call, REST or WebSocket. */
export class ProtectApiError extends Error {
  override readonly name = 'ProtectApiError'
  readonly kind: ProtectErrorKind
  readonly status: number | null
  readonly apiName: string | null
  readonly retryAfterMs: number | null
  readonly endpoint: string | null

  constructor(message: string, init: ProtectApiErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.kind = init.kind
    this.status = init.status ?? null
    this.apiName = init.apiName ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.endpoint = init.endpoint ?? null
  }

  /** True for the kinds where trying the same call again can plausibly succeed. */
  get retryable(): boolean {
    return (
      this.kind === 'rate-limit' ||
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      this.kind === 'server' ||
      this.kind === 'unavailable'
    )
  }
}

/**
 * Reads a non-2xx body as the documented `{ error, name, cause? }` shape (plus a 429's `windowMs`
 * and `limit`). Lenient on purpose: a console that answers with HTML, an empty body or a different
 * JSON shape must still produce a usable error, not a parse crash.
 */
export function parseProtectErrorBody(body: unknown): Partial<ProtectErrorBody> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof raw.error === 'string') out.error = raw.error
  if (typeof raw.name === 'string') out.name = raw.name
  if (typeof raw.cause === 'object' && raw.cause !== null) out.cause = raw.cause
  if (typeof raw.windowMs === 'number') out.windowMs = raw.windowMs
  if (typeof raw.limit === 'number') out.limit = raw.limit
  return Object.keys(out).length === 0 ? null : out
}

/** HTTP status → kind. Anything unexpected becomes `server`, which is retryable but not silent. */
export function protectErrorKindForStatus(status: number): ProtectErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  if (status === 503) return 'unavailable'
  if (status >= 400 && status < 500) return 'bad-request'
  return 'server'
}

export interface ProtectResponseErrorContext {
  readonly status: number
  /** The parsed JSON body, if it parsed at all. */
  readonly body?: unknown
  /** What was being done, for the message: `GET /v1/cameras`. Never include a query with a secret. */
  readonly what: string
  readonly endpoint?: string | null
}

/** Builds the error for a non-2xx response. */
export function protectErrorFromResponse(ctx: ProtectResponseErrorContext): ProtectApiError {
  const parsed = parseProtectErrorBody(ctx.body)
  const kind = protectErrorKindForStatus(ctx.status)
  const detail = parsed?.error ?? null
  const code = parsed?.name ?? null
  const retryAfterMs = kind === 'rate-limit' ? (parsed?.windowMs ?? 1000) : null
  const parts = [`${ctx.what} failed with HTTP ${String(ctx.status)}`]
  if (code !== null) parts.push(code)
  const head = parts.join(' ')
  const tail = detail === null ? '' : `: ${detail}`
  const advice =
    kind === 'auth'
      ? ' Check the API key in Settings (UniFi OS → Control Plane → Integrations).'
      : kind === 'rate-limit'
        ? ` The console allows a limited number of requests per second; retrying in ${String(
            retryAfterMs ?? 1000,
          )} ms.`
        : ''
  return new ProtectApiError(`${head}${tail}.${advice}`, {
    kind,
    status: ctx.status,
    apiName: code,
    retryAfterMs,
    endpoint: ctx.endpoint ?? null,
  })
}

/**
 * Wraps a thrown connection failure. A pin failure keeps its own message and becomes `kind: 'pin'`
 * — it is the one kind a caller must never retry around, so it stays distinguishable from a plain
 * network error. `fetch` reports connect failures as a `TypeError` with the real reason in `cause`,
 * which is why this unwraps.
 */
export function protectErrorFromThrown(err: unknown, what: string, endpoint?: string): never {
  if (err instanceof ProtectApiError) throw err
  const pin = pinFailure(err)
  if (pin !== null) {
    throw new ProtectApiError(pin.message, {
      kind: 'pin',
      endpoint: endpoint ?? null,
      cause: err,
    })
  }
  const root = rootCause(err)
  // Checked on both: our own `AbortSignal.timeout` is the outer error, while undici's header and
  // body deadlines arrive as the cause.
  const timedOut = isTimeoutError(err) || isTimeoutError(root)
  throw new ProtectApiError(
    `${what} failed: ${timedOut ? 'the console did not answer in time' : describeError(root)}.`,
    {
      kind: timedOut ? 'timeout' : 'network',
      endpoint: endpoint ?? null,
      cause: err,
    },
  )
}
