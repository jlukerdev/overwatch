// Local HTTPS mock of the UniFi Access developer API (P0.4, P5.5; SPEC §5.2, R3). Dev-only.
//
//   npm run mock:access
//   npm run mock:access -- --port 12445 --host 127.0.0.1 --latency-ms 300 --fail-rate 0.2
//
// Serves the door API and the notifications WebSocket of Ubiquiti's official reference
// (docs/reference/access-endpoints-v4.2.16.md; the read calls checked on a console, OS-1).
// What the reference leaves open is the mock's own choice: see docs/spikes/P0.4-access-mock.md.
// Binds to loopback by default. Uses a self-signed certificate generated on first run into
// scripts/mock-access/.cert/ (gitignored) with the system `openssl`, so the client's TLS pinning
// path is exercised exactly as against a console. `--cert`/`--key` use your own PEM files instead.
//
// REST (Bearer token), below /api/v1/developer:
//   GET  /doors                      GET /doors/{id}
//   PUT  /doors/{id}/unlock          GET | PUT /doors/{id}/lock_rule
//   GET | PUT /doors/settings/emergency
// WebSocket (same Bearer token on the upgrade): /api/v1/developer/devices/notifications
//   Pushes `access.data.device.remote_unlock` on every successful PUT …/unlock and NOTHING else:
//   no relock event and no relay state, because the reference documents none. Read GET /doors.
//
// Mock-only controls, outside the API prefix, same Bearer token (T = token, B = https://127.0.0.1:12445):
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/doors/<door id>/unlock"          a card tap: unlocks, pushes nothing
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/doors/<door id>/unlock?push=1"   ... and pushes remote_unlock
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/doors/<door id>/lock"            relock now, end any lock rule
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/doors/<door id>/position?status=open"   or status=close
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/doors/<door id>/schedule?minutes=30"    the door's unlock schedule starts: unlocked, lock rule "schedule" for 30 min (default 60)
//   curl -k -X POST -H "Authorization: Bearer $T" "$B/__mock/notifications/drop"              cut every WebSocket client off
//
// Token: VP_ACCESS_TOKEN (environment, else .env.local) if set, never printed. Otherwise a random
// mock-only token is generated and printed once. Each request is logged as method, path and
// result code; headers (and so the token) are never logged. WebSocket connects, disconnects and
// the names of pushed events are logged too. Every response, the 101 included, carries the
// mock-only header `x-view-protect-mock: 1` (MOCK_HEADER in app.ts), which is how the spike tells
// it is the mock.
// Node runs this file directly (type stripping): erasable syntax only.
import { execFileSync } from 'node:child_process'
import { X509Certificate, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCESS_API_PATH, ACCESS_DEFAULT_PORT } from '../../src/main/access/types.ts'
import { MOCK_ADMIN_PATH, NOTIFICATIONS_PATH, createAccessMock } from './app.ts'
import { DEFAULT_UNLOCK_MS } from './doors.ts'
import { createMockServer } from './http.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CERT_DIR = join(HERE, '.cert')
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const USAGE =
  'Usage: node scripts/mock-access/server.ts [--port 12445 (0 = any free port)] [--host 127.0.0.1] ' +
  '[--latency-ms <ms>] [--fail-rate <0..1>] [--unlock-ms <ms>] [--cert <pem> --key <pem>]\n' +
  'Mock-only controls (POST, same Bearer token, outside the API prefix):\n' +
  '  /__mock/doors/<id>/unlock[?push=1]   unlock at the door; silent unless push=1\n' +
  '  /__mock/doors/<id>/lock              relock now and end any lock rule\n' +
  '  /__mock/doors/<id>/position?status=open|close\n' +
  '  /__mock/doors/<id>/schedule[?minutes=N]   start an unlock schedule (lock rule "schedule")\n' +
  '  /__mock/notifications/drop           cut every WebSocket client off'

interface Args {
  port: number
  host: string
  latencyMs: number
  failRate: number
  unlockMs: number
  cert: string | undefined
  key: string | undefined
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: ACCESS_DEFAULT_PORT,
    host: '127.0.0.1',
    latencyMs: 0,
    failRate: 0,
    unlockMs: DEFAULT_UNLOCK_MS,
    cert: undefined,
    key: undefined,
  }
  const num = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v)
    if (v === undefined || !Number.isFinite(n) || n < min || n > max)
      throw new Error(`${flag} needs a number in [${String(min)}, ${String(max)}]\n${USAGE}`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (a === '--port') args.port = num(a, argv[++i], 0, 65535)
    else if (a === '--host') {
      const v = argv[++i]
      if (!v) throw new Error(`--host needs an address\n${USAGE}`)
      args.host = v
    } else if (a === '--latency-ms') args.latencyMs = num(a, argv[++i], 0, 120_000)
    else if (a === '--fail-rate') args.failRate = num(a, argv[++i], 0, 1)
    else if (a === '--unlock-ms') args.unlockMs = num(a, argv[++i], 0, 600_000)
    else if (a === '--cert') args.cert = argv[++i]
    else if (a === '--key') args.key = argv[++i]
    else throw new Error(`Unknown argument "${String(a)}"\n${USAGE}`)
  }
  if ((args.cert === undefined) !== (args.key === undefined))
    throw new Error(`--cert and --key go together\n${USAGE}`)
  return args
}

/** Generates (once) a self-signed P-256 cert for localhost/127.0.0.1/::1 with the system openssl. */
function ensureCert(): { cert: string; key: string } {
  const certPath = join(CERT_DIR, 'cert.pem')
  const keyPath = join(CERT_DIR, 'key.pem')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 })
    try {
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
          '825',
          '-subj',
          '/CN=view-protect-access-mock',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (err) {
      throw new Error(
        'Could not generate the mock certificate with `openssl` (macOS and Linux ship it; on ' +
          'Windows use the one from Git for Windows, or pass --cert/--key with your own PEM files). ' +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    console.log(`Generated a self-signed certificate in ${CERT_DIR}`)
  }
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const envFile = join(ROOT, '.env.local')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  let token = (process.env.VP_ACCESS_TOKEN ?? '').trim()
  let tokenNote = 'using VP_ACCESS_TOKEN (not printed)'
  if (!token) {
    token = randomBytes(24).toString('base64url')
    tokenNote = `generated a MOCK-ONLY token (valid for this mock run only): ${token}`
  }

  const { cert, key } =
    args.cert !== undefined && args.key !== undefined
      ? { cert: readFileSync(args.cert, 'utf8'), key: readFileSync(args.key, 'utf8') }
      : ensureCert()
  const fingerprint = new X509Certificate(cert).fingerprint256

  const mock = createAccessMock({ token, failRate: args.failRate, unlockMs: args.unlockMs })
  const mockServer = createMockServer({
    mock,
    cert,
    key,
    latencyMs: args.latencyMs,
    log: (line) => {
      console.log(`${new Date().toISOString()} ${line}`)
    },
  })
  const { server } = mockServer

  server.on('error', (err) => {
    console.error(`mock-access: ${err.message}`)
    process.exit(1)
  })
  server.listen(args.port, args.host, () => {
    // The port actually bound (it differs from the flag with --port 0).
    const port = String((server.address() as AddressInfo).port)
    const hostPart = args.host.includes(':') ? `[${args.host}]` : args.host
    const origin = `${hostPart}:${port}`
    console.log('UniFi Access MOCK (official reference v4.2.16 shapes, not run against hardware)')
    console.log(`  base URL:     https://${origin}${ACCESS_API_PATH}`)
    console.log(`  WebSocket:    wss://${origin}${NOTIFICATIONS_PATH}`)
    console.log(`  mock control: https://${origin}${MOCK_ADMIN_PATH}/ (POST, see --help)`)
    console.log(`  cert SHA-256: ${fingerprint}`)
    console.log(`  token:        ${tokenNote}`)
    console.log(
      `  unlock relay: ${String(args.unlockMs)} ms, latency ${String(args.latencyMs)} ms, ` +
        `fail rate ${String(args.failRate)}`,
    )
    console.log('  doors:')
    for (const d of mock.store.list())
      console.log(`    ${d.id}  ${d.name}${d.is_bind_hub ? '' : '  (no hub: unlock refused)'}`)
    if (!LOOPBACK.has(args.host))
      console.log(
        `  WARNING: listening on ${args.host}, not loopback. Anyone on that network can reach it.`,
      )
    console.log('Ctrl+C to stop.')
  })

  const stop = (): void => {
    void mockServer.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

try {
  main()
} catch (err) {
  console.error(`mock-access: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
