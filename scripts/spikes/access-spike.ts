// P0.4 UniFi Access developer API spike. Node 24 runs this file directly (type stripping).
// Runs against the local mock now (`npm run mock:access`) and against the site console on-site
// (OS-1, docs/spikes/P0.4-access-mock.md §6).
//
//   npm run spike:access                                     list doors + error probes (read-only)
//   npm run spike:access -- --unlock "Front Door"            also unlock ONE door after you type its name
//   npm run spike:access -- --unlock "Front Door" --yes      skip the typed confirmation (mock only:
//                                                            refused unless the target is the mock)
//   npm run spike:access -- --unlock "Front Door" --watch 10 re-read the relay for 10 s after unlocking
//
// Env (environment first, then .env.local): VP_ACCESS_TOKEN (required), VP_ACCESS_BASE_URL
// (default https://<VP_CONSOLE_HOST>:12445/api/v1/developer; mock: https://127.0.0.1:12445/api/v1/developer),
// optional VP_ACCESS_FINGERPRINT to pin a known certificate.
//
// TLS: the leaf certificate is pinned per host and port in scripts/spikes/output/
// access-pin-<host>-<port>.json (trust on first use), so the mock's and the console's pins never
// collide. Every printed line goes through the fixture sanitizer: the token and host never print.
//
// The ONLY write is PUT /doors/{id}/unlock, only for the door --unlock names, only once per run,
// and only after the door name is typed back (DOOR-3/4). --yes skips that only against the mock.
//
// Mock vs console: the target is `mock` only if the GET /doors response carries the mock-only
// header `x-view-protect-mock: 1` (sourceFromHeaders); anything else is `console`, whatever the
// host. --yes against a `console` target exits 1 before anything is written or unlocked.
//
// Outputs: sanitized fixtures in tests/fixtures/access/ (each with "_source": "mock" | "console")
// and a sanitized summary in scripts/spikes/output/ (gitignored).
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { fetch } from 'undici'
import type { Agent } from 'undici'
import type { z } from 'zod'
import {
  ACCESS_SUCCESS_CODE,
  AccessDoorListResponseSchema,
  AccessDoorResponseSchema,
  AccessDoorSchema,
  AccessErrorEnvelopeSchema,
  AccessUnlockResponseSchema,
} from '../../src/main/access/types.ts'
import type { AccessDoor } from '../../src/main/access/types.ts'
import {
  accessPinFileName,
  confirmationMatches,
  describeIssues,
  extraKeys,
  findDoorByName,
  resolveAccessBaseUrl,
  shapeNotes,
  sourceFromHeaders,
  unlockConfirmation,
  urlPort,
} from './lib/access.ts'
import type { FixtureSource, HeaderReader } from './lib/access.ts'
import { createSanitizer } from './lib/sanitize.ts'
import { createPinnedAgent, fetchLeafCert, normalizeFingerprint } from './lib/tls.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'access')
const OUTPUT = join(ROOT, 'scripts', 'spikes', 'output')
const REQUEST_TIMEOUT_MS = 15_000
/** A well-formed id no console should have, for the not-exists probe. */
const MISSING_DOOR_ID = '00000000-0000-4000-8000-000000000000'
/** A token that is never valid, for the unauthorized probe. */
const BAD_TOKEN = 'view-protect-spike-invalid-token'
const ENVELOPE_KEYS = ['code', 'msg', 'data']
const DOOR_KEYS = Object.keys(AccessDoorSchema.shape)

const USAGE =
  'Usage: node scripts/spikes/access-spike.ts [--unlock <door name> [--yes] [--watch <seconds>]]'

// ---------------------------------------------------------------------------------------------
// Setup

interface Args {
  unlock: string | undefined
  yes: boolean
  watchSec: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { unlock: undefined, yes: false, watchSec: 8 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (a === '--unlock') {
      const v = argv[++i]?.trim()
      if (!v) throw new Error(`--unlock needs a door name\n${USAGE}`)
      args.unlock = v
    } else if (a === '--yes') args.yes = true
    else if (a === '--watch') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0 || n > 120)
        throw new Error(`--watch needs 0..120 seconds\n${USAGE}`)
      args.watchSec = n
    } else throw new Error(`Unknown argument "${String(a)}"\n${USAGE}`)
  }
  if (args.yes && args.unlock === undefined)
    throw new Error(`--yes only makes sense with --unlock\n${USAGE}`)
  return args
}

/** Setup errors (bad flags, missing env) print one clean line instead of a stack trace. */
function orExit<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    console.error(`access-spike: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const args = orExit(() => parseArgs(process.argv.slice(2)))
const envFile = join(ROOT, '.env.local')
// loadEnvFile does not override variables already set, so `VP_ACCESS_TOKEN=... npm run ...` wins.
if (existsSync(envFile)) process.loadEnvFile(envFile)

const token = orExit(() => {
  const t = (process.env.VP_ACCESS_TOKEN ?? '').trim()
  if (!t) {
    throw new Error(
      'VP_ACCESS_TOKEN must be set (in .env.local or the environment). For the mock, use the ' +
        'token it printed (or set VP_ACCESS_TOKEN in .env.local so the mock uses that one).',
    )
  }
  return t
})
const baseUrl = orExit(() => resolveAccessBaseUrl(process.env))
const host = baseUrl.hostname.replace(/^\[|\]$/g, '')
const port = urlPort(baseUrl)
/** Set from the GET /doors response headers; `console` (the strict case) until then. */
let source: FixtureSource = 'console'
const PIN_FILE = join(OUTPUT, accessPinFileName(baseUrl))
const PIN_REL = `scripts/spikes/output/${accessPinFileName(baseUrl)}`

// The host is always a secret: whether this is the mock is only known after the first response.
const sanitizer = createSanitizer({ secrets: [token, BAD_TOKEN, host] })
const S = (v: unknown): unknown => sanitizer.sanitize(v)
function say(line = ''): void {
  console.log(sanitizer.sanitizeString(line))
}

function message(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as { code?: unknown }).code
  const own = typeof code === 'string' ? `${err.message} [${code}]` : err.message
  return err.cause === undefined ? own : `${own} <- ${message(err.cause)}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------------------------
// Shape checks

interface Mismatch {
  check: string
  issues: string[]
  extraKeys: string[]
}
const mismatches: Mismatch[] = []
/** Lenient-schema normalizations seen on the raw JSON (UNVERIFIED shapes, OS-1). */
const notesSeen: { check: string; notes: string[] }[] = []
const checksRun: string[] = []

/** Validates `data` against `schema`, records issues and undocumented keys, prints one line. */
function validate<T>(check: string, schema: z.ZodType<T>, data: unknown): T | undefined {
  checksRun.push(check)
  const notes = shapeNotes(data)
  if (notes.length > 0) notesSeen.push({ check, notes })
  const r = schema.safeParse(data)
  const extras = extraKeys(data, ENVELOPE_KEYS).map((k) => `(envelope).${k}`)
  const payload = isRecord(data) ? data.data : undefined
  const doors = Array.isArray(payload) ? payload : isRecord(payload) ? [payload] : []
  for (const d of doors)
    if (isRecord(d) && 'door_lock_relay_status' in d)
      for (const k of extraKeys(d, DOOR_KEYS)) extras.push(`door.${k}`)
  const extraList = [...new Set(extras)]
  const issues = r.success ? [] : describeIssues(r.error)
  if (issues.length > 0 || extraList.length > 0)
    mismatches.push({ check, issues, extraKeys: extraList })
  say(
    `    shape (${check}): ${r.success ? 'matches community shape' : 'MISMATCH'}` +
      (extraList.length > 0 ? `; undocumented keys: ${extraList.join(', ')}` : ''),
  )
  for (const i of issues) say(`      - ${i}`)
  for (const n of notes) say(`      shape note: ${n}`)
  return r.success ? r.data : undefined
}

// ---------------------------------------------------------------------------------------------
// HTTP

interface ApiResponse {
  status: number
  headers: HeaderReader
  json: unknown
  ms: number
}

let agent: Agent | undefined

async function api(
  method: 'GET' | 'PUT',
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  if (agent === undefined) throw new Error('TLS agent not ready')
  const started = performance.now()
  const res = await fetch(`${baseUrl.origin}${baseUrl.pathname}${path}`, {
    method,
    dispatcher: agent,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${opts.token ?? token}`,
      Accept: 'application/json',
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = {
      _nonJson: `${String(text.length)} bytes, content-type ${res.headers.get('content-type') ?? 'none'}`,
    }
  }
  const out = {
    status: res.status,
    headers: res.headers,
    json,
    ms: Math.round(performance.now() - started),
  }
  const code = isRecord(json) && typeof json.code === 'string' ? json.code : '(no code)'
  say(`  ${method} ${path} -> HTTP ${String(out.status)} ${code} in ${String(out.ms)} ms`)
  return out
}

function codeOf(res: ApiResponse): string | undefined {
  return isRecord(res.json) && typeof res.json.code === 'string' ? res.json.code : undefined
}

function isSuccess(res: ApiResponse): boolean {
  return codeOf(res) === ACCESS_SUCCESS_CODE
}

/** A clean, actionable error for a failed call (no stack, no secrets). */
function apiError(what: string, res: ApiResponse): Error {
  const msg = isRecord(res.json) && typeof res.json.msg === 'string' ? res.json.msg : ''
  const hint =
    res.status === 401 || codeOf(res) === 'CODE_ACCESS_TOKEN_INVALID'
      ? ' The token was rejected: check VP_ACCESS_TOKEN (mock: use the token it uses or printed).'
      : ''
  return new Error(
    `${what} failed: HTTP ${String(res.status)} ${codeOf(res) ?? '(no code)'}${msg ? ` (${msg})` : ''}.` +
      hint,
  )
}

// ---------------------------------------------------------------------------------------------
// Main

const summary: Record<string, unknown> = { startedAt: new Date().toISOString() }

async function main(): Promise<void> {
  await mkdir(OUTPUT, { recursive: true })
  say('Access spike (target classified from the first response)')

  // --- TLS
  say('\n== TLS')
  const cert = await fetchLeafCert(host, port)
  const pin = await resolvePin(cert.fingerprint256)
  console.log(`  leaf SHA-256: ${cert.fingerprint256}`)
  say(
    `  valid ${cert.validFrom} -> ${cert.validTo}, self-signed: ${String(cert.selfSigned)}, pin: ${pin.source}`,
  )
  summary.tls = { selfSigned: cert.selfSigned, validTo: cert.validTo, pinSource: pin.source }
  agent = createPinnedAgent(pin.fingerprint256)

  // --- doors
  say('\n== GET /doors')
  const list = await api('GET', '/doors')
  source = sourceFromHeaders(list.headers)
  summary.source = source
  say(
    `  target: ${source === 'mock' ? 'LOCAL MOCK (x-view-protect-mock header present)' : 'CONSOLE (no mock header)'} (_source: "${source}")`,
  )
  // DOOR-3/4: refuse --yes before anything is written or unlocked unless this is the mock.
  if (args.unlock !== undefined && args.yes) unlockConfirmation({ source, yes: true, isTTY: false })
  if (!isSuccess(list)) throw apiError('GET /doors', list)
  const listData = isRecord(list.json) ? list.json.data : undefined
  const rawDoors = Array.isArray(listData) ? listData.filter(isRecord) : []
  for (const d of rawDoors) {
    if (typeof d.id === 'string') sanitizer.mapId(d.id, 'door')
    if (typeof d.floor_id === 'string') sanitizer.mapId(d.floor_id, 'floor')
  }
  validate('GET /doors', AccessDoorListResponseSchema, list.json)
  const table = rawDoors.map((d) => ({
    id: typeof d.id === 'string' ? sanitizer.mapId(d.id, 'door') : '?',
    name: d.name,
    type: d.type,
    is_bind_hub: d.is_bind_hub,
    relay: d.door_lock_relay_status,
    position: d.door_position_status,
    floor: typeof d.floor_id === 'string' ? sanitizer.mapId(d.floor_id, 'floor') : '?',
  }))
  say(`  ${String(rawDoors.length)} doors`)
  for (const line of formatTable(table)) say(`  ${line}`)
  summary.doors = S(table)
  await writeFixture('doors.json', { request: { method: 'GET', path: '/doors' }, res: list })

  // --- error probes (read-only)
  say('\n== Error probes (read-only)')
  const unauth = await api('GET', '/doors', { token: BAD_TOKEN })
  if (isSuccess(unauth)) say('  WARNING: an invalid token was accepted!')
  else validate('GET /doors (invalid token)', AccessErrorEnvelopeSchema, unauth.json)
  await writeFixture('error-unauthorized.json', {
    request: { method: 'GET', path: '/doors', auth: 'Bearer <invalid token>' },
    res: unauth,
  })
  const missing = await api('GET', `/doors/${MISSING_DOOR_ID}`)
  if (isSuccess(missing)) say('  WARNING: a made-up door id was found!')
  else validate('GET /doors/{id} (missing)', AccessErrorEnvelopeSchema, missing.json)
  await writeFixture('error-not-exists.json', {
    request: { method: 'GET', path: '/doors/{id}', id: MISSING_DOOR_ID },
    res: missing,
  })
  summary.errorProbes = {
    invalidToken: { status: unauth.status, code: codeOf(unauth) },
    missingDoor: { status: missing.status, code: codeOf(missing) },
  }

  // --- unlock (only with --unlock, only after confirmation)
  if (args.unlock !== undefined) {
    const parsed = rawDoors.map((d) => AccessDoorSchema.safeParse(d))
    const doors: Pick<AccessDoor, 'id' | 'name' | 'is_bind_hub'>[] = rawDoors.map((d, i) => {
      const p = parsed[i]
      return p?.success === true
        ? p.data
        : {
            id: String(d.id),
            name: String(d.name),
            is_bind_hub: d.is_bind_hub === true || d.is_bind_hub === 'true',
          }
    })
    const door = findDoorByName(doors, args.unlock)
    const fakeId = sanitizer.mapId(door.id, 'door')
    say(`\n== PUT /doors/{id}/unlock: ${fakeId} "${door.name}"`)
    if (!door.is_bind_hub)
      say('  note: is_bind_hub is false; the console should refuse this unlock')
    await confirm(door.name)
    const unlock = await api('PUT', `/doors/${encodeURIComponent(door.id)}/unlock`)
    if (isSuccess(unlock))
      validate('PUT /doors/{id}/unlock', AccessUnlockResponseSchema, unlock.json)
    else validate('PUT /doors/{id}/unlock (error)', AccessErrorEnvelopeSchema, unlock.json)
    const relay = await watchRelay(door.id, isSuccess(unlock) ? args.watchSec : 0)
    await writeFixture('unlock.json', {
      request: { method: 'PUT', path: '/doors/{id}/unlock', id: door.id, body: null },
      res: unlock,
      extra: { relayAfterUnlock: relay },
    })
    summary.unlock = { door: fakeId, status: unlock.status, code: codeOf(unlock), relay }
    if (!isSuccess(unlock)) throw apiError('Unlock', unlock)
  } else {
    say('\n(no --unlock: read-only run, nothing was unlocked)')
  }
}

/** Requires the door name typed back; --yes skips that only against the mock (DOOR-3/4). */
async function confirm(doorName: string): Promise<void> {
  const mode = unlockConfirmation({ source, yes: args.yes, isTTY: process.stdin.isTTY })
  if (mode === 'skip') {
    say('  --yes against the mock: skipping the typed confirmation')
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const typed = await rl.question(`  Type the door name ("${doorName}") to unlock it: `)
    if (!confirmationMatches(typed, doorName))
      throw new Error('Confirmation did not match; nothing was unlocked')
  } finally {
    rl.close()
  }
}

interface RelaySample {
  tMs: number
  relay: unknown
  position: unknown
}

/** Re-reads the door right away, then once a second for `seconds`, printing relay changes. */
async function watchRelay(id: string, seconds: number): Promise<RelaySample[]> {
  say(`  re-reading the door${seconds > 0 ? ` for ${String(seconds)} s` : ''}`)
  const samples: RelaySample[] = []
  const start = Date.now()
  let last: unknown = undefined
  let first = true
  for (;;) {
    const res = await api('GET', `/doors/${encodeURIComponent(id)}`)
    if (first) {
      validate('GET /doors/{id}', AccessDoorResponseSchema, res.json)
      first = false
    }
    const d = isRecord(res.json) && isRecord(res.json.data) ? res.json.data : {}
    const sample = {
      tMs: Date.now() - start,
      relay: d.door_lock_relay_status,
      position: d.door_position_status,
    }
    if (sample.relay !== last) {
      say(`    t+${String(sample.tMs)} ms: door_lock_relay_status=${String(sample.relay)}`)
      samples.push(sample)
      last = sample.relay
    }
    if (Date.now() - start >= seconds * 1000) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  return samples
}

// ---------------------------------------------------------------------------------------------
// TLS pin (scripts/spikes/output/, gitignored), keyed by host and port

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function resolvePin(actual: string): Promise<{ fingerprint256: string; source: string }> {
  const reset =
    `If the certificate really changed (e.g. the mock's .cert/ was deleted), delete ${PIN_REL} ` +
    'or set VP_ACCESS_FINGERPRINT.'
  const env = process.env.VP_ACCESS_FINGERPRINT?.trim()
  if (env) {
    const expected = normalizeFingerprint(env)
    if (expected !== actual)
      throw new Error(
        `TLS pin mismatch against VP_ACCESS_FINGERPRINT. Refusing to connect. ${reset}`,
      )
    return { fingerprint256: expected, source: 'VP_ACCESS_FINGERPRINT' }
  }
  if (await exists(PIN_FILE)) {
    const saved: unknown = JSON.parse(await readFile(PIN_FILE, 'utf8'))
    if (!isRecord(saved) || typeof saved.fingerprint256 !== 'string')
      throw new Error(`${PIN_REL} is unreadable. ${reset}`)
    const expected = normalizeFingerprint(saved.fingerprint256)
    if (expected !== actual) {
      console.log(`  presented: ${actual}\n  expected:  ${expected}`)
      throw new Error(`TLS pin mismatch against the saved pin. Refusing to connect. ${reset}`)
    }
    return { fingerprint256: expected, source: `saved pin (${PIN_REL})` }
  }
  await writeFile(
    PIN_FILE,
    `${JSON.stringify({ fingerprint256: actual, savedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  say(`  trusting on first use: saved the pin to ${PIN_REL}`)
  return { fingerprint256: actual, source: 'first use (TOFU), now saved' }
}

// ---------------------------------------------------------------------------------------------
// Output

async function writeFixture(
  name: string,
  f: { request: Record<string, unknown>; res: ApiResponse; extra?: Record<string, unknown> },
): Promise<void> {
  const fixture = {
    _source: source,
    request: f.request,
    status: f.res.status,
    response: f.res.json,
    ...(f.extra ?? {}),
  }
  await mkdir(FIXTURES, { recursive: true })
  // `_source` is set after sanitizing so the marker itself is never rewritten.
  const clean = { ...(S(fixture) as Record<string, unknown>), _source: source }
  await writeFile(join(FIXTURES, name), `${JSON.stringify(clean, null, 2)}\n`)
  say(`  wrote tests/fixtures/access/${name}`)
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

async function writeSummary(): Promise<void> {
  summary.checks = checksRun
  summary.mismatches = mismatches
  summary.shapeNotes = notesSeen
  await writeFile(
    join(OUTPUT, `access-summary-${source}.json`),
    `${JSON.stringify(S(summary), null, 2)}\n`,
  )
}

main()
  .then(async () => {
    say('\n== Shape check summary')
    if (mismatches.length === 0)
      say(`  all ${String(checksRun.length)} checks match the community shapes`)
    for (const m of mismatches) {
      say(`  ${m.check}:`)
      for (const i of m.issues) say(`    - ${i}`)
      if (m.extraKeys.length > 0) say(`    - undocumented keys: ${m.extraKeys.join(', ')}`)
    }
    if (notesSeen.length === 0) say('  shape notes: none (no lenient normalization was needed)')
    for (const n of notesSeen) {
      say(`  shape notes (${n.check}):`)
      for (const line of n.notes) say(`    - ${line}`)
    }
    await writeSummary()
    say(`  summary: scripts/spikes/output/access-summary-${source}.json`)
  })
  .catch((err: unknown) => {
    say(`access-spike: ${message(err)}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (agent !== undefined) void agent.close()
  })
