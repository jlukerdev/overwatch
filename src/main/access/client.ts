// UniFi Access developer API client: list doors (DOOR-1/2), remote unlock (DOOR-3) and the rest of
// the documented door endpoints (lock rule, emergency status). SPEC §5.2.
//
// **The shapes are Ubiquiti's, from the official UniFi Access API reference** — the extract in
// `docs/reference/access-endpoints-v4.2.16.md` (the full PDF sits next to it; § numbers below are
// the PDF's). ⚠️ **Documented is not the same as run against hardware:** no Access hardware exists
// on the development network, so nothing here has talked to a real console. The on-site checklist
// **OS-1** (`docs/spikes/P0.4-access-mock.md` §6) remains the check, and whatever is marked
// `unverified (OS-1)` below is something the reference leaves open or contradicts itself on. Until
// then this client is exercised against the local mock (`scripts/mock-access/`), which is what
// `tests/unit/accessClient.test.ts` drives — in-process and over real pinned TLS.
//
// Push exists too: the notifications WebSocket (§11.1) lives in `./notifications.ts`. It carries no
// relay state and no relock event, which is why the relay is still read here with a GET.
//
// Five rules this module exists to keep:
//  1. **DOOR-0.** `enabled()` is read on *every* call, and while it is false **no request is sent
//     at all** — the call fails with `kind: 'disabled'`. The feature is off by default, so a client
//     may be constructed long before Access is usable.
//  2. **An error is HTTP non-2xx *or* `code !== 'SUCCESS'`, whatever the status.** The reference
//     lists the HTTP statuses (§2.2) and the error codes (§2.4) but does **not** say which status
//     goes with which code, so the real console may well answer 200 with a non-`SUCCESS` code. A
//     401 is an auth error whatever the body.
//  3. **The message is never empty** (SPEC §5.2): the envelope's `msg` when it is there, and the
//     `code` plus the HTTP status when it is not (`msg` is optional in the schemas). A DOOR-3
//     failure the user cannot read is a bug — the whole point of the unlock button is feedback.
//  4. **Nothing that moves a door is ever automated** (DOOR-3/4, see {@link AccessClient.unlock},
//     {@link AccessClient.setLockRule}, {@link AccessClient.setEmergencyStatus}). This client does
//     not prompt and does not retry any of them, ever.
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
  AccessEmergencyRequestSchema,
  AccessEmergencyStatusResponseSchema,
  AccessErrorEnvelopeSchema,
  AccessLockRuleRequestSchema,
  AccessLockRuleResponseSchema,
  AccessOkResponseSchema,
  AccessUnlockRequestSchema,
  AccessUnlockResponseSchema,
  accessSuccessEnvelope,
} from './types'
import type { AccessDoor, AccessLockRuleSetType } from './types'
import type { ConsoleEndpoint } from '../console/endpoints'
import type { Door } from '@shared/models'

/** How long one Access request may take before it is aborted. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/**
 * What went wrong, in the terms a caller can act on. Same shape of taxonomy as
 * `protect/errors.ts`, with two Access-only members:
 * - `disabled` — DOOR-0: Access is switched off, so **no call was made**. Not a failure of the
 *   console; the UI should not be showing an unlock control at all in this state.
 * - `auth` — the token is missing, wrong, expired or lacks the scopes (`CODE_AUTH_FAILED`,
 *   `CODE_ACCESS_TOKEN_INVALID`, `CODE_UNAUTHORIZED`, or any 401). The fix is in Settings.
 * - `forbidden` — the console answered and refused the operation itself, not the caller's
 *   identity: `CODE_OPERATION_FORBIDDEN` (the reference says a door "can only be used for remote
 *   opening if it's bound" to a hub, `is_bind_hub`; which code an unbound door really gets is
 *   unverified, OS-1), a door whose device cannot do it right now (`CODE_DEVICE_DEVICE_OFFLINE`,
 *   `…_BUSY`, `…_API_NOT_SUPPORTED`, `…_VERSION_TOO_OLD`), and a console that has moved to
 *   Identity Enterprise (`CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED`). See `KIND_BY_CODE`.
 * - `not-found` — the door, its device or the path does not exist: `CODE_NOT_EXISTS`,
 *   `CODE_RESOURCE_NOT_FOUND`, `CODE_DEVICE_DEVICE_NOT_FOUND`,
 *   `CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND`. A saved door link can point at a deleted door
 *   (DOOR-2).
 * - `bad-request` — the request was malformed (`CODE_PARAMS_INVALID`, HTTP 400), including a body
 *   this client rejected locally before sending it.
 * - `rate-limit` — the Access API throttles (429, §2.2). No limit and no `Retry-After` are
 *   documented, so there is no `retryAfterMs` here; P1.7's queue owns pacing (R9).
 * - `server` — a 5xx, `CODE_SYSTEM_ERROR`, a 402 ("request failed") with no code this client
 *   knows, or any other non-`SUCCESS` code it does not recognise.
 * - `timeout` — the console did not answer inside `requestTimeoutMs`.
 * - `network` — the connection failed (console down, wrong host or port, TCP reset).
 * - `pin` — the TLS pin is missing or did not match (CON-3). **Never** retried and never
 *   downgraded to an unpinned connection; the user re-accepts the certificate in Settings.
 * - `invalid-response` — a 2xx `SUCCESS` body that does not match the schemas in `./types.ts`.
 *   The reference contradicts itself in places (see `./types.ts`), so this is what OS-1 is most
 *   likely to trip over, which is why the reason names the field.
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
   * (DOOR-3/4), and the same goes for `setLockRule()` and `setEmergencyStatus()`. Read this flag
   * for the GET calls only.
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
 * The optional unlock body (§7.9). With no actor the console uses the API token's name as the
 * actor, which is the common case; the app passes one once it has a notion of who is at the
 * keyboard. `actor_id` and `actor_name` go together or not at all ("required if the other is
 * given"), which `AccessUnlockRequestSchema` enforces — this client checks the body **before**
 * sending it.
 */
export interface UnlockOptions {
  readonly actor?: { readonly id: string; readonly name: string }
}

/** A door's temporary locking rule, from `GET /doors/{id}/lock_rule` (§7.11). */
export interface DoorLockRule {
  /**
   * Documented as `schedule`, `keep_lock`, `keep_unlock`, `custom` or `lock_early`
   * (`ACCESS_LOCK_RULE_TYPES`). Left a plain string: what a door with **no** rule answers is not
   * documented (unverified, OS-1), so it may be empty or a value not listed here.
   */
  readonly type: string
  /** When the rule ends, in Unix **seconds**; `null` when the console sent none. */
  readonly endedTime: number | null
}

/** Options of {@link AccessClient.doors}. */
export interface DoorsOptions {
  /**
   * For a caller that polls (the door-state monitor, DOOR-6): the per-request success line is not
   * logged, and a "skipped N of M doors" problem is logged once per change instead of once per
   * read. A wall display polls every few seconds, all day; failures are still logged every time
   * (they are rare, and the monitor backs off while they last).
   */
  readonly quiet?: boolean
}

export interface AccessClient {
  /** `GET /doors` (DOOR-1/2, §7.8). */
  doors(options?: DoorsOptions): Promise<Door[]>
  /**
   * `GET /doors/{id}` (§7.7). Used to read one door's relay, e.g. after an unlock: the
   * notifications WebSocket (`./notifications.ts`) says that a remote unlock happened but carries
   * no `door_lock_relay_status` and no relock event, so the relay itself only comes from a GET.
   */
  door(id: string): Promise<Door>
  /**
   * `PUT /doors/{id}/unlock` (DOOR-3, §7.9) — **releases a physical door.**
   *
   * The explicit user interaction DOOR-3/4 requires belongs to the **caller** (the P5.x unlock
   * control: press-and-hold for 1 s or a confirm dialog). This client deliberately does not
   * prompt, so nothing in the app may call `unlock()` from a timer, an event handler, a keyboard
   * shortcut alone, a reconnect or any kind of retry — each call is one door release, and a
   * failed unlock is reported, never repeated (DOOR-4). `retryable` is about the read calls.
   *
   * Resolves when the console accepted the unlock. The relay goes to `unlock` for the door's
   * configured time and back to `lock` on its own. The notifications WebSocket pushes
   * `access.data.device.remote_unlock` for the unlock, but nothing for the relock and no relay
   * state at all (§11.1), so a caller that wants to show the relay reads it with `door(id)`.
   */
  unlock(id: string, options?: UnlockOptions): Promise<void>
  /** `GET /doors/{id}/lock_rule` (§7.11, Access 1.24.6+, scope `view:space`). Read-only. */
  lockRule(id: string): Promise<DoorLockRule>
  /**
   * `PUT /doors/{id}/lock_rule` (§7.10, Access 1.24.6+, scope `edit:space`) — **changes a
   * physical door's lock state**: `keep_unlock` and `custom` hold it unlocked, `keep_lock` holds
   * it locked, `reset` / `lock_early` / `lock_now` end an unlock. `intervalMinutes` is the
   * duration in **minutes**, required for `custom` and refused for every other type; the body is
   * checked with `AccessLockRuleRequestSchema` **before** anything is sent.
   *
   * Same rule as {@link AccessClient.unlock} (DOOR-3/4, CLAUDE.md "door unlock must always need
   * explicit user interaction"): **never** call this from a timer, an automatic trigger, an event
   * handler, a reconnect or any kind of retry — only as the direct result of a user action. A
   * failure is reported, never repeated. Nothing in the app calls it yet; it exists so the client
   * covers the documented door API.
   */
  setLockRule(
    id: string,
    rule: { readonly type: AccessLockRuleSetType; readonly intervalMinutes?: number },
  ): Promise<void>
  /** `GET /doors/settings/emergency` (§7.13, Access 1.24.6+, scope `view:space`). Read-only. */
  emergencyStatus(): Promise<{ lockdown: boolean; evacuation: boolean }>
  /**
   * `PUT /doors/settings/emergency` (§7.12, Access 1.24.6+, scope `edit:space`) — **changes the
   * lock state of every door at once**: `evacuation: true` keeps all doors unlocked, `lockdown:
   * true` keeps them all locked, both `false` restores the initial state.
   *
   * Same rule as {@link AccessClient.unlock}, with more at stake (DOOR-3/4, CLAUDE.md): **never**
   * call this from a timer, an automatic trigger, an event handler, a reconnect or any kind of
   * retry — only as the direct result of a user action. A failure is reported, never repeated.
   * Nothing in the app calls it yet; it exists so the client covers the documented door API.
   */
  setEmergencyStatus(status: {
    readonly lockdown: boolean
    readonly evacuation: boolean
  }): Promise<void>
}

/** The code of a console that refuses the whole developer API (Identity Enterprise, §1). */
const ACCESS_API_UNAVAILABLE_CODE = 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED'

/**
 * True for a failure that says the **whole Access API is unavailable** on this console
 * (`CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED`). Its kind is `forbidden` (see `KIND_BY_CODE` for why no
 * kind was added), which elsewhere means "the console refused this one door"; a caller that treats
 * `forbidden` as door-level, or as worth polling through, must ask this first. No retry fixes it.
 */
export function isAccessApiUnavailable(err: unknown): boolean {
  return err instanceof AccessApiError && err.code === ACCESS_API_UNAVAILABLE_CODE
}

/**
 * Error `code` → kind, for the case rule 2 exists for: the reference does not say which HTTP status
 * goes with which code, so a recognised code decides the kind and the status is only the fallback.
 * The codes and their meanings are the reference's (§2.4; `ACCESS_ERROR_CODES` in `./types.ts`);
 * which of them a door call really returns is unverified (OS-1).
 */
const KIND_BY_CODE: Readonly<Record<string, AccessErrorKind>> = {
  // "Authentication failed" / "the provided access token is invalid" / "you are not allowed to
  // perform this action". All three are fixed by fixing the token in Settings, so all three are
  // `auth` rather than `forbidden`: scopes are a property of the token, not of the door.
  CODE_AUTH_FAILED: 'auth',
  CODE_ACCESS_TOKEN_INVALID: 'auth',
  CODE_UNAUTHORIZED: 'auth',
  // "The requested operation is not allowed" — the mock's answer for unlocking a door with
  // `is_bind_hub: false`. The reference says such a door cannot be opened remotely but not which
  // code it gets (unverified, OS-1).
  CODE_OPERATION_FORBIDDEN: 'forbidden',
  // "The requested item does not exist" vs "the requested resource was not found"; the mock uses
  // the first for an unknown door id.
  CODE_NOT_EXISTS: 'not-found',
  CODE_RESOURCE_NOT_FOUND: 'not-found',
  // The door's hub is gone, or the hub is not bound to a location any more: for the caller that
  // is the same thing as a stale door link (DOOR-2).
  CODE_DEVICE_DEVICE_NOT_FOUND: 'not-found',
  CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND: 'not-found',
  CODE_PARAMS_INVALID: 'bad-request',
  // The door's device cannot do it right now: offline, busy, on firmware that is too old, or a
  // model the API does not cover. The console answered and its token was accepted, so this is not
  // `server` (which would say the console is broken, mark the call retryable and turn the Access
  // status red) and not `auth`. `forbidden` is the existing kind for "the console refused this
  // door": it is one of `DOOR_LEVEL_UNLOCK_KINDS` in `src/main/connection.ts`, so a failed unlock
  // of an offline door stays a fault of that door and the Access status stays connected. No new
  // kind was added because other files switch on the union. The Door Hub hint that normally goes
  // with `forbidden` is left off for these (see `responseErrorMessage`): the console's own `msg`
  // ("The device is currently offline") is the explanation.
  CODE_DEVICE_DEVICE_OFFLINE: 'forbidden',
  CODE_DEVICE_DEVICE_BUSY: 'forbidden',
  CODE_DEVICE_API_NOT_SUPPORTED: 'forbidden',
  CODE_DEVICE_DEVICE_VERSION_TOO_OLD: 'forbidden',
  // "The API is not available after upgrading to Identity Enterprise" (§1). Nothing is wrong with
  // the request or the token; the console refuses the **whole API**. The kind stays `forbidden`
  // because that already gives the right message — the console's `msg`, no "check your token"
  // advice and no Door Hub hint — and is not retryable, and because adding a kind would touch every
  // file that switches on the union. But unlike the device codes above this refusal is about the
  // endpoint, not about one door, so the two places that read `forbidden` as door-level ask
  // `isAccessApiUnavailable` first: the door-state monitor halts on it instead of polling for ever,
  // and a failed unlock leaves the Access status `error` instead of `connected`.
  [ACCESS_API_UNAVAILABLE_CODE]: 'forbidden',
  // "An error occurred on the server's end" — a documented code (§2.4), and also what the mock's
  // `--fail-rate` sends. Listed so it classifies the same way whatever status it arrives with.
  CODE_SYSTEM_ERROR: 'server',
}

/**
 * What the reference says each of these codes means (§2.4), used **only** when the console sent no
 * `msg` of its own, so that a refusal with the generic `forbidden` / `not-found` kind still tells
 * the user what happened (rule 3). `CODE_DEVICE_DEVICE_BUSY` is reworded: the reference's text is
 * "The camera is currently in use", which would be confusing next to a door.
 */
const DOCUMENTED_MSG_BY_CODE: Readonly<Record<string, string>> = {
  CODE_DEVICE_DEVICE_OFFLINE: 'The device is currently offline',
  CODE_DEVICE_DEVICE_NOT_FOUND: 'The device was not found',
  CODE_DEVICE_DEVICE_BUSY: 'The device is currently in use',
  CODE_DEVICE_API_NOT_SUPPORTED: 'The API is currently not available for this device',
  CODE_DEVICE_DEVICE_VERSION_TOO_OLD:
    'The firmware version is too old. Please update to the latest version',
  CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND: "The device's location was not found",
  [ACCESS_API_UNAVAILABLE_CODE]: 'The API is not available after upgrading to Identity Enterprise',
}

/** HTTP status → kind, used only when the `code` is missing or unrecognised (§2.2). */
export function accessErrorKindForStatus(status: number): AccessErrorKind {
  if (status === 401) return 'auth'
  // 402 is "Request Failed: the parameters were valid but the request failed for some reason" —
  // explicitly *not* a bad request, so it must not tell the user their input was wrong. Without a
  // code that says more, the honest reading is "the console could not do it", which is `server`
  // (retryable for the GETs; an unlock is never retried whatever this says). A 402 that carries a
  // known code, e.g. `CODE_DEVICE_DEVICE_OFFLINE`, is classified by that code instead.
  if (status === 402) return 'server'
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
 * by the schemas in `./types.ts`, except that `''` has to collapse to `null` here: the reference
 * says "a null value means that no device is connected" while its own §7.7 sample sends `''`, and
 * the UI must not have to know about both (which one a console sends is unverified, OS-1).
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

/**
 * What to do about an `auth` failure, appended to the message (leading space included). The path
 * and the scopes are the reference's (§2.7 and the scope column of each endpoint).
 */
export const ACCESS_AUTH_ADVICE =
  ' Check the Access API token in Settings: it may be wrong, expired or missing a permission ' +
  '(Access → Settings → General → Advanced → API Token; view:space to list doors, edit:space to ' +
  'unlock, view:device for live door state).'

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
  const documented = args.code === null ? undefined : DOCUMENTED_MSG_BY_CODE[args.code]
  const detail =
    args.msg !== null && args.msg.trim() !== ''
      ? `: ${args.msg.trim()}`
      : documented !== undefined
        ? `: ${documented}`
        : args.code === null
          ? '. The response was not an Access API envelope ({ code, msg, data })'
          : '. The console sent no message with that code'
  const advice =
    args.kind === 'auth'
      ? ACCESS_AUTH_ADVICE
      : args.kind === 'forbidden' && documented === undefined
        ? // Only for a bare refusal (`CODE_OPERATION_FORBIDDEN`, or a 403 with no known code). The
          // device codes and the Identity Enterprise one say what is wrong themselves, and a Door
          // Hub hint next to "the device is currently offline" would point the wrong way.
          ' The console refused the operation: the token may lack the edit:space permission, or ' +
          'the door is not bound to a Door Hub, which remote unlock needs.'
        : args.kind === 'rate-limit'
          ? ' The Access API is throttling requests; wait a moment and try again.'
          : ''
  // `msg` is the console's own sentence and may already end with a full stop.
  return `${head}${detail.replace(/[.\s]+$/, '')}.${advice}`
}

/**
 * Wraps a thrown connection failure. `fetch` reports a connect failure as a `TypeError` with the
 * real reason in `cause`, so this unwraps to find it: a pin failure keeps its own message and
 * becomes `kind: 'pin'` (the one kind that must never be retried or worked around), an abort from
 * our own deadline becomes `timeout`, and anything else `network`. `what` is the subject of the
 * message (`GET /doors`); it and `endpoint` (`host:port`) must carry no credential. Shared with
 * `./notifications.ts`, whose failed upgrades are classified the same way.
 */
export function accessErrorFromThrown(args: {
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

/** Emergency status applies to all doors, so its path has no door id (§7.12, §7.13). */
const EMERGENCY_PATH = '/doors/settings/emergency'

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
    /** `DoorsOptions.quiet`: the success line is not logged. Every failure still is. */
    quiet = false,
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
        `${what} was not sent: no Access API token is saved.${ACCESS_AUTH_ADVICE}`,
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

    if (!quiet) log(`${what} -> ${String(status)} ${looseCode(json) ?? '(no code)'}`)
    return { what, status, json }
  }

  /** Parses a 2xx `SUCCESS` body with its schema; anything else is `invalid-response` (the reason
   *  names the field, for OS-1). */
  function parseBody<T>(raw: AccessRawResponse, schema: ResponseParser<T>): T {
    const result = schema.safeParse(raw.json)
    if (result.success) return result.data
    throw new AccessApiError(
      `${raw.what} returned HTTP ${String(raw.status)} ${ACCESS_SUCCESS_CODE} with a body the ` +
        `Access schemas do not accept (${schemaMismatchReason(result.error)}). The schemas follow ` +
        'the official Access API reference but have not been run against a console yet; OS-1 is ' +
        'the on-site check that corrects them.',
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

  /**
   * For the two PUTs that change door state. Like an unlock, a 2xx `SUCCESS` **counts as done**
   * whatever `data` looks like: the change has already been applied, and reporting a failure would
   * invite the user to apply it again. The reference's samples answer `data: "success"`; anything
   * else is logged for OS-1 and otherwise ignored.
   */
  function noteIfNotPlainSuccess(raw: AccessRawResponse): void {
    const parsed = AccessOkResponseSchema.safeParse(raw.json)
    if (parsed.success && parsed.data.data === 'success') return
    log(
      `${raw.what} -> ${String(raw.status)} ${ACCESS_SUCCESS_CODE} ` +
        `(unexpected body, treated as done: ${
          parsed.success ? 'data is not "success"' : schemaMismatchReason(parsed.error)
        })`,
    )
  }

  /**
   * The "skipped N of M doors" line the last quiet `doors()` logged, or `null` when its last answer
   * had nothing to skip. A quiet read repeats the line only when it changes, so a door the schemas
   * do not accept is reported once, not once per poll.
   */
  let quietSkipLine: string | null = null

  return {
    async doors(doorsOptions?: DoorsOptions): Promise<Door[]> {
      const quiet = doorsOptions?.quiet === true
      const raw = await call('GET', '/doors', undefined, quiet)
      // The reference documents no parameters and no pagination for the doors list (§7.8): if OS-1
      // finds a `pagination` envelope after all, this is where the second page would be fetched.
      const envelope = parseBody(raw, DoorListEnvelopeSchema)
      // Parsed **door by door**, not as one array. The shapes are documented but not yet run
      // against a console (R3, OS-1), so one surprising field on one door must not empty the list
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
        // to find, so it has to be visible somewhere. A quiet (polling) read says it once per
        // change rather than every few seconds.
        const line =
          `GET /doors -> skipped ${String(problems.length)} of ${String(envelope.data.length)} ` +
          `doors the Access schemas do not accept (${problems[0] ?? 'no reason given'})`
        if (!quiet || line !== quietSkipLine) log(line)
        if (quiet) quietSkipLine = line
      } else if (quiet) {
        quietSkipLine = null
      }
      // Every door unusable is a different thing from no doors at all: returning an empty list
      // would read as "none configured" and hide a wholesale shape change.
      if (doors.length === 0 && problems.length > 0) {
        throw new AccessApiError(
          `GET /doors returned ${String(problems.length)} door(s), none of which the Access ` +
            `schemas accept (${problems[0] ?? 'no reason given'}). The schemas follow the ` +
            'official Access API reference but have not been run against a console yet; OS-1 is ' +
            'the on-site check that corrects them.',
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
      // With no actor the body is omitted entirely, which is the documented default: the system
      // then uses the API token's name as the actor (§7.9).
      const raw = await call('PUT', doorPath(id, '/unlock'), body)
      // `data: "success"` is what the reference's sample shows (§7.9); no console has confirmed it.
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

    async lockRule(id: string): Promise<DoorLockRule> {
      const raw = await call('GET', doorPath(id, '/lock_rule'))
      const rule = parseBody(raw, AccessLockRuleResponseSchema).data
      return { type: rule.type, endedTime: rule.ended_time ?? null }
    },

    async setLockRule(id, rule): Promise<void> {
      const what = `PUT ${doorPath(id, '/lock_rule')}`
      // Checked before any request, like the unlock actor: the rule may be relayed from an IPC
      // payload, and a `custom` without minutes (or minutes on anything else) must not reach a
      // door.
      const parsed = AccessLockRuleRequestSchema.safeParse({
        type: rule.type,
        ...(rule.intervalMinutes === undefined ? {} : { interval: rule.intervalMinutes }),
      })
      if (!parsed.success) {
        log(`${what} -> not sent (invalid lock rule)`)
        throw new AccessApiError(
          `${what} was not sent: the lock rule is not usable ` +
            `(${schemaMismatchReason(parsed.error)}). A custom rule needs a whole number of ` +
            'minutes, and no other rule takes one.',
          { kind: 'bad-request', endpoint: where },
        )
      }
      noteIfNotPlainSuccess(
        await call('PUT', doorPath(id, '/lock_rule'), JSON.stringify(parsed.data)),
      )
    },

    async emergencyStatus(): Promise<{ lockdown: boolean; evacuation: boolean }> {
      const raw = await call('GET', EMERGENCY_PATH)
      const status = parseBody(raw, AccessEmergencyStatusResponseSchema).data
      return { lockdown: status.lockdown, evacuation: status.evacuation }
    },

    async setEmergencyStatus(status): Promise<void> {
      const what = `PUT ${EMERGENCY_PATH}`
      // Both flags, both real booleans, nothing else — checked before sending for the same reason
      // as above: a truthy string from a careless caller must not put every door into lockdown.
      const parsed = AccessEmergencyRequestSchema.safeParse({
        lockdown: status.lockdown,
        evacuation: status.evacuation,
      })
      if (!parsed.success) {
        log(`${what} -> not sent (invalid emergency status)`)
        throw new AccessApiError(
          `${what} was not sent: the emergency status is not usable ` +
            `(${schemaMismatchReason(parsed.error)}). lockdown and evacuation must both be true ` +
            'or false.',
          { kind: 'bad-request', endpoint: where },
        )
      }
      noteIfNotPlainSuccess(await call('PUT', EMERGENCY_PATH, JSON.stringify(parsed.data)))
    },
  }
}
