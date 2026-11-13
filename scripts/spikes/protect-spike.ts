// P0.3 Protect Integration API spike. Node 24 runs this file directly (type stripping).
//
//   npm run spike:protect                              read-only; listen on both WebSockets 120 s
//   npm run spike:protect -- --listen 300              listen for 300 s
//   npm run spike:protect -- --post-camera cam-004     also POST missing qualities on that camera
//
// Reads VP_CONSOLE_HOST and VP_PROTECT_API_KEY (optionally VP_CONSOLE_FINGERPRINT) from
// .env.local. Every printed line goes through the fixture sanitizer, so the key, the console host,
// MACs, ids and RTSPS URLs never reach the terminal.
//
// The only write to the console is POST /v1/cameras/{id}/rtsps-stream, and only when
// --post-camera names the camera: the spike never picks a camera to write to by itself. It POSTs
// only qualities a fresh GET shows as null, records the camera in
// scripts/spikes/output/posted-camera.json, and refuses a different camera on later runs unless
// --allow-second-camera is passed.
//
// TLS: the console's leaf fingerprint is pinned. VP_CONSOLE_FINGERPRINT wins; otherwise the pin
// saved in scripts/spikes/output/console-pin.json on first use is enforced.
//
// Outputs: sanitized fixtures in tests/fixtures/protect/, plus a sanitized run summary, the pin,
// the posted-camera record and snapshot JPEGs in scripts/spikes/output/ (gitignored).
import diagnostics from 'node:diagnostics_channel'
import { mkdir, writeFile } from 'node:fs/promises'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, fetch } from 'undici'
import type { Agent } from 'undici'
import { Contract, responsePointer } from '../lib/contract.ts'
import type { ValidationResult } from '../lib/contract.ts'
import { jpegSize } from './lib/jpeg.ts'
import { createSanitizer } from './lib/sanitize.ts'
import { filterRateLimitHeader } from '../../src/main/net/rateLimitHeaders.ts'
import { createPinnedAgent, fetchLeafCert, normalizeFingerprint } from './lib/tls.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTRACT_PATH = join(ROOT, 'docs', 'reference', 'protect-openapi-v7.3.74.json')
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'protect')
const OUTPUT = join(ROOT, 'scripts', 'spikes', 'output')
const PIN_FILE = join(OUTPUT, 'console-pin.json')
const POSTED_FILE = join(OUTPUT, 'posted-camera.json')
const API_PREFIX = '/proxy/protect/integration'
const QUALITIES = ['high', 'medium', 'low'] as const
const REQUEST_TIMEOUT_MS = 20_000
/** The console allows 10 requests per 1000 ms window (observed: 429 TOO_MANY_REQUESTS_ERROR). */
const MIN_REQUEST_GAP_MS = 150
const MAX_429_RETRIES = 4

const USAGE =
  'Usage: node scripts/spikes/protect-spike.ts [--listen <seconds>] ' +
  '[--post-camera <name-or-fake-id> [--allow-second-camera]]'

// ---------------------------------------------------------------------------------------------
// Setup

interface Args {
  listenSec: number
  help: boolean
  /** Camera name or fake id (`cam-004`) to POST missing rtsps-stream qualities to. */
  postCamera: string | undefined
  allowSecondCamera: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    listenSec: 120,
    help: false,
    postCamera: undefined,
    allowSecondCamera: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--listen') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--listen needs a number of seconds\n${USAGE}`)
      args.listenSec = n
    } else if (a === '--post-camera') {
      const v = argv[++i]?.trim()
      if (!v) throw new Error(`--post-camera needs a camera name or fake id\n${USAGE}`)
      args.postCamera = v
    } else if (a === '--allow-second-camera') args.allowSecondCamera = true
    else throw new Error(`Unknown argument "${String(a)}"\n${USAGE}`)
  }
  if (args.allowSecondCamera && args.postCamera === undefined)
    throw new Error(`--allow-second-camera only makes sense with --post-camera\n${USAGE}`)
  return args
}

const { listenSec, help, postCamera, allowSecondCamera } = parseArgs(process.argv.slice(2))
if (help) {
  console.log(USAGE)
  process.exit(0)
}

process.loadEnvFile(join(ROOT, '.env.local'))
const rawHost = (process.env.VP_CONSOLE_HOST ?? '').trim()
const apiKey = (process.env.VP_PROTECT_API_KEY ?? '').trim()
if (!rawHost || !apiKey)
  throw new Error('VP_CONSOLE_HOST and VP_PROTECT_API_KEY must be set in .env.local')
const consoleUrl = new URL(`https://${rawHost.replace(/^https?:\/\//, '')}`)
const host = consoleUrl.hostname
const port = consoleUrl.port ? Number(consoleUrl.port) : 443

const sanitizer = createSanitizer({ secrets: [apiKey, host, rawHost] })
const S = (value: unknown): unknown => sanitizer.sanitize(value)

/** Prints a line after redaction (key, host, ids, MACs, IPs, RTSPS URLs). */
function say(line = ''): void {
  console.log(sanitizer.sanitizeString(line))
}

/** Shape of an RTSPS URL without its host or token: `rtsps://<host>:7441/<token:16 chars>?enableSrtp`. */
function urlShape(url: string | null | undefined): string {
  if (url == null) return 'null'
  const m = /^([a-z]+):\/\/[^/:?#]+(?::(\d+))?\/([^?#]*)(\?[^#]*)?/i.exec(url)
  if (!m) return '<unparseable>'
  const [, scheme = '?', p, token = '', query = ''] = m
  // Deliberately not URL-shaped, so the sanitizer's rtsps:// rule leaves the description alone.
  return `scheme=${scheme} port=${p ?? '(default)'} path=<${String(token.length)}-char token> query=${query || '(none)'}`
}

/** Error message including the `cause` chain (undici wraps socket errors as "fetch failed"). */
function message(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as { code?: unknown }).code
  const own = typeof code === 'string' ? `${err.message} [${code}]` : err.message
  return err.cause === undefined ? own : `${own} <- ${message(err.cause)}`
}

/** Stringifies an unknown JSON value for logs. */
function text(v: unknown): string {
  if (v === undefined) return 'undefined'
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------------------------
// Contract bookkeeping

interface EndpointReport {
  endpoint: string
  samples: number
  invalid: number
  errors: Set<string>
  extraProperties: Set<string>
}

const reports = new Map<string, EndpointReport>()
let contract: Contract

function check(endpoint: string, pointer: string, data: unknown): ValidationResult {
  const r = contract.validate(pointer, data)
  let rep = reports.get(endpoint)
  if (!rep) {
    rep = { endpoint, samples: 0, invalid: 0, errors: new Set(), extraProperties: new Set() }
    reports.set(endpoint, rep)
  }
  rep.samples++
  if (!r.valid) rep.invalid++
  for (const e of r.errors) rep.errors.add(e)
  for (const e of r.extraProperties) rep.extraProperties.add(e)
  return r
}

// ---------------------------------------------------------------------------------------------
// REST

interface ApiResponse {
  status: number
  contentType: string
  json?: unknown
  bytes?: Uint8Array
  /** Body size in bytes, whether or not it parsed as JSON. */
  size: number
  ms: number
}

let agent: Agent
let agentReady = false

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let lastRequestAt = 0
const rateLimit = { hits: 0, headers: new Map<string, string>() }

/** The 429 body's `windowMs` (the console's rate-limit window), default 1000 ms. */
function windowMsOf(res: ApiResponse): number {
  return isRecord(res.json) && typeof res.json.windowMs === 'number' ? res.json.windowMs : 1000
}

/** Paces requests under the console's rate limit. GETs are retried on 429; a POST never is
 * (its caller re-GETs first and decides whether a second POST is still needed). */
async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    const res = await apiOnce(method, path, body)
    if (res.status !== 429) return res
    rateLimit.hits++
    if (method !== 'GET' || attempt >= MAX_429_RETRIES) return res
    const windowMs = windowMsOf(res)
    say(`    429 on ${method} (attempt ${String(attempt + 1)}), waiting ${String(windowMs)} ms`)
    await sleep(windowMs)
  }
}

async function apiOnce(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> {
  const started = performance.now()
  const res = await fetch(`https://${consoleUrl.host}${API_PREFIX}${path}`, {
    method,
    dispatcher: agent,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'X-API-KEY': apiKey,
      Accept: '*/*',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const contentType = res.headers.get('content-type') ?? ''
  for (const name of res.headers.keys()) {
    if (/rate|retry|limit/i.test(name)) {
      // Allowlist only: keeps the policy name and q/w/r/t/limit/remaining/reset, and drops
      // everything else, including the per-client partition key `pk`.
      const value = filterRateLimitHeader(res.headers.get(name) ?? '')
      if (value) rateLimit.headers.set(name, value)
    }
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  const ms = Math.round(performance.now() - started)
  if (contentType.includes('json') && buf.length > 0) {
    try {
      return {
        status: res.status,
        contentType,
        size: buf.length,
        json: JSON.parse(Buffer.from(buf).toString('utf8')),
        ms,
      }
    } catch {
      // fall through to bytes
    }
  }
  return { status: res.status, contentType, bytes: buf, size: buf.length, ms }
}

/** Calls a JSON endpoint, validates the 200 (or default error) body, and prints a status line. */
async function apiJson(
  method: 'GET' | 'POST',
  path: string,
  templatePath: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await api(method, path, body)
  const ok = res.status >= 200 && res.status < 300
  const pointer = responsePointer(
    templatePath,
    method.toLowerCase(),
    ok ? String(res.status) : 'default',
  )
  const label = `${method} ${templatePath}${ok ? '' : ` (${String(res.status)})`}`
  if (res.json !== undefined) {
    const v = check(label, pointer, res.json)
    say(
      `  ${label} -> ${String(res.status)} in ${String(res.ms)} ms, contract ${v.valid ? 'valid' : 'INVALID'}`,
    )
  } else {
    say(
      `  ${label} -> ${String(res.status)} in ${String(res.ms)} ms, non-JSON (${res.contentType || 'no content-type'})`,
    )
  }
  if (!ok) say(`    error body: ${JSON.stringify(S(res.json ?? null))}`)
  return res
}

// ---------------------------------------------------------------------------------------------
// Main

interface CameraRow {
  rawId: string
  supportFullHdSnapshot: boolean
  fakeId: string
  name: string
  type: string
  state: string
  hasPackageCamera: boolean
  hasSpeaker: boolean
}

type Summary = Record<string, unknown>

const summary: Summary = { startedAt: new Date().toISOString(), listenSec }

async function main(): Promise<void> {
  contract = new Contract(JSON.parse(await readFile(CONTRACT_PATH, 'utf8')))
  await mkdir(OUTPUT, { recursive: true })

  // --- TLS: pin every connection to the leaf fingerprint (env, else saved pin, else first use).
  say('== TLS')
  const cert = await fetchLeafCert(host, port)
  const pin = await resolvePin(cert.fingerprint256)
  // Printed raw: a fingerprint is not secret, and the MAC rule would mangle it.
  console.log(`  leaf SHA-256: ${cert.fingerprint256}`)
  say(
    `  valid ${cert.validFrom} -> ${cert.validTo}, self-signed: ${String(cert.selfSigned)}, ` +
      `pin source: ${pin.source}`,
  )
  summary.tls = {
    fingerprint256: cert.fingerprint256,
    selfSigned: cert.selfSigned,
    validTo: cert.validTo,
    pinSource: pin.source,
  }
  agent = createPinnedAgent(pin.fingerprint256)
  agentReady = true

  // --- meta/info
  say('\n== GET /v1/meta/info')
  const meta = await apiJson('GET', '/v1/meta/info', '/v1/meta/info')
  if (meta.status !== 200 || !isRecord(meta.json)) {
    throw new Error(`meta/info failed with HTTP ${String(meta.status)}; is the API key valid?`)
  }
  say(`  applicationVersion: ${String(meta.json.applicationVersion)}`)
  summary.applicationVersion = meta.json.applicationVersion
  await writeFixture('meta-info.json', S(meta.json))

  // --- cameras
  say('\n== GET /v1/cameras')
  const camsRes = await apiJson('GET', '/v1/cameras', '/v1/cameras')
  if (!Array.isArray(camsRes.json)) throw new Error('cameras did not return an array')
  const rawCameras = camsRes.json.filter(isRecord)
  const cameras: CameraRow[] = rawCameras.map((c) => {
    const ff = isRecord(c.featureFlags) ? c.featureFlags : {}
    return {
      rawId: String(c.id),
      fakeId: sanitizer.mapId(String(c.id), 'cam'),
      name: typeof c.name === 'string' ? c.name : '(null)',
      type: String(c.type),
      state: String(c.state),
      hasPackageCamera: c.hasPackageCamera === true,
      hasSpeaker: ff.hasSpeaker === true,
      supportFullHdSnapshot: ff.supportFullHdSnapshot === true,
    }
  })
  const table = rawCameras.map((c, i) => {
    const ff = isRecord(c.featureFlags) ? c.featureFlags : {}
    const smart = Array.isArray(ff.smartDetectTypes) ? ff.smartDetectTypes.join(',') : ''
    return {
      id: cameras[i]?.fakeId,
      name: c.name,
      type: c.type,
      state: c.state,
      hasMic: ff.hasMic,
      isMicEnabled: c.isMicEnabled,
      hasSpeaker: ff.hasSpeaker,
      hasPackageCamera: c.hasPackageCamera,
      fullHdSnapshot: ff.supportFullHdSnapshot,
      smartDetectTypes: smart || '-',
    }
  })
  say(`  ${String(cameras.length)} cameras`)
  for (const line of formatTable(table)) say(`  ${line}`)
  summary.cameras = table
  await writeFixture('cameras.json', S(rawCameras))

  // --- rtsps-stream: read every connected camera (read-only) to pick the spike camera.
  say('\n== GET /v1/cameras/{id}/rtsps-stream (all connected cameras, read-only)')
  const connected = cameras.filter((c) => c.state === 'CONNECTED')
  const existing = new Map<string, Record<string, unknown>>()
  for (const cam of connected) {
    const r = await apiJson(
      'GET',
      `/v1/cameras/${cam.rawId}/rtsps-stream`,
      '/v1/cameras/{id}/rtsps-stream',
    )
    if (r.status !== 200 || !isRecord(r.json)) continue
    existing.set(cam.rawId, r.json)
    const parts = Object.entries(r.json).map(([q, u]) => `${q}=${u === null ? 'null' : 'present'}`)
    say(`    ${cam.fakeId} (${cam.name}): ${parts.join(' ')}`)
  }
  const nullQualities: Record<string, string[]> = {}
  for (const cam of connected) {
    const body = existing.get(cam.rawId)
    if (body) nullQualities[cam.fakeId] = QUALITIES.filter((q) => body[q] === null)
  }
  const presentCount = (s: Record<string, unknown>): number =>
    QUALITIES.filter((q) => typeof s[q] === 'string').length
  // Prefer a camera that already has all three (no POST at all, and a re-run reuses the camera a
  // previous run already POSTed to, so only ONE camera is ever written to); then one with some
  // streams and some missing (exercises reuse and POST); then any connected camera.
  const ranked = connected
    .filter((c) => existing.has(c.rawId))
    .map((c) => ({ c, n: presentCount(existing.get(c.rawId) ?? {}) }))
  const pick =
    ranked.find((r) => r.n === QUALITIES.length) ??
    ranked.find((r) => r.n > 0 && r.n < QUALITIES.length) ??
    ranked[0]
  const rtspsSummary: Record<string, unknown> = {
    camerasRead: existing.size,
    withAnyStream: ranked.filter((r) => r.n > 0).length,
    withAllThree: ranked.filter((r) => r.n === QUALITIES.length).length,
    nullQualities,
    postCameraFlag: postCamera !== undefined,
  }
  summary.rtsps = rtspsSummary

  // Only --post-camera allows a POST, and only to the camera it names. Without it the run is
  // read-only and the stream checks use a camera that already has streams.
  let target: CameraRow | undefined
  if (postCamera !== undefined) {
    target = resolveCamera(postCamera, cameras)
    if (target.state !== 'CONNECTED')
      throw new Error(`--post-camera ${target.fakeId} (${target.name}) is ${target.state}`)
    await guardPostedCamera(target, cameras)
    say(`  --post-camera: ${target.fakeId} (${target.name}); POST allowed for its null qualities`)
  } else {
    target = pick?.c
    say('  no --post-camera: read-only run, no POST will be made')
  }
  if (!target) {
    say('  no connected camera returned rtsps-stream; skipping stream and snapshot checks')
  } else {
    await rtspsSpike(
      target,
      existing.get(target.rawId) ?? {},
      rtspsSummary,
      postCamera !== undefined,
    )
    await snapshotSpike(target, cameras)
  }

  // --- WebSockets (let the REST rate-limit window drain first)
  await sleep(1100)
  await listen(listenSec)
  summary.rateLimit = { hits429: rateLimit.hits, headers: Object.fromEntries(rateLimit.headers) }
  say(
    `\n  429s hit: ${String(rateLimit.hits)}; rate-limit headers seen (allowlisted params): ${[...rateLimit.headers].map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'}`,
  )

  // --- Report
  say('\n== Contract validation (docs/reference/protect-openapi-v7.3.74.json)')
  const contractSummary = [...reports.values()].map((r) => ({
    endpoint: r.endpoint,
    samples: r.samples,
    invalid: r.invalid,
    errors: [...r.errors],
    extraProperties: [...r.extraProperties].sort(),
  }))
  for (const r of contractSummary) {
    say(
      `  ${r.endpoint}: ${r.invalid === 0 ? 'valid' : 'INVALID'} (${String(r.samples)} sample(s), ${String(r.invalid)} invalid)`,
    )
    for (const e of r.errors.slice(0, 15)) say(`      error: ${e}`)
    if (r.errors.length > 15) say(`      ... ${String(r.errors.length - 15)} more`)
    for (const e of r.extraProperties) say(`      extra property: ${e}`)
  }
  summary.contract = contractSummary
  summary.finishedAt = new Date().toISOString()
  await writeFile(join(OUTPUT, 'summary.json'), `${JSON.stringify(S(summary), null, 2)}\n`)
  say(`\nSanitized run summary: scripts/spikes/output/summary.json`)
}

async function rtspsSpike(
  cam: CameraRow,
  before: Record<string, unknown>,
  out: Record<string, unknown>,
  mayPost: boolean,
): Promise<void> {
  say(`\n== rtsps-stream on ${cam.fakeId} (${cam.name}, ${cam.type})`)
  out.camera = {
    id: cam.fakeId,
    name: cam.name,
    type: cam.type,
    hasPackageCamera: cam.hasPackageCamera,
  }
  for (const [q, u] of Object.entries(before))
    say(`  before: ${q} = ${urlShape(u as string | null)}`)
  out.before = Object.fromEntries(
    Object.entries(before).map(([q, u]) => [q, urlShape(u as string | null)]),
  )

  // Re-read once to see whether existing URLs are stable across GETs.
  const again = await apiJson(
    'GET',
    `/v1/cameras/${cam.rawId}/rtsps-stream`,
    '/v1/cameras/{id}/rtsps-stream',
  )
  if (again.status !== 200 || !isRecord(again.json)) {
    throw new Error(`rtsps-stream re-read failed with HTTP ${String(again.status)}; not POSTing`)
  }
  const againBody = again.json
  const stableAcrossGets = QUALITIES.every((q) => before[q] === againBody[q])
  say(`  second GET returns identical URLs: ${String(stableAcrossGets)}`)
  out.stableAcrossGets = stableAcrossGets

  // Decide from the freshest GET: POST only qualities that are null right now.
  const missing = QUALITIES.filter((q) => againBody[q] === null)
  out.nullBeforePost = missing
  out.postedQualities = []
  let postBody: Record<string, unknown> | undefined
  if (missing.length === 0) {
    say(
      '  all of high/medium/low already exist: no POST needed (safety rule: never POST an existing quality)',
    )
  } else if (!mayPost) {
    say(
      `  qualities ${JSON.stringify(missing)} are null; NOT POSTing (read-only run: pass --post-camera to create them)`,
    )
  } else {
    postBody = await postMissing(cam, missing, out)
  }

  const after = await apiJson(
    'GET',
    `/v1/cameras/${cam.rawId}/rtsps-stream`,
    '/v1/cameras/{id}/rtsps-stream',
  )
  if (after.status !== 200 || !isRecord(after.json)) {
    throw new Error(`rtsps-stream follow-up GET failed with HTTP ${String(after.status)}`)
  }
  const afterBody = after.json
  for (const [q, u] of Object.entries(afterBody))
    say(`  after:  ${q} = ${urlShape(u as string | null)}`)
  const preservedExisting = QUALITIES.filter((q) => typeof before[q] === 'string').every(
    (q) => before[q] === afterBody[q],
  )
  const postMatchesGet =
    postBody === undefined ? null : Object.entries(postBody).every(([q, u]) => afterBody[q] === u)
  const allPresent = QUALITIES.every((q) => typeof afterBody[q] === 'string')
  say(`  pre-existing URLs unchanged at the follow-up GET: ${String(preservedExisting)}`)
  if (postMatchesGet !== null) say(`  POST URLs equal the follow-up GET: ${String(postMatchesGet)}`)
  say(
    `  high/medium/low all present now: ${String(allPresent)} (medium: ${urlShape(afterBody.medium as string | null)})`,
  )
  const tokens = QUALITIES.map((q) => afterBody[q]).filter(
    (u): u is string => typeof u === 'string',
  )
  say(`  distinct URL per quality: ${String(new Set(tokens).size === tokens.length)}`)
  Object.assign(out, {
    after: Object.fromEntries(
      Object.entries(afterBody).map(([q, u]) => [q, urlShape(u as string | null)]),
    ),
    preservedExisting,
    postMatchesGet,
    allPresent,
  })
  await writeFixture('rtsps-stream.get.json', S(afterBody))
}

/** POSTs `missing` qualities once. On 429 it waits `windowMs`, re-GETs, and makes at most one
 * more POST for the qualities that are still null. */
async function postMissing(
  cam: CameraRow,
  missing: readonly string[],
  out: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const path = `/v1/cameras/${cam.rawId}/rtsps-stream`
  const template = '/v1/cameras/{id}/rtsps-stream'
  let requested = [...missing]
  await recordPostedCamera(cam, requested)
  say(`  POST qualities ${JSON.stringify(requested)} (GET showed them as null)`)
  let post = await apiJson('POST', path, template, { qualities: requested })
  if (post.status === 429) {
    const windowMs = windowMsOf(post)
    say(
      `  POST was rate limited (429), not retried as is. Waiting ${String(windowMs)} ms, then re-reading`,
    )
    await sleep(windowMs)
    const fresh = await apiJson('GET', path, template)
    if (fresh.status !== 200 || !isRecord(fresh.json)) {
      throw new Error(
        `rtsps-stream re-read after a 429 failed with HTTP ${String(fresh.status)}; stopping without a second POST`,
      )
    }
    const freshBody = fresh.json
    requested = QUALITIES.filter((q) => freshBody[q] === null)
    if (requested.length === 0) {
      say('  re-read shows every quality present now: no second POST')
      out.postStatus = 429
      return undefined
    }
    say(`  one more POST for ${JSON.stringify(requested)} (still null after the 429)`)
    await recordPostedCamera(cam, requested)
    post = await apiJson('POST', path, template, { qualities: requested })
    if (post.status === 429) {
      throw new Error(
        'POST rtsps-stream was rate limited (429) twice; stopping. Wait a few seconds and re-run ' +
          'with the same --post-camera: the spike re-reads first and POSTs only qualities still null.',
      )
    }
  }
  out.postedQualities = requested
  out.postStatus = post.status
  if (post.status !== 200 || !isRecord(post.json)) return undefined
  for (const [q, u] of Object.entries(post.json))
    say(`  POST returned: ${q} = ${urlShape(u as string)}`)
  out.postReturned = Object.keys(post.json)
  await writeFixture(
    'rtsps-stream.post.json',
    S({ request: { qualities: requested }, response: post.json }),
  )
  return post.json
}

async function snapshotSpike(cam: CameraRow, cameras: CameraRow[]): Promise<void> {
  say(`\n== GET /v1/cameras/{id}/snapshot`)
  const meta: Record<string, unknown>[] = []
  const shots: { label: string; cam: CameraRow; query: string }[] = [
    { label: 'default', cam, query: '' },
    { label: 'highQuality=true', cam, query: '?highQuality=true' },
  ]
  // highQuality=true is refused (400) by cameras without supportFullHdSnapshot: also try one that has it.
  const fullHd = cam.supportFullHdSnapshot
    ? undefined
    : cameras.find((c) => c.state === 'CONNECTED' && c.supportFullHdSnapshot)
  if (fullHd) {
    shots.push({
      label: 'highQuality=true (supportFullHdSnapshot)',
      cam: fullHd,
      query: '?highQuality=true',
    })
    shots.push({ label: 'default (supportFullHdSnapshot)', cam: fullHd, query: '' })
  }
  const offline = cameras.find((c) => c.state !== 'CONNECTED')
  if (offline) shots.push({ label: `offline camera (${offline.state})`, cam: offline, query: '' })
  else say('  no offline camera: 503 behaviour not observable this run')

  for (const s of shots) {
    const res = await api('GET', `/v1/cameras/${s.cam.rawId}/snapshot${s.query}`)
    const size = res.size
    const dims = res.bytes && res.contentType.startsWith('image/') ? jpegSize(res.bytes) : undefined
    say(
      `  ${s.cam.fakeId} ${s.label}: ${String(res.status)} ${res.contentType || '(no content-type)'} ` +
        `${String(size)} bytes${dims ? ` ${String(dims.width)}x${String(dims.height)}` : ''} in ${String(res.ms)} ms`,
    )
    if (res.json !== undefined) {
      check(
        `GET /v1/cameras/{id}/snapshot (${String(res.status)})`,
        responsePointer('/v1/cameras/{id}/snapshot', 'get', 'default'),
        res.json,
      )
      say(`    body: ${JSON.stringify(S(res.json))}`)
    } else if (res.status !== 200 && res.bytes && res.bytes.length > 0) {
      say(`    body (text): ${Buffer.from(res.bytes.slice(0, 200)).toString('utf8')}`)
    }
    if (res.status === 200 && res.bytes) {
      const file = join(OUTPUT, `snapshot-${s.cam.fakeId}-${s.query ? 'hq' : 'default'}.jpg`)
      await writeFile(file, res.bytes)
    }
    meta.push({
      request: s.label.startsWith('offline') ? 'offline camera, default' : s.label,
      camera: s.cam.fakeId,
      status: res.status,
      contentType: res.contentType,
      bytes: size,
      ...(res.json === undefined ? {} : { body: S(res.json) }),
    })
  }
  summary.snapshot = meta.map((m) => ({ ...m }))
  await writeFixture('snapshot.meta.json', meta)
}

// ---------------------------------------------------------------------------------------------
// WebSockets

interface WsCapture {
  devices: unknown[]
  events: unknown[]
  /** Receive time (ms since epoch) of each events message, parallel to `events`. */
  eventTimes: number[]
}

async function listen(seconds: number): Promise<void> {
  say(
    `\n== WebSockets: listening ${String(seconds)} s on /v1/subscribe/devices and /v1/subscribe/events`,
  )
  const capture: WsCapture = { devices: [], events: [], eventTimes: [] }
  const t0 = Date.now()
  const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`
  let pings = 0
  let pongs = 0
  const onPing = (): void => {
    pings++
  }
  const onPong = (): void => {
    pongs++
  }
  diagnostics.subscribe('undici:websocket:ping', onPing)
  diagnostics.subscribe('undici:websocket:pong', onPong)

  const wsInfo: Record<string, unknown> = {}
  /** Sockets that closed before the listen period ended (not closed by us). */
  const closedEarly: { socket: string; code: number; reason: string; afterMs: number }[] = []
  let listening = true
  let openCount = 2
  let wake: () => void = () => undefined
  const sockets = (['devices', 'events'] as const).map((kind) => {
    const path = `/v1/subscribe/${kind}`
    const url = `wss://${consoleUrl.host}${API_PREFIX}${path}`
    const ws = new WebSocket(url, { headers: { 'X-API-KEY': apiKey }, dispatcher: agent })
    ws.binaryType = 'arraybuffer'
    const info: Record<string, unknown> = { messages: 0, binaryFrames: 0 }
    wsInfo[kind] = info
    ws.addEventListener('open', () => {
      info.openedAfterMs = Date.now() - t0
      say(`  ${stamp()} ${kind}: open (protocol "${ws.protocol}", extensions "${ws.extensions}")`)
    })
    ws.addEventListener('error', (ev) => {
      say(
        `  ${stamp()} ${kind}: error ${message((ev as unknown as { error?: unknown }).error ?? 'unknown')}`,
      )
    })
    ws.addEventListener('close', (ev) => {
      const afterMs = Date.now() - t0
      info.close = { code: ev.code, reason: ev.reason, afterMs, early: listening }
      say(`  ${stamp()} ${kind}: close code=${String(ev.code)} reason="${ev.reason}"`)
      if (listening) {
        closedEarly.push({ socket: kind, code: ev.code, reason: ev.reason, afterMs })
        say(`  ${stamp()} ${kind}: CLOSED EARLY (before the ${String(seconds)} s listen ended)`)
      }
      openCount--
      if (openCount === 0) wake()
    })
    ws.addEventListener('message', (ev) => {
      info.messages = Number(info.messages) + 1
      let text: string
      if (typeof ev.data === 'string') text = ev.data
      else {
        info.binaryFrames = Number(info.binaryFrames) + 1
        text = Buffer.from(ev.data as ArrayBuffer).toString('utf8')
      }
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        say(`  ${stamp()} ${kind}: non-JSON frame (${String(text.length)} chars)`)
        return
      }
      capture[kind].push(msg)
      if (kind === 'events') capture.eventTimes.push(Date.now())
      const v = check(`WS ${path}`, responsePointer(path, 'get'), msg)
      say(`  ${stamp()} ${kind}: ${describeWs(msg)}${v.valid ? '' : '  [contract INVALID]'}`)
    })
    return ws
  })

  // Wait for the listen period, or stop early once both sockets have closed.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  listening = false
  const listenedMs = Date.now() - t0
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
      ws.close(1000, 'spike done')
  }
  await sleep(500)
  diagnostics.unsubscribe('undici:websocket:ping', onPing)
  diagnostics.unsubscribe('undici:websocket:pong', onPong)
  say(`  server pings seen: ${String(pings)}, pongs seen: ${String(pongs)}`)
  if (closedEarly.length === 0) {
    say('  early close: none (both sockets stayed open for the whole listen period)')
  } else {
    for (const c of closedEarly)
      say(
        `  early close: ${c.socket} closed after ${(c.afterMs / 1000).toFixed(1)} s, code=${String(c.code)} reason="${c.reason}"`,
      )
    if (openCount === 0)
      say(`  both sockets closed: stopped listening after ${(listenedMs / 1000).toFixed(1)} s`)
    if (closedEarly.some((c) => c.socket === 'events'))
      say(
        '  NOTE: the events socket closed early, so the absence of motion (or any event) in this run is NOT meaningful',
      )
  }

  const events = analyseEvents(capture.events, capture.eventTimes)
  summary.ws = {
    ...wsInfo,
    pings,
    pongs,
    listenedMs,
    closedEarly,
    eventsClosedEarly: closedEarly.some((c) => c.socket === 'events'),
    ...events.summary,
  }
  await writeDeviceFixture(capture.devices)
  await writeEventFixture(events)
}

function describeWs(msg: unknown): string {
  if (!isRecord(msg)) return `(${typeof msg})`
  const item = msg.item
  const items = Array.isArray(item) ? item : [item]
  const parts = items.filter(isRecord).map((it) => {
    const bits = [`modelKey=${String(it.modelKey)}`]
    if (it.type !== undefined) bits.push(`item.type=${text(it.type)}`)
    if (typeof it.id === 'string')
      bits.push(
        `id=${sanitizer.mapId(it.id, it.modelKey === 'event' ? 'evt' : text(it.modelKey ?? 'id'))}`,
      )
    if (typeof it.device === 'string') bits.push(`device=${sanitizer.mapId(it.device)}`)
    if ('start' in it) bits.push(`start=${String(it.start)}`)
    if ('end' in it) bits.push(`end=${String(it.end)}`)
    if (Array.isArray(it.smartDetectTypes))
      bits.push(`smartDetectTypes=${it.smartDetectTypes.join(',')}`)
    const keys = Object.keys(it).filter(
      (k) => !['id', 'modelKey', 'type', 'device', 'start', 'end', 'smartDetectTypes'].includes(k),
    )
    if (keys.length) bits.push(`keys=[${keys.join(',')}]`)
    return bits.join(' ')
  })
  return `type=${String(msg.type)} ${parts.join(' | ')}`
}

interface EventAnalysis {
  motion?: { add: unknown; updates: unknown[]; durationMs: number | null; receivedGapMs: number }
  smartDetect: unknown[]
  ring: unknown[]
  summary: Record<string, unknown>
}

function analyseEvents(events: unknown[], times: number[]): EventAnalysis {
  const typesSeen: Record<string, number> = {}
  const byId = new Map<
    string,
    { add?: { msg: unknown; at: number }; updates: { msg: unknown; at: number }[] }
  >()
  events.forEach((msg, idx) => {
    if (!isRecord(msg) || !isRecord(msg.item)) return
    const it = msg.item
    const key = `${text(msg.type)}:${text(it.type ?? '(partial)')}`
    typesSeen[key] = (typesSeen[key] ?? 0) + 1
    if (typeof it.id !== 'string') return
    const entry = byId.get(it.id) ?? { updates: [] }
    if (msg.type === 'add') entry.add = { msg, at: idx }
    else entry.updates.push({ msg, at: idx })
    byId.set(it.id, entry)
  })
  let motion: EventAnalysis['motion']
  for (const e of byId.values()) {
    if (!e.add || !isRecord(e.add.msg) || !isRecord(e.add.msg.item)) continue
    const add = e.add.msg.item
    if (add.type !== 'motion' || add.end != null) continue
    const endIdx = e.updates.findIndex(
      (u) => isRecord(u.msg) && isRecord(u.msg.item) && u.msg.item.end != null,
    )
    if (endIdx < 0) continue
    const updates = e.updates.slice(0, endIdx + 1).map((u) => u.msg)
    const last = updates[updates.length - 1]
    const end = isRecord(last) && isRecord(last.item) ? last.item.end : null
    motion = {
      add: e.add.msg,
      updates,
      durationMs: typeof end === 'number' && typeof add.start === 'number' ? end - add.start : null,
      receivedGapMs: (times[e.updates[endIdx]?.at ?? 0] ?? 0) - (times[e.add.at] ?? 0),
    }
    break
  }
  const pick = (pred: (t: string) => boolean): unknown[] => {
    const out: unknown[] = []
    for (const e of byId.values()) {
      const first = e.add?.msg
      if (!isRecord(first) || !isRecord(first.item) || typeof first.item.type !== 'string') continue
      if (!pred(first.item.type)) continue
      out.push(first, ...e.updates.map((u) => u.msg))
      if (out.length >= 8) break
    }
    return out
  }
  const smartDetect = pick((t) => t.startsWith('smartDetect'))
  const ring = pick((t) => t === 'ring')
  say(`\n  event message kinds (type:item.type -> count): ${JSON.stringify(typesSeen)}`)
  say(
    `  motion add->update(end) pair captured: ${motion ? `yes, event start->end ${String(motion.durationMs)} ms, add->end-update received ${String(motion.receivedGapMs)} ms apart, ${String(motion.updates.length)} update(s)` : 'NO'}`,
  )
  return {
    ...(motion ? { motion } : {}),
    smartDetect,
    ring,
    summary: {
      eventKinds: typesSeen,
      motionPairCaptured: motion !== undefined,
      motionDurationMs: motion?.durationMs ?? null,
      motionReceivedGapMs: motion?.receivedGapMs ?? null,
      motionUpdates: motion?.updates.length ?? 0,
      smartDetectMessages: smartDetect.length,
      ringMessages: ring.length,
    },
  }
}

async function writeDeviceFixture(devices: unknown[]): Promise<void> {
  if (devices.length === 0) {
    say('  no devices messages captured: devices-ws.sample.json left unchanged')
    return
  }
  // One example per (type, modelKey, changed-key-set), at most 8.
  const seen = new Set<string>()
  const sample: unknown[] = []
  for (const m of devices) {
    if (!isRecord(m)) continue
    const it: unknown = Array.isArray(m.item) ? m.item[0] : m.item
    const sig = isRecord(it)
      ? `${String(m.type)}:${String(it.modelKey)}:${Object.keys(it).sort().join(',')}`
      : String(m.type)
    if (seen.has(sig)) continue
    seen.add(sig)
    sample.push(m)
    if (sample.length >= 8) break
  }
  await writeFixture('devices-ws.sample.json', S(sample))
}

async function writeEventFixture(ev: EventAnalysis): Promise<void> {
  const path = join(FIXTURES, 'events-ws.motion.json')
  if (!ev.motion && (await exists(path))) {
    // Never replace a captured motion pair with a run that has none; otherwise keep the richer file.
    const old: unknown = JSON.parse(await readFile(path, 'utf8'))
    const oldHasMotion = isRecord(old) && old.motion != null
    if (oldHasMotion || ev.smartDetect.length + ev.ring.length === 0) {
      say('  no motion pair this run: events-ws.motion.json left unchanged')
      return
    }
  }
  await writeFixture(
    'events-ws.motion.json',
    S({
      motion: ev.motion ? { add: ev.motion.add, updates: ev.motion.updates } : null,
      smartDetect: ev.smartDetect,
      ring: ev.ring,
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// TLS pin and posted-camera record (both in scripts/spikes/output/, gitignored)

interface Pin {
  fingerprint256: string
  source: string
}

const PIN_RESET_HINT =
  'If the console certificate really changed, delete scripts/spikes/output/console-pin.json ' +
  '(the next run trusts the new certificate on first use) or set VP_CONSOLE_FINGERPRINT in ' +
  '.env.local to the new fingerprint.'

/** Picks the pin: VP_CONSOLE_FINGERPRINT, else the saved pin, else first use (saved for later). */
async function resolvePin(actual: string): Promise<Pin> {
  const env = process.env.VP_CONSOLE_FINGERPRINT?.trim()
  // Fingerprints are printed with console.log, not say(): they are not secret, and the MAC rule
  // would mangle them.
  const mismatch = (expected: string, from: string): Error => {
    console.log(`  presented leaf SHA-256: ${actual}`)
    console.log(`  expected (${from}): ${expected}`)
    return new Error(
      `TLS pin mismatch: the console's certificate does not match ${from}. Refusing to connect. ${PIN_RESET_HINT}`,
    )
  }
  if (env) {
    const expected = normalizeFingerprint(env)
    if (expected !== actual) throw mismatch(expected, 'VP_CONSOLE_FINGERPRINT')
    return { fingerprint256: expected, source: 'VP_CONSOLE_FINGERPRINT' }
  }
  if (await exists(PIN_FILE)) {
    let expected: string
    try {
      const saved: unknown = JSON.parse(await readFile(PIN_FILE, 'utf8'))
      if (!isRecord(saved) || typeof saved.fingerprint256 !== 'string') throw new Error('bad shape')
      expected = normalizeFingerprint(saved.fingerprint256)
    } catch {
      throw new Error(
        `scripts/spikes/output/console-pin.json is unreadable. Delete it to re-pin, or set VP_CONSOLE_FINGERPRINT.`,
      )
    }
    if (expected !== actual) throw mismatch(expected, 'the saved pin')
    return {
      fingerprint256: expected,
      source: 'saved pin (scripts/spikes/output/console-pin.json)',
    }
  }
  await writeFile(
    PIN_FILE,
    `${JSON.stringify({ fingerprint256: actual, savedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  say('  trusting on first use: saved the pin to scripts/spikes/output/console-pin.json')
  return { fingerprint256: actual, source: 'first use (TOFU), now saved' }
}

/** Finds the camera named by --post-camera, by fake id (`cam-004`) or exact name. */
function resolveCamera(arg: string, cameras: CameraRow[]): CameraRow {
  const want = arg.toLowerCase()
  const byId = cameras.filter((c) => c.fakeId.toLowerCase() === want)
  const matches = byId.length > 0 ? byId : cameras.filter((c) => c.name.toLowerCase() === want)
  const list = cameras.map((c) => `${c.fakeId} (${c.name})`).join(', ')
  const [match, ...rest] = matches
  if (match === undefined)
    throw new Error(`--post-camera "${arg}" matches no camera. Cameras: ${list}`)
  if (rest.length > 0)
    throw new Error(`--post-camera "${arg}" matches several cameras; use the fake id. ${list}`)
  return match
}

interface PostedEntry {
  /** Raw Protect id: fine here, this file is gitignored and never committed. */
  rawId: string
  name: string
  firstPostedAt: string
  lastPostedAt: string
  qualities: string[]
}

async function readPosted(): Promise<PostedEntry[]> {
  if (!(await exists(POSTED_FILE))) return []
  const data: unknown = JSON.parse(await readFile(POSTED_FILE, 'utf8'))
  if (!isRecord(data) || !Array.isArray(data.cameras)) {
    throw new Error(
      'scripts/spikes/output/posted-camera.json is malformed; fix or delete it (deleting forgets which camera was POSTed to)',
    )
  }
  return data.cameras.filter(isRecord).map((c) => ({
    rawId: String(c.rawId),
    name: String(c.name),
    firstPostedAt: String(c.firstPostedAt),
    lastPostedAt: String(c.lastPostedAt),
    qualities: Array.isArray(c.qualities) ? c.qualities.map(String) : [],
  }))
}

/** Refuses a second camera unless --allow-second-camera was passed. */
async function guardPostedCamera(target: CameraRow, cameras: CameraRow[]): Promise<void> {
  const posted = await readPosted()
  if (posted.length === 0 || posted.some((p) => p.rawId === target.rawId)) return
  const names = posted
    .map((p) => {
      const cam = cameras.find((c) => c.rawId === p.rawId)
      return cam ? `${cam.fakeId} (${cam.name})` : `"${p.name}" (no longer listed)`
    })
    .join(', ')
  if (allowSecondCamera) {
    say(`  --allow-second-camera: POSTing to ${target.fakeId} although ${names} was used before`)
    return
  }
  throw new Error(
    `--post-camera ${target.fakeId} (${target.name}) is not the camera already POSTed to: ${names} ` +
      `(recorded in scripts/spikes/output/posted-camera.json). The spike writes to one camera only. ` +
      `Re-run with --post-camera naming that camera, or add --allow-second-camera.`,
  )
}

/** Records the camera before POSTing to it, so a crash mid-POST still leaves a record. */
async function recordPostedCamera(cam: CameraRow, qualities: readonly string[]): Promise<void> {
  const posted = await readPosted()
  const now = new Date().toISOString()
  const entry = posted.find((p) => p.rawId === cam.rawId)
  if (entry) {
    entry.lastPostedAt = now
    entry.qualities = [...new Set([...entry.qualities, ...qualities])]
  } else {
    posted.push({
      rawId: cam.rawId,
      name: cam.name,
      firstPostedAt: now,
      lastPostedAt: now,
      qualities: [...qualities],
    })
  }
  await writeFile(POSTED_FILE, `${JSON.stringify({ cameras: posted }, null, 2)}\n`)
  say(`  recorded ${cam.fakeId} in scripts/spikes/output/posted-camera.json`)
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function writeFixture(name: string, data: unknown): Promise<void> {
  await mkdir(FIXTURES, { recursive: true })
  await writeFile(join(FIXTURES, name), `${JSON.stringify(data, null, 2)}\n`)
  say(`  wrote tests/fixtures/protect/${name}`)
}

function formatTable(rows: Record<string, unknown>[]): string[] {
  const first = rows[0]
  if (!first) return []
  const cols = Object.keys(first)
  const cell = (v: unknown): string =>
    v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ')
  return [
    line(cols),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => cell(r[c])))),
  ]
}

main()
  .catch((err: unknown) => {
    say(`protect-spike: ${message(err)}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (agentReady) void agent.close()
  })
