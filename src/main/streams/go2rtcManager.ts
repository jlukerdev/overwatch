// P2.1 — the go2rtc sidecar's lifecycle: spawn on a free loopback port, prove the port is ours,
// keep it alive, and shut it down cleanly. SPEC §5.3 is the normative contract for all of it.
//
// This is the module that turns the P0.5 spike's one-shot launcher into something an app can run
// for eight hours (Gate G6) and that recovers by itself after go2rtc is killed (Gate G2, NFR-7).
// The parts that are a *value* rather than an action live next door in `./go2rtcConfig.ts`
// (config, credentials, URLs, redactors) and `./ownership.ts` (the port-race verdict); both are
// ports of the reviewed spike code in `scripts/spikes/video-spike/lib.ts`, copied rather than
// imported because `src/main` may not import from `scripts/`.
//
// The five things worth understanding before changing anything here:
//
//  1. **The port is not stable, so nothing may cache it.** A free port is found, go2rtc binds it,
//     and the bind is verified — and every restart repeats that on a *new* port. `onRuntimeChange`
//     exists for exactly this: P2.2/P2.3 re-point the registry and the renderer at `{ port, epoch }`
//     instead of remembering a port. `epoch` is a monotonically increasing restart counter, so a
//     consumer can tell "same go2rtc" from "a new one that needs its streams re-attached".
//  2. **The listener has to be proved ours** (SPEC §5.3 "Listener ownership"). Finding a free port
//     and binding it are not atomic, and go2rtc keeps running without a listener when its bind
//     fails, so after every start — including every restart — the app checks authenticated
//     `GET /api` → 200, unauthenticated → 401, and listening PID == child PID. On failure the child
//     is killed, the config deleted, and the whole thing retried on a new port, 3 attempts
//     (`START_ATTEMPTS`). See `./ownership.ts` for why all three facts are needed.
//  2b. **One spawn at a time.** `start()` and the restart loop both go through a single
//     mutual-exclusion point (`launch`), and `start()` *joins* an in-flight restart instead of
//     racing its backoff sleep. Every spawned child is held in `liveChildren` until it exits, so a
//     child that loses a race or is superseded is always signalled and `stop()` can never leave a
//     live go2rtc holding the loopback listener and an upstream RTSPS session (CON-2, NFR-9).
//  3. **The config file is a secret and is deleted** (SPEC §5.3, CON-2, NFR-9). It holds the RTSPS
//     source URLs (whose alias is the camera's stream credential) and the per-launch API
//     credentials. It is written `0600`, with an explicit `chmod` on non-Windows because `mode` on
//     `writeFile` is subject to the process umask for a file that already exists, and removed as
//     soon as the API answers — go2rtc keeps it in memory. It is removed on every failure path and
//     on `stop()` too, so an interrupted start cannot leave it behind.
//  4. **The desired stream set is the source of truth, not go2rtc's.** `addStream`/`removeStream`
//     record what *should* exist; a stream added while go2rtc is up also goes in live through an
//     authenticated `PUT /api/streams`. Every (re)start writes the whole set into the generated
//     YAML, so a restart replays it with no window in which a cell has no stream (QUAL-8) and no
//     race between "go2rtc is back" and "re-register everything". The set is read per *attempt*,
//     and a stream recorded after an attempt's config was written is registered live as soon as
//     that listener is verified, so a stream added mid-start is never missing until the next
//     restart. What `streams()` reports is therefore always what the running go2rtc has.
//  5. **No secret and no Electron leaves this module.** `authHeader()` is for main only; the
//     renderer gets a port and a stream name (CON-2, NFR-9). Every impure dependency — spawn, the
//     free port, the HTTP probe, the PID lookup, the filesystem, the clock, the delay, the
//     randomness, the binary path, the platform and the log — is injected, so the whole lifecycle
//     including the port race, the crash restart, the backoff and the give-up is unit-tested in
//     plain Node with no real go2rtc binary and no Electron (`tests/unit/go2rtcManager.test.ts`).
//     `app.getPath('userData')` and the `session`/`webRequest` header injection stay in
//     `src/main/index.ts`, which is wired in a later task.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fetch } from 'undici'
import {
  GO2RTC_CONFIG_FILE,
  GO2RTC_HOST,
  authSecrets,
  basicAuthHeader,
  buildGo2rtcConfig,
  createGo2rtcAuth,
  go2rtcApiUrl,
  isSafeStreamName,
  redactSecrets,
  redactSourceUrls,
  sourceHostIs,
  summarizeGo2rtcStream,
  type Go2rtcAuth,
  type StreamCodecSummary,
} from './go2rtcConfig'
import { decideOwnership, parseLsofPids, parseNetstatListenPids } from './ownership'

const execFileAsync = promisify(execFile)

// --- thresholds, all named on purpose ----------------------------------------------------------

/** SPEC §5.3: on a lost port race, retry on a new port "up to 3 attempts". */
export const START_ATTEMPTS = 3

/** How long one attempt waits for the API to answer. P0.5 measured go2rtc up ~160 ms after spawn. */
export const READY_TIMEOUT_MS = 10_000

/** Readiness poll interval, as in the spike. */
export const READY_POLL_MS = 150

/** Timeout for main's own loopback API calls. Loopback is fast; a hang means something is wrong. */
export const API_TIMEOUT_MS = 3000

/**
 * Health poll interval (Gate G2, NFR-7). The child's `exit` event covers a crash within
 * milliseconds; this covers the nastier case where the process is alive but its API has stopped
 * answering (a wedged listener, or the port taken over), which no signal would tell us about.
 */
export const HEALTH_INTERVAL_MS = 5000

/** SIGTERM grace period before SIGKILL on shutdown. */
export const STOP_GRACE_MS = 5000

/**
 * Consecutive failed restarts before the manager gives up into `failed` and stops trying. A bound
 * is required: without one, a machine where go2rtc can never bind (a mandatory-ACL environment, a
 * missing binary) would respawn for ever and the user would see nothing but a spinning grid. 5
 * attempts with the backoff below spans about a minute, which covers a console reboot or a sleep/
 * wake, and after that the state is reported rather than hidden. `start()` clears it and tries again.
 */
export const MAX_CONSECUTIVE_RESTART_FAILURES = 5

/** Capped exponential restart backoff: 1 s, 2 s, 4 s, 8 s, 16 s, … capped at 30 s. */
export const RESTART_BACKOFF = { initialMs: 1000, maxMs: 30_000, factor: 2 } as const

/**
 * How long a runtime must have been healthy before a failure is treated as a fresh problem rather
 * than as the continuation of a flap. A run this long is the **only** thing that clears
 * {@link MAX_CONSECUTIVE_RESTART_FAILURES}'s budget apart from an explicit `start()`: a successful
 * start does not, or a go2rtc that starts and dies two seconds later would reset the budget on
 * every cycle and never reach `failed`. Same idea as `DEFAULT_STABLE_AFTER_MS` in
 * `protect/subscriptions.ts`.
 */
export const RESTART_STABLE_AFTER_MS = 60_000

/** Guard against a go2rtc that writes megabytes without a newline: flush the buffer as one line. */
const MAX_LOG_LINE_CHARS = 8192

// --- injected dependencies ----------------------------------------------------------------------

/** The slice of a child process this module uses, so a test can pass a hand-driven fake. */
export interface Go2rtcChild {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdout: Go2rtcOutputStream | null
  readonly stderr: Go2rtcOutputStream | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: () => void): unknown
}

/** The slice of a readable stream this module uses (line-buffered, UTF-8 text). */
export interface Go2rtcOutputStream {
  setEncoding(encoding: 'utf8'): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
}

export interface Go2rtcSpawnOptions {
  readonly cwd: string
  /** stdin closed, stdout and stderr piped so every line can go through the redactors. */
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
  readonly windowsHide: true
}

export type Go2rtcSpawn = (
  command: string,
  args: readonly string[],
  options: Go2rtcSpawnOptions,
) => Go2rtcChild

export interface Go2rtcHttpRequest {
  readonly url: string
  readonly method: 'GET' | 'PUT' | 'DELETE'
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

/** The body is handed over as text: parsing it is the caller's business, and it may not be JSON. */
export interface Go2rtcHttpResponse {
  readonly status: number
  readonly body: string
}

/** A `fetch`-like probe for the loopback API. Rejects on a transport error. */
export type Go2rtcHttp = (request: Go2rtcHttpRequest) => Promise<Go2rtcHttpResponse>

/** The filesystem operations the config file needs, injected so no test writes to disk. */
export interface Go2rtcFileSystem {
  mkdir(dir: string): Promise<void>
  writeFile(path: string, data: string, mode: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  /** Must not reject when the file is already gone. */
  remove(path: string): Promise<void>
}

export interface Go2rtcManagerOptions {
  /** Where `go2rtc.yaml` is written. `<userData>` in the app (ARCHITECTURE §4). */
  readonly configDir: string
  /** The bundled binary for this platform, resolved per start so a path error is reportable. */
  readonly binaryPath: () => string
  /**
   * The pinned console host (CON-3). Read per call, because the user can change the address while
   * the app runs. R4: a source pointing anywhere else is refused — the unpinned `rtspx://` scheme
   * is only ever used toward this host. P2.2 owns *producing* sources; this module only refuses a
   * bad one.
   */
  readonly consoleHost: () => string | null
  readonly spawn?: Go2rtcSpawn
  /** A free loopback port. Not atomic with go2rtc's bind, hence the ownership check. */
  readonly freePort?: () => Promise<number>
  readonly http?: Go2rtcHttp
  /** PIDs listening on a port, or null if they could not be read. */
  readonly listenerPids?: (port: number) => Promise<number[] | null>
  readonly fs?: Go2rtcFileSystem
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** Cryptographically random bytes for the per-launch API credentials. */
  readonly random?: (n: number) => Uint8Array
  /** Decides whether `chmod` runs and whether the PID check is mandatory (SPEC §5.3). */
  readonly platform?: NodeJS.Platform
  /** Default {@link HEALTH_INTERVAL_MS}. 0 turns the health poll off (the exit watch stays). */
  readonly healthIntervalMs?: number
  /** Safe lines only — no credential, no source URL (CON-2, NFR-9). Default: no-op. */
  readonly log?: (line: string) => void
}

// --- public surface -----------------------------------------------------------------------------

/**
 * `starting`/`restarting` are in-flight; `running` means a verified listener exists; `failed` is
 * the give-up state of {@link MAX_CONSECUTIVE_RESTART_FAILURES} and only `start()` leaves it.
 */
export type Go2rtcState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'

/** What a consumer needs to reach go2rtc, and nothing else (CON-2). Safe for the renderer. */
export interface Go2rtcRuntime {
  /** Loopback port of the verified API listener. Changes on every restart. */
  readonly port: number
  /** Monotonically increasing: 1 for the first start, +1 for every successful (re)start. */
  readonly epoch: number
}

export interface Go2rtcManager {
  /**
   * Starts go2rtc and resolves once a *verified* listener is up. Idempotent: on a healthy runtime
   * it resolves with the existing one, concurrent calls share a single in-flight start, and a
   * restart that is already in flight is **joined** rather than raced — so this can wait out the
   * current restart backoff rather than spawning a second go2rtc. Also clears a previous `failed`
   * state and tries again. Rejects when no attempt produced a verified listener, so the caller can
   * report why.
   */
  start(): Promise<Go2rtcRuntime>
  /**
   * Deliberate shutdown: SIGTERM, grace period, SIGKILL fallback, delete the config, clear the
   * runtime and notify listeners with `null`. Never triggers a restart. Safe to call twice.
   */
  stop(): Promise<void>
  /** The verified runtime, or null when go2rtc is not up. */
  runtime(): Go2rtcRuntime | null
  state(): Go2rtcState
  /**
   * `Authorization: Basic …` for the current launch, or null when go2rtc is not up.
   * **Main-process use only** (CON-2, NFR-9): it must never reach the renderer or a log line. Main
   * injects it into the renderer's requests in a `webRequest` hook (a later task).
   */
  authHeader(): string | null
  /**
   * The OS process id of the verified go2rtc child, or null when go2rtc is not up. Read-only and
   * not a secret; the P2.5 perf harness uses it to sample go2rtc's CPU and memory.
   */
  pid(): number | null
  /**
   * Records `name` → `source` in the desired set and, when go2rtc is up, registers it live through
   * `PUT /api/streams`. Rejects an unsafe name or a source that is not on the pinned console host
   * (R4). While go2rtc is down it only records, and the next start writes it into the YAML; while a
   * start is *in flight* it also only records, and that launch registers it as soon as its listener
   * is verified (QUAL-8).
   */
  addStream(name: string, source: string): Promise<void>
  /** Drops `name` from the desired set, and from a running go2rtc on a best-effort basis. */
  removeStream(name: string): Promise<void>
  /** The desired set: what the next (re)start will put in the config. */
  streams(): Record<string, string>
  /**
   * The allowlisted `/api/streams` summary for one stream (R7: the codec is only knowable at
   * runtime). Null when go2rtc is down or the stream is unknown — never throws, because callers
   * ask this opportunistically.
   */
  streamInfo(name: string): Promise<StreamCodecSummary | null>
  /**
   * Fires on every runtime change with `{ port, epoch }` or `null`. This is how P2.2/P2.3 survive a
   * restart on a new port. It does **not** fire on subscribe — read {@link Go2rtcManager.runtime}
   * for the current value. Returns an unsubscribe function.
   */
  onRuntimeChange(listener: (runtime: Go2rtcRuntime | null) => void): () => void
}

// --- real implementations of the injected dependencies -----------------------------------------

const nodeSpawn: Go2rtcSpawn = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    // The app keeps no secrets in its environment (they are in the keystore), unlike the P0.5
    // spike, which had to hand go2rtc a stripped environment because it parsed `.env.local`.
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
  })

const nodeFs: Go2rtcFileSystem = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true })
  },
  async writeFile(path, data, mode) {
    await writeFile(path, data, { mode, encoding: 'utf8' })
  },
  async chmod(path, mode) {
    await chmod(path, mode)
  },
  async remove(path) {
    await rm(path, { force: true })
  },
}

const nodeHttp: Go2rtcHttp = async (request) => {
  const res = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    signal: AbortSignal.timeout(request.timeoutMs),
  })
  // Always drained, so the connection is released even when the body is not wanted.
  return { status: res.status, body: await res.text() }
}

const timerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** A free loopback port. The window between this close and go2rtc's bind is what {@link decideOwnership} guards. */
const freeLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, GO2RTC_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port === 0) reject(new Error('could not find a free loopback port'))
        else resolve(port)
      })
    })
  })

/** `lsof` on macOS/Linux, `netstat` on Windows (SPEC §5.3). Null means "could not be read". */
const nodeListenerPids = async (port: number): Promise<number[] | null> => {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      return parseNetstatListenPids(stdout, port)
    }
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp'],
      { timeout: 10_000 },
    )
    return parseLsofPids(stdout)
  } catch (err) {
    // lsof exits 1 with no output when nothing listens: that is an empty list, not "unreadable".
    const e = err as { code?: unknown; stdout?: unknown }
    if (e.code === 1 && typeof e.stdout === 'string') return parseLsofPids(e.stdout)
    return null
  }
}

/**
 * The bundled binary for one platform/arch, in the layout `scripts/fetch-go2rtc.ts` installs
 * (`resources/bin/<platform>-<arch>/`, see `scripts/lib/go2rtc.ts`). Pure path arithmetic, so the
 * caller — `src/main/index.ts` in a later task — only has to supply the resources root.
 */
export function go2rtcBinaryPath(
  resourcesRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const exe = platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'
  return join(resourcesRoot, 'bin', `${platform}-${arch}`, exe)
}

// --- the manager --------------------------------------------------------------------------------

export function createGo2rtcManager(options: Go2rtcManagerOptions): Go2rtcManager {
  const spawnChild = options.spawn ?? nodeSpawn
  const freePort = options.freePort ?? freeLoopbackPort
  const http = options.http ?? nodeHttp
  const listenerPids = options.listenerPids ?? nodeListenerPids
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? timerSleep
  const platform = options.platform ?? process.platform
  const healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS
  const log = options.log ?? ((): void => undefined)
  const random = options.random ?? ((n: number): Uint8Array => randomBytes(n))

  const configPath = join(options.configDir, GO2RTC_CONFIG_FILE)

  /** go2rtc stream name → source URL. Insertion-ordered, and replayed into every generated config. */
  const desired = new Map<string, string>()
  const listeners = new Set<(runtime: Go2rtcRuntime | null) => void>()

  /** The credentials of the *current* launch. New ones are generated for every attempt. */
  let auth: Go2rtcAuth | null = null
  /** The most recently spawned child, verified or not, so `stop()` can always reach it. */
  let child: Go2rtcChild | null = null
  /**
   * **Every** child that has been spawned and has not exited. `child` is only the latest one, and a
   * child that lost a port race, or that was superseded for any other reason, still holds a
   * loopback listener with the launch credentials and an upstream RTSPS session to the console
   * (CON-2, NFR-9) — so `stop()` signals this whole set and not just the last one.
   */
  const liveChildren = new Set<Go2rtcChild>()
  /** The child whose listener passed {@link decideOwnership}. Only this one triggers a restart. */
  let verifiedChild: Go2rtcChild | null = null
  let runtimeValue: Go2rtcRuntime | null = null
  let stateValue: Go2rtcState = 'stopped'
  let epoch = 0
  /** False while stopped or stopping: every loop checks it, so `stop()` can never be undone. */
  let desiredRunning = false
  /**
   * The **one** mutual-exclusion point for spawning: both `start()` and the restart loop go through
   * {@link launch}, so at most one `startOnce()` — and therefore at most one spawn attempt — is
   * ever in flight. Without it a `start()` during the restart loop's backoff sleep could spawn a
   * second go2rtc, and the loop a third, each overwriting `child` and leaving the previous one
   * running where no shutdown path could reach it.
   */
  let launchPromise: Promise<Go2rtcRuntime> | null = null
  let restartPromise: Promise<void> | null = null
  let consecutiveFailures = 0
  let startedAt = 0
  /** Identity of the live health poll. Replacing it retires the previous loop. */
  let monitorToken: object | null = null

  const readState = (): Go2rtcState => stateValue
  // Read through accessors in the async loops below: a plain read of the closure variable is
  // narrowed by the compiler to the value it had when the loop started, which is exactly what a
  // concurrent `stop()` or a successful restart is allowed to change under them.
  const wantRunning = (): boolean => desiredRunning
  const currentRuntime = (): Go2rtcRuntime | null => runtimeValue

  /** Error text that is safe to log: no source URL, no credential (CON-2, NFR-9). */
  const safeMessage = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err)
    const current = auth
    return redactSecrets(redactSourceUrls(raw), current === null ? [] : authSecrets(current))
  }

  const emitRuntime = (): void => {
    const value = runtimeValue
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (err) {
        // A consumer's bug must not take the sidecar's lifecycle down with it.
        log(`[go2rtc] a runtime listener threw: ${safeMessage(err)}`)
      }
    }
  }

  const clearRuntime = (): void => {
    monitorToken = null
    auth = null
    if (runtimeValue === null) return
    runtimeValue = null
    emitRuntime()
  }

  /** R4 and the stream-name allowlist, checked for every source before it can reach a config. */
  const assertStream = (name: string, source: string): void => {
    if (!isSafeStreamName(name)) throw new Error(`go2rtc: unsafe stream name "${name}"`)
    const host = options.consoleHost()
    if (host === null || host.trim() === '')
      throw new Error('go2rtc: no console host is configured, so no source can be trusted (R4)')
    // The source is never put in the message: its alias is the camera's stream credential (CON-2).
    if (!sourceHostIs(source, host))
      throw new Error(`go2rtc: source for stream "${name}" is not on the pinned console host (R4)`)
  }

  const authHeaders = (a: Go2rtcAuth): Record<string, string> => ({
    Authorization: basicAuthHeader(a),
  })

  /** `GET /api` with or without the credentials. Null means nothing answered. */
  const apiStatus = async (
    port: number,
    withAuth: boolean,
    a: Go2rtcAuth,
  ): Promise<number | null> => {
    try {
      const res = await http({
        url: go2rtcApiUrl(port, '/api'),
        method: 'GET',
        headers: withAuth ? authHeaders(a) : {},
        timeoutMs: API_TIMEOUT_MS,
      })
      return res.status
    } catch {
      return null
    }
  }

  /** Waits until something answers on the port, and returns the authenticated status it gave. */
  const waitForApi = async (port: number, c: Go2rtcChild, a: Go2rtcAuth): Promise<number> => {
    const deadline = now() + READY_TIMEOUT_MS
    for (;;) {
      if (c.exitCode !== null || c.signalCode !== null)
        throw new Error(
          `go2rtc exited during startup (code ${String(c.exitCode)}, signal ${String(c.signalCode)})`,
        )
      const status = await apiStatus(port, true, a)
      if (status !== null) return status
      if (now() >= deadline) throw new Error('go2rtc API did not answer in time')
      await sleep(READY_POLL_MS)
    }
  }

  /** Pipes one output stream into `log`, line by line, through both redactors. */
  const pipeLines = (stream: Go2rtcOutputStream | null, a: Go2rtcAuth): void => {
    if (stream === null) return
    const secrets = authSecrets(a)
    const emit = (line: string): void => {
      const trimmed = line.trimEnd()
      if (trimmed !== '') log(`[go2rtc] ${redactSecrets(redactSourceUrls(trimmed), secrets)}`)
    }
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        emit(buffer.slice(0, i))
        buffer = buffer.slice(i + 1)
      }
      if (buffer.length > MAX_LOG_LINE_CHARS) {
        emit(buffer)
        buffer = ''
      }
    })
  }

  /** SIGTERM, grace period, SIGKILL fallback (ported from the spike's `stopChild`). */
  const killChild = async (c: Go2rtcChild): Promise<void> => {
    if (c.exitCode !== null || c.signalCode !== null) {
      liveChildren.delete(c)
      return
    }
    const exited = new Promise<void>((resolve) => {
      c.once('exit', () => {
        resolve()
      })
    })
    c.kill('SIGTERM')
    const graceful = await Promise.race([
      exited.then(() => true),
      sleep(STOP_GRACE_MS).then(() => false),
    ])
    if (!graceful) {
      log('[go2rtc] did not exit on SIGTERM, sending SIGKILL')
      c.kill('SIGKILL')
      await exited
    }
    liveChildren.delete(c)
  }

  /**
   * The health poll (Gate G2). Retired by replacing `monitorToken`, which is how a `stop()` or a
   * restart guarantees that an in-flight poll cannot act on a runtime that no longer exists.
   */
  const monitor = async (token: object, port: number): Promise<void> => {
    if (healthIntervalMs <= 0) return
    while (token === monitorToken && wantRunning()) {
      await sleep(healthIntervalMs)
      if (token !== monitorToken || !wantRunning()) return
      const current = auth
      if (current === null) return
      const status = await apiStatus(port, true, current)
      if (token !== monitorToken || !wantRunning()) return
      if (status === 200) continue
      log(
        `[go2rtc] health check on port ${String(port)} answered ${String(status ?? 'nothing')}: restarting`,
      )
      await teardownAndRestart('a failed health check')
      return
    }
  }

  /** A crash or a failed health check: tear the runtime down and hand over to the restart loop. */
  const teardownAndRestart = async (reason: string): Promise<void> => {
    monitorToken = null
    const dead = child
    child = null
    verifiedChild = null
    clearRuntime()
    if (dead !== null) await killChild(dead)
    await fs.remove(configPath)
    if (stateValue !== 'failed') stateValue = 'restarting'
    scheduleRestart(reason)
  }

  const onUnexpectedExit = (c: Go2rtcChild): void => {
    if (!desiredRunning || c !== verifiedChild) return
    log(
      `[go2rtc] exited unexpectedly (code ${String(c.exitCode)}, signal ${String(c.signalCode)}): restarting`,
    )
    void teardownAndRestart('an unexpected exit').catch((err: unknown) => {
      log(`[go2rtc] restart after an unexpected exit failed: ${safeMessage(err)}`)
    })
  }

  const backoffMs = (failures: number): number =>
    Math.min(RESTART_BACKOFF.maxMs, RESTART_BACKOFF.initialMs * RESTART_BACKOFF.factor ** failures)

  const runRestartLoop = async (reason: string): Promise<void> => {
    // A runtime that was healthy for long enough gets a fresh budget; a flapping one does not.
    if (startedAt !== 0 && now() - startedAt >= RESTART_STABLE_AFTER_MS) consecutiveFailures = 0
    log(`[go2rtc] restarting after ${reason}`)
    while (wantRunning()) {
      consecutiveFailures += 1
      if (consecutiveFailures > MAX_CONSECUTIVE_RESTART_FAILURES) {
        stateValue = 'failed'
        log(
          `[go2rtc] giving up after ${String(MAX_CONSECUTIVE_RESTART_FAILURES)} consecutive ` +
            'failed restarts: streams stay down until start() is called again',
        )
        return
      }
      const delay = backoffMs(consecutiveFailures - 1)
      log(
        `[go2rtc] restart attempt ${String(consecutiveFailures)} of ${String(MAX_CONSECUTIVE_RESTART_FAILURES)} in ${String(delay)} ms`,
      )
      await sleep(delay)
      if (!wantRunning()) return
      // An explicit `start()` may have won the race while this loop was sleeping.
      if (currentRuntime() !== null) return
      try {
        // Through the same mutex `start()` uses, so a restart and an explicit start can never both
        // be spawning a go2rtc.
        await launch()
        return
      } catch (err) {
        log(`[go2rtc] restart attempt ${String(consecutiveFailures)} failed: ${safeMessage(err)}`)
      }
    }
  }

  const scheduleRestart = (reason: string): void => {
    if (!desiredRunning || restartPromise !== null) return
    const loop = runRestartLoop(reason)
    restartPromise = loop
    void loop
      .catch((err: unknown) => {
        log(`[go2rtc] the restart loop stopped with an error: ${safeMessage(err)}`)
      })
      .finally(() => {
        if (restartPromise === loop) restartPromise = null
      })
  }

  /** `PUT /api/streams`: registers one stream in a *running* go2rtc. Throws on any non-2xx. */
  const putStream = async (
    name: string,
    source: string,
    port: number,
    a: Go2rtcAuth,
  ): Promise<void> => {
    const url = `${go2rtcApiUrl(port, '/api/streams')}?name=${encodeURIComponent(name)}&src=${encodeURIComponent(source)}`
    const res = await http({
      url,
      method: 'PUT',
      headers: authHeaders(a),
      timeoutMs: API_TIMEOUT_MS,
    })
    if (res.status < 200 || res.status >= 300)
      throw new Error(`PUT /api/streams answered ${String(res.status)}`)
  }

  /**
   * Registers whatever `addStream` recorded *after* this attempt's config was written. While a
   * start is in flight there is no runtime to register against, so `addStream` can only record —
   * and the launch that then comes up has to pick those streams up itself, or a cell would wait for
   * the next restart to get a picture (QUAL-8).
   *
   * A stream go2rtc refuses is dropped from the desired set rather than claimed: `streams()` means
   * "what the running go2rtc has", and P2.2's `ensureStream` is the retry.
   */
  const registerLate = async (
    written: ReadonlyMap<string, string>,
    runtime: Go2rtcRuntime,
    a: Go2rtcAuth,
  ): Promise<void> => {
    for (const [name, source] of [...desired]) {
      if (written.get(name) === source) continue
      try {
        await putStream(name, source, runtime.port, a)
        log(`[go2rtc] registered stream "${name}" added while go2rtc was starting`)
      } catch (err) {
        if (desired.get(name) === source) desired.delete(name)
        log(
          `[go2rtc] could not register stream "${name}" added while go2rtc was starting: ` +
            safeMessage(err),
        )
      }
    }
  }

  /**
   * One full start: config → spawn → readiness → delete the config → ownership verdict, retried on
   * a new port up to {@link START_ATTEMPTS} times (SPEC §5.3). Every attempt gets fresh
   * credentials, so a port taken over by someone else never sees the credentials twice.
   */
  const startOnce = async (): Promise<Go2rtcRuntime> => {
    let lastReason = 'no attempt was made'
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      // Read per attempt, not once before the loop: `addStream` while a start is in flight has no
      // runtime to register against, so the launch that comes up must pick it up itself. What this
      // attempt was given is remembered, and anything added after it is registered live below.
      for (const [name, source] of desired) assertStream(name, source)
      const written = new Map(desired)
      const port = await freePort()
      const launchAuth = createGo2rtcAuth(random)
      const config = buildGo2rtcConfig({
        port,
        streams: Object.fromEntries(written),
        auth: launchAuth,
      })
      await fs.mkdir(options.configDir)
      await fs.writeFile(configPath, config, 0o600)
      // `mode` on writeFile only applies to a file it creates, and is masked by the umask, so the
      // permissions are set again explicitly. Windows has no POSIX modes (the spike does the same).
      if (platform !== 'win32') await fs.chmod(configPath, 0o600)

      const spawned = spawnChild(options.binaryPath(), ['-c', configPath], {
        cwd: options.configDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = spawned
      liveChildren.add(spawned)
      pipeLines(spawned.stdout, launchAuth)
      pipeLines(spawned.stderr, launchAuth)
      spawned.once('exit', () => {
        liveChildren.delete(spawned)
        onUnexpectedExit(spawned)
      })

      let outcome: { ok: true; reason: string } | { ok: false; reason: string }
      try {
        const pid = spawned.pid
        if (pid === undefined) throw new Error('go2rtc could not be spawned (no pid)')
        const authStatus = await waitForApi(port, spawned, launchAuth)
        const verdict = decideOwnership({
          childPid: pid,
          authStatus,
          unauthStatus: await apiStatus(port, false, launchAuth),
          listenerPids: await listenerPids(port),
          // SPEC §5.3: lsof is mandatory on macOS/Linux, netstat is best effort on Windows.
          pidCheckRequired: platform !== 'win32',
        })
        outcome = verdict
      } catch (err) {
        outcome = { ok: false, reason: safeMessage(err) }
      } finally {
        // SPEC §5.3: the config holds the RTSPS and API credentials and go2rtc has it in memory.
        await fs.remove(configPath)
      }

      if (outcome.ok) {
        // Nothing else may stay alive behind a verified listener: a superseded child keeps a
        // loopback listener with its launch credentials and an upstream RTSPS session.
        for (const stray of [...liveChildren]) if (stray !== spawned) await killChild(stray)
        auth = launchAuth
        verifiedChild = spawned
        epoch += 1
        startedAt = now()
        const runtime: Go2rtcRuntime = { port, epoch }
        runtimeValue = runtime
        stateValue = 'running'
        // Deliberately *not* a reset of `consecutiveFailures`: only a run that lasted
        // {@link RESTART_STABLE_AFTER_MS} clears the budget (see `runRestartLoop`), or else a
        // go2rtc that dies seconds after every start would never reach `failed`.
        await registerLate(written, runtime, launchAuth)
        const token = {}
        monitorToken = token
        void monitor(token, port).catch((err: unknown) => {
          log(`[go2rtc] the health poll stopped with an error: ${safeMessage(err)}`)
        })
        log(
          `[go2rtc] ready on ${GO2RTC_HOST}:${String(port)} (epoch ${String(epoch)}, ` +
            `${String(desired.size)} stream(s); config file deleted; ${outcome.reason})`,
        )
        emitRuntime()
        return runtime
      }

      lastReason = outcome.reason
      log(
        `[go2rtc] start attempt ${String(attempt)} of ${String(START_ATTEMPTS)} on port ${String(port)} failed: ${lastReason}`,
      )
      await killChild(spawned)
      if (child === spawned) child = null
    }
    throw new Error(
      `go2rtc: no verified listener after ${String(START_ATTEMPTS)} attempts (${lastReason})`,
    )
  }

  /**
   * The mutual-exclusion point: one `startOnce()` at a time, whoever asked for it. Concurrent
   * callers share the attempt that is already running rather than spawning a second go2rtc.
   */
  const launch = async (): Promise<Go2rtcRuntime> => {
    const inflight = launchPromise
    if (inflight !== null) return await inflight
    const attempt = startOnce()
    launchPromise = attempt
    try {
      return await attempt
    } finally {
      if (launchPromise === attempt) launchPromise = null
    }
  }

  const start = async (): Promise<Go2rtcRuntime> => {
    desiredRunning = true
    // A restart loop that is mid-backoff has no runtime and no launch in flight, so a start here
    // would race it into a second spawn. It is *joined* instead: the loop either brings a runtime
    // up or gives up into `failed`, and only then does an explicit start try on its own — which is
    // what makes `start()` the documented way out of `failed`.
    const restarting = restartPromise
    if (restarting !== null) {
      await restarting.catch(() => undefined)
      const recovered = runtimeValue
      if (recovered !== null && verifiedChild !== null) return recovered
      // Through the accessor: a concurrent `stop()` is exactly what may have changed this under us.
      if (!wantRunning()) throw new Error('go2rtc: stopped while a restart was in flight')
    }
    const running = runtimeValue
    if (running !== null && verifiedChild !== null) return running
    const inflight = launchPromise
    if (inflight !== null) return await inflight
    // An explicit start is also the way out of `failed`, so the budget starts again.
    consecutiveFailures = 0
    stateValue = 'starting'
    try {
      return await launch()
    } catch (err) {
      // Read through the accessor, so the state a concurrent restart may have reached is honoured.
      if (runtimeValue === null && readState() !== 'failed') stateValue = 'stopped'
      throw err
    }
  }

  const stop = async (): Promise<void> => {
    // First, so that nothing a pending start or restart does afterwards can bring go2rtc back.
    desiredRunning = false
    monitorToken = null
    // Drained in this order and more than once: the restart loop owns the launch it starts, and a
    // launch that was already past its `wantRunning()` check can still finish under us. Both
    // handles are null again before anything is killed, so no spawn can outlive this.
    for (let drain = 0; drain < 3 && (launchPromise !== null || restartPromise !== null); drain++) {
      const inflightStart = launchPromise
      if (inflightStart !== null) await inflightStart.catch(() => undefined)
      const inflightRestart = restartPromise
      if (inflightRestart !== null) await inflightRestart.catch(() => undefined)
    }
    child = null
    verifiedChild = null
    // Every spawned child, not just the last: nothing may keep the loopback listener or the
    // upstream RTSPS session alive past a deliberate shutdown.
    for (const c of [...liveChildren]) await killChild(c)
    liveChildren.clear()
    // An interrupted start may have left the file behind, and it holds credentials.
    await fs.remove(configPath)
    clearRuntime()
    stateValue = 'stopped'
    consecutiveFailures = 0
    startedAt = 0
  }

  const addStream = async (name: string, source: string): Promise<void> => {
    assertStream(name, source)
    const previous = desired.get(name)
    desired.set(name, source)
    const runtime = runtimeValue
    const current = auth
    // Not running: recorded only. The next (re)start writes the whole set into the YAML, which is
    // what makes a restart replay every stream with no re-registration race (QUAL-8).
    if (runtime === null || current === null) return
    try {
      await putStream(name, source, runtime.port, current)
      log(`[go2rtc] registered stream "${name}"`)
    } catch (err) {
      // The desired set is rolled back so it keeps meaning "what go2rtc has": a source go2rtc
      // refused must not be resurrected by the next restart. P2.2's `ensureStream` is the retry.
      if (previous === undefined) desired.delete(name)
      else desired.set(name, previous)
      throw new Error(`go2rtc: could not register stream "${name}": ${safeMessage(err)}`, {
        cause: err,
      })
    }
  }

  const removeStream = async (name: string): Promise<void> => {
    if (!desired.delete(name)) return
    const runtime = runtimeValue
    const current = auth
    if (runtime === null || current === null) return
    // Best effort: the desired set is authoritative, and the next start simply leaves it out. A
    // stream go2rtc still knows about costs nothing while no consumer is attached (ARCHITECTURE §2).
    try {
      await http({
        url: `${go2rtcApiUrl(runtime.port, '/api/streams')}?src=${encodeURIComponent(name)}`,
        method: 'DELETE',
        headers: authHeaders(current),
        timeoutMs: API_TIMEOUT_MS,
      })
    } catch (err) {
      log(`[go2rtc] could not unregister stream "${name}": ${safeMessage(err)}`)
    }
  }

  const streamInfo = async (name: string): Promise<StreamCodecSummary | null> => {
    const runtime = runtimeValue
    const current = auth
    if (runtime === null || current === null || !isSafeStreamName(name)) return null
    try {
      const res = await http({
        url: `${go2rtcApiUrl(runtime.port, '/api/streams')}?src=${encodeURIComponent(name)}`,
        method: 'GET',
        headers: authHeaders(current),
        timeoutMs: API_TIMEOUT_MS,
      })
      if (res.status !== 200) return null
      return summarizeGo2rtcStream(JSON.parse(res.body) as unknown)
    } catch (err) {
      log(`[go2rtc] could not read stream info for "${name}": ${safeMessage(err)}`)
      return null
    }
  }

  return {
    start,
    stop,
    runtime: () => runtimeValue,
    state: readState,
    authHeader: () => (auth === null ? null : basicAuthHeader(auth)),
    pid: () => (runtimeValue === null ? null : (verifiedChild?.pid ?? null)),
    addStream,
    removeStream,
    streams: () => Object.fromEntries(desired),
    streamInfo,
    onRuntimeChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
