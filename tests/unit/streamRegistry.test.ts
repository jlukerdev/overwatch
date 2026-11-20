// P2.2: the stream registry (src/main/streams/registry.ts) — QUAL-8, CAM-4, CON-2/NFR-9, R4, R9,
// NFR-6, SPEC §5.1/§6.1.
//
// Everything runs on fakes: a Protect client that counts its GETs and POSTs, a go2rtc manager that
// records the streams it was asked to register, a fixed inventory and a recorded log. So no test
// talks to a console, spawns go2rtc or touches Electron, and the five things that would actually
// hurt are asserted directly:
//
//  - the **request budget** (R9, NFR-6): one GET per camera/quality for the session, one POST only
//    for a quality that does not exist yet, and ten concurrent calls for one stream make **one**
//    GET rather than ten;
//  - **nothing is ever deleted** and `invalidate()` does not tear a registered stream down, because
//    Protect streams may be shared with other integrations and a playing cell must not blink;
//  - the **RTSPS URL never leaves main** (CON-2, NFR-9): not in a handle, not in an error message,
//    not in a log line — asserted against the alias of every fake URL in the file;
//  - **R4**: a source that is not on the pinned console host is refused before go2rtc sees it;
//  - the handle always describes the runtime that is up **now** (port + epoch), and `gateway-down`
//    is what the caller gets when go2rtc cannot be started at all.
import { StreamHandleSchema, type StreamHandle } from '@shared/streams'
import type { StreamQuality } from '@shared/quality'
import type { RtspStreamUrls } from '@shared/rtsp'
import type { Camera } from '@shared/models'
import { CameraSchema } from '@shared/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectApiError } from '../../src/main/protect/errors'
import {
  StreamRegistryError,
  createStreamRegistry,
  type StreamRegistry,
} from '../../src/main/streams/registry'

const HOST = '192.0.2.10'
const OTHER_HOST = 'attacker.example'

/** The 16-character alias of a Protect RTSPS URL **is** the stream's credential (SPEC §5.1). */
const ALIASES = {
  high: 'aaaaBBBBccccDDDD',
  medium: 'eeeeFFFFggggHHHH',
  low: 'iiiiJJJJkkkkLLLL',
  package: 'mmmmNNNNooooPPPP',
} as const

function rtspsUrl(alias: string, host = HOST): string {
  return `rtsps://${host}:7441/${alias}?enableSrtp`
}

const PORT = 18555
const EPOCH = 2

// --- fakes --------------------------------------------------------------------------------------

/** The two `rtsps-stream` calls, with per-quality state and a counter each. */
function createFakeProtect(initial: Partial<Record<StreamQuality, string>> = { low: ALIASES.low }) {
  const aliases = new Map<StreamQuality, string>(
    Object.entries(initial) as [StreamQuality, string][],
  )
  /** A quality the POST refuses to report back, for the "200 without the quality" case. */
  let withholdFromPost: StreamQuality | null = null
  let host = HOST

  const rtspsStreams = vi.fn(() =>
    Promise.resolve({
      high: aliases.has('high') ? rtspsUrl(aliases.get('high') ?? '', host) : null,
      medium: aliases.has('medium') ? rtspsUrl(aliases.get('medium') ?? '', host) : null,
      low: aliases.has('low') ? rtspsUrl(aliases.get('low') ?? '', host) : null,
      package: aliases.has('package') ? rtspsUrl(aliases.get('package') ?? '', host) : null,
    }),
  )

  const createRtspsStreams = vi.fn((_id: string, qualities: readonly StreamQuality[]) => {
    const out: Partial<Record<StreamQuality, string>> = {}
    // The console returns **only** the qualities that were requested (SPEC §5.1, P0.3 §3).
    for (const quality of qualities) {
      aliases.set(quality, ALIASES[quality])
      if (quality !== withholdFromPost) out[quality] = rtspsUrl(ALIASES[quality], host)
    }
    return Promise.resolve(out)
  })

  return {
    client: { rtspsStreams, createRtspsStreams },
    rtspsStreams,
    createRtspsStreams,
    withhold(quality: StreamQuality): void {
      withholdFromPost = quality
    },
    /** The console starts handing out URLs for a different host (R4). */
    answerForHost(next: string): void {
      host = next
    },
  }
}

/** The slice of the P2.1 manager the registry uses, plus the calls it must never make. */
function createFakeManager() {
  const registered = new Map<string, string>()
  let runtime: { port: number; epoch: number } | null = { port: PORT, epoch: EPOCH }
  let startError: Error | null = null
  let addError: Error | null = null

  const start = vi.fn(() => {
    if (startError !== null) return Promise.reject(startError)
    runtime ??= { port: PORT, epoch: EPOCH }
    return Promise.resolve(runtime)
  })
  const addStream = vi.fn((name: string, source: string) => {
    if (addError !== null) return Promise.reject(addError)
    registered.set(name, source)
    return Promise.resolve()
  })
  /**
   * Never used to refresh a URL: the app never deletes or stops anything for that. Only a switch to
   * RTSP mode (`unregisterAll`, MODE-4) removes streams.
   */
  const removeStream = vi.fn((name: string) => {
    registered.delete(name)
    return Promise.resolve(true)
  })
  const stop = vi.fn(() => Promise.resolve())

  return {
    manager: {
      start,
      runtime: () => runtime,
      addStream,
      removeStream,
      stop,
      streams: () => Object.fromEntries(registered),
    },
    start,
    addStream,
    removeStream,
    stop,
    registered,
    /** A restart: a new epoch on a new port, as P2.1 produces. */
    restartOn(port: number, epoch: number): void {
      runtime = { port, epoch }
    },
    failStart(error: Error): void {
      startError = error
    },
    failAdd(error: Error): void {
      addError = error
    },
  }
}

function camera(id: string, extra: Partial<Camera> = {}): Camera {
  return CameraSchema.parse({ id, ...extra })
}

interface Harness {
  readonly registry: StreamRegistry
  readonly protect: ReturnType<typeof createFakeProtect>
  readonly go2rtc: ReturnType<typeof createFakeManager>
  readonly lines: string[]
  setCameras(next: readonly Camera[]): void
  setHost(next: string | null): void
  /** MODE-4: the app mode the registry is told about. */
  setProtectMode(next: boolean): void
  /** RTSP-3: the configured streams (`config.rtsp.streams`). */
  setRtspStreams(next: readonly { id: string; name: string }[]): void
  /** RTSP-2: the decrypted URLs main holds (`credentials.rtspUrls`). */
  setRtspUrls(next: Record<string, RtspStreamUrls> | undefined): void
}

function setup(
  options: {
    readonly cameras?: readonly Camera[]
    readonly existing?: Partial<Record<StreamQuality, string>>
  } = {},
): Harness {
  const protect = createFakeProtect(options.existing)
  const go2rtc = createFakeManager()
  const lines: string[] = []
  let cameras: readonly Camera[] = options.cameras ?? [camera('cam-1')]
  let host: string | null = HOST
  let protectMode = true
  let rtspStreams: readonly { id: string; name: string }[] = []
  let rtspUrls: Record<string, RtspStreamUrls> | undefined

  const registry = createStreamRegistry({
    manager: go2rtc.manager,
    protect: () => protect.client,
    cameras: () => cameras,
    consoleHost: () => host,
    protectMode: () => protectMode,
    rtspStreams: () => rtspStreams,
    rtspUrls: () => rtspUrls,
    log: (line) => lines.push(line),
  })

  return {
    registry,
    protect,
    go2rtc,
    lines,
    setCameras(next) {
      cameras = next
    },
    setHost(next) {
      host = next
    },
    setProtectMode(next) {
      protectMode = next
    },
    setRtspStreams(next) {
      rtspStreams = next
    },
    setRtspUrls(next) {
      rtspUrls = next
    },
  }
}

/** The error of a rejected `ensureStream`, as a `StreamRegistryError`. */
async function refusal(promise: Promise<unknown>): Promise<StreamRegistryError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof StreamRegistryError) return err
    throw new Error(`expected a StreamRegistryError, got ${String(err)}`, { cause: err })
  }
  throw new Error('expected a refusal')
}

/**
 * The one rule that holds for every test in this file: no alias and no RTSPS URL may appear in
 * anything the registry hands out or writes down (CON-2, NFR-9, SPEC §6.1).
 */
function expectNoSecret(h: Harness, ...values: unknown[]): void {
  const text = [...values.map((v) => JSON.stringify(v)), ...h.lines].join('\n')
  for (const alias of Object.values(ALIASES)) expect(text).not.toContain(alias)
  expect(text).not.toContain('rtsps://')
  expect(text).not.toContain('rtspx://')
  expect(text).not.toContain('enableSrtp')
}

let h: Harness

beforeEach(() => {
  h = setup()
})

describe('ensureStream: reading the Protect URL (QUAL-8)', () => {
  it('uses the quality the GET already has, and never POSTs for it', async () => {
    const handle = await h.registry.ensureStream('cam-1', 'low')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)
    expect(h.protect.rtspsStreams).toHaveBeenCalledWith('cam-1')
    expect(h.protect.createRtspsStreams).not.toHaveBeenCalled()
    // The transform of SPEC §5.3: `rtspx://`, `?enableSrtp` stripped, host and path kept.
    expect(h.go2rtc.registered.get('cam-1_low')).toBe(`rtspx://${HOST}:7441/${ALIASES.low}`)
    expect(handle.name).toBe('cam-1_low')
  })

  it('POSTs only the missing quality and takes the URL from the POST response', async () => {
    const handle = await h.registry.ensureStream('cam-1', 'high')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)
    expect(h.protect.createRtspsStreams).toHaveBeenCalledTimes(1)
    // Only the one quality that is missing: the other qualities stay as they are, and the app never
    // DELETEs (SPEC §5.1, R2).
    expect(h.protect.createRtspsStreams).toHaveBeenCalledWith('cam-1', ['high'])
    expect(h.go2rtc.registered.get('cam-1_high')).toBe(`rtspx://${HOST}:7441/${ALIASES.high}`)
    expect(handle.quality).toBe('high')
  })

  it('reports a POST that answers without the quality instead of POSTing again', async () => {
    h.protect.withhold('high')

    const error = await refusal(h.registry.ensureStream('cam-1', 'high'))

    expect(error.kind).toBe('invalid-response')
    // A rate-limited or half-applied POST is never repeated blindly (R9, SPEC §5.1).
    expect(h.protect.createRtspsStreams).toHaveBeenCalledTimes(1)
    expect(h.go2rtc.addStream).not.toHaveBeenCalled()
    expectNoSecret(h, error.message)
  })

  it('lets a Protect failure through with its own kind, unwrapped', async () => {
    const apiError = new ProtectApiError('The console refused the API key.', {
      kind: 'auth',
      endpoint: `${HOST}:443`,
    })
    h.protect.rtspsStreams.mockRejectedValueOnce(apiError)

    await expect(h.registry.ensureStream('cam-1', 'low')).rejects.toBe(apiError)
  })
})

describe('ensureStream: the session cache (SPEC §5.1, R9)', () => {
  it('reads the URL once per camera/quality and reuses it', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    await h.registry.ensureStream('cam-1', 'low')
    await h.registry.ensureStream('cam-1', 'low')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)
    // Still re-registered every time: `addStream` is idempotent and cheap, and it is what keeps the
    // desired set correct after a restart (P2.1).
    expect(h.go2rtc.addStream).toHaveBeenCalledTimes(3)
  })

  it('caches per quality, not per camera', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    await h.registry.ensureStream('cam-1', 'medium')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
    expect(h.protect.createRtspsStreams).toHaveBeenCalledWith('cam-1', ['medium'])
  })

  it('coalesces concurrent calls for one stream into a single GET (R9, NFR-6)', async () => {
    // Ten cells on one camera at startup, i.e. the 4×4 View opening case.
    const handles = await Promise.all(
      Array.from({ length: 10 }, () => h.registry.ensureStream('cam-1', 'low')),
    )

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)
    expect(h.go2rtc.addStream).toHaveBeenCalledTimes(1)
    // One promise, so one handle value for all ten callers.
    expect(new Set(handles.map((handle) => handle.wsUrl)).size).toBe(1)
  })

  it('does not coalesce two different streams', async () => {
    await Promise.all([
      h.registry.ensureStream('cam-1', 'low'),
      h.registry.ensureStream('cam-1', 'high'),
    ])

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
    expect([...h.go2rtc.registered.keys()].sort()).toEqual(['cam-1_high', 'cam-1_low'])
  })

  it('lets the next call retry after a failed one rather than caching the failure', async () => {
    h.protect.rtspsStreams.mockRejectedValueOnce(new Error('the console hung up'))

    await expect(h.registry.ensureStream('cam-1', 'low')).rejects.toThrow('the console hung up')
    await h.registry.ensureStream('cam-1', 'low')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
  })
})

describe('invalidate (QUAL-8 "refresh on camera changes")', () => {
  it('forces the next call to re-read, without touching the registered stream', async () => {
    const before = await h.registry.ensureStream('cam-1', 'low')

    h.registry.invalidate()
    const after = await h.registry.ensureStream('cam-1', 'low')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
    // Nothing was torn down: no stream removed, no sidecar stopped, and the handle is unchanged, so
    // a playing cell keeps playing (the renderer only re-attaches on a new epoch).
    expect(h.go2rtc.removeStream).not.toHaveBeenCalled()
    expect(h.go2rtc.stop).not.toHaveBeenCalled()
    expect(h.go2rtc.registered.get('cam-1_low')).toBe(`rtspx://${HOST}:7441/${ALIASES.low}`)
    expect(after).toEqual(before)
  })

  it('drops one camera only when it is named', async () => {
    h.setCameras([camera('cam-1'), camera('cam-2')])
    await h.registry.ensureStream('cam-1', 'low')
    await h.registry.ensureStream('cam-2', 'low')
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)

    h.registry.invalidate('cam-2')
    await h.registry.ensureStream('cam-1', 'low')
    await h.registry.ensureStream('cam-2', 'low')

    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(3)
  })

  it('writes nothing about a URL when it drops one', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    h.registry.invalidate()
    h.registry.invalidate('cam-1')

    expectNoSecret(h)
  })
})

describe('ensureStream: what it refuses', () => {
  it('refuses a camera the inventory does not have (CAM-1)', async () => {
    const error = await refusal(h.registry.ensureStream('cam-nope', 'low'))

    expect(error.kind).toBe('not-found')
    expect(error.retryable).toBe(true)
    // Nothing was asked of the console or of go2rtc for an id nobody reported.
    expect(h.protect.rtspsStreams).not.toHaveBeenCalled()
    expect(h.go2rtc.start).not.toHaveBeenCalled()
  })

  it('refuses the package channel on a camera without one (CAM-4)', async () => {
    const error = await refusal(h.registry.ensureStream('cam-1', 'package'))

    expect(error.kind).toBe('bad-request')
    expect(error.retryable).toBe(false)
    expect(h.protect.createRtspsStreams).not.toHaveBeenCalled()
  })

  it('allows the package channel on a camera that has one (CAM-4)', async () => {
    h.setCameras([camera('cam-1', { hasPackageCamera: true })])

    const handle = await h.registry.ensureStream('cam-1', 'package')

    expect(handle.name).toBe('cam-1_package')
    expect(h.protect.createRtspsStreams).toHaveBeenCalledWith('cam-1', ['package'])
  })

  it('refuses a source that is not on the pinned console host (R4)', async () => {
    h.protect.answerForHost(OTHER_HOST)

    const error = await refusal(h.registry.ensureStream('cam-1', 'low'))

    expect(error.kind).toBe('invalid-response')
    // The unpinned `rtspx://` scheme never even reaches the manager for another host.
    expect(h.go2rtc.addStream).not.toHaveBeenCalled()
    expect(error.message).toContain(HOST)
    expectNoSecret(h, error.message)
  })

  it('re-checks the host against a cached source, so an address change cannot reuse it (R4)', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    h.setHost(OTHER_HOST)

    // The console still answers for the old host, so the re-read is off-host too and is refused.
    const error = await refusal(h.registry.ensureStream('cam-1', 'low'))

    expect(error.kind).toBe('invalid-response')
    expect(h.go2rtc.addStream).toHaveBeenCalledTimes(1)
  })

  it('evicts a cached source that fails the host check and re-reads it (R4, QUAL-8)', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)

    // The user points View Protect at the console's new address and the console answers for it.
    // The stale cached URL must not make the pair fail for ever with a message blaming the console.
    h.setHost(OTHER_HOST)
    h.protect.answerForHost(OTHER_HOST)

    const handle = await h.registry.ensureStream('cam-1', 'low')

    expect(handle.name).toBe('cam-1_low')
    // Re-read from Protect: one extra GET, per QUAL-8, and no POST for a stream that exists.
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
    expect(h.protect.createRtspsStreams).not.toHaveBeenCalled()
    expect(h.go2rtc.registered.get('cam-1_low')).toBe(`rtspx://${OTHER_HOST}:7441/${ALIASES.low}`)
    // And the re-read source is cached in its turn: a third call costs nothing.
    await h.registry.ensureStream('cam-1', 'low')
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
    expectNoSecret(h, handle)
  })

  it('refuses when no console address is configured (CON-1)', async () => {
    h.setHost(null)

    const error = await refusal(h.registry.ensureStream('cam-1', 'low'))

    expect(error.kind).toBe('not-configured')
  })
})

describe('ensureStream: the handle and the gateway', () => {
  it('builds a handle that matches the contract and the runtime that is up now', async () => {
    const handle: StreamHandle = await h.registry.ensureStream('cam-1', 'low')

    // The schema ties name, port and wsUrl together, so this is the renderer's own check.
    expect(StreamHandleSchema.parse(handle)).toEqual(handle)
    expect(handle).toEqual({
      cameraId: 'cam-1',
      quality: 'low',
      name: 'cam-1_low',
      port: PORT,
      epoch: EPOCH,
      wsUrl: `ws://127.0.0.1:${String(PORT)}/api/ws?src=cam-1_low`,
    })
  })

  it('follows go2rtc onto its new port and epoch after a restart', async () => {
    await h.registry.ensureStream('cam-1', 'low')
    h.go2rtc.restartOn(19999, EPOCH + 1)

    const handle = await h.registry.ensureStream('cam-1', 'low')

    expect(handle).toMatchObject({ port: 19999, epoch: EPOCH + 1 })
    expect(handle.wsUrl).toBe('ws://127.0.0.1:19999/api/ws?src=cam-1_low')
    // The URL is still the cached one: a restart is not a reason to spend a Protect request.
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(1)
  })

  it('starts go2rtc lazily, on the first stream', async () => {
    expect(h.go2rtc.start).not.toHaveBeenCalled()

    await h.registry.ensureStream('cam-1', 'low')

    expect(h.go2rtc.start).toHaveBeenCalledTimes(1)
  })

  it('reports gateway-down, retryable, when go2rtc cannot be started', async () => {
    h.go2rtc.failStart(new Error('go2rtc gave up after 3 attempts'))

    const error = await refusal(h.registry.ensureStream('cam-1', 'low'))

    expect(error.kind).toBe('gateway-down')
    expect(error.retryable).toBe(true)
    expect(h.go2rtc.addStream).not.toHaveBeenCalled()
  })

  it('reports gateway-down when go2rtc will not take the stream', async () => {
    h.go2rtc.failAdd(new Error('PUT /api/streams -> 500'))

    const error = await refusal(h.registry.ensureStream('cam-1', 'low'))

    expect(error.kind).toBe('gateway-down')
    expect(error.retryable).toBe(true)
    expectNoSecret(h, error.message)
  })
})

describe('no secret ever leaves the registry (CON-2, NFR-9, SPEC §6.1)', () => {
  it('keeps every alias and URL out of the handles and out of the log', async () => {
    h.setCameras([camera('cam-1', { hasPackageCamera: true })])
    const handles = [
      await h.registry.ensureStream('cam-1', 'low'),
      await h.registry.ensureStream('cam-1', 'high'),
      await h.registry.ensureStream('cam-1', 'package'),
    ]

    // The sources *are* in go2rtc's desired set — that is where they belong (P2.1 writes them 0600
    // into the generated config and deletes it) — and nowhere else.
    expect([...h.go2rtc.registered.values()].join()).toContain(ALIASES.low)
    expectNoSecret(h, handles)
    expect(h.lines.length).toBeGreaterThan(0)
  })

  it('shutdown forgets the cached URLs without stopping the sidecar', async () => {
    await h.registry.ensureStream('cam-1', 'low')

    h.registry.shutdown()

    expect(h.go2rtc.stop).not.toHaveBeenCalled()
    await h.registry.ensureStream('cam-1', 'low')
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(2)
  })
})

describe('RTSP streams mode (MODE-4)', () => {
  it('treats a Protect camera id as an unknown stream and makes no Protect call', async () => {
    const h = setup()
    h.setProtectMode(false)
    const err = await refusal(h.registry.ensureStream('cam-1', 'high'))
    expect(err.kind).toBe('not-found')
    expect(err.retryable).toBe(false)
    expect(h.protect.rtspsStreams).not.toHaveBeenCalled()
    expect(h.protect.createRtspsStreams).not.toHaveBeenCalled()
    expect(h.go2rtc.start).not.toHaveBeenCalled()
    expect(h.go2rtc.addStream).not.toHaveBeenCalled()
  })

  it('unregisterAll removes every registered stream from go2rtc and forgets the cached URLs', async () => {
    const h = setup()
    await h.registry.ensureStream('cam-1', 'high')
    await h.registry.ensureStream('cam-1', 'low')
    expect(h.go2rtc.registered.size).toBe(2)
    await h.registry.unregisterAll()
    expect(h.go2rtc.removeStream).toHaveBeenCalledTimes(2)
    expect(h.go2rtc.registered.size).toBe(0)
    // go2rtc itself keeps running: the switch removes streams, not the sidecar.
    expect(h.go2rtc.stop).not.toHaveBeenCalled()
    // The cache went too: the next stream (back in Protect mode) reads its URL again.
    await h.registry.ensureStream('cam-1', 'high')
    expect(h.protect.rtspsStreams).toHaveBeenCalledTimes(3)
    expectNoSecret(h)
  })

  it('does not register a stream whose read was in flight when everything was unregistered', async () => {
    const h = setup()
    let release = (): void => undefined
    h.protect.rtspsStreams.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ high: rtspsUrl(ALIASES.high, HOST), medium: null, low: null, package: null })
          }
        }),
    )
    const pending = h.registry.ensureStream('cam-1', 'high')
    await Promise.resolve()
    await h.registry.unregisterAll()
    release()
    const err = await refusal(pending)
    expect(err.kind).toBe('bad-request')
    expect(h.go2rtc.addStream).not.toHaveBeenCalled()
    expect(h.go2rtc.registered.size).toBe(0)
  })

  it('never rejects, even when go2rtc will not drop a stream', async () => {
    const h = setup()
    await h.registry.ensureStream('cam-1', 'high')
    h.go2rtc.removeStream.mockRejectedValueOnce(new Error('go2rtc is restarting'))
    await expect(h.registry.unregisterAll()).resolves.toBeUndefined()
    expect(h.lines.some((line) => line.includes('could not be removed'))).toBe(true)
  })

  it('counts a stream the running go2rtc did not drop (removeStream answers false)', async () => {
    const h = setup()
    await h.registry.ensureStream('cam-1', 'high')
    await h.registry.ensureStream('cam-1', 'low')
    // The real manager never rejects: a failed DELETE is a `false` answer.
    h.go2rtc.removeStream.mockResolvedValueOnce(false)
    await h.registry.unregisterAll()
    expect(h.lines.some((line) => line.includes('1 could not be removed'))).toBe(true)
  })

  it('logs no failure when go2rtc dropped every stream', async () => {
    const h = setup()
    await h.registry.ensureStream('cam-1', 'high')
    await h.registry.unregisterAll()
    expect(h.lines.some((line) => line.includes('could not be removed'))).toBe(false)
  })
})

// --- RTSP streams mode playback (RTSP-3, RTSP-5) -------------------------------------------------

describe('ensureStream in RTSP streams mode (RTSP-3, RTSP-5)', () => {
  const GARDEN = 'rtsp-22222222-2222-4222-8222-222222222222'
  const PORCH = 'rtsp-11111111-1111-4111-8111-111111111111'
  /** Credentials and hosts that must never appear in a handle, a message or a log line (CON-2). */
  const HIGH = 'rtsps://admin:garden-pass-1@cam-a.invalid:7441/high?x=1'
  const LOW = 'rtsp://admin:garden-pass-3@cam-a.invalid:554/low'
  const PORCH_MED = 'rtsp://admin:porch-pass@cam-b.invalid/live'

  function rtspHarness(
    urls: Record<string, RtspStreamUrls> = { [GARDEN]: { high: HIGH, low: LOW } },
  ) {
    const r = setup()
    r.setProtectMode(false)
    // No console is configured: RTSP mode needs none.
    r.setHost(null)
    r.setRtspStreams([
      { id: GARDEN, name: 'Garden' },
      { id: PORCH, name: 'Porch' },
    ])
    r.setRtspUrls(urls)
    return r
  }

  /** CON-2: no URL, nor any part of one, in a handle, an error or the log. */
  function expectNoUrl(r: Harness, ...values: unknown[]): void {
    const text = [
      ...values.map((v) => (v instanceof Error ? v.message : JSON.stringify(v))),
      ...r.lines,
    ].join('\n')
    expect(text).not.toMatch(/rtsp[sx]?:\/\//i)
    expect(text).not.toContain('pass')
    expect(text).not.toContain('cam-a.invalid')
    expect(text).not.toContain('cam-b.invalid')
    expect(text).not.toContain('admin')
  }

  it('registers the asked quality from the secrets, rtsps:// as rtspx://, and makes no Protect call', async () => {
    const r = rtspHarness()
    const handle = await r.registry.ensureStream(GARDEN, 'high')
    expect(StreamHandleSchema.parse(handle)).toEqual(handle)
    expect(handle).toMatchObject({ cameraId: GARDEN, quality: 'high', name: `${GARDEN}_high` })
    expect(handle.port).toBe(PORT)
    // Only the scheme changes: the query is kept verbatim (unlike Protect's enableSrtp strip).
    expect(r.go2rtc.registered.get(`${GARDEN}_high`)).toBe(
      'rtspx://admin:garden-pass-1@cam-a.invalid:7441/high?x=1',
    )
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBe(r.go2rtc.registered.get(`${GARDEN}_high`))
    expect(r.protect.rtspsStreams).not.toHaveBeenCalled()
    expect(r.protect.createRtspsStreams).not.toHaveBeenCalled()
    expectNoUrl(r, handle)
  })

  it('passes rtsp:// as is', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'low')
    expect(r.go2rtc.registered.get(`${GARDEN}_low`)).toBe(LOW)
  })

  it('serves the closest stored quality and names it in the handle (lower on a tie)', async () => {
    const r = rtspHarness()
    // medium has no URL: high and low are equally close, so the lower one plays.
    const handle = await r.registry.ensureStream(GARDEN, 'medium')
    expect(handle).toMatchObject({ quality: 'low', name: `${GARDEN}_low` })
    expect([...r.go2rtc.registered.keys()]).toEqual([`${GARDEN}_low`])

    const p = rtspHarness({ [PORCH]: { medium: PORCH_MED } })
    expect((await p.registry.ensureStream(PORCH, 'high')).quality).toBe('medium')
    expect((await p.registry.ensureStream(PORCH, 'low')).quality).toBe('medium')
  })

  it('records the source before go2rtc is asked, so the manager`s RTSP-5 check can accept it', async () => {
    const r = rtspHarness()
    const seen: (string | null)[] = []
    r.go2rtc.addStream.mockImplementationOnce((name: string, source: string) => {
      seen.push(r.registry.rtspSource(name) === source ? 'match' : null)
      r.go2rtc.registered.set(name, source)
      return Promise.resolve()
    })
    await r.registry.ensureStream(GARDEN, 'high')
    expect(seen).toEqual(['match'])
    expect(r.registry.rtspSource(`${PORCH}_high`)).toBeNull()
  })

  it('coalesces calls that are served by the same stream into one registration', async () => {
    const r = rtspHarness()
    const handles = await Promise.all([
      r.registry.ensureStream(GARDEN, 'low'),
      r.registry.ensureStream(GARDEN, 'medium'),
      r.registry.ensureStream(GARDEN, 'low'),
    ])
    expect(handles.map((x) => x.name)).toEqual([`${GARDEN}_low`, `${GARDEN}_low`, `${GARDEN}_low`])
    expect(r.go2rtc.addStream).toHaveBeenCalledTimes(1)
  })

  it('refuses a stream that is not configured: not-found, not retryable', async () => {
    const r = rtspHarness({ [PORCH]: { medium: PORCH_MED } })
    // URLs stored, but the stream is not in the list (deleted): the list is the authority.
    r.setRtspStreams([{ id: GARDEN, name: 'Garden' }])
    const err = await refusal(r.registry.ensureStream(PORCH, 'medium'))
    expect(err).toMatchObject({ kind: 'not-found', retryable: false })
    expect(r.go2rtc.start).not.toHaveBeenCalled()
    expect(r.go2rtc.addStream).not.toHaveBeenCalled()
    expectNoUrl(r, err)
  })

  it('refuses the package channel', async () => {
    const r = rtspHarness()
    const err = await refusal(r.registry.ensureStream(GARDEN, 'package'))
    expect(err.kind).toBe('bad-request')
    expect(r.go2rtc.addStream).not.toHaveBeenCalled()
  })

  it('refuses a stream with no URL stored as not-configured', async () => {
    const r = rtspHarness()
    const err = await refusal(r.registry.ensureStream(PORCH, 'high'))
    expect(err).toMatchObject({ kind: 'not-configured', retryable: false })
    r.setRtspUrls(undefined)
    expect((await refusal(r.registry.ensureStream(GARDEN, 'high'))).kind).toBe('not-configured')
    expect(r.go2rtc.addStream).not.toHaveBeenCalled()
  })

  it('refuses a stored URL that fails RTSP-2`s rules, without quoting it (RTSP-5, CON-2)', async () => {
    for (const bad of [
      'exec:/bin/sh -c "curl evil"',
      'http://admin:pass@cam-a.invalid/x',
      'rtspx://admin:pass@cam-a.invalid/x',
      'rtsp://admin:pass@cam-a.invalid/x\nstreams:',
    ]) {
      const r = rtspHarness({ [GARDEN]: { high: bad } })
      const err = await refusal(r.registry.ensureStream(GARDEN, 'high'))
      expect(err.kind).toBe('bad-request')
      expect(err.message).not.toContain(bad)
      expect(r.go2rtc.addStream).not.toHaveBeenCalled()
      expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
      expect(err.message).not.toContain('pass')
      expect(r.lines.join('\n')).not.toContain('pass')
    }
  })

  it('reports gateway-down when go2rtc will not take the stream, and forgets the source', async () => {
    const r = rtspHarness()
    r.go2rtc.failAdd(new Error('go2rtc: could not register stream'))
    const err = await refusal(r.registry.ensureStream(GARDEN, 'high'))
    expect(err).toMatchObject({ kind: 'gateway-down', retryable: true })
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
    expectNoUrl(r, err)
  })

  it('unregisterAll forgets every RTSP source', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'high')
    await r.registry.unregisterAll()
    expect(r.go2rtc.registered.size).toBe(0)
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
  })

  it('keeps the RTSP sources through an inventory invalidate', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'high')
    r.registry.invalidate()
    expect(r.registry.rtspSource(`${GARDEN}_high`)).not.toBeNull()
  })
})

describe('rtspStreamChanged (RTSP-3)', () => {
  const GARDEN = 'rtsp-22222222-2222-4222-8222-222222222222'
  const PORCH = 'rtsp-11111111-1111-4111-8111-111111111111'
  const OLD = 'rtsp://admin:old-pass@cam-a.invalid/high'
  const NEW = 'rtsp://admin:new-pass@cam-a.invalid/high'

  function rtspHarness() {
    const r = setup()
    r.setProtectMode(false)
    r.setRtspStreams([
      { id: GARDEN, name: 'Garden' },
      { id: PORCH, name: 'Porch' },
    ])
    r.setRtspUrls({ [GARDEN]: { high: OLD, low: OLD }, [PORCH]: { high: OLD } })
    return r
  }

  it('removes every registration of that stream, and only that stream', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'high')
    await r.registry.ensureStream(GARDEN, 'low')
    await r.registry.ensureStream(PORCH, 'high')
    await r.registry.rtspStreamChanged(GARDEN)
    expect([...r.go2rtc.registered.keys()]).toEqual([`${PORCH}_high`])
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
    expect(r.registry.rtspSource(`${GARDEN}_low`)).toBeNull()
    expect(r.registry.rtspSource(`${PORCH}_high`)).not.toBeNull()
    // The next ask reads the new URL.
    r.setRtspUrls({ [GARDEN]: { high: NEW }, [PORCH]: { high: OLD } })
    await r.registry.ensureStream(GARDEN, 'high')
    expect(r.go2rtc.registered.get(`${GARDEN}_high`)).toBe(NEW)
    expect(r.lines.join('\n')).not.toContain('pass')
  })

  it('keeps an ensure already in flight from registering the old URL afterwards', async () => {
    const r = rtspHarness()
    let release = (): void => undefined
    r.go2rtc.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ port: PORT, epoch: EPOCH })
          }
        }),
    )
    const pending = r.registry.ensureStream(GARDEN, 'high')
    await Promise.resolve()
    await r.registry.rtspStreamChanged(GARDEN)
    release()
    const err = await refusal(pending)
    // Retryable: the player asks again and picks up the new URL.
    expect(err).toMatchObject({ kind: 'bad-request', retryable: true })
    expect(r.go2rtc.addStream).not.toHaveBeenCalled()
    expect(r.go2rtc.registered.size).toBe(0)
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
    // And a new ask is not handed the stale in-flight promise.
    r.setRtspUrls({ [GARDEN]: { high: NEW } })
    await r.registry.ensureStream(GARDEN, 'high')
    expect(r.go2rtc.registered.get(`${GARDEN}_high`)).toBe(NEW)
  })

  it('removes a registration that landed while it ran, rather than leave the old URL playing', async () => {
    const r = rtspHarness()
    let release = (): void => undefined
    r.go2rtc.addStream.mockImplementationOnce((name: string, source: string) => {
      r.go2rtc.registered.set(name, source)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const pending = r.registry.ensureStream(GARDEN, 'high')
    await vi.waitFor(() => {
      expect(r.go2rtc.addStream).toHaveBeenCalledTimes(1)
    })
    // The change runs while go2rtc is still answering the PUT; the PUT then lands.
    await r.registry.rtspStreamChanged(GARDEN)
    r.go2rtc.registered.set(`${GARDEN}_high`, 'rtsp://admin:old-pass@cam-a.invalid/high')
    release()
    expect((await refusal(pending)).kind).toBe('bad-request')
    expect(r.go2rtc.registered.size).toBe(0)
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBeNull()
  })

  it('keeps the record of a newer ensure that registered while the removals were awaited', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'high')
    // The name leaves the desired set at once, but go2rtc takes its time answering the DELETE.
    let releaseRemoval = (): void => undefined
    r.go2rtc.removeStream.mockImplementationOnce((name: string) => {
      r.go2rtc.registered.delete(name)
      return new Promise<boolean>((resolve) => {
        releaseRemoval = () => {
          resolve(true)
        }
      })
    })
    const changing = r.registry.rtspStreamChanged(GARDEN)
    r.setRtspUrls({ [GARDEN]: { high: NEW } })
    await r.registry.ensureStream(GARDEN, 'high')
    releaseRemoval()
    await changing
    // The manager holds the new source, and the registry still vouches for exactly that one, so a
    // later go2rtc (re)start accepts it.
    expect(r.go2rtc.registered.get(`${GARDEN}_high`)).toBe(NEW)
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBe(NEW)
  })

  it('a stale ensure leaves alone an identical registration a newer ensure made', async () => {
    const r = rtspHarness()
    let release = (): void => undefined
    r.go2rtc.addStream.mockImplementationOnce((name: string, source: string) => {
      r.go2rtc.registered.set(name, source)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const stale = r.registry.ensureStream(GARDEN, 'high')
    await vi.waitFor(() => {
      expect(r.go2rtc.addStream).toHaveBeenCalledTimes(1)
    })
    // Only the low URL changed: the high source the newer ensure registers is the same as before.
    r.setRtspUrls({ [GARDEN]: { high: OLD, low: NEW }, [PORCH]: { high: OLD } })
    await r.registry.rtspStreamChanged(GARDEN)
    await r.registry.ensureStream(GARDEN, 'high')
    release()
    expect((await refusal(stale)).retryable).toBe(true)
    expect(r.go2rtc.registered.get(`${GARDEN}_high`)).toBe(OLD)
    expect(r.registry.rtspSource(`${GARDEN}_high`)).toBe(OLD)
    // Only the change's own removal: the stale ensure removed nothing.
    expect(r.go2rtc.removeStream).toHaveBeenCalledTimes(1)
  })

  it('never rejects, even when go2rtc will not drop a stream', async () => {
    const r = rtspHarness()
    await r.registry.ensureStream(GARDEN, 'high')
    r.go2rtc.removeStream.mockRejectedValueOnce(new Error('go2rtc is restarting'))
    await expect(r.registry.rtspStreamChanged(GARDEN)).resolves.toBeUndefined()
    expect(r.lines.some((line) => line.includes('could not be removed'))).toBe(true)
  })

  it('is a no-op for a stream with no registration', async () => {
    const r = rtspHarness()
    await expect(r.registry.rtspStreamChanged(PORCH)).resolves.toBeUndefined()
    expect(r.go2rtc.removeStream).not.toHaveBeenCalled()
  })
})
