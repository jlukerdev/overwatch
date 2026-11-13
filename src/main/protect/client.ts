// The Protect Integration API REST client (SPEC §5.1, P1.3): the one place in the app that turns
// an HTTP call to the console into either a trimmed domain object or a `ProtectApiError`.
//
// Everything that talks to Protect goes through here — Settings' "Test connection" (CON-4), the
// camera list and its snapshots (CAM-1/3), and the stream URLs the go2rtc manager needs (QUAL-8) —
// because four constraints have to hold on *every* call and none of them can be left to a caller:
//
//  1. **Rate limit (R9).** The console allows 10 requests per 1-second window **per key**, which is
//     not in the contract (P0.3 §7 found it by hitting it). Every attempt, retries included, takes a
//     permit from a `RateLimiter` first, and the limiter is injectable so the WebSocket
//     subscriptions can share one: a WS upgrade spends from the same budget (P0.3 §7).
//  2. **Pinned TLS (CON-3).** The console presents a self-signed certificate, so the request has to
//     carry the pinned undici `Agent` as its `dispatcher` — hence undici's `fetch` and not Node's
//     global one, which has no per-request dispatcher. TLS verification is never disabled here or
//     anywhere else (CLAUDE.md); `src/main/tls/` owns the pin.
//  3. **No secret anywhere but main (CON-2, R5, NFR-9).** The API key is read through a callback on
//     each request (so a key edited in Settings takes effect without rebuilding the client) and is
//     never put in a message, a log line or an error `cause`. `rtsps-stream` responses are
//     credentials in URL form, so **no response body is ever logged or quoted in an error**, not
//     even a truncated one.
//  4. **Lenient parsing (R8, R11).** A console upgrade may add fields, and the P0.3 samples already
//     drift from the contract (`lcdMessage`). One camera with a surprising payload must never empty
//     the camera list (CAM-1), so `cameras()` maps what it can and reports what it skipped.
//
// Wire shapes are **never hand-written**: they come from `./types`, which derives them from
// `./generated` (openapi-typescript over the vendored contract) plus the documented P0.3 drift
// overrides. The app-facing camera shape is the trimmed `Camera` of `@shared/models`.
//
// No Electron import and no I/O beyond `fetch`: `fetchImpl`, `dispatcher`, `apiKey`, `limiter` and
// `log` are all injected, so the unit tests drive every path on a fake clock in plain Node.
import { fetch } from 'undici'
import type { Dispatcher, RequestInit, Response } from 'undici'
import { CameraSchema, type Camera } from '@shared/models'
import type { ConsoleEndpoint } from '../console/endpoints'
import { collectRateLimitHeaders } from '../net/rateLimitHeaders'
import { PROTECT_RATE_WINDOW_MS, createRateLimiter, type RateLimiter } from '../net/rateLimiter'
import { ProtectApiError, protectErrorFromResponse, protectErrorFromThrown } from './errors'
import type {
  ProtectMetaInfo,
  RtspsQuality,
  RtspsStreams,
  RtspsStreamsCreated,
  RtspsStreamsRequest,
  SnapshotChannel,
} from './types'

export type { SnapshotChannel } from './types'

/** What the P0.3 spike used per request, and what it measured the console against (§3, §4). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** Retries of a rate-limited **GET**, as in the P0.3 spike. A POST is never retried (see `send`). */
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4

/**
 * The qualities of `rtsps-stream`, in the order the console reports them. `satisfies` ties every
 * member to the contract's enum, so a renamed quality is a typecheck error rather than a key that
 * silently never matches; a quality a console upgrade *adds* has to be added here too, and until it
 * is, it is simply not read (which is the lenient behaviour R8 asks for).
 */
export const RTSPS_QUALITIES = [
  'high',
  'medium',
  'low',
  'package',
] as const satisfies readonly RtspsQuality[]

export interface SnapshotOptions {
  /**
   * `highQuality=true` is the **caller's** decision, taken from `camera.supportsFullHdSnapshot`:
   * on a camera without that flag the console answers `400 BAD_REQUEST` ("Camera does not support
   * full HD snapshot") and does **not** fall back to a smaller image (P0.3 §4, SPEC §5.1). This
   * client therefore neither probes the flag nor retries without the parameter — it would spend a
   * second rate-limit permit per camera to paper over a question the camera list already answers.
   */
  readonly highQuality?: boolean
  /** A doorbell's package channel (CAM-4). Only send it when `camera.hasPackageCamera`. */
  readonly channel?: SnapshotChannel
}

/** A snapshot exactly as the console sent it. `image/jpeg` in every P0.3 sample (§4). */
export interface ProtectSnapshot {
  readonly bytes: Uint8Array
  readonly contentType: string
}

export interface ProtectClientOptions {
  /** From `protectEndpoint(config.console)`. Request paths are appended to its `baseUrl`. */
  readonly endpoint: ConsoleEndpoint
  /**
   * The Integration API key, read **per request** so a key edited in Settings takes effect without
   * a new client (CON-1). `null` or `''` means "not configured yet" and fails as `kind: 'auth'`
   * before anything is sent. The value is never stored in this module, logged or put in a message
   * (CON-2, NFR-9).
   */
  readonly apiKey: () => string | null
  /**
   * `registry.agentFor(host, port)` — the pinned undici Agent (CON-3). Read per request so a repin
   * takes effect on the next call, and called inside the request's `try` so the `PinRequiredError`
   * it throws for an unpinned endpoint arrives as `kind: 'pin'` like any other pin failure.
   */
  readonly dispatcher: () => Dispatcher
  /**
   * Shared with the subscriptions: a WebSocket upgrade spends from the same per-key budget (R9,
   * P0.3 §7), so the app passes one limiter to the client and both sockets. Default: a new one,
   * which is only right for a client that is the sole user of the key (tests, a one-off probe).
   */
  readonly limiter?: RateLimiter
  /** undici's `fetch`, which unlike Node's global accepts a per-request `dispatcher`. */
  readonly fetchImpl?: typeof fetch
  readonly requestTimeoutMs?: number
  readonly maxRateLimitRetries?: number
  /**
   * One line per attempt: the contract path, the status, the console's error `name` and the
   * rate-limit headers filtered through {@link collectRateLimitHeaders} (which drops the `pk`
   * partition key — P0.3 §7). **Never a body, a query or the key.** Default: no-op.
   */
  readonly log?: (line: string) => void
}

export interface ProtectClient {
  /** `GET /v1/meta/info` — the CON-4 "Test connection" probe. Returns `{ applicationVersion }`. */
  metaInfo(): Promise<ProtectMetaInfo>
  /**
   * `GET /v1/cameras`, mapped onto the trimmed shared `Camera` (CAM-1). Items with no usable `id`
   * are skipped rather than failing the whole call (R8/R11); the count goes to `log`.
   */
  cameras(): Promise<Camera[]>
  /** `GET /v1/cameras/{id}`, mapped like one item of {@link ProtectClient.cameras}. */
  camera(id: string): Promise<Camera>
  /**
   * `GET /v1/cameras/{id}/snapshot`. CAM-3's "any failure means the camera is offline" is the
   * caller's rule (P1.7), not this client's: every failure is thrown with its real `kind` so
   * Settings can tell an expired key from an offline camera. Nothing is swallowed here.
   */
  snapshot(id: string, options?: SnapshotOptions): Promise<ProtectSnapshot>
  /**
   * `GET /v1/cameras/{id}/rtsps-stream` (QUAL-8): one RTSPS URL or `null` per quality.
   * **SECRET** — main only, never logged, never over IPC (CON-2, NFR-9).
   */
  rtspsStreams(id: string): Promise<RtspsStreams>
  /**
   * `POST /v1/cameras/{id}/rtsps-stream` (QUAL-8): creates the missing qualities and returns
   * **only the ones requested** (P0.3 §3). Existing qualities are left untouched, and the app never
   * DELETEs: 4 of the 9 development cameras had a `medium` stream made by another integration.
   * **SECRET**, like `rtspsStreams`.
   */
  createRtspsStreams(id: string, qualities: readonly RtspsQuality[]): Promise<RtspsStreamsCreated>
}

const PATH_META_INFO = '/v1/meta/info'
const PATH_CAMERAS = '/v1/cameras'
const PATH_CAMERA = '/v1/cameras/{id}'
const PATH_SNAPSHOT = '/v1/cameras/{id}/snapshot'
const PATH_RTSPS = '/v1/cameras/{id}/rtsps-stream'

/** `json` is parsed and checked; `image` is handed back as bytes (snapshots). */
type Accept = 'json' | 'image'

interface RequestSpec {
  readonly method: 'GET' | 'POST'
  /** Appended to `endpoint.baseUrl`, with the id already substituted and encoded. */
  readonly path: string
  /**
   * The **contract path template** (`GET /v1/cameras/{id}/snapshot`). Everything the user or a log
   * file sees is built from this, so no camera id and no query string can reach a message.
   */
  readonly what: string
  readonly accept: Accept
  readonly query?: Readonly<Record<string, string>>
  /** The only request body in this client is `rtsps-stream`'s. */
  readonly body?: RtspsStreamsRequest
}

type SendResult =
  | { readonly accept: 'json'; readonly status: number; readonly json: unknown }
  | { readonly accept: 'image'; readonly status: number; readonly snapshot: ProtectSnapshot }

/** One attempt either produced a result or asked for a rate-limit retry (never both). */
type Attempt = { readonly done: SendResult } | { readonly retry: true }

export function createProtectClient(options: ProtectClientOptions): ProtectClient {
  const endpoint = options.endpoint
  // A client built without a limiter gets its own, so a caller cannot accidentally send unthrottled.
  const limiter = options.limiter ?? createRateLimiter()
  const doFetch = options.fetchImpl ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES
  const log = options.log ?? ((): void => undefined)

  /** CON-1: no key yet is an auth failure, and **nothing is sent** — not even a permit is spent. */
  function requireApiKey(): string {
    const key = options.apiKey()
    if (key === null || key === '') {
      throw new ProtectApiError(
        'No Protect Integration API key is set yet. Add one in Settings (UniFi OS → Control ' +
          'Plane → Integrations).',
        { kind: 'auth', endpoint: endpoint.hostPort },
      )
    }
    return key
  }

  /**
   * A 2xx the contract does not describe. The detail is **our own words only**: the body may be an
   * `rtsps-stream` response, i.e. a credential (CON-2, NFR-9), so it is never quoted.
   */
  function invalidResponse(spec: RequestSpec, detail: string, status: number): ProtectApiError {
    return new ProtectApiError(`${spec.what} returned an unexpected response: ${detail}.`, {
      kind: 'invalid-response',
      status,
      endpoint: endpoint.hostPort,
    })
  }

  function logAttempt(spec: RequestSpec, res: Response, apiName: string | null): void {
    const parts = [`${spec.what} -> ${String(res.status)}`]
    if (apiName !== null) parts.push(apiName)
    // Allowlist only: the `pk` partition key never reaches a log (P0.3 §7).
    for (const [name, value] of Object.entries(collectRateLimitHeaders(res.headers))) {
      parts.push(`${name}: ${value}`)
    }
    log(parts.join(' | '))
  }

  async function attemptOnce(
    spec: RequestSpec,
    apiKey: string,
    canRetry: boolean,
  ): Promise<Attempt> {
    const query =
      spec.query === undefined || Object.keys(spec.query).length === 0
        ? ''
        : `?${new URLSearchParams(spec.query).toString()}`
    try {
      const init: RequestInit = {
        method: spec.method,
        headers: {
          'X-API-KEY': apiKey,
          // `*/*` is what P0.3 verified on every endpoint, snapshots included. A narrower `Accept`
          // would be nominally tidier and is unverified against the console, which is not a trade
          // worth making for a header the console evidently ignores.
          Accept: '*/*',
          ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        // CON-3: the pinned Agent, read per request so a repin applies to the next call. Built
        // inside the `try` on purpose: an unpinned endpoint throws `PinRequiredError` here, and
        // that has to arrive as `kind: 'pin'` like any other pin failure.
        dispatcher: options.dispatcher(),
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      }
      const res = await doFetch(`${endpoint.baseUrl}${spec.path}${query}`, init)
      if (res.status < 200 || res.status >= 300) {
        // Lenient: a console that answers with HTML or an empty body must still give a usable
        // error (see `parseProtectErrorBody`), so a failed parse is simply "no body".
        const error = protectErrorFromResponse({
          status: res.status,
          body: await readErrorBody(res),
          what: spec.what,
          endpoint: endpoint.hostPort,
        })
        logAttempt(spec, res, error.apiName)
        if (error.kind === 'rate-limit') {
          // R9: hold **everything** sharing this limiter back for the window the console named,
          // which is also what makes the retry below wait — the next `acquire()` cannot resolve
          // until the penalty expires, so there is no sleep of our own to get wrong.
          limiter.penalize(error.retryAfterMs ?? PROTECT_RATE_WINDOW_MS)
          if (canRetry) return { retry: true }
        }
        throw error
      }
      logAttempt(spec, res, null)
      const done: SendResult =
        spec.accept === 'image'
          ? { accept: 'image', status: res.status, snapshot: await readImage(spec, res) }
          : { accept: 'json', status: res.status, json: await readJson(spec, res) }
      return { done }
    } catch (err) {
      // Unwraps a pin failure out of fetch's `TypeError.cause` into `kind: 'pin'` and a timeout
      // into `kind: 'timeout'`; a `ProtectApiError` (ours, above) passes through unchanged.
      protectErrorFromThrown(err, spec.what, endpoint.hostPort)
    }
  }

  /**
   * One request, with the rate-limit budget and the 429 retry around it.
   *
   * **A POST is never retried automatically.** P0.3's spike re-GETs after a 429 and lets its caller
   * decide whether a second POST is still needed, because `POST /rtsps-stream` is not something to
   * repeat blindly: the GET may show the quality now exists. The caller gets `kind: 'rate-limit'`
   * with `retryAfterMs` instead.
   */
  async function send(spec: RequestSpec): Promise<SendResult> {
    for (let attempt = 0; ; attempt += 1) {
      const apiKey = requireApiKey()
      // R9: every attempt, including each retry, spends a permit.
      await limiter.acquire()
      const result = await attemptOnce(
        spec,
        apiKey,
        spec.method === 'GET' && attempt < maxRateLimitRetries,
      )
      if ('done' in result) return result.done
    }
  }

  /** A 2xx JSON body, checked only for being parsable and an object/array (not crashing on HTML). */
  async function readJson(spec: RequestSpec, res: Response): Promise<unknown> {
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw invalidResponse(spec, 'the body is not JSON', res.status)
    }
    if (!isRecord(parsed) && !isUnknownArray(parsed)) {
      throw invalidResponse(spec, 'the body is not a JSON object', res.status)
    }
    return parsed
  }

  /** A 2xx whose body is a JSON object, with the status kept for any further check's error. */
  async function readRecord(
    spec: RequestSpec,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await send(spec)
    const json = result.accept === 'json' ? result.json : null
    if (!isRecord(json)) {
      throw invalidResponse(spec, 'the body is not a JSON object', result.status)
    }
    return { status: result.status, body: json }
  }

  async function readImage(spec: RequestSpec, res: Response): Promise<ProtectSnapshot> {
    const contentType = res.headers.get('content-type') ?? ''
    // Read first, so the body is drained even when the type is wrong and the socket can be reused.
    const bytes = new Uint8Array(await res.arrayBuffer())
    const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
    if (!mediaType.startsWith('image/')) {
      // A 2xx carrying JSON is not a snapshot (R11: the contract's only non-image answer here is
      // the undocumented-status 503 "camera offline", which never arrives as a 2xx).
      throw invalidResponse(
        spec,
        `the content type is ${mediaType || 'missing'}, not an image`,
        res.status,
      )
    }
    return { bytes, contentType }
  }

  async function metaInfo(): Promise<ProtectMetaInfo> {
    const spec: RequestSpec = {
      method: 'GET',
      path: PATH_META_INFO,
      what: `GET ${PATH_META_INFO}`,
      accept: 'json',
    }
    const { status, body } = await readRecord(spec)
    const applicationVersion = body.applicationVersion
    if (typeof applicationVersion !== 'string') {
      throw invalidResponse(spec, 'applicationVersion is missing', status)
    }
    return { applicationVersion }
  }

  async function cameras(): Promise<Camera[]> {
    const spec: RequestSpec = {
      method: 'GET',
      path: PATH_CAMERAS,
      what: `GET ${PATH_CAMERAS}`,
      accept: 'json',
    }
    const result = await send(spec)
    const json = result.accept === 'json' ? result.json : null
    if (!isUnknownArray(json)) {
      throw invalidResponse(spec, 'the body is not a JSON array', result.status)
    }
    const mapped: Camera[] = []
    let skipped = 0
    for (const item of json) {
      // R8/R11, CAM-1: one unusable item must not cost the user the other fourteen cameras.
      try {
        mapped.push(toCamera(item))
      } catch {
        skipped += 1
      }
    }
    if (skipped > 0) {
      log(
        `${spec.what} -> skipped ${String(skipped)} of ${String(json.length)} items with no ` +
          'usable id',
      )
    }
    return mapped
  }

  async function camera(id: string): Promise<Camera> {
    const { body } = await readRecord({
      method: 'GET',
      path: cameraPath(id),
      what: `GET ${PATH_CAMERA}`,
      accept: 'json',
    })
    return toCamera(body)
  }

  async function snapshot(id: string, snapshotOptions?: SnapshotOptions): Promise<ProtectSnapshot> {
    // Only what the caller asked for: an absent parameter is the console's own default, which on
    // the one full-HD camera already returned 2688×1512 (P0.3 §4).
    const query: Record<string, string> = {}
    if (snapshotOptions?.highQuality !== undefined) {
      query.highQuality = snapshotOptions.highQuality ? 'true' : 'false'
    }
    if (snapshotOptions?.channel !== undefined) query.channel = snapshotOptions.channel
    const spec: RequestSpec = {
      method: 'GET',
      path: cameraPath(id, '/snapshot'),
      what: `GET ${PATH_SNAPSHOT}`,
      accept: 'image',
      query,
    }
    const result = await send(spec)
    // Unreachable for `accept: 'image'`; the check is what keeps the union narrowing honest.
    if (result.accept !== 'image') {
      throw invalidResponse(spec, 'the body is not an image', result.status)
    }
    return result.snapshot
  }

  async function rtspsStreams(id: string): Promise<RtspsStreams> {
    const { body } = await readRecord({
      method: 'GET',
      path: cameraPath(id, '/rtsps-stream'),
      what: `GET ${PATH_RTSPS}`,
      accept: 'json',
    })
    const out: RtspsStreams = {}
    for (const quality of RTSPS_QUALITIES) {
      const url = body[quality]
      // A quality that exists is a URL, one that does not is `null` (P0.3 §3). Anything else, and a
      // key the console stops sending, is treated as "absent" rather than failing the call (R8).
      if (typeof url === 'string') out[quality] = url
      else if (url === null) out[quality] = null
    }
    return out
  }

  async function createRtspsStreams(
    id: string,
    qualities: readonly RtspsQuality[],
  ): Promise<RtspsStreamsCreated> {
    if (qualities.length === 0) {
      // The contract's `minItems: 1`. Caught here so an empty list costs no rate-limit permit.
      throw new ProtectApiError(`POST ${PATH_RTSPS} needs at least one quality to create.`, {
        kind: 'bad-request',
        endpoint: endpoint.hostPort,
      })
    }
    const { body } = await readRecord({
      method: 'POST',
      path: cameraPath(id, '/rtsps-stream'),
      what: `POST ${PATH_RTSPS}`,
      accept: 'json',
      body: { qualities: [...qualities] },
    })
    const out: RtspsStreamsCreated = {}
    // The response carries only the qualities that were requested (P0.3 §3), each one a URL.
    for (const quality of RTSPS_QUALITIES) {
      const url = body[quality]
      if (typeof url === 'string') out[quality] = url
    }
    return out
  }

  return { metaInfo, cameras, camera, snapshot, rtspsStreams, createRtspsStreams }
}

/**
 * One `GET /v1/cameras` item onto the trimmed shared `Camera` (CAM-1). Exported for the unit tests
 * and for P1.7, which maps the same shape out of the devices WebSocket.
 *
 * Deliberately lenient (R8, R11): every field is taken only when it has the type the contract
 * describes and left to `CameraSchema`'s default otherwise, so a missing `featureFlags`, an absent
 * `lcdMessage` (the P0.3 drift — every real camera omits it), a `null` name or a field a console
 * upgrade renames all cost one property, not a camera. `featureFlags` is **flattened** onto the
 * shared shape, and `state` stays a plain string: an unknown value is kept as it arrived and read
 * through `isCameraOnline`, never parsed into an enum (see the leniency rule in `models.ts`).
 *
 * `id` is the one thing that cannot be defaulted — a camera without it cannot be addressed, shown
 * or linked to a cell — so that alone throws, and `cameras()` turns the throw into a skip.
 */
export function toCamera(raw: unknown): Camera {
  const rec = isRecord(raw) ? raw : {}
  const flags = isRecord(rec.featureFlags) ? rec.featureFlags : {}
  const parsed = CameraSchema.safeParse({
    id: asString(rec.id),
    // `name` is nullable in the contract and null in the samples; `null` is kept as null.
    name: rec.name === null ? null : asString(rec.name),
    model: asString(rec.type),
    state: asString(rec.state),
    hasMic: asBoolean(flags.hasMic),
    micEnabled: asBoolean(rec.isMicEnabled),
    hasSpeaker: asBoolean(flags.hasSpeaker),
    smartDetectTypes: asStringArray(flags.smartDetectTypes),
    supportsFullHdSnapshot: asBoolean(flags.supportFullHdSnapshot),
    hasPackageCamera: asBoolean(rec.hasPackageCamera),
  })
  if (!parsed.success) {
    throw new ProtectApiError('A camera in the Protect inventory has no usable id.', {
      kind: 'invalid-response',
    })
  }
  return parsed.data
}

/** `/v1/cameras/<id>[/suffix]`, with the id encoded so it cannot escape the path. */
function cameraPath(id: string, suffix = ''): string {
  return `${PATH_CAMERAS}/${encodeURIComponent(id)}${suffix}`
}

/** A non-2xx body, parsed if it is JSON at all. Never thrown over: the status is the error. */
async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text())
  } catch {
    return undefined
  }
}

/** A plain JSON object. Arrays are excluded: nothing in this API answers with an array of pairs. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `Array.isArray` on an `unknown` narrows to `any[]`; this keeps the items `unknown`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** `undefined` for anything but a string, which lets the zod schema apply its default. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Keeps only the usable members, so one odd entry does not reject the whole list (R8). */
function asStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}
