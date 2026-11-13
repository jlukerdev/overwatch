// P1.4 (DOOR-0/1/2/3/4, R3): the UniFi Access client in src/main/access/client.ts.
//
// Everything the client talks to is COMMUNITY-SOURCED and UNVERIFIED (SPEC §5.2, P0.4), so these
// tests pin down the client's *behaviour* against the P0.4 mock rather than against hardware. Three
// layers:
//  (a) the mock's real semantics, in process: an injected `fetch` turns a `Request` into the mock's
//      `MockRequest` and its `MockResponse` back into a `Response`, so the mock decides every
//      status, code and relay transition (no sockets, fake timers for the relay revert);
//  (b) the same mock behind a real `node:https` server with an openssl-generated self-signed
//      certificate, driven through `createPinnedAgent` — the only test that proves the pinned
//      dispatcher, the mock and the client work together (skipped when `openssl` is missing);
//  (c) a plain fake `fetch` for the responses the mock cannot produce: a 200 carrying an error
//      code, an envelope without `msg`, a 2xx body that fails the schema, a pin failure and a
//      timeout.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, Request, Response } from 'undici'
import type { Dispatcher } from 'undici'
import {
  AccessApiError,
  accessErrorKind,
  createAccessClient,
  toDoor,
} from '../../src/main/access/client'
import type { AccessClient, AccessClientOptions } from '../../src/main/access/client'
import { AccessDoorSchema } from '../../src/main/access/types'
import { accessEndpoint } from '../../src/main/console/endpoints'
import { PinMismatchError, PinRequiredError, createPinnedAgent } from '../../src/main/tls/pinning'
import { MOCK_HEADER, createAccessMock } from '../../scripts/mock-access/app.ts'
import type { AccessMock, MockRequest } from '../../scripts/mock-access/app.ts'
import { DEFAULT_UNLOCK_MS, SEED_DOORS } from '../../scripts/mock-access/doors.ts'
import type { ConsoleEndpoint } from '../../src/main/console/endpoints'
import type { Door } from '@shared/models'

const HOST = '127.0.0.1'
const TOKEN = 'access-client-test-token'
const API_PATH = '/api/v1/developer'

type FetchImpl = NonNullable<AccessClientOptions['fetchImpl']>

const FRONT = SEED_DOORS.find((d) => d.name === 'Front Door')
const GARAGE = SEED_DOORS.find((d) => d.name === 'Garage Side Door')
const STORAGE = SEED_DOORS.find((d) => d.name === 'Storage Room')
if (FRONT === undefined || GARAGE === undefined || STORAGE === undefined) {
  throw new Error('the P0.4 seed doors changed; update this test')
}

/** The Access endpoint for a port, exactly as the app derives it from the saved settings. */
function endpointFor(port: number): ConsoleEndpoint {
  return accessEndpoint({
    host: HOST,
    certFingerprint: null,
    accessEnabled: true,
    accessBaseUrl: `https://${HOST}:${String(port)}${API_PATH}`,
    accessCertFingerprint: null,
  })
}

/** A dispatcher the fake-fetch layers never use: the injected fetch ignores it. */
let unusedDispatcher: Agent

beforeAll(() => {
  unusedDispatcher = new Agent()
})

afterAll(async () => {
  await unusedDispatcher.close()
})

/** Turns one undici `Request` into the mock's `MockRequest`. */
async function toMockRequest(request: Request): Promise<MockRequest> {
  const url = new URL(request.url)
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of request.headers) headers[name] = value
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    body: await request.text(),
  }
}

interface MockFetch {
  /** What the client sent, in order: `GET /api/v1/developer/doors`. */
  readonly sent: { what: string; authorization: string | null; body: string }[]
  readonly fn: FetchImpl
}

/** Layer (a): the mock's own handler, reached through a `fetch` the client cannot tell apart. */
function fetchThroughMock(mock: AccessMock): MockFetch {
  const sent: { what: string; authorization: string | null; body: string }[] = []
  const fn = vi.fn<FetchImpl>(async (input, init) => {
    const request = new Request(input, init)
    const mockRequest = await toMockRequest(request)
    sent.push({
      what: `${mockRequest.method} ${mockRequest.url}`,
      authorization: request.headers.get('authorization'),
      body: mockRequest.body,
    })
    const res = mock.handle(mockRequest)
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json', ...res.headers },
    })
  })
  return { sent, fn }
}

interface Harness {
  client: AccessClient
  fetchSpy: FetchImpl
  logs: string[]
  state: { enabled: boolean; token: string | null }
}

/** A client wired to an injected fetch, with the DOOR-0 switch and the token mutable per test. */
function harness(
  fetchImpl: FetchImpl,
  init: { enabled?: boolean; token?: string | null; port?: number; requestTimeoutMs?: number } = {},
): Harness {
  // `?? TOKEN` would turn an explicit `token: null` (nothing saved yet) back into a real token.
  const state = {
    enabled: init.enabled ?? true,
    token: init.token === undefined ? TOKEN : init.token,
  }
  const logs: string[] = []
  const client = createAccessClient({
    endpoint: endpointFor(init.port ?? 12445),
    enabled: () => state.enabled,
    token: () => state.token,
    dispatcher: (): Dispatcher => unusedDispatcher,
    fetchImpl,
    ...(init.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: init.requestTimeoutMs }),
    log: (line) => logs.push(line),
  })
  return { client, fetchSpy: fetchImpl, logs, state }
}

/** The thrown value as an `AccessApiError`, or a failure naming what arrived instead. */
async function accessError(promise: Promise<unknown>): Promise<AccessApiError> {
  const err: unknown = await promise.then(
    () => {
      throw new Error('expected the call to fail')
    },
    (reason: unknown) => reason,
  )
  if (!(err instanceof AccessApiError)) {
    throw new Error(`expected an AccessApiError, got ${String(err)}`)
  }
  return err
}

// -------------------------------------------------------------------------------------------------
// (a) Against the P0.4 mock, in process

describe('against the P0.4 mock', () => {
  let mock: AccessMock
  let mockFetch: MockFetch

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createAccessMock({ token: TOKEN })
    mockFetch = fetchThroughMock(mock)
  })

  afterEach(() => {
    mock.store.dispose()
    vi.useRealTimers()
  })

  it('maps GET /doors onto the trimmed shared Door shape (DOOR-1)', async () => {
    const { client, logs } = harness(mockFetch.fn)
    const doors = await client.doors()

    expect(doors).toHaveLength(4)
    expect(doors.map((d) => d.name)).toStrictEqual([
      'Front Door',
      'Garage Side Door',
      'Office',
      'Storage Room',
    ])
    const front = doors[0]
    expect(front).toStrictEqual<Door>({
      id: FRONT.id,
      name: 'Front Door',
      fullName: FRONT.full_name,
      floorId: FRONT.floor_id,
      type: 'door',
      boundToHub: true,
      relay: 'lock',
      position: 'close',
    })
    // The two doors P0.4 seeded for the edge cases.
    const storage = doors.find((d) => d.name === 'Storage Room')
    expect(storage?.boundToHub).toBe(false)
    expect(storage?.position).toBeNull()
    expect(doors.find((d) => d.name === 'Garage Side Door')?.position).toBe('open')

    expect(mockFetch.sent.map((s) => s.what)).toStrictEqual([`GET ${API_PATH}/doors`])
    expect(logs).toStrictEqual(['GET /doors -> 200 SUCCESS'])
  })

  it('reads one door, and reports an unknown id as not-found (CODE_NOT_EXISTS)', async () => {
    const { client } = harness(mockFetch.fn)
    const door = await client.door(GARAGE.id)
    expect(door.id).toBe(GARAGE.id)
    expect(door.fullName).toBe(GARAGE.full_name)

    const err = await accessError(client.door('00000000-0000-4000-8000-000000000000'))
    expect(err.kind).toBe('not-found')
    expect(err.status).toBe(404)
    expect(err.code).toBe('CODE_NOT_EXISTS')
    expect(err.message).toContain('door does not exist')
    expect(err.retryable).toBe(false)
  })

  it('unlocks a door and the relay returns to lock on its own (DOOR-3)', async () => {
    const { client, logs } = harness(mockFetch.fn)
    const relay = (): string | undefined => mock.store.get(FRONT.id)?.door_lock_relay_status
    expect(relay()).toBe('lock')

    await expect(client.unlock(FRONT.id)).resolves.toBeUndefined()
    expect(relay()).toBe('unlock')
    await expect(client.door(FRONT.id)).resolves.toMatchObject({ relay: 'unlock' })

    vi.advanceTimersByTime(DEFAULT_UNLOCK_MS + 1)
    expect(relay()).toBe('lock')
    await expect(client.door(FRONT.id)).resolves.toMatchObject({ relay: 'lock' })

    // No body at all when no actor is given: the console logs the token's name instead (P0.4 §3).
    const unlockCall = mockFetch.sent[0]
    expect(unlockCall?.what).toBe(`PUT ${API_PATH}/doors/${FRONT.id}/unlock`)
    expect(unlockCall?.body).toBe('')
    expect(logs[0]).toBe(`PUT /doors/${FRONT.id}/unlock -> 200 SUCCESS`)
  })

  it('reports the refused unlock of an unbound door with the console message (DOOR-3)', async () => {
    const { client } = harness(mockFetch.fn)
    const err = await accessError(client.unlock(STORAGE.id))
    expect(err.kind).toBe('forbidden')
    expect(err.status).toBe(403)
    expect(err.code).toBe('CODE_OPERATION_FORBIDDEN')
    // The mock's own `msg` reaches the user (SPEC §5.2: never an empty message).
    expect(err.message).toContain('door is not bound to a hub')
    expect(err.message).toContain('CODE_OPERATION_FORBIDDEN')
    expect(err.retryable).toBe(false)
    expect(mock.store.get(STORAGE.id)?.door_lock_relay_status).toBe('lock')
  })

  it('sends an actor when one is given, and rejects a half actor before any request', async () => {
    const { client } = harness(mockFetch.fn)
    await expect(
      client.unlock(FRONT.id, { actor: { id: 'user-7', name: 'Josh' } }),
    ).resolves.toBeUndefined()
    expect(mockFetch.sent[0]?.body).toBe(JSON.stringify({ actor_id: 'user-7', actor_name: 'Josh' }))

    // What an IPC payload (P1.5) can look like once a field goes missing: the schema's
    // "together or not at all" rule is checked locally, so nothing is sent and no door moves.
    const halfActor = { id: 'user-7' } as unknown as { id: string; name: string }
    const err = await accessError(client.unlock(STORAGE.id, { actor: halfActor }))
    expect(err.kind).toBe('bad-request')
    expect(err.status).toBeNull()
    expect(err.message).toContain('together')
    const blankName = await accessError(
      client.unlock(FRONT.id, { actor: { id: 'user-7', name: '' } }),
    )
    expect(blankName.kind).toBe('bad-request')
    // One request in total: the successful unlock.
    expect(mockFetch.fn).toHaveBeenCalledTimes(1)
  })

  it('maps a rejected token to auth, whichever way the token is wrong (401)', async () => {
    const wrong = harness(mockFetch.fn, { token: 'not-the-mock-token' })
    const err = await accessError(wrong.client.doors())
    expect(err.kind).toBe('auth')
    expect(err.status).toBe(401)
    expect(err.code).toBe('CODE_ACCESS_TOKEN_INVALID')
    expect(err.message).toContain('API Token')

    // A token that was never saved fails the same way, without spending a request on it (DOOR-1).
    const none = harness(mockFetch.fn, { token: null })
    const missing = await accessError(none.client.doors())
    expect(missing.kind).toBe('auth')
    expect(missing.status).toBeNull()
    expect(missing.message).toContain('no Access API token is saved')
    expect(mockFetch.fn).toHaveBeenCalledTimes(1)
  })

  it('maps the mock --fail-rate 500 CODE_SYSTEM_ERROR to a retryable server error', async () => {
    const failing = createAccessMock({ token: TOKEN, failRate: 1, random: () => 0 })
    const { client } = harness(fetchThroughMock(failing).fn)
    const err = await accessError(client.doors())
    expect(err.kind).toBe('server')
    expect(err.status).toBe(500)
    expect(err.code).toBe('CODE_SYSTEM_ERROR')
    expect(err.retryable).toBe(true)
    failing.store.dispose()
  })

  it('makes no request at all while Access is disabled (DOOR-0)', async () => {
    const { client, logs, state } = harness(mockFetch.fn, { enabled: false })
    for (const call of [
      client.doors(),
      client.door(FRONT.id),
      client.unlock(FRONT.id),
      client.unlock(FRONT.id, { actor: { id: 'user-7', name: 'Josh' } }),
    ]) {
      const err = await accessError(call)
      expect(err.kind).toBe('disabled')
      expect(err.status).toBeNull()
      expect(err.code).toBeNull()
      expect(err.message).toContain('DOOR-0')
      expect(err.retryable).toBe(false)
    }
    expect(mockFetch.fn).not.toHaveBeenCalled()
    expect(mockFetch.sent).toStrictEqual([])
    expect(logs.every((line) => line.includes('not sent'))).toBe(true)

    // The switch is read per call, so turning Access on needs no new client.
    state.enabled = true
    await expect(client.doors()).resolves.toHaveLength(4)
    expect(mockFetch.fn).toHaveBeenCalledTimes(1)
  })

  it('keeps the token out of every log line and every message (CON-2, NFR-9)', async () => {
    const { client, logs } = harness(mockFetch.fn)
    const messages: string[] = []
    for (const call of [
      client.doors(),
      client.door('no-such-door'),
      client.unlock(STORAGE.id),
      client.unlock(FRONT.id, { actor: { id: 'user-7', name: '' } }),
    ]) {
      await call.then(
        () => undefined,
        (err: unknown) => {
          messages.push(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : '')
        },
      )
    }
    expect(messages.length).toBeGreaterThan(0)
    for (const text of [...logs, ...messages]) expect(text).not.toContain(TOKEN)
    // ...and the token really was in play: it travelled in the Authorization header only.
    expect(mockFetch.sent[0]?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(mockFetch.sent.every((s) => !s.what.includes(TOKEN) && !s.body.includes(TOKEN))).toBe(
      true,
    )
  })
})

// -------------------------------------------------------------------------------------------------
// (b) Against a real HTTPS server through the pinned dispatcher

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const OPENSSL = hasOpenssl()

describe.skipIf(!OPENSSL)('over real TLS with the pinned dispatcher (P0.4 §4, CON-3)', () => {
  let certDir = ''
  let fingerprint256 = ''
  let server: Server
  let port = 0
  let mock: AccessMock

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'vp-access-client-'))
    const certPath = join(certDir, 'cert.pem')
    const keyPath = join(certDir, 'key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=view-protect-access-mock',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const cert = readFileSync(certPath, 'utf8')
    fingerprint256 = new X509Certificate(cert).fingerprint256
    mock = createAccessMock({ token: TOKEN })

    // The same pure handler as layer (a), this time behind node:https — i.e. what
    // `npm run mock:access` serves (scripts/mock-access/server.ts).
    server = createServer({ cert, key: readFileSync(keyPath, 'utf8') }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {}
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name] = Array.isArray(value) ? value.join(', ') : value
        }
        const out = mock.handle({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers })
        res.end(JSON.stringify(out.body))
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, HOST, () => {
        resolve()
      })
    })
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    port = address.port
  })

  afterAll(async () => {
    mock.store.dispose()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    rmSync(certDir, { recursive: true, force: true })
  })

  /** The client as the app builds it: undici's own fetch plus the pinned Agent as dispatcher. */
  function pinnedClient(pin: string): { client: AccessClient; agent: Agent; logs: string[] } {
    const endpoint = endpointFor(port)
    const agent = createPinnedAgent(pin, { endpoint: endpoint.hostPort })
    const logs: string[] = []
    return {
      agent,
      logs,
      client: createAccessClient({
        endpoint,
        enabled: () => true,
        token: () => TOKEN,
        dispatcher: () => agent,
        log: (line) => logs.push(line),
      }),
    }
  }

  it('lists doors over real TLS when the leaf matches the pin', async () => {
    const { client, agent, logs } = pinnedClient(fingerprint256)
    try {
      const doors = await client.doors()
      expect(doors).toHaveLength(4)
      expect(doors.map((d) => d.name)).toContain('Front Door')
      expect(logs).toStrictEqual(['GET /doors -> 200 SUCCESS'])
      // The mock header rides along on the real response too (P0.4 §1).
      expect(MOCK_HEADER).toBe('x-view-protect-mock')
    } finally {
      await agent.close()
    }
  })

  it('unlocks over real TLS, and refuses the unbound door with the console message', async () => {
    const { client, agent } = pinnedClient(fingerprint256)
    try {
      await expect(client.unlock(GARAGE.id)).resolves.toBeUndefined()
      await expect(client.door(GARAGE.id)).resolves.toMatchObject({ relay: 'unlock' })
      const err = await accessError(client.unlock(STORAGE.id))
      expect(err.kind).toBe('forbidden')
      expect(err.message).toContain('door is not bound to a hub')
    } finally {
      await agent.close()
    }
  })

  it('refuses to connect, and sends nothing, when the pin does not match (CON-3)', async () => {
    const wrong = `${'AA:'.repeat(31)}AA`
    const { client, agent } = pinnedClient(wrong)
    try {
      const err = await accessError(client.doors())
      expect(err.kind).toBe('pin')
      expect(err.status).toBeNull()
      expect(err.retryable).toBe(false)
      // The PinMismatchError's own message survives, both fingerprints and all.
      expect(err.message).toMatch(/Refusing to connect/)
      expect(err.message).toContain(wrong)
      expect(err.message).toContain(fingerprint256)
      expect(err.cause).toBeInstanceOf(Error)
    } finally {
      await agent.close()
    }
  })
})

// -------------------------------------------------------------------------------------------------
// (c) Responses the mock cannot produce

/** A fetch that answers from a canned handler and records what it was asked. */
function fakeFetch(handler: (request: Request) => Response | Promise<Response>): FetchImpl {
  return vi.fn<FetchImpl>(async (input, init) => handler(new Request(input, init)))
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('responses the console may send but the mock does not (rule 2, SPEC §5.2)', () => {
  it('treats HTTP 200 with a non-SUCCESS code as an error, not a success', async () => {
    const { client, logs } = harness(
      fakeFetch(() =>
        jsonResponse(200, { code: 'CODE_NOT_EXISTS', msg: 'door does not exist', data: null }),
      ),
    )
    const err = await accessError(client.door('d-1'))
    expect(err.kind).toBe('not-found')
    expect(err.status).toBe(200)
    expect(err.code).toBe('CODE_NOT_EXISTS')
    expect(err.message).toContain('door does not exist')
    expect(logs).toStrictEqual(['GET /doors/d-1 -> 200 CODE_NOT_EXISTS'])
  })

  it('names the code and the status when the envelope carries no msg (never an empty message)', async () => {
    const { client } = harness(fakeFetch(() => jsonResponse(403, { code: 'CODE_UNAUTHORIZED' })))
    const err = await accessError(client.unlock('d-1'))
    expect(err.kind).toBe('auth')
    expect(err.code).toBe('CODE_UNAUTHORIZED')
    expect(err.message).toContain('CODE_UNAUTHORIZED')
    expect(err.message).toContain('HTTP 403')
    expect(err.message).toContain('API Token')
    expect(err.message.trim().length).toBeGreaterThan(20)
  })

  it('is an error with a non-empty message even when the body is not an envelope at all', async () => {
    const { client } = harness(
      fakeFetch(
        () =>
          new Response('<html>502 Bad Gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    )
    const err = await accessError(client.doors())
    expect(err.kind).toBe('server')
    expect(err.status).toBe(502)
    expect(err.code).toBeNull()
    expect(err.message).toContain('HTTP 502')
    expect(err.message).toContain('{ code, msg, data }')
    // The untrusted body is never quoted back into the message.
    expect(err.message).not.toContain('<html>')
  })

  it('fails only when no door at all is usable, naming the field', async () => {
    // Every door unusable is a wholesale shape change, which an empty list would hide behind
    // "no doors configured".
    const door = { ...FRONT, full_name: undefined }
    const { client } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', msg: 'success', data: [door] })),
    )
    const err = await accessError(client.doors())
    expect(err.kind).toBe('invalid-response')
    expect(err.status).toBe(200)
    expect(err.code).toBe('SUCCESS')
    expect(err.message).toContain('full_name')
    expect(err.message).toContain('OS-1')
    // A concrete reason, not a zod dump.
    expect(err.message).not.toContain('ZodError')
    expect(err.message.split('\n')).toHaveLength(1)
  })

  it('skips one unusable door and keeps the rest (DOOR-1/2)', async () => {
    // The Access shapes are entirely unverified (R3): one surprising field on one door must not
    // cost the user the doors that are fine, the same way a camera that cannot be mapped does not
    // empty the camera list (CAM-1).
    const { client, logs } = harness(
      fakeFetch(() =>
        jsonResponse(200, {
          code: 'SUCCESS',
          msg: 'success',
          data: [FRONT, { ...FRONT, id: 'door-bad', door_lock_relay_status: 'ajar' }],
        }),
      ),
    )
    const doors = await client.doors()
    expect(doors.map((d) => d.id)).toEqual([FRONT.id])
    // The skip is logged, because it is exactly the mismatch OS-1 exists to find.
    expect(logs.join('\n')).toContain('skipped 1 of 2')
    expect(logs.join('\n')).toContain('door_lock_relay_status')
  })

  it('returns an empty list for a console with no doors, without calling that a failure', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', msg: 'success', data: [] })),
    )
    await expect(client.doors()).resolves.toEqual([])
  })

  it('still counts an unlock as done when only the SUCCESS envelope data is unexpected', async () => {
    // A second unlock would be a second physical door release (DOOR-3/4), so a 2xx SUCCESS whose
    // `data` is shaped differently is logged, not failed.
    const { client, logs } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', msg: 'success', data: { ok: true } })),
    )
    await expect(client.unlock('d-1')).resolves.toBeUndefined()
    expect(logs.some((line) => line.includes('treated as unlocked'))).toBe(true)
  })

  it('maps a pin failure to kind pin, keeping the original message', async () => {
    const mismatch = new PinMismatchError({
      endpoint: `${HOST}:12445`,
      expected: `${'AA:'.repeat(31)}AA`,
      actual: `${'BB:'.repeat(31)}BB`,
    })
    const { client } = harness(
      fakeFetch(() => {
        throw new TypeError('fetch failed', { cause: mismatch })
      }),
    )
    const err = await accessError(client.doors())
    expect(err.kind).toBe('pin')
    expect(err.status).toBeNull()
    expect(err.message).toBe(mismatch.message)
    expect(err.retryable).toBe(false)

    const required = new PinRequiredError(`${HOST}:12445`)
    const unpinned = harness(
      fakeFetch(() => {
        throw new TypeError('fetch failed', { cause: required })
      }),
    )
    const second = await accessError(unpinned.client.doors())
    expect(second.kind).toBe('pin')
    expect(second.message).toBe(required.message)
  })

  it('maps an endpoint with no accepted certificate to pin, without sending anything', async () => {
    // `registry.agentFor` throws PinRequiredError synchronously while the endpoint is unpinned
    // (CON-3), which is the realistic path for a first run with Access just switched on.
    const required = new PinRequiredError(`${HOST}:12445`)
    const fetchSpy = fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: [] }))
    const logs: string[] = []
    const client = createAccessClient({
      endpoint: endpointFor(12445),
      enabled: () => true,
      token: () => TOKEN,
      dispatcher: (): Dispatcher => {
        throw required
      },
      fetchImpl: fetchSpy,
      log: (line) => logs.push(line),
    })
    const err = await accessError(client.doors())
    expect(err.kind).toBe('pin')
    expect(err.message).toBe(required.message)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logs).toStrictEqual(['GET /doors -> pin (not sent)'])
  })

  it('maps a connection failure to network and our own deadline to timeout', async () => {
    const down = harness(
      fakeFetch(() => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        })
      }),
    )
    const networkError = await accessError(down.client.doors())
    expect(networkError.kind).toBe('network')
    expect(networkError.status).toBeNull()
    expect(networkError.message).toContain('ECONNREFUSED')
    expect(networkError.retryable).toBe(true)

    const stalled = harness(
      vi.fn<FetchImpl>(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const reason: unknown = init.signal?.reason
              reject(reason instanceof Error ? reason : new Error('aborted'))
            })
          }),
      ),
      { requestTimeoutMs: 20 },
    )
    const timeout = await accessError(stalled.client.doors())
    expect(timeout.kind).toBe('timeout')
    expect(timeout.status).toBeNull()
    expect(timeout.message).toContain('did not answer in time')
    expect(timeout.retryable).toBe(true)
  })
})

// -------------------------------------------------------------------------------------------------
// Pure mapping and classification

describe('toDoor', () => {
  it('renames every wire field and turns "" (no position sensor) into null', () => {
    // Both leniencies of the wire schema at once: `is_bind_hub` as a string, position as `''`
    // (P0.4 §3 assumption 7, UNVERIFIED — OS-1).
    const parsed = AccessDoorSchema.parse({
      id: 'd-1',
      name: 'Side Gate',
      full_name: 'Mock Console - 1F - Side Gate',
      floor_id: 'f-1',
      type: 'door',
      is_bind_hub: 'true',
      door_lock_relay_status: 'unlock',
      door_position_status: '',
      extra_field_from_a_newer_firmware: 1,
    })
    expect(toDoor(parsed)).toStrictEqual<Door>({
      id: 'd-1',
      name: 'Side Gate',
      fullName: 'Mock Console - 1F - Side Gate',
      floorId: 'f-1',
      type: 'door',
      boundToHub: true,
      relay: 'unlock',
      position: null,
    })
  })

  it('keeps an explicit null position null and a real reading as it is', () => {
    expect(toDoor({ ...FRONT, door_position_status: null }).position).toBeNull()
    expect(toDoor({ ...FRONT, door_position_status: 'open' }).position).toBe('open')
  })
})

describe('accessErrorKind', () => {
  it('is auth for a 401 whatever the body says (SPEC §5.2)', () => {
    expect(accessErrorKind(401, null)).toBe('auth')
    expect(accessErrorKind(401, 'SUCCESS')).toBe('auth')
    expect(accessErrorKind(401, 'CODE_NOT_EXISTS')).toBe('auth')
  })

  it('lets a known code outrank the undocumented status (P0.4 §3 assumption 4)', () => {
    expect(accessErrorKind(200, 'CODE_OPERATION_FORBIDDEN')).toBe('forbidden')
    expect(accessErrorKind(200, 'CODE_PARAMS_INVALID')).toBe('bad-request')
    expect(accessErrorKind(500, 'CODE_NOT_EXISTS')).toBe('not-found')
    expect(accessErrorKind(403, 'CODE_ACCESS_TOKEN_INVALID')).toBe('auth')
  })

  it('falls back to the status, and to server for anything unrecognised', () => {
    expect(accessErrorKind(403, null)).toBe('forbidden')
    expect(accessErrorKind(404, null)).toBe('not-found')
    expect(accessErrorKind(429, null)).toBe('rate-limit')
    expect(accessErrorKind(405, null)).toBe('bad-request')
    expect(accessErrorKind(503, null)).toBe('server')
    expect(accessErrorKind(200, 'CODE_SOMETHING_NEW')).toBe('server')
  })
})
