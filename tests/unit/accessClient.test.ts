// P1.4 (DOOR-0/1/2/3/4, R3): the UniFi Access client in src/main/access/client.ts.
//
// The shapes are from Ubiquiti's official Access API reference
// (docs/reference/access-endpoints-v4.2.16.md) but nothing has run against a console yet (OS-1), so
// these tests pin down the client's *behaviour* against the P0.4 mock rather than against hardware.
// Three layers:
//  (a) the mock's real semantics, in process: an injected `fetch` turns a `Request` into the mock's
//      `MockRequest` and its `MockResponse` back into a `Response`, so the mock decides every
//      status, code and relay transition (no sockets, fake timers for the relay revert);
//  (b) the same mock behind a real `node:https` server with an openssl-generated self-signed
//      certificate, driven through `createPinnedAgent` — the only test that proves the pinned
//      dispatcher, the mock and the client work together (skipped when `openssl` is missing);
//  (c) a plain fake `fetch` for the responses the mock cannot produce: a 200 carrying an error
//      code, an envelope without `msg`, a 2xx body that fails the schema, a pin failure and a
//      timeout — and for the endpoints the mock does not serve (lock rule, emergency status, P5.5).
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
  ACCESS_AUTH_ADVICE,
  AccessApiError,
  accessErrorKind,
  accessErrorKindForStatus,
  createAccessClient,
  isAccessApiUnavailable,
  toDoor,
} from '../../src/main/access/client'
import type { AccessClient, AccessClientOptions } from '../../src/main/access/client'
import { ACCESS_ERROR_CODES, AccessDoorSchema } from '../../src/main/access/types'
import type { AccessLockRuleSetType } from '../../src/main/access/types'
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
    connectOnLaunch: false,
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
    expect(err.message).toContain('Access → Settings → General → Advanced → API Token')

    // A token that was never saved fails the same way, without spending a request on it (DOOR-1).
    const none = harness(mockFetch.fn, { token: null })
    const missing = await accessError(none.client.doors())
    expect(missing.kind).toBe('auth')
    expect(missing.status).toBeNull()
    expect(missing.message).toContain('no Access API token is saved')
    expect(missing.message).toContain('Access → Settings → General → Advanced → API Token')
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
      client.lockRule(FRONT.id),
      client.setLockRule(FRONT.id, { type: 'keep_unlock' }),
      client.setLockRule(FRONT.id, { type: 'custom', intervalMinutes: 10 }),
      client.emergencyStatus(),
      client.setEmergencyStatus({ lockdown: true, evacuation: false }),
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

  it('logs nothing for a quiet read that works, and still logs one that fails', async () => {
    let fail = false
    const { client, logs } = harness(
      fakeFetch(() =>
        fail
          ? jsonResponse(401, { code: 'CODE_AUTH_FAILED', msg: 'no' })
          : jsonResponse(200, { code: 'SUCCESS', msg: 'success', data: [FRONT] }),
      ),
    )
    // A poll every few seconds must not write a line per request (DOOR-6).
    for (let i = 0; i < 5; i += 1) await client.doors({ quiet: true })
    expect(logs).toEqual([])
    // The same read asked for by the user is logged as before.
    await client.doors()
    expect(logs).toEqual(['GET /doors -> 200 SUCCESS'])
    fail = true
    await accessError(client.doors({ quiet: true }))
    expect(logs.at(-1)).toBe('GET /doors -> 401 CODE_AUTH_FAILED')
  })

  it('logs a skipped door once per change on quiet reads, and every time otherwise', async () => {
    const bad = { ...FRONT, id: 'door-bad', door_lock_relay_status: 'ajar' }
    let data: unknown[] = [FRONT, bad]
    const { client, logs } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', msg: 'success', data })),
    )
    const skipped = (): number => logs.filter((line) => line.includes('skipped')).length
    for (let i = 0; i < 4; i += 1) await client.doors({ quiet: true })
    expect(skipped()).toBe(1)
    // A different problem is a change…
    data = [FRONT, bad, { ...bad, id: 'door-bad-2' }]
    await client.doors({ quiet: true })
    await client.doors({ quiet: true })
    expect(skipped()).toBe(2)
    // …and so is the problem coming back after it went away.
    data = [FRONT]
    await client.doors({ quiet: true })
    data = [FRONT, bad]
    await client.doors({ quiet: true })
    expect(skipped()).toBe(3)
    // A read that is not quiet always says it.
    await client.doors()
    await client.doors()
    expect(skipped()).toBe(5)
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
// (c, continued) P5.5: the rest of the documented door endpoints (§7.10–§7.13)

/** A fetch that records method, path and body of every request and answers from `respond`. */
function recordingFetch(respond: (request: Request) => Response): {
  fn: FetchImpl
  sent: { method: string; path: string; body: string; authorization: string | null }[]
} {
  const sent: { method: string; path: string; body: string; authorization: string | null }[] = []
  const fn = vi.fn<FetchImpl>(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    sent.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body: await request.clone().text(),
      authorization: request.headers.get('authorization'),
    })
    return respond(request)
  })
  return { fn, sent }
}

const OK = { code: 'SUCCESS', msg: 'success', data: 'success' }

describe('lock rule (§7.10, §7.11)', () => {
  it('reads GET /doors/{id}/lock_rule and maps ended_time', async () => {
    const { fn, sent } = recordingFetch(() =>
      jsonResponse(200, {
        code: 'SUCCESS',
        msg: 'success',
        data: { ended_time: 1708673342, type: 'custom' },
      }),
    )
    const { client, logs } = harness(fn)
    await expect(client.lockRule('door-1')).resolves.toStrictEqual({
      type: 'custom',
      endedTime: 1708673342,
    })
    expect(sent).toStrictEqual([
      {
        method: 'GET',
        path: `${API_PATH}/doors/door-1/lock_rule`,
        body: '',
        authorization: `Bearer ${TOKEN}`,
      },
    ])
    expect(logs).toStrictEqual(['GET /doors/door-1/lock_rule -> 200 SUCCESS'])
  })

  it('logs nothing at all for a quiet read, success or failure, and still throws the failure (P5.6)', async () => {
    let fail = false
    const { client, logs } = harness(
      fakeFetch(() =>
        fail
          ? jsonResponse(404, { code: 'CODE_RESOURCE_NOT_FOUND', msg: 'not found' })
          : jsonResponse(200, { code: 'SUCCESS', data: { type: 'schedule', ended_time: 9 } }),
      ),
    )
    // A details round is one of these per door, every `detailsSec`, all day.
    for (let i = 0; i < 5; i += 1) await client.lockRule('door-1', { quiet: true })
    expect(logs).toEqual([])
    // On a console older than Access 1.24.6 every one fails: not a line each either.
    fail = true
    for (let i = 0; i < 5; i += 1) {
      const error = await accessError(client.lockRule('door-1', { quiet: true }))
      expect(error.kind).toBe('not-found')
    }
    expect(logs).toEqual([])
    // The same read without the flag is logged as before.
    await accessError(client.lockRule('door-1'))
    expect(logs).toEqual(['GET /doors/door-1/lock_rule -> 404 CODE_RESOURCE_NOT_FOUND'])
  })

  it('a quiet read is still refused, silently, while Access is off or there is no token (DOOR-0)', async () => {
    const { client, logs, state, fetchSpy } = harness(fakeFetch(() => jsonResponse(200, {})))
    state.enabled = false
    expect((await accessError(client.lockRule('door-1', { quiet: true }))).kind).toBe('disabled')
    expect((await accessError(client.emergencyStatus({ quiet: true }))).kind).toBe('disabled')
    state.enabled = true
    state.token = null
    expect((await accessError(client.lockRule('door-1', { quiet: true }))).kind).toBe('auth')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  it('reads a rule without ended_time as endedTime null, and keeps an undocumented type', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: { type: 'keep_lock' } })),
    )
    await expect(client.lockRule('d-1')).resolves.toStrictEqual({
      type: 'keep_lock',
      endedTime: null,
    })
    // What a door with no rule answers is not documented: an empty type must not be a failure.
    const none = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: { type: '' } })),
    )
    await expect(none.client.lockRule('d-1')).resolves.toStrictEqual({ type: '', endedTime: null })
  })

  it('reports a lock rule body it cannot read as invalid-response, naming the field', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: { type: 7 } })),
    )
    const err = await accessError(client.lockRule('d-1'))
    expect(err.kind).toBe('invalid-response')
    expect(err.message).toContain('data.type')
    expect(err.message).toContain('OS-1')
  })

  it('maps the errors of a lock rule read like any other call', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(404, { code: 'CODE_NOT_EXISTS', msg: 'door does not exist' })),
    )
    const err = await accessError(client.lockRule('gone'))
    expect(err.kind).toBe('not-found')
    expect(err.message).toContain('door does not exist')
  })

  it.each<[AccessLockRuleSetType, number | undefined, string]>([
    ['keep_lock', undefined, '{"type":"keep_lock"}'],
    ['keep_unlock', undefined, '{"type":"keep_unlock"}'],
    ['custom', 10, '{"type":"custom","interval":10}'],
    ['reset', undefined, '{"type":"reset"}'],
    ['lock_early', undefined, '{"type":"lock_early"}'],
    ['lock_now', undefined, '{"type":"lock_now"}'],
  ])('sends PUT /doors/{id}/lock_rule for %s', async (type, intervalMinutes, body) => {
    const { fn, sent } = recordingFetch(() => jsonResponse(200, OK))
    const { client, logs } = harness(fn)
    await expect(
      client.setLockRule(
        'door-1',
        intervalMinutes === undefined ? { type } : { type, intervalMinutes },
      ),
    ).resolves.toBeUndefined()
    expect(sent).toStrictEqual([
      {
        method: 'PUT',
        path: `${API_PATH}/doors/door-1/lock_rule`,
        body,
        authorization: `Bearer ${TOKEN}`,
      },
    ])
    expect(logs).toStrictEqual(['PUT /doors/door-1/lock_rule -> 200 SUCCESS'])
  })

  it('rejects an unusable lock rule locally, before any request', async () => {
    const { fn, sent } = recordingFetch(() => jsonResponse(200, OK))
    const { client, logs } = harness(fn)
    // What a relayed IPC payload can look like: the compile-time types are not a check.
    const loose = (id: string, rule: { type: string; intervalMinutes?: unknown }): Promise<void> =>
      client.setLockRule(id, rule as { type: AccessLockRuleSetType; intervalMinutes?: number })
    for (const rule of [
      { type: 'custom' }, // custom needs minutes
      { type: 'keep_unlock', intervalMinutes: 10 }, // and nothing else takes them
      { type: 'lock_now', intervalMinutes: 1 },
      { type: 'custom', intervalMinutes: 0 },
      { type: 'custom', intervalMinutes: -5 },
      { type: 'custom', intervalMinutes: 1.5 },
      { type: 'custom', intervalMinutes: '10' },
      { type: 'unlock_forever' },
      { type: '' },
    ]) {
      const err = await accessError(loose('door-1', rule))
      expect(err.kind).toBe('bad-request')
      expect(err.status).toBeNull()
      expect(err.message).toContain('was not sent')
      expect(err.message).toContain('PUT /doors/door-1/lock_rule')
    }
    expect(fn).not.toHaveBeenCalled()
    expect(sent).toStrictEqual([])
    expect(logs.every((line) => line.includes('not sent (invalid lock rule)'))).toBe(true)
  })

  it('counts a 2xx SUCCESS as done whatever data is, and never repeats the PUT', async () => {
    for (const data of [{ ok: true }, null, 'done', undefined]) {
      const { fn } = recordingFetch(() => jsonResponse(200, { code: 'SUCCESS', data }))
      const { client, logs } = harness(fn)
      await expect(client.setLockRule('d-1', { type: 'keep_lock' })).resolves.toBeUndefined()
      expect(fn).toHaveBeenCalledTimes(1)
      expect(logs.some((line) => line.includes('treated as done'))).toBe(true)
    }
  })

  it('reports a refused lock rule once, with the console message', async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse(200, {
        code: 'CODE_DEVICE_DEVICE_OFFLINE',
        msg: 'The device is currently offline',
      }),
    )
    const { client } = harness(fn)
    const err = await accessError(client.setLockRule('d-1', { type: 'keep_unlock' }))
    expect(err.kind).toBe('forbidden')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('The device is currently offline')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('encodes the door id so it cannot reshape the path', async () => {
    const { fn, sent } = recordingFetch(() => jsonResponse(200, OK))
    const { client } = harness(fn)
    await client.setLockRule('a/b?c', { type: 'reset' })
    expect(sent[0]?.path).toBe(`${API_PATH}/doors/a%2Fb%3Fc/lock_rule`)
  })
})

describe('emergency status (§7.12, §7.13)', () => {
  it('logs nothing at all for a quiet read, success or failure (P5.6)', async () => {
    let fail = false
    const { client, logs } = harness(
      fakeFetch(() =>
        fail
          ? jsonResponse(500, { code: 'CODE_SYSTEM_ERROR', msg: 'boom' })
          : jsonResponse(200, { code: 'SUCCESS', data: { evacuation: false, lockdown: true } }),
      ),
    )
    await expect(client.emergencyStatus({ quiet: true })).resolves.toStrictEqual({
      lockdown: true,
      evacuation: false,
    })
    fail = true
    expect((await accessError(client.emergencyStatus({ quiet: true }))).kind).toBe('server')
    expect(logs).toEqual([])
    await accessError(client.emergencyStatus())
    expect(logs).toEqual(['GET /doors/settings/emergency -> 500 CODE_SYSTEM_ERROR'])
  })

  it('never quiets a PUT: changing a door or the emergency status is always logged', async () => {
    const { client, logs } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: 'success' })),
    )
    await client.setEmergencyStatus({ lockdown: true, evacuation: false })
    await client.setLockRule('door-1', { type: 'keep_lock' })
    await client.unlock('door-1')
    expect(logs).toEqual([
      'PUT /doors/settings/emergency -> 200 SUCCESS',
      'PUT /doors/door-1/lock_rule -> 200 SUCCESS',
      'PUT /doors/door-1/unlock -> 200 SUCCESS',
    ])
  })

  it('reads GET /doors/settings/emergency', async () => {
    const { fn, sent } = recordingFetch(() =>
      jsonResponse(200, {
        code: 'SUCCESS',
        data: { evacuation: true, lockdown: false },
        msg: 'success',
      }),
    )
    const { client } = harness(fn)
    await expect(client.emergencyStatus()).resolves.toStrictEqual({
      lockdown: false,
      evacuation: true,
    })
    expect(sent).toStrictEqual([
      {
        method: 'GET',
        path: `${API_PATH}/doors/settings/emergency`,
        body: '',
        authorization: `Bearer ${TOKEN}`,
      },
    ])
  })

  it('reads a missing flag as false, and a non-boolean one as invalid-response', async () => {
    const partial = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: { lockdown: true } })),
    )
    await expect(partial.client.emergencyStatus()).resolves.toStrictEqual({
      lockdown: true,
      evacuation: false,
    })
    const wrong = harness(
      fakeFetch(() => jsonResponse(200, { code: 'SUCCESS', data: { lockdown: 'true' } })),
    )
    const err = await accessError(wrong.client.emergencyStatus())
    expect(err.kind).toBe('invalid-response')
    expect(err.message).toContain('data.lockdown')
  })

  it.each([
    [{ lockdown: true, evacuation: false }, '{"lockdown":true,"evacuation":false}'],
    [{ lockdown: false, evacuation: true }, '{"lockdown":false,"evacuation":true}'],
    [{ lockdown: false, evacuation: false }, '{"lockdown":false,"evacuation":false}'],
  ])('sends PUT /doors/settings/emergency with both flags (%j)', async (status, body) => {
    const { fn, sent } = recordingFetch(() => jsonResponse(200, OK))
    const { client, logs } = harness(fn)
    await expect(client.setEmergencyStatus(status)).resolves.toBeUndefined()
    expect(sent).toStrictEqual([
      {
        method: 'PUT',
        path: `${API_PATH}/doors/settings/emergency`,
        body,
        authorization: `Bearer ${TOKEN}`,
      },
    ])
    expect(logs).toStrictEqual(['PUT /doors/settings/emergency -> 200 SUCCESS'])
  })

  it('rejects flags that are not booleans locally, and sends only the two flags', async () => {
    const { fn, sent } = recordingFetch(() => jsonResponse(200, OK))
    const { client } = harness(fn)
    const loose = (status: Record<string, unknown>): Promise<void> =>
      client.setEmergencyStatus(status as { lockdown: boolean; evacuation: boolean })
    for (const status of [
      { lockdown: 'true', evacuation: false },
      { lockdown: true },
      { lockdown: 1, evacuation: 0 },
      {},
    ]) {
      const err = await accessError(loose(status))
      expect(err.kind).toBe('bad-request')
      expect(err.status).toBeNull()
      expect(err.message).toContain('was not sent')
    }
    expect(fn).not.toHaveBeenCalled()

    // A stray field on the caller's object does not ride along.
    await loose({ lockdown: false, evacuation: false, door_id: 'd-1' })
    expect(sent[0]?.body).toBe('{"lockdown":false,"evacuation":false}')
  })

  it('counts a 2xx SUCCESS as done whatever data is, and reports a failure once', async () => {
    const odd = recordingFetch(() => jsonResponse(200, { code: 'SUCCESS', data: {} }))
    const done = harness(odd.fn)
    await expect(
      done.client.setEmergencyStatus({ lockdown: true, evacuation: false }),
    ).resolves.toBeUndefined()
    expect(done.logs.some((line) => line.includes('treated as done'))).toBe(true)

    const failing = recordingFetch(() =>
      jsonResponse(500, {
        code: 'CODE_SYSTEM_ERROR',
        msg: "An error occurred on the server's end",
      }),
    )
    const { client } = harness(failing.fn)
    const err = await accessError(client.setEmergencyStatus({ lockdown: true, evacuation: false }))
    expect(err.kind).toBe('server')
    // `retryable` describes the kind; the client itself never sends the PUT twice.
    expect(failing.fn).toHaveBeenCalledTimes(1)
  })
})

describe('error mapping from the official reference (§2.2, §2.4)', () => {
  it('reports a door whose device is offline as a refusal of that door, with the console msg', async () => {
    // HTTP 402 is "request failed: valid parameters"; the code decides, not the status.
    const { client } = harness(
      fakeFetch(() =>
        jsonResponse(402, {
          code: 'CODE_DEVICE_DEVICE_OFFLINE',
          msg: 'The device is currently offline.',
        }),
      ),
    )
    const err = await accessError(client.unlock('d-1'))
    // `forbidden` is door-level in connection.ts (DOOR_LEVEL_UNLOCK_KINDS): the status stays green.
    expect(err.kind).toBe('forbidden')
    expect(err.status).toBe(402)
    expect(err.code).toBe('CODE_DEVICE_DEVICE_OFFLINE')
    expect(err.retryable).toBe(false)
    expect(err.message).toBe(
      'PUT /doors/d-1/unlock failed with HTTP 402 CODE_DEVICE_DEVICE_OFFLINE: The device is ' +
        'currently offline.',
    )
    // The Door Hub hint that goes with a bare refusal would point the wrong way here.
    expect(err.message).not.toContain('Door Hub')
  })

  it('falls back to the documented meaning when a device code arrives without msg', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(200, { code: 'CODE_DEVICE_DEVICE_VERSION_TOO_OLD' })),
    )
    const err = await accessError(client.unlock('d-1'))
    expect(err.kind).toBe('forbidden')
    expect(err.message).toContain('The firmware version is too old')
    expect(err.message).not.toContain('sent no message')
    expect(err.message).not.toContain('Door Hub')
  })

  it('shows the console msg for a console moved to Identity Enterprise, as a refusal', async () => {
    const msg = 'The API is not available after upgrading to Identity Enterprise'
    const { client } = harness(
      fakeFetch(() => jsonResponse(400, { code: 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED', msg })),
    )
    const err = await accessError(client.doors())
    expect(err.kind).toBe('forbidden')
    expect(err.kind).not.toBe('bad-request')
    expect(err.message).toBe(
      `GET /doors failed with HTTP 400 CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED: ${msg}.`,
    )
    // The kind is a door-level one, so callers tell this endpoint-level refusal apart by the code.
    expect(isAccessApiUnavailable(err)).toBe(true)
    expect(err.retryable).toBe(false)
    expect(err.message).not.toContain('token')
    expect(err.message).not.toContain('Door Hub')
  })

  it('falls back to the documented text for Identity Enterprise, still without token advice', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(400, { code: 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED' })),
    )
    const err = await accessError(client.unlock('d-1'))
    expect(isAccessApiUnavailable(err)).toBe(true)
    expect(err.message).toContain('The API is not available after upgrading to Identity Enterprise')
    expect(err.message).not.toContain('token')
    expect(err.message).not.toContain('Door Hub')
  })

  it('does not take any other refusal for an unavailable API', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(403, { code: 'CODE_OPERATION_FORBIDDEN', msg: 'no' })),
    )
    expect(isAccessApiUnavailable(await accessError(client.unlock('d-1')))).toBe(false)
    expect(isAccessApiUnavailable(new Error('x'))).toBe(false)
  })

  it('keeps the Door Hub hint for a bare CODE_OPERATION_FORBIDDEN, naming the scope', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(403, { code: 'CODE_OPERATION_FORBIDDEN', msg: 'not allowed' })),
    )
    const err = await accessError(client.unlock('d-1'))
    expect(err.kind).toBe('forbidden')
    expect(err.message).toContain('not allowed')
    expect(err.message).toContain('Door Hub')
    expect(err.message).toContain('edit:space')
  })

  it('treats a 402 without a known code as the console failing, not as a bad request', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(402, { code: 'CODE_SOMETHING_NEW', msg: 'request failed' })),
    )
    const err = await accessError(client.door('d-1'))
    expect(err.kind).toBe('server')
    expect(err.status).toBe(402)
    expect(err.message).toContain('request failed')
  })

  it('gives auth advice with the documented path and the scopes', async () => {
    const { client } = harness(
      fakeFetch(() => jsonResponse(401, { code: 'CODE_ACCESS_TOKEN_INVALID', msg: 'invalid' })),
    )
    const err = await accessError(client.doors())
    expect(err.message.endsWith(ACCESS_AUTH_ADVICE)).toBe(true)
    expect(ACCESS_AUTH_ADVICE).toContain('Access → Settings → General → Advanced → API Token')
    for (const scope of ['view:space', 'edit:space', 'view:device']) {
      expect(ACCESS_AUTH_ADVICE).toContain(scope)
    }
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

  it('classifies HTTP 402 ("request failed", §2.2) as server, never as bad-request', () => {
    expect(accessErrorKindForStatus(402)).toBe('server')
    expect(accessErrorKind(402, null)).toBe('server')
    expect(accessErrorKindForStatus(400)).toBe('bad-request')
    // A known code still outranks it.
    expect(accessErrorKind(402, 'CODE_DEVICE_DEVICE_OFFLINE')).toBe('forbidden')
    expect(accessErrorKind(402, 'CODE_PARAMS_INVALID')).toBe('bad-request')
  })

  it('maps the documented device codes onto door-level kinds (§2.4)', () => {
    // "The console answered; the fault is the door's": every one of these must be a kind in
    // connection.ts's DOOR_LEVEL_UNLOCK_KINDS (forbidden, not-found, bad-request).
    for (const status of [200, 400, 402, 500]) {
      expect(accessErrorKind(status, 'CODE_DEVICE_DEVICE_OFFLINE')).toBe('forbidden')
      expect(accessErrorKind(status, 'CODE_DEVICE_DEVICE_BUSY')).toBe('forbidden')
      expect(accessErrorKind(status, 'CODE_DEVICE_API_NOT_SUPPORTED')).toBe('forbidden')
      expect(accessErrorKind(status, 'CODE_DEVICE_DEVICE_VERSION_TOO_OLD')).toBe('forbidden')
      expect(accessErrorKind(status, 'CODE_DEVICE_DEVICE_NOT_FOUND')).toBe('not-found')
      expect(accessErrorKind(status, 'CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND')).toBe(
        'not-found',
      )
    }
  })

  it('maps Identity Enterprise to forbidden and CODE_SYSTEM_ERROR to server', () => {
    expect(accessErrorKind(400, 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED')).toBe('forbidden')
    expect(accessErrorKind(200, 'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED')).toBe('forbidden')
    expect(accessErrorKind(200, 'CODE_SYSTEM_ERROR')).toBe('server')
    expect(accessErrorKind(400, 'CODE_SYSTEM_ERROR')).toBe('server')
  })

  it('gives every code in ACCESS_ERROR_CODES a kind of its own, not the status fallback', () => {
    // 418 falls back to bad-request and 200 to server, so a code that is mapped answers the same
    // for both, and one that is missing from the table does not.
    for (const code of ACCESS_ERROR_CODES) {
      expect(accessErrorKind(418, code), code).toBe(accessErrorKind(200, code))
    }
    for (const code of [
      'CODE_SYSTEM_ERROR',
      'CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND',
      'CODE_DEVICE_DEVICE_NOT_FOUND',
      'CODE_DEVICE_DEVICE_OFFLINE',
      'CODE_DEVICE_DEVICE_BUSY',
      'CODE_DEVICE_API_NOT_SUPPORTED',
      'CODE_DEVICE_DEVICE_VERSION_TOO_OLD',
    ]) {
      expect(ACCESS_ERROR_CODES).toContain(code)
    }
  })
})
