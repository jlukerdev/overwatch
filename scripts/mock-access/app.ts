// Request handling for the UniFi Access mock (P0.4). Pure: no sockets, no TLS, no console output,
// so it is unit-tested directly (tests/unit/accessMock.test.ts). server.ts wraps it in node:https.
//
// Everything served here follows COMMUNITY-SOURCED, UNVERIFIED shapes (SPEC §5.2, R3). The HTTP
// status codes for errors are the mock's own choice: no source documents them. OS-1 checks all
// of it against the site console. Node runs this file directly: erasable syntax only.
import { timingSafeEqual } from 'node:crypto'
import {
  ACCESS_API_PATH,
  ACCESS_SUCCESS_CODE,
  AccessUnlockRequestSchema,
} from '../../src/main/access/types.ts'
import { createDoorStore } from './doors.ts'
import type { DoorStore, DoorStoreOptions } from './doors.ts'

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

export interface AccessMock {
  handle(req: MockRequest): MockResponse
  readonly store: DoorStore
}

/** Mock-only code for injected failures (`--fail-rate`); not a documented Access code. */
export const MOCK_FAILURE_CODE = 'CODE_SYSTEM_ERROR'

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

/** Path below the API prefix with the query dropped, or undefined if outside the prefix. */
export function routePath(url: string): string | undefined {
  const path = url.split('?')[0] ?? ''
  if (path !== ACCESS_API_PATH && !path.startsWith(`${ACCESS_API_PATH}/`)) return undefined
  const rest = path.slice(ACCESS_API_PATH.length).replace(/\/+$/, '')
  return rest === '' ? '/' : rest
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

  function unlock(id: string, rawBody: string): MockResponse {
    // The community docs make the body optional; an empty body is the common case.
    if (rawBody.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return fail(400, 'CODE_PARAMS_INVALID', 'request body is not valid JSON')
      }
      const result = AccessUnlockRequestSchema.safeParse(parsed)
      if (!result.success) {
        const issue = result.error.issues[0]
        return fail(400, 'CODE_PARAMS_INVALID', issue?.message ?? 'invalid parameters')
      }
    }
    const door = store.get(id)
    if (door === undefined) return fail(404, 'CODE_NOT_EXISTS', 'door does not exist')
    if (!door.is_bind_hub) {
      return fail(403, 'CODE_OPERATION_FORBIDDEN', 'door is not bound to a hub')
    }
    store.unlock(id)
    return ok('success')
  }

  function handle(req: MockRequest): MockResponse {
    const path = routePath(req.url)
    if (path === undefined) return fail(404, 'CODE_RESOURCE_NOT_FOUND', 'not found')
    if (!tokenMatches(req.headers.authorization, options.token)) {
      return fail(401, 'CODE_ACCESS_TOKEN_INVALID', 'token is missing, invalid or expired')
    }
    if (failRate > 0 && random() < failRate) {
      return fail(500, MOCK_FAILURE_CODE, 'injected failure (mock --fail-rate)')
    }
    const method = req.method.toUpperCase()
    if (path === '/doors') {
      if (method === 'GET') return ok(store.list())
      return fail(405, 'CODE_RESOURCE_NOT_FOUND', 'method not allowed')
    }
    const unlockMatch = /^\/doors\/([^/]+)\/unlock$/.exec(path)
    if (unlockMatch?.[1] !== undefined) {
      if (method !== 'PUT') return fail(405, 'CODE_RESOURCE_NOT_FOUND', 'method not allowed')
      const id = decodeId(unlockMatch[1])
      if (id === undefined) return fail(400, 'CODE_PARAMS_INVALID', 'malformed door id')
      return unlock(id, req.body)
    }
    const doorMatch = /^\/doors\/([^/]+)$/.exec(path)
    if (doorMatch?.[1] !== undefined) {
      if (method !== 'GET') return fail(405, 'CODE_RESOURCE_NOT_FOUND', 'method not allowed')
      const id = decodeId(doorMatch[1])
      if (id === undefined) return fail(400, 'CODE_PARAMS_INVALID', 'malformed door id')
      const door = store.get(id)
      return door === undefined ? fail(404, 'CODE_NOT_EXISTS', 'door does not exist') : ok(door)
    }
    return fail(404, 'CODE_RESOURCE_NOT_FOUND', 'not found')
  }

  return { handle, store }
}
