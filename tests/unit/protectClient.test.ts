// P1.3: the Protect Integration API REST client (src/main/protect/client.ts).
//
// Everything here runs on an injected `fetch` and an injected clock, so no test touches a network,
// a timer or a real console: the rate limiter gets the fake clock's `now`/`sleep` (its own unit
// tests cover the limiter itself), and the fake `fetch` records the clock reading of every call,
// which is how the R9 spacing and the 429 retry delay are asserted instead of waited out.
//
// The response bodies are the sanitized P0.3 fixtures wherever one exists, so a contract or
// console change shows up here rather than in Settings (CON-4) or the camera list (CAM-1).
import { Agent, Headers, Response, type Dispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import { ConsoleConfigSchema, type Camera } from '../../src/shared/models'
import { protectEndpoint } from '../../src/main/console/endpoints'
import {
  DEFAULT_MIN_GAP_MS,
  createRateLimiter,
  type RateLimiter,
} from '../../src/main/net/rateLimiter'
import { ProtectApiError } from '../../src/main/protect/errors'
import { PinMismatchError, PinRequiredError } from '../../src/main/tls/pinning'
import {
  createProtectClient,
  toCamera,
  type ProtectClient,
  type ProtectClientOptions,
} from '../../src/main/protect/client'
import camerasFixture from '../fixtures/protect/cameras.json'
import metaInfoFixture from '../fixtures/protect/meta-info.json'
import rtspsGetFixture from '../fixtures/protect/rtsps-stream.get.json'
import rtspsPostFixture from '../fixtures/protect/rtsps-stream.post.json'

/** Distinctive on purpose: several tests assert it appears in no log line and no message. */
const API_KEY = 'vp-test-api-key-NEVER-LOG-THIS'

const ENDPOINT = protectEndpoint(ConsoleConfigSchema.parse({ host: 'console.invalid' }))
const BASE = ENDPOINT.baseUrl

/** `name` of the console's 429 body (P0.3 §7), with the window and limit it really sends. */
const RATE_LIMIT_BODY = {
  error: 'Too many requests',
  name: 'TOO_MANY_REQUESTS_ERROR',
  windowMs: 1000,
  limit: 10,
}

/** The headers every response carries (P0.3 §7). `pk` must never survive into a log line. */
const RATE_LIMIT_HEADERS = {
  ratelimit: '"10-in-1sec"; r=7; t=1',
  'ratelimit-policy': '"10-in-1sec"; q=10; w=1; pk=:c2VjcmV0LXBrLXZhbHVl:',
}

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string | null
  /** The fake clock reading when the request was sent. */
  readonly at: number
}

type Handler = (call: Call, index: number) => Response

/** A clock whose `sleep` is the only thing that moves it, so waiting is instant and exact. */
function createClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let now = 0
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms
      return Promise.resolve()
    },
  }
}

interface HarnessOptions {
  /** `undefined` means "use the test key"; `null` and `''` are the CON-1 unset cases. */
  readonly apiKey?: string | null
  readonly maxRateLimitRetries?: number
  /** Throws instead of returning the pinned Agent, as `agentFor` does for an unpinned host. */
  readonly dispatcherError?: Error
}

interface Harness {
  readonly client: ProtectClient
  readonly calls: Call[]
  readonly logs: string[]
  readonly limiter: RateLimiter
  readonly now: () => number
  /** How often the client asked for the pinned dispatcher (once per attempt). */
  readonly dispatcherReads: () => number
}

function harness(handler: Handler, options: HarnessOptions = {}): Harness {
  const clock = createClock()
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
  const agent = new Agent()
  const calls: Call[] = []
  const logs: string[] = []
  let dispatcherReads = 0

  const fetchImpl: ProtectClientOptions['fetchImpl'] = (input, init) => {
    const call: Call = {
      // The client only ever passes a string; the other two forms keep `typeof fetch` satisfied.
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
      at: clock.now(),
    }
    calls.push(call)
    return Promise.resolve(handler(call, calls.length - 1))
  }

  const dispatcher = (): Dispatcher => {
    dispatcherReads += 1
    if (options.dispatcherError !== undefined) throw options.dispatcherError
    return agent
  }

  const client = createProtectClient({
    endpoint: ENDPOINT,
    apiKey: () => (options.apiKey === undefined ? API_KEY : options.apiKey),
    dispatcher,
    limiter,
    fetchImpl,
    log: (line) => logs.push(line),
    ...(options.maxRateLimitRetries === undefined
      ? {}
      : { maxRateLimitRetries: options.maxRateLimitRetries }),
  })

  return {
    client,
    calls,
    logs,
    limiter,
    now: clock.now,
    dispatcherReads: () => dispatcherReads,
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function jpeg(): Response {
  return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
}

function callAt(calls: readonly Call[], index: number): Call {
  const call = calls[index]
  if (call === undefined) throw new Error(`there was no request #${String(index)}`)
  return call
}

/** Awaits a call that must fail with a `ProtectApiError`, and hands the error back. */
async function failure(promise: Promise<unknown>): Promise<ProtectApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ProtectApiError) return err
    throw err
  }
  throw new Error('expected the call to fail with a ProtectApiError')
}

/** A timeout as `AbortSignal.timeout` reports it: `protectErrorFromThrown` reads `name`. */
class FakeTimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

function cameraById(cameras: readonly Camera[], id: string): Camera {
  const found = cameras.find((camera) => camera.id === id)
  if (found === undefined) throw new Error(`camera ${id} is missing from the mapped list`)
  return found
}

describe('createProtectClient: request shape', () => {
  it('sends X-API-KEY to the contract path under the endpoint base URL', async () => {
    const h = harness(() => json(metaInfoFixture, 200, RATE_LIMIT_HEADERS))

    await expect(h.client.metaInfo()).resolves.toEqual({ applicationVersion: '7.3.74' })

    const call = callAt(h.calls, 0)
    expect(call.url).toBe(`${BASE}/v1/meta/info`)
    expect(call.url.startsWith('https://console.invalid/proxy/protect/integration/v1/')).toBe(true)
    expect(call.method).toBe('GET')
    expect(call.headers.get('x-api-key')).toBe(API_KEY)
    // CON-3: the pinned dispatcher is read per request, so a repin applies to the next call.
    expect(h.dispatcherReads()).toBe(1)
  })

  it('appends the camera id to the contract path, encoded', async () => {
    const h = harness(() => json(camerasFixture[0]))

    await h.client.camera('cam 001/../x')

    expect(callAt(h.calls, 0).url).toBe(`${BASE}/v1/cameras/cam%20001%2F..%2Fx`)
  })

  it('fails with kind "auth" and sends nothing when no key is configured (CON-1)', async () => {
    for (const apiKey of [null, '']) {
      const h = harness(() => json(metaInfoFixture), { apiKey })

      const err = await failure(h.client.metaInfo())

      expect(err.kind).toBe('auth')
      expect(h.calls).toHaveLength(0)
      expect(h.dispatcherReads()).toBe(0)
    }
  })

  it('reports an unpinned endpoint as kind "pin" (CON-3), without sending', async () => {
    const h = harness(() => json(metaInfoFixture), {
      dispatcherError: new PinRequiredError('console.invalid:443'),
    })

    const err = await failure(h.client.metaInfo())

    expect(err.kind).toBe('pin')
    expect(h.calls).toHaveLength(0)
  })
})

describe('createProtectClient: cameras', () => {
  it('maps the P0.3 fixture onto the trimmed Camera shape (CAM-1)', async () => {
    const h = harness(() => json(camerasFixture))

    const cameras = await h.client.cameras()

    expect(callAt(h.calls, 0).url).toBe(`${BASE}/v1/cameras`)
    expect(cameras).toHaveLength(camerasFixture.length)
    expect(cameras[0]).toEqual({
      id: 'cam-001',
      name: 'Shop',
      model: 'UVC G3 Instant',
      state: 'CONNECTED',
      hasMic: true,
      micEnabled: true,
      hasSpeaker: true,
      smartDetectTypes: [],
      supportsFullHdSnapshot: false,
      hasPackageCamera: false,
    })
    // The G4 Bullet is the one camera with full-HD snapshots and the smart-detect types (P0.3 §2).
    const bullet = cameraById(cameras, 'cam-006')
    expect(bullet.supportsFullHdSnapshot).toBe(true)
    expect(bullet.hasSpeaker).toBe(false)
    expect(bullet.smartDetectTypes).toEqual(['person', 'vehicle', 'animal'])
    // Nothing wire-shaped leaks through: no `featureFlags`, no `mac`, no `lcdMessage`.
    expect(Object.keys(bullet).sort()).toEqual(Object.keys(cameras[0] ?? {}).sort())
  })

  it('maps GET /v1/cameras/{id} the same way', async () => {
    const h = harness(() => json(camerasFixture[5]))

    const camera = await h.client.camera('cam-006')

    expect(callAt(h.calls, 0).url).toBe(`${BASE}/v1/cameras/cam-006`)
    expect(camera.id).toBe('cam-006')
    expect(camera.supportsFullHdSnapshot).toBe(true)
  })

  it('keeps a camera with a surprising payload (R8/R11)', () => {
    // No featureFlags, no lcdMessage (the P0.3 drift), a null name and a state the contract does
    // not list: all of it survives as defaults, and the state is kept verbatim, never an enum.
    expect(
      toCamera({ id: 'cam-x', name: null, type: 'UVC G9 Imaginary', state: 'REBOOTING' }),
    ).toEqual({
      id: 'cam-x',
      name: null,
      model: 'UVC G9 Imaginary',
      state: 'REBOOTING',
      hasMic: false,
      micEnabled: false,
      hasSpeaker: false,
      smartDetectTypes: [],
      supportsFullHdSnapshot: false,
      hasPackageCamera: false,
    })
  })

  it('drops only the unusable members of a camera payload', () => {
    const camera = toCamera({
      id: 'cam-y',
      name: 42,
      state: 'CONNECTED',
      isMicEnabled: 'yes',
      hasPackageCamera: true,
      featureFlags: { hasMic: true, smartDetectTypes: ['person', '', 7, 'animal'] },
    })

    expect(camera.name).toBeNull()
    expect(camera.micEnabled).toBe(false)
    expect(camera.hasMic).toBe(true)
    expect(camera.hasPackageCamera).toBe(true)
    expect(camera.smartDetectTypes).toEqual(['person', 'animal'])
  })

  it('throws for a camera with no usable id', () => {
    for (const raw of [{}, { id: '' }, { id: 7 }, null, 'nonsense']) {
      const err = (() => {
        try {
          toCamera(raw)
          return null
        } catch (caught) {
          return caught
        }
      })()
      expect(err).toBeInstanceOf(ProtectApiError)
      expect(err instanceof ProtectApiError ? err.kind : null).toBe('invalid-response')
    }
  })

  it('skips an item with no id, keeps the rest, and reports the count (CAM-1, R8)', async () => {
    const h = harness(() =>
      json([camerasFixture[0], { name: 'No id here' }, camerasFixture[1], 'not an object']),
    )

    const cameras = await h.client.cameras()

    expect(cameras.map((camera) => camera.id)).toEqual(['cam-001', 'cam-002'])
    expect(h.logs.some((line) => line.includes('skipped 2 of 4 items with no usable id'))).toBe(
      true,
    )
  })

  it('fails with invalid-response when the body is not an array', async () => {
    const h = harness(() => json({ cameras: [] }))

    expect((await failure(h.client.cameras())).kind).toBe('invalid-response')
  })
})

describe('createProtectClient: error mapping', () => {
  const cases = [
    { status: 401, name: 'UNAUTHORIZED', error: 'Unauthorized', kind: 'auth' },
    { status: 403, name: 'FORBIDDEN', error: 'Forbidden', kind: 'auth' },
    { status: 404, name: 'NOT_FOUND', error: 'Camera not found', kind: 'not-found' },
    {
      status: 400,
      name: 'BAD_REQUEST',
      error: 'Camera does not support full HD snapshot',
      kind: 'bad-request',
    },
    { status: 503, name: 'SERVICE_UNAVAILABLE', error: 'Camera is offline', kind: 'unavailable' },
    { status: 500, name: 'API_ERROR', error: 'Unexpected API error occurred', kind: 'server' },
  ] as const

  it.each(cases)('maps $status to kind $kind with the body name', async (expected) => {
    const h = harness(() =>
      json({ error: expected.error, name: expected.name }, expected.status, RATE_LIMIT_HEADERS),
    )

    const err = await failure(h.client.cameras())

    expect(err.kind).toBe(expected.kind)
    expect(err.status).toBe(expected.status)
    expect(err.apiName).toBe(expected.name)
    expect(err.message).toContain(expected.error)
    expect(err.message).toContain(expected.name)
    expect(err.endpoint).toBe('console.invalid:443')
    // The log line carries the status and the console's code, and the filtered headers only.
    expect(h.logs).toHaveLength(1)
    expect(callAt(h.calls, 0).method).toBe('GET')
    expect(h.logs[0]).toContain(String(expected.status))
    expect(h.logs[0]).toContain(expected.name)
  })

  it('still produces a usable error when the body is not the documented shape', async () => {
    const h = harness(() => new Response('<html>502</html>', { status: 502 }))

    const err = await failure(h.client.metaInfo())

    expect(err.kind).toBe('server')
    expect(err.status).toBe(502)
    expect(err.apiName).toBeNull()
    expect(err.message).toContain('HTTP 502')
    // The body is never quoted back: an rtsps-stream body would be a credential (CON-2).
    expect(err.message).not.toContain('<html>')
  })

  it('maps a pin mismatch out of fetch’s TypeError.cause to kind "pin"', async () => {
    const mismatch = new PinMismatchError({
      endpoint: 'console.invalid:443',
      expected: 'AA:BB:CC',
      actual: 'DD:EE:FF',
    })
    const h = harness(() => {
      throw new TypeError('fetch failed', { cause: mismatch })
    })

    const err = await failure(h.client.cameras())

    expect(err.kind).toBe('pin')
    expect(err.message).toBe(mismatch.message)
  })

  it('maps a timed-out request to kind "timeout"', async () => {
    const h = harness(() => {
      throw new FakeTimeoutError('The operation was aborted due to timeout')
    })

    const err = await failure(h.client.metaInfo())

    expect(err.kind).toBe('timeout')
    expect(err.message).toContain('did not answer in time')
  })

  it('maps a connection failure to kind "network"', async () => {
    const h = harness(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      })
    })

    const err = await failure(h.client.metaInfo())

    expect(err.kind).toBe('network')
    expect(err.message).toContain('ECONNREFUSED')
  })

  it('treats a 2xx that is not JSON, or not an object, as invalid-response', async () => {
    const notJson = harness(() => new Response('definitely not json', { status: 200 }))
    expect((await failure(notJson.client.metaInfo())).kind).toBe('invalid-response')

    const notObject = harness(() => json(7))
    expect((await failure(notObject.client.metaInfo())).kind).toBe('invalid-response')

    const noVersion = harness(() => json({}))
    const err = await failure(noVersion.client.metaInfo())
    expect(err.kind).toBe('invalid-response')
    expect(err.message).toContain('applicationVersion')
  })
})

describe('createProtectClient: rate limiting (R9)', () => {
  it('spaces consecutive requests with the shared limiter', async () => {
    const h = harness(() => json(metaInfoFixture))

    await h.client.metaInfo()
    await h.client.metaInfo()
    await h.client.metaInfo()

    expect(h.calls.map((call) => call.at)).toEqual([0, DEFAULT_MIN_GAP_MS, DEFAULT_MIN_GAP_MS * 2])
  })

  it('penalizes the limiter and retries a GET after windowMs', async () => {
    const h = harness((_call, index) =>
      index === 0
        ? json(RATE_LIMIT_BODY, 429, RATE_LIMIT_HEADERS)
        : json(camerasFixture, 200, RATE_LIMIT_HEADERS),
    )
    const penalize = vi.spyOn(h.limiter, 'penalize')

    const cameras = await h.client.cameras()

    expect(cameras).toHaveLength(camerasFixture.length)
    expect(penalize).toHaveBeenCalledWith(1000)
    // The penalty is what makes the retry wait: it lands exactly one window later.
    expect(h.calls.map((call) => call.at)).toEqual([0, 1000])
  })

  it('gives up on a GET that stays rate limited, with retryAfterMs set', async () => {
    const h = harness(() => json(RATE_LIMIT_BODY, 429, RATE_LIMIT_HEADERS), {
      maxRateLimitRetries: 2,
    })
    const penalize = vi.spyOn(h.limiter, 'penalize')

    const err = await failure(h.client.cameras())

    expect(err.kind).toBe('rate-limit')
    expect(err.status).toBe(429)
    expect(err.apiName).toBe('TOO_MANY_REQUESTS_ERROR')
    expect(err.retryAfterMs).toBe(1000)
    expect(err.retryable).toBe(true)
    // One attempt plus two retries, each spending a permit and each penalizing the limiter.
    expect(h.calls).toHaveLength(3)
    expect(penalize).toHaveBeenCalledTimes(3)
    expect(h.calls.map((call) => call.at)).toEqual([0, 1000, 2000])
  })

  it('never retries a rate-limited POST (P0.3: the caller re-GETs and decides)', async () => {
    const h = harness(() => json(RATE_LIMIT_BODY, 429, RATE_LIMIT_HEADERS))
    const penalize = vi.spyOn(h.limiter, 'penalize')

    const err = await failure(h.client.createRtspsStreams('cam-004', ['high']))

    expect(err.kind).toBe('rate-limit')
    expect(err.retryAfterMs).toBe(1000)
    expect(h.calls).toHaveLength(1)
    expect(callAt(h.calls, 0).method).toBe('POST')
    // The budget is still protected for whatever runs next (R9).
    expect(penalize).toHaveBeenCalledWith(1000)
  })

  it('defaults a 429 with no windowMs to one window', async () => {
    const h = harness(
      () => json({ error: 'Too many requests', name: 'TOO_MANY_REQUESTS_ERROR' }, 429),
      {
        maxRateLimitRetries: 0,
      },
    )

    expect((await failure(h.client.cameras())).retryAfterMs).toBe(1000)
  })
})

describe('createProtectClient: snapshot', () => {
  it('returns the bytes and the content type, and sends no query by default', async () => {
    const h = harness(() => jpeg())

    const snapshot = await h.client.snapshot('cam-004')

    expect(callAt(h.calls, 0).url).toBe(`${BASE}/v1/cameras/cam-004/snapshot`)
    expect(snapshot.contentType).toBe('image/jpeg')
    expect([...snapshot.bytes]).toEqual([...JPEG])
  })

  it('sends only the query parameters the caller asked for', async () => {
    const h = harness(() => jpeg())

    await h.client.snapshot('cam-006', { highQuality: true })
    await h.client.snapshot('cam-004', { highQuality: false })
    await h.client.snapshot('cam-010', { channel: 'package' })
    await h.client.snapshot('cam-006', { highQuality: true, channel: 'main' })

    expect(h.calls.map((call) => call.url.slice(`${BASE}/v1/cameras/`.length))).toEqual([
      'cam-006/snapshot?highQuality=true',
      'cam-004/snapshot?highQuality=false',
      'cam-010/snapshot?channel=package',
      'cam-006/snapshot?highQuality=true&channel=main',
    ])
  })

  it('surfaces the full-HD 400 instead of retrying without highQuality (P0.3 §4)', async () => {
    const h = harness(() =>
      json({ error: 'Camera does not support full HD snapshot', name: 'BAD_REQUEST' }, 400),
    )

    const err = await failure(h.client.snapshot('cam-004', { highQuality: true }))

    expect(err.kind).toBe('bad-request')
    expect(err.message).toContain('full HD snapshot')
    expect(h.calls).toHaveLength(1)
  })

  it('treats a 2xx that is not an image as invalid-response', async () => {
    const h = harness(() => json({ error: 'surprise' }))

    const err = await failure(h.client.snapshot('cam-004'))

    expect(err.kind).toBe('invalid-response')
    expect(err.message).toContain('application/json')
  })
})

describe('createProtectClient: rtsps-stream (QUAL-8)', () => {
  it('returns the GET fixture, with a null for every missing quality', async () => {
    const h = harness(() => json(rtspsGetFixture))

    const streams = await h.client.rtspsStreams('cam-004')

    expect(callAt(h.calls, 0).url).toBe(`${BASE}/v1/cameras/cam-004/rtsps-stream`)
    expect(streams).toEqual(rtspsGetFixture)
    expect(streams.package).toBeNull()
  })

  it('posts the requested qualities and returns only those (P0.3 §3)', async () => {
    const h = harness(() => json(rtspsPostFixture.response))

    const created = await h.client.createRtspsStreams('cam-004', ['high', 'low'])

    const call = callAt(h.calls, 0)
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.body).toBe(JSON.stringify(rtspsPostFixture.request))
    expect(created).toEqual(rtspsPostFixture.response)
    expect(Object.keys(created)).toEqual(['high', 'low'])
  })

  it('refuses an empty quality list without spending a permit (contract minItems: 1)', async () => {
    const h = harness(() => json({}))

    const err = await failure(h.client.createRtspsStreams('cam-004', []))

    expect(err.kind).toBe('bad-request')
    expect(h.calls).toHaveLength(0)
  })

  it('keeps a quality the console reports oddly out of the result (R8)', async () => {
    const h = harness(() => json({ high: 'rtsps://console.invalid:7441/abc?enableSrtp', low: 7 }))

    expect(await h.client.rtspsStreams('cam-004')).toEqual({
      high: 'rtsps://console.invalid:7441/abc?enableSrtp',
    })
  })
})

describe('createProtectClient: logging is safe (CON-2, R5, NFR-9)', () => {
  it('keeps the rate-limit policy name and drops the pk partition key', async () => {
    const h = harness(() => json(metaInfoFixture, 200, RATE_LIMIT_HEADERS))

    await h.client.metaInfo()

    expect(h.logs).toHaveLength(1)
    const line = h.logs[0] ?? ''
    expect(line).toContain('GET /v1/meta/info -> 200')
    expect(line).toContain('ratelimit: "10-in-1sec"; r=7; t=1')
    expect(line).toContain('ratelimit-policy: "10-in-1sec"; q=10; w=1')
    expect(line).not.toContain('pk')
    expect(line).not.toContain('c2VjcmV0LXBrLXZhbHVl')
  })

  it('never puts the API key, a body or a camera id in a log line or a message', async () => {
    const h = harness((_call, index) =>
      index % 2 === 0
        ? json(rtspsGetFixture, 200, RATE_LIMIT_HEADERS)
        : json({ error: 'Unauthorized', name: 'UNAUTHORIZED' }, 401, RATE_LIMIT_HEADERS),
    )

    const streams = await h.client.rtspsStreams('cam-004')
    const err = await failure(h.client.rtspsStreams('cam-004'))
    const messages = [...h.logs, err.message]

    // The RTSPS URLs came back to the caller but never reached a log line: they are credentials.
    expect(streams.high).toBe(rtspsGetFixture.high)
    for (const message of messages) {
      expect(message).not.toContain(API_KEY)
      expect(message).not.toContain('rtsps://')
      expect(message).not.toContain('cam-004')
    }
    // The contract path template is what is logged instead.
    expect(h.logs.every((line) => line.startsWith('GET /v1/cameras/{id}/rtsps-stream'))).toBe(true)
    expect(err.kind).toBe('auth')
  })
})
