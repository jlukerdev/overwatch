// P0.5 video spike launcher. Node 24 runs this file directly (type stripping).
//
//   npm run spike:video                                  first G4/G5 camera with `high`, 60 s
//   npm run spike:video -- --camera Carport --quality medium --duration 20
//   npm run spike:video -- --keep-open                   leave the window open after measuring
//
// Read-only against the console: GET /v1/cameras and GET /v1/cameras/{id}/rtsps-stream only. It
// never POSTs: if the quality has no RTSPS URL yet, it exits and lists the qualities that exist.
//
// Flow: pinned-TLS API calls (scripts/spikes/lib/tls.ts) → go2rtc config with one rtspx://
// source in scripts/spikes/output/video-spike/ (gitignored, deleted once go2rtc has read it) →
// go2rtc on a free 127.0.0.1 port → bare Electron window (electron-main.ts) that plays the stream
// over MSE and records codecs, decoder, hardware decode, audio, latency and CPU → G0 verdict.
//
// Secrets: the key, the console host, RTSPS URLs and the per-launch go2rtc API credentials are
// never printed. Every go2rtc log line is redacted. Electron and go2rtc get an environment
// without any VP_* secrets from .env.local; Electron receives the loopback port, the stream name
// and the go2rtc `Authorization` header value (env var, read and removed at startup; never on the
// command line, never in the renderer).
//
// go2rtc's API requires Basic auth for every client, loopback included (`local_auth: true`), and
// after start the launcher checks that the listener on the port is really its go2rtc child
// (authenticated 200, unauthenticated 401, and the listening PID via lsof/netstat), retrying on a
// new port up to 3 times.
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { availableParallelism, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'
import { fetch } from 'undici'
import type { Agent } from 'undici'
import type { ProtectCamera, RtspsStreams } from '../../../src/main/protect/types.ts'
import { createSanitizer } from '../lib/sanitize.ts'
import { createPinnedAgent, fetchLeafCert, normalizeFingerprint } from '../lib/tls.ts'
import type { CameraLike, Go2rtcAuth, PsRow, Quality } from './lib.ts'
import {
  USAGE,
  asBool,
  authSecrets,
  basicAuthHeader,
  createGo2rtcAuth,
  decideOwnership,
  parseLsofPids,
  parseNetstatListenPids,
  redactSecrets,
  cheapestQuality,
  cpuByLabel,
  mediaCodecs,
  buildGo2rtcConfig,
  candidateCameras,
  cpuPercent,
  evaluateG0,
  existingQualities,
  go2rtcWsUrl,
  parsePsCpuTime,
  parsePsRows,
  parseSpikeArgs,
  redactSourceUrls,
  sourceHostIs,
  summarizeGo2rtcStream,
  toGo2rtcSource,
} from './lib.ts'
import type { StreamCodecSummary } from './lib.ts'
import type { SampleSummary } from './stats.ts'

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUTPUT = join(ROOT, 'scripts', 'spikes', 'output')
const SPIKE_OUT = join(OUTPUT, 'video-spike')
const STAGE = join(SPIKE_OUT, 'app')
const PIN_FILE = join(OUTPUT, 'console-pin.json')
const VENDOR_PLAYER = join(ROOT, 'src', 'renderer', 'src', 'player', 'vendor', 'video-rtc.js')
const API_PREFIX = '/proxy/protect/integration'
const MIN_REQUEST_GAP_MS = 150
const REQUEST_TIMEOUT_MS = 20_000
const GO2RTC_READY_TIMEOUT_MS = 10_000
const GO2RTC_START_ATTEMPTS = 3
const CPU_SAMPLE_MS = 5_000

// ---------------------------------------------------------------------------------------------
// Setup

const args = parseSpikeArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

// Parsed, not loaded into process.env: child processes must never inherit the secrets.
const envFile = join(ROOT, '.env.local')
if (!existsSync(envFile)) throw new Error('.env.local not found (see docs/spikes/P0.5-video.md)')
const localEnv = parseEnv(await readFile(envFile, 'utf8'))
const rawHost = (localEnv.VP_CONSOLE_HOST ?? '').trim()
const apiKey = (localEnv.VP_PROTECT_API_KEY ?? '').trim()
if (!rawHost || !apiKey)
  throw new Error('VP_CONSOLE_HOST and VP_PROTECT_API_KEY must be set in .env.local')
const consoleUrl = new URL(`https://${rawHost.replace(/^https?:\/\//, '')}`)
const host = consoleUrl.hostname
const consolePort = consoleUrl.port ? Number(consoleUrl.port) : 443

const sanitizer = createSanitizer({ secrets: [apiKey, host, rawHost] })
/** Fresh go2rtc API credentials for this launch only. */
const goAuth: Go2rtcAuth = createGo2rtcAuth((n) => randomBytes(n))
const goAuthHeader = basicAuthHeader(goAuth)
const goHeaders = { Authorization: goAuthHeader }
const LOOPBACK = '127.0.0.1'
const LOOPBACK_MARK = '<<loopback>>'
/** Prints a line after redaction (key, host, source URLs, home dir, ids, MACs, IPs other than
 * loopback). */
function say(line = ''): void {
  const masked = scrub(line).replaceAll(LOOPBACK, LOOPBACK_MARK)
  console.log(sanitizer.sanitizeString(masked).replaceAll(LOOPBACK_MARK, LOOPBACK))
}

/**
 * process.env without any VP_* variable, for child processes. Also drops ELECTRON_RUN_AS_NODE:
 * VS Code's terminals inherit it from the extension host, and it makes Electron run as plain Node.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VP_') && k !== 'ELECTRON_RUN_AS_NODE') out[k] = v
  }
  return { ...out, ...extra }
}

function message(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.cause === undefined ? err.message : `${err.message} <- ${message(err.cause)}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// Console API (GET only, pinned TLS)

async function resolvePinnedAgent(): Promise<Agent> {
  const leaf = await fetchLeafCert(host, consolePort)
  const actual = leaf.fingerprint256
  const fromEnv = localEnv.VP_CONSOLE_FINGERPRINT?.trim()
  let expected: string
  let source: string
  if (fromEnv) {
    expected = normalizeFingerprint(fromEnv)
    source = 'VP_CONSOLE_FINGERPRINT'
  } else if (existsSync(PIN_FILE)) {
    const saved = JSON.parse(await readFile(PIN_FILE, 'utf8')) as { fingerprint256?: unknown }
    if (typeof saved.fingerprint256 !== 'string')
      throw new Error('scripts/spikes/output/console-pin.json is unreadable: delete it to re-pin')
    expected = normalizeFingerprint(saved.fingerprint256)
    source = 'saved pin'
  } else {
    await mkdir(OUTPUT, { recursive: true })
    await writeFile(
      PIN_FILE,
      `${JSON.stringify({ fingerprint256: actual, savedAt: new Date().toISOString() }, null, 2)}\n`,
    )
    expected = actual
    source = 'first use (TOFU), saved to scripts/spikes/output/console-pin.json'
  }
  if (expected !== actual) {
    throw new Error(
      `TLS pin mismatch against ${source}. Refusing to connect. If the console certificate really ` +
        'changed, delete scripts/spikes/output/console-pin.json or set VP_CONSOLE_FINGERPRINT.',
    )
  }
  say(`TLS pin: ${source}`)
  return createPinnedAgent(expected)
}

let lastRequestAt = 0
async function apiGet(agent: Agent, path: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    const res = await fetch(`https://${consoleUrl.host}${API_PREFIX}${path}`, {
      method: 'GET',
      dispatcher: agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
    })
    const body: unknown = await res.json().catch(() => null)
    if (res.status === 429 && attempt < 3) {
      await sleep(1000)
      continue
    }
    if (!res.ok) {
      throw new Error(
        `GET ${path.replace(/[0-9a-f]{24}/gi, '{id}')} -> ${String(res.status)} ${JSON.stringify(sanitizer.sanitize(body))}`,
      )
    }
    return body
  }
}

interface Chosen {
  camera: CameraLike
  quality: Quality
  rtspsUrl: string
  existing: Quality[]
}

async function chooseStream(agent: Agent): Promise<Chosen> {
  const cameras = (await apiGet(agent, '/v1/cameras')) as ProtectCamera[]
  const candidates = candidateCameras(
    cameras.map((c) => ({ id: c.id, name: c.name ?? '', type: c.type ?? '', state: c.state })),
    args.camera,
  )
  if (candidates.length === 0) {
    throw new Error(
      args.camera === undefined
        ? 'No connected G4/G5 camera found. Pass --camera <name>.'
        : `No connected camera named "${args.camera}". Connected cameras: ${cameras
            .filter((c) => c.state === 'CONNECTED')
            .map((c) => c.name)
            .join(', ')}`,
    )
  }
  const seen: string[] = []
  for (const cam of candidates) {
    const streams = (await apiGet(agent, `/v1/cameras/${cam.id}/rtsps-stream`)) as RtspsStreams
    const existing = existingQualities(streams)
    const url = streams[args.quality]
    if (typeof url === 'string' && url !== '') {
      return { camera: cam, quality: args.quality, rtspsUrl: url, existing }
    }
    seen.push(`${cam.name} (${cam.type}): ${existing.join(', ') || 'none'}`)
  }
  throw new Error(
    `No candidate camera already has a "${args.quality}" RTSPS stream, and this spike never ` +
      `creates one (no POST). Existing qualities:\n  ${seen.join('\n  ')}\n` +
      'Pick one of those with --quality / --camera.',
  )
}

// ---------------------------------------------------------------------------------------------
// go2rtc

function go2rtcBinary(): string {
  const exe = process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'
  const p = join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`, exe)
  if (!existsSync(p)) throw new Error(`${p} not found: run npm run fetch:go2rtc first`)
  return p
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => {
        resolve(port)
      })
    })
  })
}

/** Status of `GET /api` with or without our credentials, or null if nothing answers. */
async function apiStatus(port: number, withAuth: boolean): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api`, {
      signal: AbortSignal.timeout(1000),
      headers: withAuth ? goHeaders : {},
    })
    await res.arrayBuffer()
    return res.status
  } catch {
    return null
  }
}

/** Waits until something answers on the port. Returns the authenticated status: 200 means our
 * go2rtc is (very likely) up; anything else means another listener has the port. */
async function waitForGo2rtc(port: number, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + GO2RTC_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`go2rtc exited early (${String(child.exitCode)})`)
    const status = await apiStatus(port, true)
    if (status !== null) return status
    await sleep(150)
  }
  throw new Error('go2rtc API did not come up in time')
}

/** PIDs listening on the port: lsof on macOS/Linux, netstat on Windows. null if unreadable. */
async function listenerPids(port: number): Promise<number[] | null> {
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
    // lsof exits 1 with no output when nothing listens: that's an empty list, not "unreadable".
    const e = err as { code?: unknown; stdout?: unknown }
    if (e.code === 1 && typeof e.stdout === 'string') return parseLsofPids(e.stdout)
    return null
  }
}

async function go2rtcStreamInfo(port: number, stream: string): Promise<StreamCodecSummary | null> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${String(port)}/api/streams?src=${encodeURIComponent(stream)}`,
      { signal: AbortSignal.timeout(3000), headers: goHeaders },
    )
    return summarizeGo2rtcStream(await res.json())
  } catch {
    return null
  }
}

/** Cumulative CPU seconds of a process, or null if it can't be read. */
async function cpuSeconds(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${String(pid)}).TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture)`,
        ],
        { windowsHide: true, timeout: 10_000 },
      )
      const n = Number(stdout.trim())
      return Number.isFinite(n) ? n : null
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)], {
      timeout: 5000,
    })
    return parsePsCpuTime(stdout)
  } catch {
    return null
  }
}

/** All processes with cumulative CPU time (macOS/Linux), or null on Windows / failure. */
async function psSnapshot(): Promise<PsRow[] | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,time=,args='], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parsePsRows(stdout)
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
  onLine?: (l: string) => void,
): void {
  if (!stream) return
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd()
      buf = buf.slice(i + 1)
      if (line) {
        say(`${prefix} ${line}`)
        onLine?.(line)
      }
    }
  })
}

async function stopChild(child: ChildProcess | undefined, name: string): Promise<void> {
  if (child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) =>
    child.once('exit', () => {
      r()
    }),
  )
  child.kill('SIGTERM')
  const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!done) {
    say(`${name} did not stop on SIGTERM, killing`)
    child.kill('SIGKILL')
    await exited
  }
}

// ---------------------------------------------------------------------------------------------
// Renderer staging

/** Strips types from the spike page modules and writes them, the CSS, the vendored player and an
 * index.html whose CSP allows only this go2rtc port, into STAGE. */
async function stageRenderer(port: number): Promise<void> {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })
  const strip = async (src: string, dest: string): Promise<void> => {
    const code = stripTypeScriptTypes(await readFile(src, 'utf8'), { mode: 'strip' })
    await writeFile(join(STAGE, dest), code.replaceAll("'../stats.ts'", "'./stats.js'"))
  }
  await strip(join(HERE, 'renderer', 'page.ts'), 'page.js')
  await strip(join(HERE, 'stats.ts'), 'stats.js')
  await copyFile(join(HERE, 'renderer', 'page.css'), join(STAGE, 'page.css'))
  await copyFile(VENDOR_PLAYER, join(STAGE, 'video-rtc.js'))
  const origin = `127.0.0.1:${String(port)}`
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ws://${origin} http://${origin}`,
    'media-src blob:',
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  const html = await readFile(join(HERE, 'renderer', 'index.html'), 'utf8')
  await writeFile(join(STAGE, 'index.html'), html.replace('__CSP__', csp))
}

// ---------------------------------------------------------------------------------------------
// Main

let go2rtc: ChildProcess | undefined
let electron: ChildProcess | undefined
const configPath = join(SPIKE_OUT, 'go2rtc.yaml')

async function cleanup(): Promise<void> {
  await stopChild(electron, 'Electron')
  await stopChild(go2rtc, 'go2rtc')
  await rm(configPath, { force: true })
}

process.once('SIGINT', () => {
  say('interrupted, shutting down')
  void cleanup().finally(() => process.exit(130))
})

interface ElectronResult {
  gpuFeatureStatus: Record<string, string>
  summary: SampleSummary
  media: Record<string, { properties: Record<string, unknown>; errors: unknown[] }>
  cpuPercentByProcessType: Record<string, number>
  lastMetrics: { byType: Record<string, { pids: number[] }> } | null
  [k: string]: unknown
}

function pickProperty(r: ElectronResult, name: string): unknown {
  for (const p of Object.values(r.media)) if (name in p.properties) return p.properties[name]
  return undefined
}

/**
 * The result holds no secrets by construction (no ids, URLs or host). Belt and braces: drop the
 * key/host if they ever appear, redact source URLs and shorten the home directory (Media-domain
 * messages can carry local file paths). The full fixture sanitizer is not used here because its
 * IPv4 rule would mangle Chrome and GPU driver version numbers.
 */
function scrub(text: string): string {
  let out = redactSecrets(
    redactSourceUrls(text).replace(/blob:[^\s"\\]+/g, 'blob:<id>'),
    authSecrets(goAuth),
  )
  for (const s of [apiKey, rawHost, host]) out = out.split(s).join('<redacted>')
  const home = homedir()
  if (home.length > 1) {
    out = out.split(home).join('~')
    out = out.split(JSON.stringify(home).slice(1, -1)).join('~') // JSON-escaped (Windows)
  }
  return out
}

/** Writes the config (gitignored output dir, 0600), starts go2rtc on a free loopback port, waits
 * for its API, deletes the config file again (go2rtc keeps it in memory) and verifies that the
 * listener is our child (decideOwnership). On a lost port race it kills the child and retries on
 * a new port, up to GO2RTC_START_ATTEMPTS times. */
async function startGo2rtc(
  streams: Record<string, string>,
): Promise<{ port: number; pid: number }> {
  for (const src of Object.values(streams)) {
    // The no-verify rtspx:// scheme is only ever used toward the console host the API was called on.
    if (!sourceHostIs(src, host)) throw new Error('RTSPS URL host is not the console host')
  }
  for (let attempt = 1; ; attempt++) {
    const port = await freeLoopbackPort()
    await mkdir(SPIKE_OUT, { recursive: true })
    await writeFile(configPath, buildGo2rtcConfig({ port, streams, auth: goAuth }), {
      mode: 0o600,
    })
    if (process.platform !== 'win32') await chmod(configPath, 0o600)
    const started = Date.now()
    const child = spawn(go2rtcBinary(), ['-c', configPath], {
      cwd: SPIKE_OUT,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    go2rtc = child
    pipeLines(child.stdout, '[go2rtc]')
    pipeLines(child.stderr, '[go2rtc]')
    if (child.pid === undefined) throw new Error('go2rtc failed to start')
    let authStatus: number
    try {
      authStatus = await waitForGo2rtc(port, child)
    } finally {
      await rm(configPath, { force: true })
    }
    const verdict = decideOwnership({
      childPid: child.pid,
      authStatus,
      unauthStatus: await apiStatus(port, false),
      listenerPids: await listenerPids(port),
      pidCheckRequired: process.platform !== 'win32',
    })
    if (verdict.ok) {
      say(
        `go2rtc ready on 127.0.0.1:${String(port)} in ${String(Date.now() - started)} ms (config file deleted; ${verdict.reason})`,
      )
      return { port, pid: child.pid }
    }
    say(`go2rtc attempt ${String(attempt)}: port ${String(port)} not ours (${verdict.reason})`)
    await stopChild(child, 'go2rtc')
    if (attempt >= GO2RTC_START_ATTEMPTS)
      throw new Error(`go2rtc: could not get a verified listener in ${String(attempt)} attempts`)
  }
}

/** Status of a WebSocket upgrade to /api/ws without credentials (101 would mean accepted). */
function unauthWsStatus(port: number, stream: string): Promise<string> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/api/ws?src=${encodeURIComponent(stream)}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Origin: `http://127.0.0.1:${String(port)}`,
      },
      timeout: 5000,
    })
    req.on('response', (res) => {
      res.resume()
      resolve(String(res.statusCode))
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve('101 (ACCEPTED)')
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('timeout')
    })
    req.on('error', (err) => {
      resolve(`error ${err.message}`)
    })
    req.end()
  })
}

/** Unauthenticated / wrong-credential requests against the live go2rtc. All must be refused. */
async function authRejectionChecks(
  port: number,
  stream: string,
): Promise<{ name: string; result: string; pass: boolean }[]> {
  const base = `http://127.0.0.1:${String(port)}`
  const status = async (path: string, headers: Record<string, string> = {}): Promise<string> => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000), headers })
      await res.arrayBuffer()
      return String(res.status)
    } catch (err) {
      return `error ${message(err)}`
    }
  }
  const wrong = basicAuthHeader({ username: goAuth.username, password: 'wrong-password-0000' })
  const checks = [
    { name: 'GET /api/streams, no credentials', result: await status('/api/streams') },
    {
      name: 'GET /api/streams, wrong password',
      result: await status('/api/streams', { Authorization: wrong }),
    },
    {
      name: 'WebSocket upgrade /api/ws, no credentials',
      result: await unauthWsStatus(port, stream),
    },
  ]
  return checks.map((c) => ({ ...c, pass: c.result === '401' }))
}

/** Codec probe through go2rtc (`/api/streams?src=…&video=all&audio=all`): connects the source,
 * reads its SDP and disconnects, without a player. */
async function go2rtcProbe(port: number, stream: string): Promise<StreamCodecSummary | null> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${String(port)}/api/streams?src=${encodeURIComponent(stream)}&video=all&audio=all`,
      { signal: AbortSignal.timeout(15_000), headers: goHeaders },
    )
    if (!res.ok) return null
    return summarizeGo2rtcStream(await res.json())
  } catch {
    return null
  }
}

/** --list: cameras, existing qualities and probed codecs. Read-only (GETs + RTSPS DESCRIBE). */
async function listCameras(): Promise<void> {
  const agent = await resolvePinnedAgent()
  const cameras = (await apiGet(agent, '/v1/cameras')) as ProtectCamera[]
  const rows: { name: string; type: string; existing: Quality[]; probe?: string }[] = []
  const streams: Record<string, string> = {}
  for (const c of cameras.filter((x) => x.state === 'CONNECTED')) {
    const s = (await apiGet(agent, `/v1/cameras/${c.id}/rtsps-stream`)) as RtspsStreams
    const existing = existingQualities(s)
    const q = cheapestQuality(existing)
    const url = q === undefined ? undefined : s[q]
    rows.push({ name: c.name ?? '?', type: c.type ?? '?', existing })
    if (typeof url === 'string') streams[`probe_${String(rows.length)}`] = toGo2rtcSource(url)
  }
  await agent.close()
  if (Object.keys(streams).length > 0) {
    const { port } = await startGo2rtc(streams)
    for (const [i, row] of rows.entries()) {
      const name = `probe_${String(i + 1)}`
      if (!(name in streams)) continue
      const info = await go2rtcProbe(port, name)
      const q = cheapestQuality(row.existing) ?? '?'
      row.probe = info
        ? `${q}: video ${mediaCodecs(info.producerMedias, 'video').join('+') || '?'}, audio ${mediaCodecs(info.producerMedias, 'audio').join('+') || 'none'}`
        : `${q}: probe failed`
    }
    await stopChild(go2rtc, 'go2rtc')
  }
  say('')
  for (const r of rows) {
    say(
      `${r.name.padEnd(16)} ${r.type.padEnd(18)} qualities: ${(r.existing.join(',') || 'none').padEnd(16)} ${r.probe ?? ''}`,
    )
  }
}

async function main(): Promise<void> {
  if (args.list) {
    await listCameras()
    return
  }
  say(
    `P0.5 video spike: quality=${args.quality} duration=${String(args.durationSec)}s trim-keep=${String(args.trimKeepSec)}s${args.bare ? ' bare' : ''}`,
  )
  const agent = await resolvePinnedAgent()
  const chosen = await chooseStream(agent)
  await agent.close()
  say(
    `camera: ${chosen.camera.name} (${chosen.camera.type}); existing qualities: ${chosen.existing.join(', ')}`,
  )

  const source = toGo2rtcSource(chosen.rtspsUrl)
  const streamName = `spike_${chosen.quality}`
  const { port, pid: go2rtcPid } = await startGo2rtc({ [streamName]: source })
  say(`renderer stream URL: ${go2rtcWsUrl(port, streamName)}`)
  const authChecks = await authRejectionChecks(port, streamName)
  for (const c of authChecks)
    say(`go2rtc auth: ${c.pass ? 'REJECTED' : 'NOT REJECTED'}  ${c.name} -> ${c.result}`)
  if (!authChecks.every((c) => c.pass))
    throw new Error('go2rtc accepted a request without valid credentials')

  await stageRenderer(port)
  const resultFile = join(
    SPIKE_OUT,
    `result-${process.platform}-${process.arch}-${chosen.quality}${args.bare ? '-bare' : ''}.json`,
  )
  await rm(resultFile, { force: true })

  const electronBin = createRequire(import.meta.url)('electron') as string
  electron = spawn(electronBin, [join(HERE, 'electron-main.ts')], {
    cwd: HERE,
    env: childEnv({
      VP_SPIKE_PORT: String(port),
      VP_SPIKE_STREAM: streamName,
      VP_SPIKE_STAGE_DIR: STAGE,
      VP_SPIKE_RESULT_FILE: resultFile,
      VP_SPIKE_DURATION_SEC: String(args.durationSec),
      VP_SPIKE_KEEP_OPEN: args.keepOpen ? '1' : '0',
      VP_SPIKE_TRIM_KEEP_SEC: String(args.trimKeepSec),
      VP_SPIKE_BARE: args.bare ? '1' : '0',
      // Read and deleted from process.env by electron-main.ts before any helper starts. Env, not
      // argv, so it isn't in `ps` args (it is still readable by same-user tools such as `ps -E`).
      VP_SPIKE_GO2RTC_AUTH: goAuthHeader,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  pipeLines(electron.stdout, '[electron]')
  pipeLines(electron.stderr, '[electron]')
  const electronExit = new Promise<number | null>((r) =>
    electron?.once('exit', (code) => {
      r(code)
    }),
  )

  // CPU from cumulative CPU-time deltas (ps on macOS/Linux; PowerShell for go2rtc on Windows)
  // and codec info, while Electron runs. Steady state: from 10 s in to the last reading.
  const electronPid = electron.pid ?? -1
  const cpu: { t: number; sec: number }[] = []
  const ps: { t: number; rows: PsRow[] }[] = []
  let streamInfo: StreamCodecSummary | null = null
  const state = { running: true }
  void electronExit.then(() => {
    state.running = false
  })
  const t0 = Date.now()
  while (state.running) {
    const rows = await psSnapshot()
    if (rows) {
      ps.push({ t: Date.now() - t0, rows })
    } else {
      const sec = await cpuSeconds(go2rtcPid)
      if (sec !== null) cpu.push({ t: Date.now() - t0, sec })
    }
    // Keep the latest stream info (codecs + packet/drop counters) while a player is attached.
    const info = await go2rtcStreamInfo(port, streamName)
    if (info && info.consumers > 0) streamInfo = info
    await Promise.race([electronExit, sleep(CPU_SAMPLE_MS)])
  }
  const code = await electronExit
  if (!existsSync(resultFile)) throw new Error(`Electron exited (${String(code)}) without a result`)

  const result = JSON.parse(await readFile(resultFile, 'utf8')) as ElectronResult
  let cpuPs: Record<string, number> | null = null
  const steadyPs = ps.filter((p) => p.t >= 10_000)
  const psA = steadyPs[0]
  const psB = steadyPs.at(-1)
  if (psA && psB && psB.t > psA.t) {
    cpuPs = cpuByLabel(psA.rows, psB.rows, psB.t - psA.t, go2rtcPid, electronPid)
  }
  const steady = cpu.filter((c) => c.t >= 10_000)
  const a = steady[0]
  const b = steady.at(-1)
  const go2rtcCpu =
    cpuPs?.go2rtc ?? (a && b && b.t > a.t ? cpuPercent(a.sec, b.sec, b.t - a.t) : null)
  const cores = availableParallelism()

  const facts = {
    mseMime: result.summary.mseMime,
    videoDecoderName: pickProperty(result, 'kVideoDecoderName') as string | undefined,
    isPlatformVideoDecoder: asBool(pickProperty(result, 'kIsPlatformVideoDecoder')),
    audioDecoderName: pickProperty(result, 'kAudioDecoderName') as string | undefined,
    gpuVideoDecode: result.gpuFeatureStatus.video_decode,
    decodedFrames: result.summary.totalFrames,
    audioDecodedBytes: result.summary.audioDecodedBytes,
  }
  const verdict = evaluateG0(facts)

  const final = {
    ...result,
    camera: { name: chosen.camera.name, type: chosen.camera.type },
    quality: chosen.quality,
    trimKeepSec: args.trimKeepSec,
    bare: args.bare,
    existingQualities: chosen.existing,
    go2rtc: { version: 'v1.9.15', cpuPercent: go2rtcCpu, streamInfo, authChecks },
    cpu: {
      note: 'ps: 100 = one core. appMetrics: Electron getAppMetrics percentCPUUsage (see doc).',
      cores,
      ps: cpuPs,
      appMetrics: result.cpuPercentByProcessType,
    },
    g0: { facts, ...verdict },
  }
  await writeFile(resultFile, scrub(`${JSON.stringify(final, null, 2)}\n`))

  const s = result.summary
  const f = (n: number | null, d = 2): string => (n === null ? '–' : n.toFixed(d))
  say('')
  say('================ P0.5 result ================')
  say(`platform        ${process.platform}-${process.arch}`)
  say(`camera          ${chosen.camera.name} (${chosen.camera.type}) @ ${chosen.quality}`)
  say(`go2rtc producer ${streamInfo?.producerMedias.join(' | ') ?? 'unknown'}`)
  say(
    `go2rtc tracks   ${(streamInfo?.tracks ?? []).map((t) => `${t.side} ${t.codec} ${String(t.packets)} pkts${t.drops > 0 ? ` ${String(t.drops)} drops` : ''}`).join(' | ') || 'unknown'}`,
  )
  say(`MSE mime        ${s.mseMime || 'none'}`)
  say(`resolution      ${String(s.width)}x${String(s.height)}, ~${f(s.meanFps, 1)} fps`)
  say(
    `video decoder   ${String(facts.videoDecoderName)} (platform=${String(facts.isPlatformVideoDecoder)})`,
  )
  say(
    `audio decoder   ${String(facts.audioDecoderName)}, ${String(s.audioDecodedBytes)} bytes decoded, max RMS ${f(s.maxAudioRms, 3)}`,
  )
  say(`gpu video_decode ${String(facts.gpuVideoDecode)}`)
  say(`first frame     ${f(s.firstFrameMs, 0)} ms after WS connect`)
  say(
    `buffer latency  mean ${f(s.latency.mean)} s, p95 ${f(s.latency.p95)} s, max ${f(s.latency.max)} s`,
  )
  say(
    `frames          ${String(s.totalFrames)} decoded, ${String(s.droppedFrames)} dropped (${f(s.droppedPercent)}%)`,
  )
  say(`CPU ps (100 = 1 core) ${cpuPs ? JSON.stringify(cpuPs) : `n/a; go2rtc ${f(go2rtcCpu, 1)}`}`)
  say(
    `CPU getAppMetrics ${JSON.stringify(result.cpuPercentByProcessType)} (${String(cores)} cores)`,
  )
  for (const c of authChecks) say(`auth            ${c.name} -> ${c.result}`)
  for (const c of verdict.checks) say(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`)
  say(`G0 (${process.platform}) ${verdict.pass ? 'PASS' : 'FAIL'}`)
  say(`result: ${resultFile.slice(ROOT.length + 1)}`)

  await stopChild(go2rtc, 'go2rtc')
  const pids = [
    go2rtcPid,
    ...Object.values(result.lastMetrics?.byType ?? {}).flatMap((v) => v.pids),
  ]
  await sleep(500)
  const alive = pids.filter(isAlive)
  say(
    alive.length === 0
      ? `shutdown clean: go2rtc and ${String(pids.length - 1)} Electron processes have exited`
      : `WARNING: processes still running: ${alive.join(', ')}`,
  )
  if (!verdict.pass) process.exitCode = 2
}

try {
  await main()
} catch (err) {
  say(`spike:video failed: ${message(err)}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
