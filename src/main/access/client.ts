// UniFi Access developer API client: list doors (DOOR-1/2) and remote unlock (DOOR-3). SPEC §5.2.
//
// ⚠️ **EVERYTHING THIS FILE TALKS TO IS COMMUNITY-SOURCED AND UNVERIFIED (R3).** Ubiquiti's
// developer portal does not document Access, no Access hardware exists on the development network,
// and nothing here has run against a console. The shapes come from `./types.ts` and the sources
// listed in `docs/spikes/P0.4-access-mock.md` §2; the on-site checklist **OS-1** (P0.4 §6) is what
// verifies them, and its results replace the assumptions marked `UNVERIFIED (OS-1)` below. Until
// then this client is exercised against the local mock (`scripts/mock-access/`), which is what
// `tests/unit/accessClient.test.ts` drives — in-process and over real pinned TLS.
//
// Five rules this module exists to keep:
//  1. **DOOR-0.** `enabled()` is read on *every* call, and while it is false **no request is sent
//     at all** — the call fails with `kind: 'disabled'`. The feature is off by default, so a client
//     may be constructed long before Access is usable.
//  2. **An error is HTTP non-2xx *or* `code !== 'SUCCESS'`, whatever the status** (P0.4 §3
//     assumption 4). The HTTP status that goes with each error code is undocumented everywhere, and
//     the real console may well answer 200 with a non-`SUCCESS` code. A 401 is an auth error
//     whatever the body.
//  3. **The message is never empty** (SPEC §5.2): the envelope's `msg` when it is there, and the
//     `code` plus the HTTP status when it is not (`msg` is optional in the schemas). A DOOR-3
//     failure the user cannot read is a bug — the whole point of the unlock button is feedback.
//  4. **Unlock is never automated** (DOOR-3/4, see {@link AccessClient.unlock}). This client does
//     not prompt and does not retry an unlock, ever.
//  5. **The token never leaves the `Authorization: Bearer` header** (CON-2, NFR-9, R5). Not in a
//     message, not in a log line, not in a URL. Log lines carry method, path, status and `code`.
//
// Nothing here imports Electron, the config store or the secrets store: the endpoint, the token,
// the enabled flag and the pinned dispatcher all arrive as injected getters, read per call so that
// a token edited in Settings, a flipped Access switch or a re-pinned certificate take effect
// without rebuilding the client (P1.6 owns that UI).
import { fetch } from 'undici'
import type { Dispatcher } from 'undici'
import { describeError, isTimeoutError, pinFailure, rootCause } from '../net/errorCause'
import { z } from 'zod'
import {
  ACCESS_SUCCESS_CODE,
  AccessDoorResponseSchema,
  AccessDoorSchema,
  AccessErrorEnvelopeSchema,
  AccessUnlockRequestSchema,
  AccessUnlockResponseSchema,
  accessSuccessEnvelope,
} from './types'
import type { AccessDoor } from './types'
import type { ConsoleEndpoint } from '../console/endpoints'
import type { Door } from '@shared/models'

/** How long one Access request may take before it is aborted. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/**
 * What went wrong, in the terms a caller can act on. Same shape of taxonomy as
 * `protect/errors.ts`, with two Access-only members:
 * - `disabled` — DOOR-0: Access is switched off, so **no call was made**. Not a failure of the
 *   console; the UI should not be showing an unlock control at all in this state.
 * - `auth` — the token is missing, wrong, expired or lacks the door scopes (`CODE_AUTH_FAILED`,
 *   `CODE_ACCESS_TOKEN_INVALID`, `CODE_UNAUTHORIZED`, or any 401). The fix is in Settings.
 * - `forbidden` — the console refused the operation itself, not the caller's identity. The
 *   community's example is remote unlock of a door that is not bound to a Door Hub
 *   (`CODE_OPERATION_FORBIDDEN`, `is_bind_hub: false`) — unverified (OS-1).
 * - `not-found` — the door (or path) does not exist: `CODE_NOT_EXISTS` /
 *   `CODE_RESOURCE_NOT_FOUND`. A saved door link can point at a deleted door (DOOR-2).
 * - `bad-request` — the request was malformed (`CODE_PARAMS_INVALID`), including a body this
 *   client rejected locally before sending it.
 * - `rate-limit` — the Access API throttles (the community guide mentions 429). No `Retry-After`
 *   is documented, so there is no `retryAfterMs` here; P1.7's queue owns pacing (R9).
 * - `server` — a 5xx, or a non-`SUCCESS` code this client does not recognise.
 * - `timeout` — the console did not answer inside `requestTimeoutMs`.
 * - `network` — the connection failed (console down, wrong host or port, TCP reset).
 * - `pin` — the TLS pin is missing or did not match (CON-3). **Never** retried and never
 *   downgraded to an unpinned connection; the user re-accepts the certificate in Settings.
 * - `invalid-response` — a 2xx `SUCCESS` body that does not match the schemas in `./types.ts`.
 *   Expected to be the first thing OS-1 trips over, which is why the reason names the field.
 */
export type AccessErrorKind =
  | 'disabled'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'rate-limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'pin'
  | 'invalid-response'

export interface AccessApiErrorInit {
  readonly kind: AccessErrorKind
  /** HTTP status, or `null` when no response was received (disabled, timeout, network, pin). */
  readonly status?: number | null
  /** The envelope's `code`, e.g. `CODE_OPERATION_FORBIDDEN`, or `null` when there was none. */
  readonly code?: string | null
  /** `host:port` the call went to (never a URL with a query). Carries no credential. */
  readonly endpoint?: string | null
  readonly cause?: unknown
}

/**
 * Every failure of an Access call. The message is always user-facing and always non-empty (rule 3),
 * and never contains the token (rule 5), so it is safe to log and to show in the UI as it is.
 */
export class AccessApiError extends Error {
  override readonly name = 'AccessApiError'
  readonly kind: AccessErrorKind
  readonly status: number | null
  readonly code: string | null
  readonly endpoint: string | null

  constructor(message: string, init: AccessApiErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.kind = init.kind
    this.status = init.status ?? null
    this.code = init.code ?? null
    this.endpoint = init.endpoint ?? null
  }

  /**
   * True for the kinds where the *same* call could plausibly succeed if repeated.
   *
   * **This is not permission to retry an unlock.** A second `PUT …/unlock` is a second physical
   * door release, so an unlock is only ever repeated by the user pressing the control again
   * (DOOR-3/4). Read this flag for `doors()` / `door()` only.
   */
  get retryable(): boolean {
    return (
      this.kind === 'rate-limit' ||
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      this.kind === 'server'
    )
  }
}

export interface AccessClientOptions {
  /** From `accessEndpoint(config.console)` — the API root, origin plus `/api/v1/developer`. */
  readonly endpoint: ConsoleEndpoint
  /** DOOR-0, read per call: while this is false the client makes **no** network call. */
  readonly enabled: () => boolean
  /** Read per call, so a token edited in Settings takes effect without a new client. */
  readonly token: () => string | null
  /** `registry.agentFor(host, port)` — read per call so a repin takes effect (CON-3). */
  readonly dispatcher: () => Dispatcher
  /** undici's `fetch` by default; tests inject a fake. Node's global `fetch` is not usable: a
   *  per-request `dispatcher` (the pinned Agent) is required. */
  readonly fetchImpl?: typeof fetch
  readonly requestTimeoutMs?: number
  /** Safe lines only (method, path, status, code — rule 5). Default: no-op. */
  readonly log?: (line: string) => void
}

/**
 * The optional unlock body (P0.4 §3 assumption 8, unverified). With no actor the console logs the
 * API token's name as the actor, which is the common case; the app passes one once it has a notion
 * of who is at the keyboard. `actor_id` and `actor_name` go together or not at all, which
 * `AccessUnlockRequestSchema` enforces — this client checks the body **before** sending it.
 */
export interface UnlockOptions {
  readonly actor?: { readonly id: string; readonly name: string }
}

export interface AccessClient {
  /** `GET /doors` (DOOR-1/2). */
  doors(): Promise<Door[]>
  /** `GET /doors/{id}`. Used to re-read one door's relay after an unlock (there is no push). */
  door(id: string): Promise<Door>
  /**
   * `PUT /doors/{id}/unlock` (DOOR-3) — **releases a physical door.**
   *
   * The explicit user interaction DOOR-3/4 requires belongs to the **caller** (the P5.x unlock
   * control: press-and-hold for 1 s or a confirm dialog). This client deliberately does not
   * prompt, so nothing in the app may call `unlock()` from a timer, an event handler, a keyboard
   * shortcut alone, a reconnect or any kind of retry — each call is one door release, and a
   * failed unlock is reported, never repeated (DOOR-4). `retryable` is about the read calls.
   *
   * Resolves when the console accepted the unlock. The relay goes to `unlock` for the door's
   * configured time and back to `lock` on its own; the local API has no push for that, so a caller
   * that wants to show it polls `door(id)` (P0.4 §2, hubitat-unifi-access).
   */
  unlock(id: string, options?: UnlockOptions): Promise<void>
}

/**
 * Error `code` → kind, for the case rule 2 exists for: the HTTP status is not trustworthy (it is
 * undocumented, P0.4 §3 assumption 4), so a recognised code decides the kind and the status is
 * only the fallback. Every entry is COMMUNITY-SOURCED / UNVERIFIED (OS-1); the code list itself is
 * `ACCESS_ERROR_CODES` in `./types.ts`.
 */
const KIND_BY_CODE: Readonly<Record<string, AccessErrorKind>> = {
  // "invalid or expired" / "auth failed" / "lacks the required permission scope". All three are
  // fixed by fixing the token in Settings, so all three are `auth` rather than `forbidden`:
  // scopes are a property of the token, not of the door (unverified, OS-1).
  CODE_AUTH_FAILED: 'auth',
  CODE_ACCESS_TOKEN_INVALID: 'auth',
  CODE_UNAUTHORIZED: 'auth',
  // The operation itself was refused — the mock's answer for unlocking a door with
  // `is_bind_hub: false`. The real code for that case is unknown (P0.4 §3 assumption 9).
  CODE_OPERATION_FORBIDDEN: 'forbidden',
  // Unknown door id vs unknown path; the mock uses the first for doors (assumption 6).
  CODE_NOT_EXISTS: 'not-found',
  CODE_RESOURCE_NOT_FOUND: 'not-found',
  CODE_PARAMS_INVALID: 'bad-request',
  CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED: 'bad-request',
  // Mock-only, for `--fail-rate` (assumption 10). Kept here so the mock's 500 classifies the same
  // way whatever status it is sent with; it is not a documented Access code.
  CODE_SYSTEM_ERROR: 'server',
}

/** HTTP status → kind, used only when the `code` is missing or unrecognised. */
export function accessErrorKindForStatus(status: number): AccessErrorKind {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'bad-request'
  // A 2xx that carried a non-`SUCCESS` code (rule 2): the status says nothing, and an unrecognised
  // failure is better treated as the console's problem than as the user's.
  return 'server'
}

/**
 * The kind for a response that is an error by rule 2. A **401 is `auth` whatever the body** — that
 * one is not negotiable (SPEC §5.2) — and otherwise the `code` wins over the status.
 */
export function accessErrorKind(status: number, code: string | null): AccessErrorKind {
  if (status === 401) return 'auth'
  const byCode = code === null ? undefined : KIND_BY_CODE[code]
  return byCode ?? accessErrorKindForStatus(status)
}

/**
 * Maps an `AccessDoor` (wire) onto the trimmed shared `Door` (SPEC §6, `@shared/models`). The
 * renderer only ever sees this shape (P1.5).
 *
 * `is_bind_hub`'s string form and the two spellings of "no position sensor" are already normalized
 * by the schemas in `./types.ts`, except that `''` has to collapse to `null` here: the community
 * docs say `null` when no sensor is connected while their single-door example sends `''`, and the
 * UI must not have to know about both (P0.4 §3 assumption 7, unverified).
 */
export function toDoor(door: AccessDoor): Door {
  return {
    id: door.id,
    name: door.name,
    fullName: door.full_name,
    floorId: door.floor_id,
    type: door.type,
    boundToHub: door.is_bind_hub,
    relay: door.door_lock_relay_status,
    position: door.door_position_status === '' ? null : door.door_position_status,
  }
}

/** One zod issue, structurally — just the two fields a reason line needs. */
interface SchemaIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/** The minimum a response schema has to offer. Keeps the generics out of `./types.ts`'s way. */
interface ResponseParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: SchemaError }
}

interface SchemaError {
  readonly issues: readonly SchemaIssue[]
}

/**
 * A short, concrete reason a body did not match: which field and what was wrong, at most two of
 * them. Deliberately **not** a zod dump — this text reaches the UI and the log — and it quotes no
 * value, so no door name or token-bearing field can ride along.
 */
export function schemaMismatchReason(error: SchemaError): string {
  const lines = error.issues.slice(0, 2).map((issue) => {
    const path = issue.path.length === 0 ? '(body)' : issue.path.map((p) => String(p)).join('.')
    return `${path}: ${issue.message}`
  })
  return lines.length === 0 ? 'the body did not match the schema' : lines.join('; ')
}

/** `code` out of a body that is not a well-formed error envelope, for naming it in a message. */
function looseCode(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const value: unknown = (json as Record<string, unknown>).code
  return typeof value === 'string' && value.length > 0 ? value : null
}

const AUTH_ADVICE =
  ' Check the Access API token in Settings: it may be wrong, expired or missing the door ' +
  'permissions (Access → Settings → Advanced → API Token).'

/** Rule 3 made concrete: `msg` when the console sent one, `code` plus the status when it did not. */
function responseErrorMessage(args: {
  what: string
  status: number
  code: string | null
  msg: string | null
  kind: AccessErrorKind
}): string {
  const head = `${args.what} failed with HTTP ${String(args.status)}${
    args.code === null ? '' : ` ${args.code}`
  }`
  const detail =
    args.msg !== null && args.msg.trim() !== ''
      ? `: ${args.msg.trim()}`
      : args.code === null
        ? '. The response was not an Access API envelope ({ code, msg, data })'
        : '. The console sent no message with that code'
  const advice =
    args.kind === 'auth'
      ? AUTH_ADVICE
      : args.kind === 'forbidden'
        ? ' The console refused the operation: the token may lack the door permission, or the ' +
          'door is not bound to a Door Hub, which remote unlock needs (unverified, OS-1).'
        : args.kind === 'rate-limit'
          ? ' The Access API is throttling requests; wait a moment and try again.'
          : ''
  return `${head}${detail}.${advice}`
}

/**
 * Wraps a thrown connection failure. `fetch` reports a connect failure as a `TypeError` with the
 * real reason in `cause`, so this unwraps to find it: a pin failure keeps its own message and
 * becomes `kind: 'pin'` (the one kind that must never be retried or worked around), an abort from
 * our own deadline becomes `timeout`, and anything else `network`.
 */
function accessErrorFromThrown(args: {
  err: unknown
  what: string
  endpoint: string
}): AccessApiError {
  const { err, what, endpoint } = args
  if (err instanceof AccessApiError) return err
  const pin = pinFailure(err)
  if (pin !== null) {
    return new AccessApiError(pin.message, { kind: 'pin', endpoint, cause: err })
  }
  const root = rootCause(err)
  const timedOut = isTimeoutError(err) || isTimeoutError(root)
  return new AccessApiError(
    `${what} failed: ${timedOut ? 'the Access API did not answer in time' : describeError(root)}.`,
    { kind: timedOut ? 'timeout' : 'network', endpoint, cause: err },
  )
}

/** What a request that got an answer hands to the per-call schema parsing. */
interface AccessRawResponse {
  /** `GET /doors`, for messages and log lines. Never carries a credential. */
  readonly what: string
  readonly status: number
  readonly json: unknown
}

export function createAccessClient(options: AccessClientOptions): AccessClient {
  const endpoint = options.endpoint
  const where = endpoint.hostPort
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? fetch
  const log = options.log ?? ((): void => undefined)

  /**
   * One request, from the DOOR-0 gate to "this is a 2xx `SUCCESS` body". Everything that is an
   * error by rule 2 throws here; the caller only has to match the body against its schema.
   */
  async function call(
    method: 'GET' | 'PUT',
    path: string,
    body?: string,
  ): Promise<AccessRawResponse> {
    const what = `${method} ${path}`

    // DOOR-0, before anything else: not a request that fails, a request that never happens.
    if (!options.enabled()) {
      log(`${what} -> not sent (UniFi Access is disabled, DOOR-0)`)
      throw new AccessApiError(
        `UniFi Access is turned off, so ${what} was not sent. Turn on "Enable UniFi Access" in ` +
          'Settings first (DOOR-0).',
        { kind: 'disabled', endpoint: where },
      )
    }
    // A missing token is the same answer the console would give (401), reached without spending a
    // request on it — and with a message that says where to paste the token (DOOR-1).
    const token = options.token()?.trim() ?? ''
    if (token === '') {
      log(`${what} -> not sent (no Access API token saved)`)
      throw new AccessApiError(
        `${what} was not sent: no Access API token is saved.${AUTH_ADVICE}`,
        { kind: 'auth', endpoint: where },
      )
    }

    // The pinned Agent, read per call so an explicit repin takes effect (CON-3). Node's global
    // fetch cannot take this, which is why undici's is used. `agentFor` **throws**
    // `PinRequiredError` when this endpoint's certificate has not been accepted yet — a
    // synchronous throw rather than a fetch failure, so it is mapped to `kind: 'pin'` here.
    let dispatcher: Dispatcher
    try {
      dispatcher = options.dispatcher()
    } catch (err) {
      const wrapped = accessErrorFromThrown({ err, what, endpoint: where })
      log(`${what} -> ${wrapped.kind} (not sent)`)
      throw wrapped
    }

    const res = await doFetch(`${endpoint.baseUrl}${path}`, {
      method,
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Rule 5: the one and only place the token appears.
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    }).catch((err: unknown) => {
      const wrapped = accessErrorFromThrown({ err, what, endpoint: where })
      log(`${what} -> ${wrapped.kind} (no response)`)
      throw wrapped
    })

    const status = res.status
    const text = await res.text().catch((err: unknown) => {
      const wrapped = accessErrorFromThrown({ err, what, endpoint: where })
      log(`${what} -> ${String(status)} ${wrapped.kind} (body not readable)`)
      throw wrapped
    })
    let json: unknown = null
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        // Left as null: a proxy's HTML error page is not an envelope, and the body is never quoted
        // back (it is untrusted, and quoting it would put unknown text in the UI and the log).
        json = null
      }
    }

    // Rule 2, both halves at once. `AccessErrorEnvelopeSchema` only matches a `code` that is not
    // `SUCCESS`, so a 200 with `CODE_NOT_EXISTS` lands here exactly like a 404 does.
    const asError = AccessErrorEnvelopeSchema.safeParse(json)
    if (asError.success) {
      const { code, msg } = asError.data
      const kind = accessErrorKind(status, code)
      log(`${what} -> ${String(status)} ${code}`)
      throw new AccessApiError(
        responseErrorMessage({ what, status, code, msg: msg ?? null, kind }),
        { kind, status, code, endpoint: where },
      )
    }
    if (status < 200 || status >= 300) {
      // Non-2xx without a usable envelope: an HTML error page, an empty body, or a `code` that is
      // the wrong type. The code is still named when one can be read, so the message is specific.
      const code = looseCode(json)
      const kind = accessErrorKind(status, code)
      log(`${what} -> ${String(status)} ${code ?? '(no code)'}`)
      throw new AccessApiError(responseErrorMessage({ what, status, code, msg: null, kind }), {
        kind,
        status,
        code,
        endpoint: where,
      })
    }

    log(`${what} -> ${String(status)} ${looseCode(json) ?? '(no code)'}`)
    return { what, status, json }
  }

  /** Parses a 2xx `SUCCESS` body with its schema; anything else is `invalid-response` (rule 6). */
  function parseBody<T>(raw: AccessRawResponse, schema: ResponseParser<T>): T {
    const result = schema.safeParse(raw.json)
    if (result.success) return result.data
    throw new AccessApiError(
      `${raw.what} returned HTTP ${String(raw.status)} ${ACCESS_SUCCESS_CODE} with a body the ` +
        `Access schemas do not accept (${schemaMismatchReason(result.error)}). The Access API is ` +
        'community-sourced and unverified; OS-1 is what corrects these shapes.',
      { kind: 'invalid-response', status: raw.status, code: looseCode(raw.json), endpoint: where },
    )
  }

  /**
   * The doors list envelope with its items left unparsed, so each door can be judged on its own (see
   * `doors()`). The strict `AccessDoorListResponseSchema` is still what defines a door — it is
   * applied per item, not to the array.
   */
  const DoorListEnvelopeSchema = accessSuccessEnvelope(z.array(z.unknown()))

  /** `encodeURIComponent` so an id with a slash or a `?` cannot reshape the path. */
  function doorPath(id: string, suffix = ''): string {
    return `/doors/${encodeURIComponent(id)}${suffix}`
  }

  return {
    async doors(): Promise<Door[]> {
      const raw = await call('GET', '/doors')
      // The doors list is assumed unpaginated (P0.4 §3 assumption 11, unverified): if OS-1 finds a
      // `pagination` envelope, this is where the second page would be fetched.
      const envelope = parseBody(raw, DoorListEnvelopeSchema)
      // Parsed **door by door**, not as one array. Every shape here is community-sourced and
      // unverified (R3, OS-1), so one surprising field on one door must not empty the whole list
      // and leave the user unable to reach the doors that are fine — the same reasoning as the
      // Protect client skipping a camera it cannot map (CAM-1).
      const doors: Door[] = []
      const problems: string[] = []
      for (const item of envelope.data) {
        const parsed = AccessDoorSchema.safeParse(item)
        if (parsed.success) {
          doors.push(toDoor(parsed.data))
          continue
        }
        problems.push(schemaMismatchReason(parsed.error))
      }
      if (problems.length > 0) {
        // Logged rather than swallowed: a skipped door is exactly the kind of mismatch OS-1 exists
        // to find, so it has to be visible somewhere.
        log(
          `GET /doors -> skipped ${String(problems.length)} of ${String(envelope.data.length)} ` +
            `doors the Access schemas do not accept (${problems[0] ?? 'no reason given'})`,
        )
      }
      // Every door unusable is a different thing from no doors at all: returning an empty list
      // would read as "none configured" and hide a wholesale shape change.
      if (doors.length === 0 && problems.length > 0) {
        throw new AccessApiError(
          `GET /doors returned ${String(problems.length)} door(s), none of which the Access ` +
            `schemas accept (${problems[0] ?? 'no reason given'}). The Access API is ` +
            'community-sourced and unverified; OS-1 is what corrects these shapes.',
          {
            kind: 'invalid-response',
            status: raw.status,
            code: ACCESS_SUCCESS_CODE,
            endpoint: where,
          },
        )
      }
      return doors
    },

    async door(id: string): Promise<Door> {
      const raw = await call('GET', doorPath(id))
      return toDoor(parseBody(raw, AccessDoorResponseSchema).data)
    },

    async unlock(id: string, unlockOptions?: UnlockOptions): Promise<void> {
      // Validated here, before any request: `actor_id` and `actor_name` go together or not at all,
      // and the console answers `CODE_PARAMS_INVALID` for a body that breaks that. The caller may
      // be relaying an IPC payload (P1.5), so this is a real check, not a type-level one.
      let body: string | undefined
      const actor = unlockOptions?.actor
      if (actor !== undefined) {
        const parsed = AccessUnlockRequestSchema.safeParse({
          actor_id: actor.id,
          actor_name: actor.name,
        })
        if (!parsed.success) {
          const what = `PUT ${doorPath(id, '/unlock')}`
          log(`${what} -> not sent (invalid unlock body)`)
          throw new AccessApiError(
            `${what} was not sent: the unlock actor is not usable ` +
              `(${schemaMismatchReason(parsed.error)}). actor id and name must be given together.`,
            { kind: 'bad-request', endpoint: where },
          )
        }
        body = JSON.stringify(parsed.data)
      }
      // With no actor the body is omitted entirely, which is the community-documented default: the
      // console then logs the API token's name as the actor (P0.4 §3 assumption 8, unverified).
      const raw = await call('PUT', doorPath(id, '/unlock'), body)
      // `data: "success"` is what the one community example shows, and nothing says it is stable.
      // A 2xx `SUCCESS` therefore **counts as unlocked** even if `data` is shaped differently: the
      // door has already been released at this point, and reporting a failure would invite the
      // user to press unlock again — a second physical door release (DOOR-3/4). The mismatch is
      // logged instead, for OS-1 to turn into a corrected schema.
      const parsed = AccessUnlockResponseSchema.safeParse(raw.json)
      if (!parsed.success) {
        log(
          `${raw.what} -> ${String(raw.status)} ${ACCESS_SUCCESS_CODE} ` +
            `(unexpected body, treated as unlocked: ${schemaMismatchReason(parsed.error)})`,
        )
      }
    },
  }
}
