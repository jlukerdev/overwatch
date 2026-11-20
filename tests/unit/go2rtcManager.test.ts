// P2.1: the go2rtc lifecycle (src/main/streams/go2rtcManager.ts) — SPEC §5.3, Gate G2, NFR-7,
// CON-2/NFR-9, R4, R7.
//
// Everything runs on fakes: a hand-driven child process, a fake loopback HTTP API, a fake
// filesystem, a manual clock and a recorded log. So no test spawns go2rtc, opens a socket, writes a
// file or waits out a backoff, and the things that are genuinely hard to get right are asserted
// directly rather than inferred:
//
//  - the **port race** (SPEC §5.3): an impostor on the port is detected and the start retried on a
//    new port, three times, and then reported;
//  - the **config file is a secret**: written 0600, chmod'ed, and deleted once the API answers —
//    including on every failure path;
//  - **recovery is automatic** (Gate G2): a killed child comes back on a new port with a new epoch
//    and the whole desired stream set replayed, with a capped backoff and a bounded give-up;
//  - a deliberate `stop()` **never** restarts;
//  - **no credential and no source URL can reach a log line** (CON-2, NFR-9).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEALTH_INTERVAL_MS,
  MAX_CONSECUTIVE_RESTART_FAILURES,
  READY_POLL_MS,
  RESTART_BACKOFF,
  RESTART_STABLE_AFTER_MS,
  START_ATTEMPTS,
  createGo2rtcManager,
  go2rtcBinaryPath,
  type Go2rtcChild,
  type Go2rtcFileSystem,
  type Go2rtcHttp,
  type Go2rtcHttpRequest,
  type Go2rtcManager,
  type Go2rtcManagerOptions,
  type Go2rtcRuntime,
  type Go2rtcSpawn,
} from '../../src/main/streams/go2rtcManager'

const HOST = 'console.test'
const SOURCE = `rtspx://${HOST}:7441/aBcDeFgHiJkLmNoP`
const OTHER_SOURCE = `rtspx://${HOST}:7441/zZyYxXwWvVuUtTsS`
const CONFIG_DIR = '/tmp/vp-test-userdata'
const CONFIG_PATH = `${CONFIG_DIR}/go2rtc.yaml`
const BINARY = '/opt/view-protect/resources/bin/darwin-arm64/go2rtc'

// --- fakes --------------------------------------------------------------------------------------

/** Lets the awakened code run its microtasks between clock steps. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await flush()
}

interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
  /** Fires every timer due within `ms`, letting the woken code run in between. */
  advance(ms: number): Promise<void>
  /** Every delay that was asked for, in order. */
  readonly delays: number[]
}

function createClock(): Clock {
  let t = 1_700_000_000_000
  const delays: number[] = []
  const pending: { at: number; resolve: () => void }[] = []
  return {
    now: () => t,
    sleep(ms) {
      delays.push(ms)
      return new Promise<void>((resolve) => {
        pending.push({ at: t + ms, resolve })
      })
    },
    async advance(ms) {
      const target = t + ms
      await settle()
      for (;;) {
        pending.sort((a, b) => a.at - b.at)
        const next = pending[0]
        if (next === undefined || next.at > target) break
        pending.shift()
        t = Math.max(t, next.at)
        next.resolve()
        await settle()
      }
      t = Math.max(t, target)
      await settle()
    },
    delays,
  }
}

interface FakeChild extends Go2rtcChild {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  /** Signals the manager sent, in order. */
  readonly signals: NodeJS.Signals[]
  /** Exit as a real child would. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void
  /** Push output as go2rtc would, for the redaction test. */
  emit(which: 'stdout' | 'stderr', chunk: string): void
}

/** `ignoreSigterm` models a child that has to be SIGKILLed. */
function createFakeChild(pid: number, ignoreSigterm = false): FakeChild {
  const exitListeners: (() => void)[] = []
  const dataListeners: Record<'stdout' | 'stderr', ((chunk: string) => void)[]> = {
    stdout: [],
    stderr: [],
  }
  const stream = (which: 'stdout' | 'stderr'): FakeChild['stdout'] => ({
    setEncoding: () => undefined,
    on: (_event, listener) => {
      dataListeners[which].push(listener)
    },
  })
  const child: FakeChild = {
    pid,
    exitCode: null,
    signalCode: null,
    signals: [],
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    kill(signal = 'SIGTERM') {
      child.signals.push(signal)
      if (signal === 'SIGKILL' || !ignoreSigterm) child.exit(null, signal)
      return true
    },
    once(_event, listener) {
      exitListeners.push(listener)
    },
    exit(code, signal = null) {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.exitCode = code
      child.signalCode = signal
      for (const listener of [...exitListeners]) listener()
    },
    emit(which, chunk) {
      for (const listener of [...dataListeners[which]]) listener(chunk)
    },
  }
  return child
}

/** A child the manager has not signalled into exiting: after `stop()` there must be none. */
function isAlive(child: FakeChild): boolean {
  return child.exitCode === null && child.signalCode === null
}

interface Harness {
  readonly manager: Go2rtcManager
  readonly clock: Clock
  readonly children: FakeChild[]
  readonly spawns: { command: string; args: readonly string[]; cwd: string }[]
  readonly requests: Go2rtcHttpRequest[]
  readonly writes: { path: string; data: string; mode: number }[]
  readonly chmods: { path: string; mode: number }[]
  readonly removals: string[]
  readonly logs: string[]
  readonly runtimes: (Go2rtcRuntime | null)[]
  /** Ports `freePort()` hands out, in order. */
  readonly ports: number[]
  /** Ports where a *different* process answers: unauthenticated GET /api gives 200, not 401. */
  readonly impostorPorts: Set<number>
  /** Authenticated GET /api status. null models "nothing answers". */
  authStatus: number | null
  /** What GET/PUT/DELETE /api/streams answers. */
  streamsStatus: number
  streamsBody: string
  /** null models an unreadable PID list; by default the last spawned child's PID is returned. */
  listenerPids: number[] | null | 'child'
  lastChild(): FakeChild
  /** The password of the current launch, decoded from the header main holds. */
  password(): string
}

function createHarness(overrides: Partial<Go2rtcManagerOptions> = {}): Harness {
  const clock = createClock()
  const children: FakeChild[] = []
  const spawns: Harness['spawns'] = []
  const requests: Go2rtcHttpRequest[] = []
  const writes: Harness['writes'] = []
  const chmods: Harness['chmods'] = []
  const removals: string[] = []
  const logs: string[] = []
  const runtimes: (Go2rtcRuntime | null)[] = []
  const ports: number[] = []
  let nextPort = 41_001
  /** Children that must be SIGKILLed, by spawn index. */
  const stubborn = new Set<number>()

  const state = {
    impostorPorts: new Set<number>(),
    authStatus: 200 as number | null,
    streamsStatus: 200,
    streamsBody: '{}',
    listenerPids: 'child' as number[] | null | 'child',
  }

  const spawn: Go2rtcSpawn = (command, args, options) => {
    spawns.push({ command, args, cwd: options.cwd })
    const child = createFakeChild(5000 + children.length, stubborn.has(children.length))
    children.push(child)
    return child
  }

  const portOf = (url: string): number => Number(new URL(url).port)

  const http: Go2rtcHttp = (request) => {
    requests.push(request)
    const url = new URL(request.url)
    const withAuth = request.headers.Authorization !== undefined
    if (url.pathname === '/api') {
      if (!withAuth)
        // An impostor does not enforce our credentials; real go2rtc answers 401.
        return Promise.resolve({
          status: state.impostorPorts.has(portOf(request.url)) ? 200 : 401,
          body: '',
        })
      if (state.authStatus === null) return Promise.reject(new Error('ECONNREFUSED'))
      return Promise.resolve({ status: state.authStatus, body: '' })
    }
    if (url.pathname === '/api/streams')
      return Promise.resolve({ status: state.streamsStatus, body: state.streamsBody })
    return Promise.resolve({ status: 404, body: '' })
  }

  const fs: Go2rtcFileSystem = {
    mkdir: () => Promise.resolve(),
    writeFile(path, data, mode) {
      writes.push({ path, data, mode })
      return Promise.resolve()
    },
    chmod(path, mode) {
      chmods.push({ path, mode })
      return Promise.resolve()
    },
    remove(path) {
      removals.push(path)
      return Promise.resolve()
    },
  }

  const manager = createGo2rtcManager({
    configDir: CONFIG_DIR,
    binaryPath: () => BINARY,
    consoleHost: () => HOST,
    spawn,
    freePort: () => {
      const port = nextPort++
      ports.push(port)
      return Promise.resolve(port)
    },
    http,
    listenerPids: () => {
      if (state.listenerPids === 'child') {
        const last = children.at(-1)
        return Promise.resolve(last === undefined ? [] : [last.pid])
      }
      return Promise.resolve(state.listenerPids)
    },
    fs,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    random: (n) => new Uint8Array(n).fill(children.length + 1),
    platform: 'darwin',
    // Off unless a test asks for it: the exit watch is what most tests exercise.
    healthIntervalMs: 0,
    log: (line) => logs.push(line),
    ...overrides,
  })

  manager.onRuntimeChange((runtime) => runtimes.push(runtime))

  return {
    manager,
    clock,
    children,
    spawns,
    requests,
    writes,
    chmods,
    removals,
    logs,
    runtimes,
    ports,
    impostorPorts: state.impostorPorts,
    get authStatus() {
      return state.authStatus
    },
    set authStatus(value) {
      state.authStatus = value
    },
    get streamsStatus() {
      return state.streamsStatus
    },
    set streamsStatus(value) {
      state.streamsStatus = value
    },
    get streamsBody() {
      return state.streamsBody
    },
    set streamsBody(value) {
      state.streamsBody = value
    },
    get listenerPids() {
      return state.listenerPids
    },
    set listenerPids(value) {
      state.listenerPids = value
    },
    lastChild() {
      const child = children.at(-1)
      if (child === undefined) throw new Error('nothing has been spawned')
      return child
    },
    password() {
      const header = manager.authHeader()
      if (header === null) throw new Error('go2rtc is not running')
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
      return decoded.slice(decoded.indexOf(':') + 1)
    },
  }
}

// --- tests --------------------------------------------------------------------------------------

describe('createGo2rtcManager — start', () => {
  it('writes the config 0600, spawns go2rtc, verifies the port and deletes the config', async () => {
    const h = createHarness()
    await h.manager.addStream('cam1_low', SOURCE)
    const runtime = await h.manager.start()

    expect(runtime).toEqual({ port: 41_001, epoch: 1 })
    expect(h.manager.runtime()).toEqual(runtime)
    expect(h.manager.state()).toBe('running')

    expect(h.writes).toEqual([
      {
        path: CONFIG_PATH,
        data: expect.stringContaining('local_auth: true') as string,
        mode: 0o600,
      },
    ])
    // The YAML carries the desired set and the verified port.
    const yaml = h.writes[0]?.data ?? ''
    expect(yaml).toContain(`cam1_low: ${JSON.stringify(SOURCE)}`)
    expect(yaml).toContain('listen: "127.0.0.1:41001"')
    expect(h.chmods).toEqual([{ path: CONFIG_PATH, mode: 0o600 }])
    // Deleted as soon as the API answers: it holds the RTSPS and API credentials (SPEC §5.3).
    expect(h.removals).toEqual([CONFIG_PATH])

    expect(h.spawns).toEqual([{ command: BINARY, args: ['-c', CONFIG_PATH], cwd: CONFIG_DIR }])
    expect(h.runtimes).toEqual([{ port: 41_001, epoch: 1 }])
  })

  it('verifies ownership exactly as SPEC §5.3 says, with the credentials only on our own call', async () => {
    const h = createHarness()
    await h.manager.start()
    const probes = h.requests.filter((r) => new URL(r.url).pathname === '/api')
    expect(probes).toHaveLength(2)
    expect(probes[0]?.headers.Authorization).toBe(h.manager.authHeader())
    expect(probes[1]?.headers.Authorization).toBeUndefined()
    expect(probes.every((p) => p.url.startsWith('http://127.0.0.1:41001/'))).toBe(true)
    expect(h.logs.join('\n')).toContain('listener PID 5000 is our go2rtc child')
  })

  it('starts with no streams at all (deviation from the spike)', async () => {
    const h = createHarness()
    await h.manager.start()
    expect(h.manager.streams()).toEqual({})
    expect((h.writes[0]?.data ?? '').trimEnd().endsWith('streams:')).toBe(true)
  })

  it('retries on a new port when another process owns it, up to 3 attempts', async () => {
    const h = createHarness()
    h.impostorPorts.add(41_001).add(41_002)
    const runtime = await h.manager.start()

    expect(h.ports).toEqual([41_001, 41_002, 41_003])
    expect(runtime.port).toBe(41_003)
    expect(h.spawns).toHaveLength(3)
    // Each losing child is killed and its config deleted before the next attempt.
    expect(h.children[0]?.signals).toEqual(['SIGTERM'])
    expect(h.children[1]?.signals).toEqual(['SIGTERM'])
    expect(h.children[2]?.signals).toEqual([])
    expect(h.removals).toEqual([CONFIG_PATH, CONFIG_PATH, CONFIG_PATH])
    // Fresh credentials per attempt, so a hostile port never sees the same ones twice.
    const credentials = new Set(h.writes.map((w) => /password: "([^"]+)"/.exec(w.data)?.[1] ?? '?'))
    expect(credentials.size).toBe(3)
    expect(h.runtimes).toEqual([{ port: 41_003, epoch: 1 }])
  })

  it('reports a clear failure when no attempt produces a verified listener', async () => {
    const h = createHarness()
    for (const port of [41_001, 41_002, 41_003]) h.impostorPorts.add(port)
    await expect(h.manager.start()).rejects.toThrow(
      new RegExp(`no verified listener after ${String(START_ATTEMPTS)} attempts`),
    )
    expect(h.spawns).toHaveLength(START_ATTEMPTS)
    expect(h.manager.runtime()).toBeNull()
    expect(h.manager.state()).toBe('stopped')
    expect(h.manager.authHeader()).toBeNull()
    expect(h.runtimes).toEqual([])
    expect(h.removals).toHaveLength(START_ATTEMPTS)
  })

  it('fails the start when the PID check cannot be read on macOS, but not on Windows', async () => {
    const mac = createHarness()
    mac.listenerPids = null
    await expect(mac.manager.start()).rejects.toThrow(/required on this platform/)

    const win = createHarness({ platform: 'win32' })
    win.listenerPids = null
    await expect(win.manager.start()).resolves.toEqual({ port: 41_001, epoch: 1 })
    // No POSIX modes on Windows, so no explicit chmod (the file is still written with mode 0600).
    expect(win.chmods).toEqual([])
  })

  it('gives up an attempt when go2rtc exits during startup', async () => {
    const h = createHarness()
    h.authStatus = null
    // The rejection handler is attached before the clock is driven, so the failure is never a
    // momentarily unhandled rejection.
    const started = expect(h.manager.start()).rejects.toThrow(/no verified listener/)
    // The readiness poll notices the dead child at once instead of waiting out its timeout, so
    // each of the three attempts ends as soon as its child exits.
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      await settle()
      for (const child of h.children) child.exit(1)
      // The attempt is parked in its readiness poll; the next tick is where it sees the exit.
      await h.clock.advance(READY_POLL_MS)
    }
    await started
    expect(h.spawns).toHaveLength(START_ATTEMPTS)
    expect(h.logs.join('\n')).toContain('exited during startup')
  })

  it('is idempotent: concurrent starts share one in-flight start, a healthy one is reused', async () => {
    const h = createHarness()
    const [first, second] = await Promise.all([h.manager.start(), h.manager.start()])
    expect(first).toEqual({ port: 41_001, epoch: 1 })
    expect(second).toEqual(first)
    expect(h.spawns).toHaveLength(1)

    const third = await h.manager.start()
    expect(third).toEqual(first)
    expect(h.spawns).toHaveLength(1)
    expect(h.runtimes).toHaveLength(1)
  })
})

describe('createGo2rtcManager — the desired stream set', () => {
  it('registers a stream live through PUT /api/streams while running', async () => {
    const h = createHarness()
    await h.manager.start()
    await h.manager.addStream('cam1_high', SOURCE)

    const put = h.requests.filter((r) => r.method === 'PUT')
    expect(put).toHaveLength(1)
    expect(put[0]?.url).toBe(
      `http://127.0.0.1:41001/api/streams?name=cam1_high&src=${encodeURIComponent(SOURCE)}`,
    )
    expect(put[0]?.headers.Authorization).toBe(h.manager.authHeader())
    expect(h.manager.streams()).toEqual({ cam1_high: SOURCE })
  })

  it('only records a stream while go2rtc is down, and replays it into the next config', async () => {
    const h = createHarness()
    await h.manager.addStream('cam1_low', SOURCE)
    await h.manager.addStream('cam2_low', OTHER_SOURCE)
    expect(h.requests).toEqual([])
    expect(h.manager.streams()).toEqual({ cam1_low: SOURCE, cam2_low: OTHER_SOURCE })

    await h.manager.start()
    const yaml = h.writes[0]?.data ?? ''
    expect(yaml).toContain(`cam1_low: ${JSON.stringify(SOURCE)}`)
    expect(yaml).toContain(`cam2_low: ${JSON.stringify(OTHER_SOURCE)}`)
  })

  it('serves a stream added while a start is in flight (QUAL-8)', async () => {
    const h = createHarness()
    // The start parks in its readiness poll, which is where an `ensureStream` finds it.
    h.authStatus = null
    const starting = h.manager.start()
    await settle()
    await h.manager.addStream('cam1_low', SOURCE)
    expect(h.manager.streams()).toEqual({ cam1_low: SOURCE })

    h.authStatus = 200
    await h.clock.advance(READY_POLL_MS * 2)
    const runtime = await starting

    // The *running* go2rtc has it, not just the desired set: either it was in the config this
    // launch was given, or it was registered live as soon as the listener was verified.
    const yaml = h.writes.at(-1)?.data ?? ''
    const put = h.requests.filter(
      (r) => r.method === 'PUT' && r.url.includes('name=cam1_low') && r.url.includes('41001'),
    )
    expect(yaml.includes(`cam1_low: ${JSON.stringify(SOURCE)}`) || put.length === 1).toBe(true)
    expect(runtime).toEqual({ port: 41_001, epoch: 1 })
    expect(h.manager.streams()).toEqual({ cam1_low: SOURCE })
  })

  it('does not claim a stream the starting go2rtc refused', async () => {
    const h = createHarness()
    h.authStatus = null
    const starting = h.manager.start()
    await settle()
    await h.manager.addStream('cam1_low', SOURCE)
    // go2rtc comes up but will not take the late registration.
    h.streamsStatus = 500
    h.authStatus = 200
    await h.clock.advance(READY_POLL_MS * 2)
    await starting

    // `streams()` is what the next restart replays, so it must not claim what go2rtc rejected.
    expect(h.manager.streams()).toEqual({})
  })

  it('rolls the desired set back when go2rtc refuses the registration', async () => {
    const h = createHarness()
    await h.manager.start()
    h.streamsStatus = 500
    await expect(h.manager.addStream('cam1_low', SOURCE)).rejects.toThrow(/could not register/)
    expect(h.manager.streams()).toEqual({})
  })

  it('refuses an unsafe stream name and a source that is not on the pinned console host (R4)', async () => {
    const h = createHarness()
    await expect(h.manager.addStream('cam 1', SOURCE)).rejects.toThrow(/unsafe stream name/)
    await expect(
      h.manager.addStream('cam1_low', 'rtspx://evil.test:7441/aBcDeFgHiJkLmNoP'),
    ).rejects.toThrow(/not on the pinned console host/)
    expect(h.manager.streams()).toEqual({})

    const noHost = createHarness({ consoleHost: () => null })
    await expect(noHost.manager.addStream('cam1_low', SOURCE)).rejects.toThrow(/no console host/)
  })

  it('never puts the source URL in the error it throws (CON-2)', async () => {
    const h = createHarness()
    const foreign = 'rtspx://evil.test:7441/aBcDeFgHiJkLmNoP'
    const error: unknown = await h.manager
      .addStream('cam1_low', foreign)
      .catch((err: unknown) => err)
    expect(String(error)).toContain('not on the pinned console host')
    expect(String(error)).not.toContain('aBcDeFgHiJkLmNoP')
    expect(String(error)).not.toContain('evil.test')
  })

  it('drops a stream from the set and tells a running go2rtc, best effort', async () => {
    const h = createHarness()
    await h.manager.start()
    await h.manager.addStream('cam1_low', SOURCE)
    expect(await h.manager.removeStream('cam1_low')).toBe(true)
    expect(h.manager.streams()).toEqual({})
    expect(h.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)

    // Unknown name: nothing is sent, nothing throws, and go2rtc does not have it.
    expect(await h.manager.removeStream('nope_low')).toBe(true)
    expect(h.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)

    // A failing DELETE is logged and answered `false`, not thrown: the desired set is what the
    // next start uses, and the caller can say the running go2rtc may still have it (MODE-4).
    await h.manager.addStream('cam2_low', OTHER_SOURCE)
    h.streamsStatus = 500
    await expect(h.manager.removeStream('cam2_low')).resolves.toBe(false)
    expect(h.manager.streams()).toEqual({})
  })

  it('answers streamInfo with the allowlisted summary, and null when go2rtc is down (R7)', async () => {
    const h = createHarness()
    expect(await h.manager.streamInfo('cam1_low')).toBeNull()

    await h.manager.start()
    h.streamsBody = JSON.stringify({
      producers: [{ url: SOURCE, medias: ['video, recvonly, H265'], receivers: [] }],
      consumers: [],
    })
    const info = await h.manager.streamInfo('cam1_low')
    expect(info?.producerMedias).toEqual(['video, recvonly, H265'])
    expect(h.requests.at(-1)?.url).toBe('http://127.0.0.1:41001/api/streams?src=cam1_low')

    h.streamsBody = 'not json'
    expect(await h.manager.streamInfo('cam1_low')).toBeNull()
    h.streamsStatus = 404
    expect(await h.manager.streamInfo('cam1_low')).toBeNull()
    // An unsafe name never reaches the API.
    const before = h.requests.length
    expect(await h.manager.streamInfo('../api/config')).toBeNull()
    expect(h.requests).toHaveLength(before)
  })
})

describe('createGo2rtcManager — recovery (Gate G2, NFR-7)', () => {
  it('restarts on an unexpected exit, on a new port, with a new epoch and the streams replayed', async () => {
    const h = createHarness()
    await h.manager.addStream('cam1_low', SOURCE)
    await h.manager.start()

    h.lastChild().exit(1)
    await settle()
    expect(h.manager.runtime()).toBeNull()
    expect(h.manager.state()).toBe('restarting')

    await h.clock.advance(RESTART_BACKOFF.initialMs)
    expect(h.manager.runtime()).toEqual({ port: 41_002, epoch: 2 })
    expect(h.manager.state()).toBe('running')
    // The whole desired set goes into the regenerated config, so no re-registration race (QUAL-8).
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]?.data).toContain(`cam1_low: ${JSON.stringify(SOURCE)}`)
    expect(h.writes[1]?.data).toContain('listen: "127.0.0.1:41002"')
    // Listeners see the gap and the new runtime, which is how P2.2/P2.3 re-point the renderer.
    expect(h.runtimes).toEqual([{ port: 41_001, epoch: 1 }, null, { port: 41_002, epoch: 2 }])
    // New credentials for the new process.
    expect(h.manager.authHeader()).not.toBeNull()
  })

  it('restarts when the API stops answering although the process is alive', async () => {
    const h = createHarness({ healthIntervalMs: HEALTH_INTERVAL_MS })
    await h.manager.start()
    h.authStatus = 500

    await h.clock.advance(HEALTH_INTERVAL_MS)
    expect(h.logs.join('\n')).toContain('health check')
    // The wedged child is killed rather than left behind.
    expect(h.children[0]?.signals).toEqual(['SIGTERM'])

    h.authStatus = 200
    await h.clock.advance(RESTART_BACKOFF.initialMs)
    expect(h.manager.runtime()).toEqual({ port: 41_002, epoch: 2 })
  })

  it('backs off exponentially and gives up into `failed` after a bounded number of failures', async () => {
    const h = createHarness()
    await h.manager.start()
    // Nothing will ever come back up again.
    for (let port = 41_002; port <= 41_100; port++) h.impostorPorts.add(port)
    h.lastChild().exit(null, 'SIGKILL')
    await settle()

    const expected: number[] = []
    for (let i = 0; i < MAX_CONSECUTIVE_RESTART_FAILURES; i++) {
      const delay = Math.min(RESTART_BACKOFF.maxMs, RESTART_BACKOFF.initialMs * 2 ** i)
      expected.push(delay)
      await h.clock.advance(delay)
    }
    await h.clock.advance(RESTART_BACKOFF.maxMs)

    expect(h.clock.delays.filter((d) => expected.includes(d) && d >= 1000)).toEqual(
      expect.arrayContaining(expected),
    )
    expect(h.manager.state()).toBe('failed')
    expect(h.manager.runtime()).toBeNull()
    expect(h.logs.join('\n')).toContain('giving up after')
    // Bounded: 1 successful start + MAX restart attempts, each of which tried START_ATTEMPTS ports.
    expect(h.spawns).toHaveLength(1 + MAX_CONSECUTIVE_RESTART_FAILURES * START_ATTEMPTS)

    // An explicit start() is the way out of `failed`.
    h.impostorPorts.clear()
    const runtime = await h.manager.start()
    expect(runtime.epoch).toBe(2)
    expect(h.manager.state()).toBe('running')
  })

  it('joins an in-flight restart instead of racing it into a second spawn', async () => {
    const h = createHarness()
    await h.manager.start()
    h.lastChild().exit(1)
    await settle()
    expect(h.manager.state()).toBe('restarting')
    expect(h.manager.runtime()).toBeNull()

    // A cell asks for a stream while the restart loop is in its backoff sleep, and the attempt the
    // loop is about to make is slow (the lost-port race can cost up to READY_TIMEOUT_MS against a
    // 1 s backoff). Nothing may spawn here: a second go2rtc would hold the loopback listener and an
    // upstream RTSPS session that `stop()` can no longer reach.
    h.authStatus = null
    const joined = h.manager.start()
    await settle()
    expect(h.spawns).toHaveLength(1)

    await h.clock.advance(RESTART_BACKOFF.initialMs)
    expect(h.spawns).toHaveLength(2)
    h.authStatus = 200
    await h.clock.advance(READY_POLL_MS * 2)

    expect(await joined).toEqual({ port: 41_002, epoch: 2 })
    // Exactly one spawn per launch, and one `up` runtime: never two `up` events in a row.
    expect(h.spawns).toHaveLength(2)
    expect(h.runtimes).toEqual([{ port: 41_001, epoch: 1 }, null, { port: 41_002, epoch: 2 }])
    expect(h.runtimes.filter((r) => r !== null)).toHaveLength(2)
    expect(h.children.filter(isAlive)).toHaveLength(1)

    // And nothing survives the shutdown (CON-2, NFR-9: a stray child holds live credentials).
    await h.manager.stop()
    expect(h.children.filter(isAlive)).toEqual([])
  })

  it('never reports two `up` runtimes without a `down`, and leaves no child behind', async () => {
    const h = createHarness({ healthIntervalMs: HEALTH_INTERVAL_MS })
    await h.manager.start()
    // A wedged listener, then a start asked for from P2.2 while the restart is in flight, then a
    // crash of whatever came up: every path into a spawn, interleaved.
    h.authStatus = 500
    await h.clock.advance(HEALTH_INTERVAL_MS)
    h.authStatus = null
    const joined = h.manager.start().catch(() => undefined)
    await h.clock.advance(RESTART_BACKOFF.initialMs)
    h.authStatus = 200
    await h.clock.advance(READY_POLL_MS * 2)
    await joined
    h.lastChild().exit(1)
    await h.clock.advance(RESTART_BACKOFF.maxMs)

    // Never `up` twice running: every consumer of onRuntimeChange relies on seeing the gap.
    for (let i = 1; i < h.runtimes.length; i++)
      expect(h.runtimes[i] === null || h.runtimes[i - 1] === null).toBe(true)
    expect(h.children.filter(isAlive)).toHaveLength(1)
    await h.manager.stop()
    expect(h.children.filter(isAlive)).toEqual([])
  })

  it('keeps the failure budget across a crash loop, so the give-up bound is reachable', async () => {
    const h = createHarness()
    await h.manager.start()
    const backoffs: number[] = []

    // A go2rtc that dies a couple of seconds after every start: far short of
    // RESTART_STABLE_AFTER_MS, so no cycle may refresh the budget.
    for (let i = 0; i < MAX_CONSECUTIVE_RESTART_FAILURES; i++) {
      await h.clock.advance(2000)
      h.lastChild().exit(1)
      await settle()
      expect(h.manager.state()).toBe('restarting')
      const delay = h.clock.delays.at(-1) ?? 0
      backoffs.push(delay)
      await h.clock.advance(delay)
      expect(h.manager.state()).toBe('running')
    }

    // The backoff grows across the whole crash loop instead of being stuck at the first step.
    expect(backoffs).toEqual([1000, 2000, 4000, 8000, 16_000])

    await h.clock.advance(2000)
    h.lastChild().exit(1)
    await settle()
    expect(h.manager.state()).toBe('failed')
    expect(h.manager.runtime()).toBeNull()
    expect(h.logs.join('\n')).toContain('giving up after')
    // Bounded: the first start plus one spawn per restart, and nothing after the give-up.
    expect(h.spawns).toHaveLength(1 + MAX_CONSECUTIVE_RESTART_FAILURES)
    await h.clock.advance(RESTART_BACKOFF.maxMs * 4)
    expect(h.spawns).toHaveLength(1 + MAX_CONSECUTIVE_RESTART_FAILURES)
  })

  it('gives a run that stayed healthy a fresh failure budget (RESTART_STABLE_AFTER_MS)', async () => {
    const h = createHarness()
    await h.manager.start()
    h.lastChild().exit(1)
    await settle()
    await h.clock.advance(RESTART_BACKOFF.initialMs)
    expect(h.manager.state()).toBe('running')

    // This one stays up long enough to count as healthy, so its failure is a fresh problem.
    await h.clock.advance(RESTART_STABLE_AFTER_MS)
    h.lastChild().exit(1)
    await settle()
    expect(h.clock.delays.at(-1)).toBe(RESTART_BACKOFF.initialMs)
  })

  it('exposes the verified child pid only while go2rtc is up (P2.5 perf harness)', async () => {
    const h = createHarness()
    expect(h.manager.pid()).toBeNull()
    await h.manager.start()
    expect(h.manager.pid()).toBe(h.lastChild().pid)
    await h.manager.stop()
    expect(h.manager.pid()).toBeNull()
  })

  it('does not restart after a deliberate stop', async () => {
    const h = createHarness()
    await h.manager.start()
    const child = h.lastChild()
    await h.manager.stop()

    expect(child.signals).toEqual(['SIGTERM'])
    expect(h.manager.runtime()).toBeNull()
    expect(h.manager.state()).toBe('stopped')
    expect(h.manager.authHeader()).toBeNull()
    expect(h.runtimes).toEqual([{ port: 41_001, epoch: 1 }, null])
    // The config is removed again in case an interrupted start left one behind.
    expect(h.removals).toEqual([CONFIG_PATH, CONFIG_PATH])

    // Nothing comes back, whatever the clock does, and a late exit event changes nothing.
    child.exit(1)
    await h.clock.advance(60_000)
    expect(h.spawns).toHaveLength(1)
    expect(h.manager.runtime()).toBeNull()
  })

  it('SIGKILLs a child that ignores SIGTERM, and stop() is safe to call twice', async () => {
    const h = createHarness({})
    await h.manager.start()
    const child = h.lastChild()
    // Make this child ignore SIGTERM by swallowing the first signal.
    const original = child.kill.bind(child)
    let first = true
    child.kill = (signal = 'SIGTERM'): boolean => {
      child.signals.push(signal)
      if (first && signal === 'SIGTERM') {
        first = false
        return true
      }
      return original(signal)
    }

    const stopping = h.manager.stop()
    await h.clock.advance(6000)
    await stopping
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
    await expect(h.manager.stop()).resolves.toBeUndefined()
    expect(h.manager.state()).toBe('stopped')
  })

  it('stops a start that is still in flight', async () => {
    const h = createHarness()
    h.authStatus = null
    const starting = h.manager.start().catch(() => undefined)
    await settle()
    h.authStatus = 200
    const stopping = h.manager.stop()
    await h.clock.advance(1000)
    await starting
    await stopping
    expect(h.manager.runtime()).toBeNull()
    expect(h.manager.state()).toBe('stopped')
    expect(h.children.every((c) => c.exitCode !== null || c.signalCode !== null)).toBe(true)
  })
})

describe('createGo2rtcManager — logging (CON-2, NFR-9)', () => {
  it('pipes go2rtc output line by line through both redactors', async () => {
    const h = createHarness()
    await h.manager.start()
    const password = h.password()
    const child = h.lastChild()

    child.emit('stdout', '[api] listen addr=127.0.0.1:41001\n[rtsp] connect ')
    // Split across chunks on purpose: the line is only logged once it is complete.
    child.emit('stdout', `${SOURCE} failed\n`)
    child.emit('stderr', `[api] auth failed for user with password ${password}\n`)

    const piped = h.logs.filter((l) => l.startsWith('[go2rtc] ['))
    expect(piped).toEqual([
      '[go2rtc] [api] listen addr=127.0.0.1:41001',
      '[go2rtc] [rtsp] connect <redacted-source-url> failed',
      '[go2rtc] [api] auth failed for user with password <redacted>',
    ])
    const everything = h.logs.join('\n')
    expect(everything).not.toContain(password)
    expect(everything).not.toContain(HOST)
    expect(everything).not.toContain('aBcDeFgHiJkLmNoP')
  })

  it('never logs the credentials it generates', async () => {
    const h = createHarness()
    await h.manager.addStream('cam1_low', SOURCE)
    await h.manager.start()
    const header = h.manager.authHeader() ?? ''
    const everything = h.logs.join('\n')
    expect(everything).not.toContain(header.slice('Basic '.length))
    expect(everything).not.toContain(h.password())
    expect(everything).not.toContain(SOURCE)
  })

  it('survives a listener that throws', async () => {
    const h = createHarness()
    const thrower = vi.fn(() => {
      throw new Error('listener is broken')
    })
    h.manager.onRuntimeChange(thrower)
    await expect(h.manager.start()).resolves.toEqual({ port: 41_001, epoch: 1 })
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(h.logs.join('\n')).toContain('a runtime listener threw')
  })

  it('stops notifying an unsubscribed listener', async () => {
    const h = createHarness()
    const seen: (Go2rtcRuntime | null)[] = []
    const off = h.manager.onRuntimeChange((runtime) => seen.push(runtime))
    await h.manager.start()
    off()
    await h.manager.stop()
    expect(seen).toEqual([{ port: 41_001, epoch: 1 }])
  })
})

describe('go2rtcBinaryPath', () => {
  it('matches the layout scripts/fetch-go2rtc.ts installs', () => {
    expect(go2rtcBinaryPath('/app/resources', 'darwin', 'arm64')).toBe(
      '/app/resources/bin/darwin-arm64/go2rtc',
    )
    expect(go2rtcBinaryPath('/app/resources', 'win32', 'x64')).toBe(
      '/app/resources/bin/win32-x64/go2rtc.exe',
    )
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})
