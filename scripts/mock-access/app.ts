// Request handling for the UniFi Access mock (P0.4, extended in P5.5). Pure: no sockets, no TLS,
// no console output, so it is unit-tested directly (tests/unit/accessMock.test.ts). http.ts wraps
// it in node:https and notifications.ts carries its notification frames over the WebSocket.
//
// Since P5.5 the routes, bodies and codes follow Ubiquiti's official reference
// (docs/reference/access-endpoints-v4.2.16.md), which is documented but NOT yet run against
// hardware (OS-1). What the reference leaves open is THE MOCK'S OWN CHOICE and is marked so:
//   - the HTTP status that goes with each error code (the reference lists statuses and codes
//     separately). The mock uses 400 / 401 / 403 / 500 from the reference's table, plus 404 and 405,
//     which that table does NOT list: a real console may answer those cases differently;
//   - which code a refused operation gets (CODE_OPERATION_FORBIDDEN here);
//   - how unlock, lock rules and emergency mode interact (see doors.ts).
//
// Notifications: the ONLY frame this mock pushes is `access.data.device.remote_unlock`, on a
// successful `PUT /doors/{id}/unlock`. NOTHING is pushed when a door relocks, and no frame carries
// the relay state: the reference documents no such event, so a client must read the lock state
// with `GET /doors`. The mock invents no undocumented event.
//
// Routes under `/__mock/` are mock-only controls (not part of the Access API): unlock, lock or
// move a door "at the door", put a door inside an unlock schedule (P5.6), and drop the WebSocket
// clients. The list with examples is in server.ts.
// Node runs this file directly: erasable syntax only.
import { timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import {
  ACCESS_API_PATH,
  ACCESS_EVENT_REMOTE_UNLOCK,
  ACCESS_NOTIFICATIONS_PATH,
  ACCESS_SUCCESS_CODE,
  AccessEmergencyRequestSchema,
  AccessLockRuleRequestSchema,
  AccessUnlockRequestSchema,
} from '../../src/main/access/types.ts'
import type { AccessDoor } from '../../src/main/access/types.ts'
import { createDoorStore } from './doors.ts'
import type { DoorStore, DoorStoreOptions } from './doors.ts'
import { isValidKey } from './ws.ts'

export interface MockRequest {
  method: string
  /** Path plus optional query string, e.g. `/api/v1/developer/doors?x=1`. */
  url: string
  /** Lowercase header names. */
  headers: Readonly<Record<string, string | undefined>>
  body: string
}

export interface MockEnvelope {
  code: string
  msg: string
  data?: unknown
}

export interface MockResponse {
  status: number
  /** Response headers the mock adds (lowercase names). Always includes {@link MOCK_HEADER}. */
  headers: Readonly<Record<string, string>>
  body: MockEnvelope
}

/**
 * Mock-only response header, sent on EVERY mock response. The spike classifies a target as the
 * mock only when it sees this header (`sourceFromHeaders`), never by host. The real console does
 * not send it. Part of the mock contract (docs/spikes/P0.4-access-mock.md §1).
 */
export const MOCK_HEADER = 'x-view-protect-mock'
export const MOCK_HEADER_VALUE = '1'
export const MOCK_HEADERS: Readonly<Record<string, string>> = { [MOCK_HEADER]: MOCK_HEADER_VALUE }

export interface AccessMockOptions extends DoorStoreOptions {
  /** The only Bearer token accepted. */
  token: string
  /** Probability (0..1) of answering a valid request with a 500 `CODE_SYSTEM_ERROR`. */
  failRate?: number
  /** Random source for `failRate` (tests inject a deterministic one). */
  random?: () => number
}

/** One frame of the notifications WebSocket, in the documented shape (§11.1). */
export interface MockNotification {
  event: string
  receiver_id: string
  event_object_id: string
  save_to_history: boolean
  data: unknown
}

export interface AccessMock {
  handle(req: MockRequest): MockResponse
  /**
   * Decides a WebSocket upgrade request: `undefined` accepts it (the caller answers 101), a
   * response refuses it (the caller writes it and closes the socket).
   */
  authorizeUpgrade(req: MockRequest): MockResponse | undefined
  /** Subscribes to the frames to push to every WebSocket client; returns the unsubscribe. */
  onNotification(listener: (frame: MockNotification) => void): () => void
  /**
   * Registers what `POST /__mock/notifications/drop` does: close every WebSocket client and
   * return how many there were. Returns the unregister function.
   */
  onDropClients(handler: () => number): () => void
  readonly store: DoorStore
}

/**
 * Code of the failures `--fail-rate` injects. The code itself is a real, documented Access code
 * ("An error occurred on the server's end", §2.4); only the injection is mock-only.
 */
export const MOCK_FAILURE_CODE = 'CODE_SYSTEM_ERROR'

/** Prefix of the mock-only control routes. Outside the API prefix on purpose. */
export const MOCK_ADMIN_PATH = '/__mock'

/** `POST /__mock/doors/{id}/schedule` without `?minutes=`: the schedule runs for an hour. */
export const DEFAULT_SCHEDULE_MINUTES = 60
/** The longest schedule the mock-only route starts: a day. */
export const MAX_SCHEDULE_MINUTES = 1440

/** Full path of the notifications WebSocket. */
export const NOTIFICATIONS_PATH = `${ACCESS_API_PATH}${ACCESS_NOTIFICATIONS_PATH}`

/** `event_object_id` of pushed frames: the hub's device id on a console, a fake here. */
export const MOCK_HUB_ID = 'mock-hub-0001'

/**
 * The `access.data.device.remote_unlock` frame for a door, shaped like the reference's sample
 * (§11.1): `data.unique_id` is the door id. Everything but the door's own id and names is a fake
 * constant (`up_id` reuses the floor id, a guess at "parent location").
 */
export function remoteUnlockNotification(door: AccessDoor): MockNotification {
  return {
    event: ACCESS_EVENT_REMOTE_UNLOCK,
    receiver_id: '',
    event_object_id: MOCK_HUB_ID,
    save_to_history: false,
    data: {
      unique_id: door.id,
      name: door.name,
      up_id: door.floor_id,
      timezone: '',
      location_type: 'door',
      extra_type: '',
      full_name: door.full_name,
      level: 0,
      work_time: '[]',
      work_time_id: '',
      extras: {
        'uah-input_state_dps': 'off',
        'uah-wiring_state_dps-neg': 'off',
        'uah-wiring_state_dps-pos': 'off',
      },
    },
  }
}

function ok(data: unknown): MockResponse {
  return {
    status: 200,
    headers: MOCK_HEADERS,
    body: { code: ACCESS_SUCCESS_CODE, msg: 'success', data },
  }
}

function fail(status: number, code: string, msg: string): MockResponse {
  return { status, headers: MOCK_HEADERS, body: { code, msg } }
}

/** Constant-time comparison of the presented Bearer token with the expected one. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
  const presented = m?.[1]
  if (presented === undefined) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Path below `prefix` with the query dropped, or undefined if outside the prefix. */
function pathBelow(prefix: string, url: string): string | undefined {
  const path = url.split('?')[0] ?? ''
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined
  const rest = path.slice(prefix.length).replace(/\/+$/, '')
  return rest === '' ? '/' : rest
}

/** Path below the API prefix with the query dropped, or undefined if outside the prefix. */
export function routePath(url: string): string | undefined {
  return pathBelow(ACCESS_API_PATH, url)
}

/** Path below the mock-only `/__mock` prefix, or undefined if outside it. */
export function adminPath(url: string): string | undefined {
  return pathBelow(MOCK_ADMIN_PATH, url)
}

/** The query parameters of a request URL (empty when there are none). */
function queryOf(url: string): URLSearchParams {
  const i = url.indexOf('?')
  return new URLSearchParams(i === -1 ? '' : url.slice(i + 1))
}

/** `decodeURIComponent` that maps malformed escapes to undefined instead of throwing. */
function decodeId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

export function createAccessMock(options: AccessMockOptions): AccessMock {
  if (options.token.length === 0) throw new Error('The mock needs a non-empty token')
  const store = createDoorStore(options)
  const failRate = options.failRate ?? 0
  const random = options.random ?? Math.random
  const notificationListeners = new Set<(frame: MockNotification) => void>()
  const dropHandlers = new Set<() => number>()

  const unauthorized = (): MockResponse =>
    fail(401, 'CODE_ACCESS_TOKEN_INVALID', 'token is missing, invalid or expired')
  const notFound = (): MockResponse => fail(404, 'CODE_RESOURCE_NOT_FOUND', 'not found')
  const noDoor = (): MockResponse => fail(404, 'CODE_NOT_EXISTS', 'door does not exist')
  const badMethod = (): MockResponse => fail(405, 'CODE_RESOURCE_NOT_FOUND', 'method not allowed')
  const badId = (): MockResponse => fail(400, 'CODE_PARAMS_INVALID', 'malformed door id')

  function pushRemoteUnlock(doorId: string): void {
    const door = store.get(doorId)
    if (door === undefined) return
    const frame = remoteUnlockNotification(door)
    for (const l of [...notificationListeners]) l(frame)
  }

  // The documented push: a remote unlock through the API. Relocks and relay changes push nothing.
  store.onChange((change) => {
    if (change.kind === 'unlock' && change.source === 'remote') pushRemoteUnlock(change.doorId)
  })

  /** Parses a JSON body against `schema`; `{ error }` is the CODE_PARAMS_INVALID answer. */
  function parseBody<T>(
    raw: string,
    schema: z.ZodType<T>,
  ): { value: T; error?: undefined } | { error: MockResponse } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: fail(400, 'CODE_PARAMS_INVALID', 'request body is not valid JSON') }
    }
    const result = schema.safeParse(parsed)
    if (!result.success) {
      const issue = result.error.issues[0]
      return { error: fail(400, 'CODE_PARAMS_INVALID', issue?.message ?? 'invalid parameters') }
    }
    return { value: result.data }
  }

  /** Why the store refused an unlock, as a response. The code is the mock's own choice. */
  function refused(outcome: 'lockdown' | 'keep_lock'): MockResponse {
    return fail(
      403,
      'CODE_OPERATION_FORBIDDEN',
      outcome === 'lockdown' ? 'doors are in lockdown' : 'door is set to keep locked',
    )
  }

  function unlock(id: string, rawBody: string): MockResponse {
    // The body is optional (§7.9); an empty body is the common case. The optional query
    // parameters (reader_id, entry_method, control_cmd) are accepted and ignored.
    if (rawBody.trim() !== '') {
      const body = parseBody(rawBody, AccessUnlockRequestSchema)
      if (body.error !== undefined) return body.error
    }
    const door = store.get(id)
    if (door === undefined) return noDoor()
    if (!door.is_bind_hub) {
      return fail(403, 'CODE_OPERATION_FORBIDDEN', 'door is not bound to a hub')
    }
    const outcome = store.unlock(id, 'remote')
    return outcome === 'ok' ? ok('success') : refused(outcome)
  }

  function lockRule(method: string, id: string, rawBody: string): MockResponse {
    if (method !== 'GET' && method !== 'PUT') return badMethod()
    const door = store.get(id)
    if (method === 'GET') return door === undefined ? noDoor() : ok(store.lockRule(id))
    const body = parseBody(rawBody, AccessLockRuleRequestSchema)
    if (body.error !== undefined) return body.error
    if (door === undefined) return noDoor()
    // Mock's own choice: a door without a hub has no lock to rule, as for unlock.
    if (!door.is_bind_hub) {
      return fail(403, 'CODE_OPERATION_FORBIDDEN', 'door is not bound to a hub')
    }
    store.setLockRule(id, body.value)
    return ok('success')
  }

  function emergency(method: string, rawBody: string): MockResponse {
    if (method === 'GET') return ok(store.emergency())
    if (method !== 'PUT') return badMethod()
    const body = parseBody(rawBody, AccessEmergencyRequestSchema)
    if (body.error !== undefined) return body.error
    // Mock's own choice: the reference does not say what both flags at once would mean.
    if (body.value.lockdown && body.value.evacuation) {
      return fail(400, 'CODE_PARAMS_INVALID', 'lockdown and evacuation cannot both be true')
    }
    store.setEmergency(body.value)
    return ok('success')
  }

  /** Mock-only controls (`/__mock/…`): things that happen at the door, not through the API. */
  function admin(req: MockRequest, path: string): MockResponse {
    if (!tokenMatches(req.headers.authorization, options.token)) return unauthorized()
    const method = req.method.toUpperCase()
    if (path === '/notifications/drop') {
      if (method !== 'POST') return badMethod()
      let closed = 0
      for (const h of [...dropHandlers]) closed += h()
      return ok({ closed })
    }
    const m = /^\/doors\/([^/]+)\/(unlock|lock|position|schedule)$/.exec(path)
    if (m?.[1] === undefined) return notFound()
    if (method !== 'POST') return badMethod()
    const id = decodeId(m[1])
    if (id === undefined) return badId()
    if (store.get(id) === undefined) return noDoor()
    const query = queryOf(req.url)
    if (m[2] === 'unlock') {
      // "Someone tapped a card": per the reference this produces NO WebSocket frame, so it is
      // silent unless ?push=1 asks for the remote_unlock frame as well.
      const outcome = store.unlock(id, 'local')
      if (outcome !== 'ok') return refused(outcome)
      if (query.get('push') === '1') pushRemoteUnlock(id)
    } else if (m[2] === 'lock') {
      store.lock(id)
    } else if (m[2] === 'schedule') {
      // P5.6: "the door's unlock schedule has just started". The API cannot create a schedule, so
      // this is how the mock gets a door whose lock rule reads `schedule` (and that `lock_early`
      // has something to end). `?minutes=N` is how long it still runs: 1 to 1440, default 60.
      const raw = query.get('minutes')
      const minutes = raw === null ? DEFAULT_SCHEDULE_MINUTES : Number(raw)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SCHEDULE_MINUTES) {
        return fail(400, 'CODE_PARAMS_INVALID', 'minutes must be a whole number from 1 to 1440')
      }
      store.startSchedule(id, minutes)
    } else {
      const status = query.get('status')
      if (status !== 'open' && status !== 'close') {
        return fail(400, 'CODE_PARAMS_INVALID', 'status must be open or close')
      }
      store.setPosition(id, status)
    }
    return ok(store.get(id))
  }

  function handle(req: MockRequest): MockResponse {
    const adminRoute = adminPath(req.url)
    if (adminRoute !== undefined) return admin(req, adminRoute)
    const path = routePath(req.url)
    if (path === undefined) return notFound()
    if (!tokenMatches(req.headers.authorization, options.token)) return unauthorized()
    if (failRate > 0 && random() < failRate) {
      return fail(500, MOCK_FAILURE_CODE, 'injected failure (mock --fail-rate)')
    }
    const method = req.method.toUpperCase()
    if (path === '/doors') {
      if (method === 'GET') return ok(store.list())
      return badMethod()
    }
    // Before the `/doors/{id}/…` patterns: `settings` here is not a door id.
    if (path === '/doors/settings/emergency') return emergency(method, req.body)
    if (path === ACCESS_NOTIFICATIONS_PATH) {
      // Reached only without `Upgrade: websocket` (upgrades go through authorizeUpgrade).
      if (method !== 'GET') return badMethod()
      return fail(400, 'CODE_PARAMS_INVALID', 'this endpoint is a WebSocket: upgrade required')
    }
    const sub = /^\/doors\/([^/]+)\/(unlock|lock_rule)$/.exec(path)
    if (sub?.[1] !== undefined) {
      if (sub[2] === 'unlock' && method !== 'PUT') return badMethod()
      const id = decodeId(sub[1])
      if (id === undefined) return badId()
      return sub[2] === 'unlock' ? unlock(id, req.body) : lockRule(method, id, req.body)
    }
    const doorMatch = /^\/doors\/([^/]+)$/.exec(path)
    if (doorMatch?.[1] !== undefined) {
      if (method !== 'GET') return badMethod()
      const id = decodeId(doorMatch[1])
      if (id === undefined) return badId()
      const door = store.get(id)
      return door === undefined ? noDoor() : ok(door)
    }
    return notFound()
  }

  function authorizeUpgrade(req: MockRequest): MockResponse | undefined {
    const path = routePath(req.url)
    if (path === undefined) return notFound()
    // A 401 on the upgrade is what tells the client to stop and fix the token.
    if (!tokenMatches(req.headers.authorization, options.token)) return unauthorized()
    if (path !== ACCESS_NOTIFICATIONS_PATH) return notFound()
    if (req.method.toUpperCase() !== 'GET') return badMethod()
    if ((req.headers.upgrade ?? '').trim().toLowerCase() !== 'websocket') {
      return fail(400, 'CODE_PARAMS_INVALID', 'only a websocket upgrade is served here')
    }
    if (!isValidKey(req.headers['sec-websocket-key'])) {
      return fail(400, 'CODE_PARAMS_INVALID', 'missing or malformed Sec-WebSocket-Key')
    }
    if ((req.headers['sec-websocket-version'] ?? '').trim() !== '13') {
      return fail(400, 'CODE_PARAMS_INVALID', 'Sec-WebSocket-Version must be 13')
    }
    return undefined
  }

  return {
    handle,
    authorizeUpgrade,
    onNotification(listener) {
      notificationListeners.add(listener)
      return () => {
        notificationListeners.delete(listener)
      }
    },
    onDropClients(handler) {
      dropHandlers.add(handler)
      return () => {
        dropHandlers.delete(handler)
      }
    },
    store,
  }
}
