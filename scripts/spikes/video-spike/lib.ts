// Pure helpers for the P0.5 video spike: argument parsing, camera/quality selection, the
// go2rtc source URL transform, config and API credentials, the listener-ownership decision,
// CPU-time parsing, go2rtc stream summaries and the G0 verdict. No I/O and no globals, so
// everything here is unit-tested.
import { codecsOf } from './stats.ts'
import { cpuPercent, type PsRow } from '../../../src/main/perf/measure.ts'

export const QUALITIES = ['high', 'medium', 'low'] as const
export type Quality = (typeof QUALITIES)[number]

export interface SpikeArgs {
  /** Camera name (case-insensitive). Default: first G4/G5 camera that already has the quality. */
  camera: string | undefined
  quality: Quality
  /** Measurement time in seconds, counted from Electron start. */
  durationSec: number
  /** Keep the window open after the measurement until it is closed by hand. */
  keepOpen: boolean
  /**
   * Seconds of media the page keeps when VideoRTC trims its SourceBuffer (upstream keeps 5 s,
   * which deletes the keyframe of a 5 s GOP). 0 = upstream behaviour.
   */
  trimKeepSec: number
  /** Page without overlay updates, clock or Web Audio analyser (player cost only). */
  bare: boolean
  /** List connected cameras, their existing qualities and their codecs (probed via go2rtc). */
  list: boolean
  help: boolean
}

export const USAGE =
  'Usage: npm run spike:video -- [--camera <name>] [--quality high|medium|low] ' +
  '[--duration <seconds>] [--trim-keep <seconds>] [--bare] [--keep-open]\n       npm run spike:video -- --list'

export function isQuality(v: string): v is Quality {
  return (QUALITIES as readonly string[]).includes(v)
}

export function parseSpikeArgs(argv: readonly string[]): SpikeArgs {
  const args: SpikeArgs = {
    camera: undefined,
    quality: 'high',
    durationSec: 60,
    keepOpen: false,
    trimKeepSec: 15,
    bare: false,
    list: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--keep-open') args.keepOpen = true
    else if (a === '--list') args.list = true
    else if (a === '--bare') args.bare = true
    else if (a === '--camera') {
      const v = argv[++i]?.trim()
      if (!v) throw new Error(`--camera needs a camera name\n${USAGE}`)
      args.camera = v
    } else if (a === '--quality') {
      const v = argv[++i]?.trim().toLowerCase() ?? ''
      if (!isQuality(v)) throw new Error(`--quality must be high, medium or low\n${USAGE}`)
      args.quality = v
    } else if (a === '--duration') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 5 || n > 3600)
        throw new Error(`--duration needs a number of seconds (5-3600)\n${USAGE}`)
      args.durationSec = n
    } else if (a === '--trim-keep') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0 || n > 120)
        throw new Error(`--trim-keep needs a number of seconds (0-120)\n${USAGE}`)
      args.trimKeepSec = n
    } else throw new Error(`Unknown argument "${String(a)}"\n${USAGE}`)
  }
  return args
}

// ---------------------------------------------------------------------------------------------
// Camera and quality selection

/** The subset of a Protect camera the spike needs. */
export interface CameraLike {
  id: string
  name: string
  type: string
  state: string
}

/** The `rtsps-stream` GET body: each quality is a URL or null (or absent). */
export type RtspsStreamsLike = Partial<Record<string, string | null>>

/** Qualities that already have a URL, in high → low order. */
export function existingQualities(streams: RtspsStreamsLike): Quality[] {
  return QUALITIES.filter((q) => typeof streams[q] === 'string' && streams[q] !== '')
}

/** The cheapest quality that already exists (low before medium before high), for probing. */
export function cheapestQuality(existing: readonly Quality[]): Quality | undefined {
  return [...QUALITIES].reverse().find((q) => existing.includes(q))
}

/** Codec names from go2rtc producer medias: `video, recvonly, H265` → `H265`. */
export function mediaCodecs(medias: readonly string[], kind: 'video' | 'audio'): string[] {
  return medias.flatMap((m) => {
    const parts = m.split(',').map((p) => p.trim())
    if (parts[0] !== kind) return []
    return parts.slice(2).map((c) => c.split('/')[0] ?? c)
  })
}

/** G4/G5 models support Enhanced Encoding (H.265); G3s do not. */
export function isG4OrG5(type: string): boolean {
  return /\bG[45]\b/i.test(type)
}

/**
 * Cameras to try, in order. With `name`, only the connected camera with that name (case
 * insensitive). Without it, connected G4/G5 cameras sorted by name.
 */
export function candidateCameras(
  cameras: readonly CameraLike[],
  name: string | undefined,
): CameraLike[] {
  const connected = cameras.filter((c) => c.state === 'CONNECTED')
  if (name !== undefined) {
    const want = name.toLowerCase()
    return connected.filter((c) => c.name.toLowerCase() === want)
  }
  return connected
    .filter((c) => isG4OrG5(c.type))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

// ---------------------------------------------------------------------------------------------
// go2rtc

/**
 * Protect RTSPS URL → go2rtc source. `rtsps://` becomes `rtspx://` (go2rtc's TLS scheme with
 * certificate verification off: the console's cert is self-signed) and the `enableSrtp` query
 * parameter is removed (go2rtc issue #81: with it the console expects SRTP and go2rtc's plain
 * RTSP-over-TLS session fails). Other query parameters and the path are kept.
 */
export function toGo2rtcSource(rtspsUrl: string): string {
  const m = /^rtsps:\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:\?([^#\s]*))?$/i.exec(rtspsUrl.trim())
  if (!m) throw new Error('Not an rtsps:// URL')
  const [, authority = '', path = '', query] = m
  const kept = (query ?? '')
    .split('&')
    .filter((p) => p !== '' && p.split('=')[0]?.toLowerCase() !== 'enablesrtp')
  return `rtspx://${authority}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}`
}

/** True if `host` is the host part of the source URL (the no-verify scheme is only for it). */
export function sourceHostIs(source: string, host: string): boolean {
  const m = /^[a-z]+:\/\/([^/?#:\s]+|\[[^\]]+\])/i.exec(source)
  return m?.[1]?.toLowerCase() === host.toLowerCase()
}

/** Per-launch credentials for go2rtc's HTTP/WS API (Basic auth). */
export interface Go2rtcAuth {
  username: string
  password: string
}

/** base64url only, at least 16 chars: no `:` (Basic auth splits on it) and nothing YAML cares about. */
const AUTH_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

export function isValidAuthToken(v: string): boolean {
  return AUTH_TOKEN.test(v)
}

/**
 * New random API credentials. `random(n)` must return `n` cryptographically random bytes
 * (`crypto.randomBytes` in the launcher). 18 bytes → 24 base64url chars (144 bits) each.
 */
export function createGo2rtcAuth(random: (n: number) => Uint8Array): Go2rtcAuth {
  const token = (): string => Buffer.from(random(18)).toString('base64url')
  const auth = { username: `vp_${token()}`, password: token() }
  if (!isValidAuthToken(auth.username) || !isValidAuthToken(auth.password))
    throw new Error('Random source returned too few bytes')
  return auth
}

/** `Authorization` header value for go2rtc. */
export function basicAuthHeader(auth: Go2rtcAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`
}

/** Every string form of the credentials that could end up in a log line. */
export function authSecrets(auth: Go2rtcAuth): string[] {
  const header = basicAuthHeader(auth)
  return [header.slice('Basic '.length), auth.password, auth.username]
}

/**
 * Replaces each secret (longest first, so a token is not half-replaced via a substring) and any
 * `Basic <token>` value with `<redacted>`.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, '$1 <redacted>')
  for (const s of [...secrets].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length))
    out = out.split(s).join('<redacted>')
  return out
}

export interface Go2rtcConfigInput {
  /** Loopback port for the HTTP/WS API (the only listener). */
  port: number
  /** go2rtc stream name → source URL. */
  streams: Readonly<Record<string, string>>
  /** API credentials. Enforced for loopback clients too (`local_auth: true`). */
  auth: Go2rtcAuth
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
}

/** Stream names the renderer may see: letters, digits, `_` and `-` only. */
export function isSafeStreamName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

/**
 * go2rtc YAML config. Only the modules the MSE path needs are loaded (`api`, `ws`, `rtsp` for the
 * RTSPS source, `mp4` for the MSE WebSocket handler), so WebRTC, HomeKit, SRTP, RTMP etc. never
 * start. The API listens on 127.0.0.1 only, the RTSP server is off, the API is limited to the
 * paths the spike uses (no web UI, no config/exit endpoints), and CORS stays off.
 *
 * Basic auth (go2rtc v1.9.15 `internal/api/api.go` `middlewareAuth`): it wraps the whole API
 * handler, so `/api`, `/api/streams` and the `/api/ws` upgrade all answer 401 without it. go2rtc
 * **skips** the check for loopback clients unless `local_auth: true`, and since the API only
 * listens on loopback, `local_auth: true` is what makes the credentials mean anything.
 * Scalars are JSON-quoted, which is valid YAML.
 */
export function buildGo2rtcConfig(input: Go2rtcConfigInput): string {
  const { port, streams, auth } = input
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  if (!isValidAuthToken(auth.username) || !isValidAuthToken(auth.password))
    throw new Error('Invalid go2rtc API credentials')
  const q = (s: string): string => JSON.stringify(s)
  const lines = [
    '# Generated by scripts/spikes/video-spike/launch.ts. Contains RTSPS secrets: never commit.',
    'app:',
    `  modules: [${['api', 'ws', 'rtsp', 'mp4'].map(q).join(', ')}]`,
    'api:',
    `  listen: ${q(`127.0.0.1:${String(port)}`)}`,
    `  origin: ${q('')}`,
    `  allow_paths: [${['/api', '/api/ws', '/api/streams'].map(q).join(', ')}]`,
    `  username: ${q(auth.username)}`,
    `  password: ${q(auth.password)}`,
    '  local_auth: true',
    'rtsp:',
    `  listen: ${q('')}`,
    'log:',
    `  level: ${q(input.logLevel ?? 'info')}`,
    'streams:',
  ]
  const names = Object.keys(streams)
  if (names.length === 0) throw new Error('At least one stream is needed')
  for (const name of names) {
    if (!isSafeStreamName(name)) throw new Error(`Unsafe stream name "${name}"`)
    lines.push(`  ${name}: ${q(streams[name] ?? '')}`)
  }
  return `${lines.join('\n')}\n`
}

/** Loopback WebSocket URL the renderer uses for MSE. */
export function go2rtcWsUrl(port: number, stream: string): string {
  return `ws://127.0.0.1:${String(port)}/api/ws?src=${encodeURIComponent(stream)}`
}

/** Redacts anything URL-like that could carry the RTSPS secret alias, for go2rtc log lines. */
export function redactSourceUrls(line: string): string {
  return line.replace(/\brtsp[sx]?:\/\/[^\s"',}]+/gi, '<redacted-source-url>')
}

// ---------------------------------------------------------------------------------------------
// Listener ownership (free-port race)

/** PIDs from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` (`p<pid>` lines; other fields ignored). */
export function parseLsofPids(text: string): number[] {
  const pids = text
    .split('\n')
    .flatMap((l) => (/^p(\d+)\s*$/.exec(l.trim()) ? [Number(l.trim().slice(1))] : []))
  return [...new Set(pids)]
}

/**
 * PIDs listening on `127.0.0.1:<port>` (or `0.0.0.0` / `[::]` / `[::1]`, which also own the
 * port) from Windows `netstat -ano -p TCP` output.
 */
export function parseNetstatListenPids(text: string, port: number): number[] {
  const pids: number[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    const [, addr = '', p = '', pid = ''] = m
    if (Number(p) !== port) continue
    if (['127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(addr)) pids.push(Number(pid))
  }
  return [...new Set(pids)]
}

export interface OwnershipFacts {
  /** PID of the go2rtc child we spawned. */
  childPid: number
  /** Status of `GET /api` with our credentials (null: no answer). */
  authStatus: number | null
  /** Status of `GET /api` without credentials (null: no answer). */
  unauthStatus: number | null
  /** PIDs listening on the port, or null if they couldn't be read (tool missing / failed). */
  listenerPids: readonly number[] | null
  /** macOS/Linux: true (lsof). Windows: false (netstat is best effort). */
  pidCheckRequired: boolean
}

/**
 * Is the listener on the chosen port our go2rtc child? Between `freeLoopbackPort()` closing its
 * probe socket and go2rtc binding, another local process can take the port (go2rtc then logs
 * `[api] listen` and keeps running without a listener). The listener must accept our credentials,
 * reject a request without them, and — the real guard, because an impostor that doesn't enforce
 * auth would pass a plain "answers 200" check — be owned by the child's PID.
 */
export function decideOwnership(f: OwnershipFacts): { ok: boolean; reason: string } {
  if (f.authStatus !== 200)
    return { ok: false, reason: `authenticated GET /api -> ${String(f.authStatus ?? 'no answer')}` }
  if (f.unauthStatus !== 401)
    return {
      ok: false,
      reason: `unauthenticated GET /api -> ${String(f.unauthStatus ?? 'no answer')} (expected 401)`,
    }
  if (f.listenerPids === null) {
    return f.pidCheckRequired
      ? { ok: false, reason: 'listener PID could not be read (required on this platform)' }
      : { ok: true, reason: 'auth checks passed; listener PID not available (best effort)' }
  }
  if (f.listenerPids.length === 0) return { ok: false, reason: 'no listener PID found' }
  const others = f.listenerPids.filter((p) => p !== f.childPid)
  if (others.length > 0)
    return { ok: false, reason: `port is also/instead held by PID ${others.join(', ')}` }
  return { ok: true, reason: `listener PID ${String(f.childPid)} is our go2rtc child` }
}

export interface StreamCodecSummary {
  /** e.g. `video, recvonly, H265` / `audio, recvonly, MPEG4-GENERIC` from go2rtc's producer medias. */
  producerMedias: string[]
  /** Codec names go2rtc negotiated with the producer (e.g. `H265`, `AAC`). */
  producerCodecs: string[]
  consumers: number
  /** Codec names sent to consumers. */
  consumerCodecs: string[]
  /** Per-track packet counters: what go2rtc received from the camera and sent to players.
   * `drops` counts packets go2rtc dropped because a consumer could not keep up. */
  tracks: TrackCounters[]
}

export interface TrackCounters {
  side: 'receiver' | 'sender'
  codec: string
  packets: number
  bytes: number
  drops: number
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : []
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function trackCounters(tracks: unknown, side: TrackCounters['side']): TrackCounters[] {
  return asArray(tracks).flatMap((t) => {
    const r = asRecord(t)
    if (!r) return []
    const name = asRecord(r.codec)?.codec_name
    return [
      {
        side,
        codec: typeof name === 'string' ? name : '?',
        packets: num(r.packets),
        bytes: num(r.bytes),
        drops: num(r.drops),
      },
    ]
  })
}

function codecNames(tracks: unknown): string[] {
  return asArray(tracks).flatMap((t) => {
    const codec = asRecord(asRecord(t)?.codec)
    const name = codec?.codec_name
    return typeof name === 'string' ? [name] : []
  })
}

/**
 * Allowlist summary of go2rtc's `GET /api/streams?src=<name>` body. Producer `url`, remote
 * addresses and user agents are dropped: only media descriptions and codec names are kept.
 */
export function summarizeGo2rtcStream(body: unknown): StreamCodecSummary {
  const stream = asRecord(body)
  const producers = asArray(stream?.producers).map(asRecord)
  const consumers = asArray(stream?.consumers).map(asRecord)
  const producerMedias = producers.flatMap((p) =>
    asArray(p?.medias).filter((m): m is string => typeof m === 'string'),
  )
  return {
    producerMedias: producerMedias.map(redactSourceUrls),
    producerCodecs: [...new Set(producers.flatMap((p) => codecNames(p?.receivers)))],
    consumers: consumers.length,
    consumerCodecs: [...new Set(consumers.flatMap((c) => codecNames(c?.senders)))],
    tracks: [
      ...producers.flatMap((p) => trackCounters(p?.receivers, 'receiver')),
      ...consumers.flatMap((c) => trackCounters(c?.senders, 'sender')),
    ],
  }
}

// ---------------------------------------------------------------------------------------------
// CPU

// parsePsCpuTime, parsePsRows, PsRow, cpuPercent and asBool moved to src/main/perf/measure.ts in P2.5
// so the app's perf harness shares them; re-exported here for the spike and its tests.
export { asBool, cpuPercent, parsePsCpuTime, parsePsRows } from '../../../src/main/perf/measure.ts'
export type { PsRow } from '../../../src/main/perf/measure.ts'

/** Groups the spike's processes: go2rtc, Electron main, and Electron helpers by kind. */
export function processLabel(
  row: PsRow,
  go2rtcPid: number,
  electronPid: number,
): string | undefined {
  if (row.pid === go2rtcPid) return 'go2rtc'
  if (row.pid === electronPid) return 'Electron main'
  if (row.ppid !== electronPid) return undefined
  if (row.command.includes('--type=gpu-process')) return 'GPU'
  if (/\(Renderer\)/i.test(row.command) || row.command.includes('--type=renderer'))
    return 'Renderer'
  return 'Utility'
}

/** CPU % (100 = one core) per label between two ps snapshots taken `wallMs` apart. */
export function cpuByLabel(
  first: readonly PsRow[],
  last: readonly PsRow[],
  wallMs: number,
  go2rtcPid: number,
  electronPid: number,
): Record<string, number> {
  const before = new Map(first.map((r) => [r.pid, r.cpuSec]))
  const out: Record<string, number> = {}
  for (const r of last) {
    const label = processLabel(r, go2rtcPid, electronPid)
    if (label === undefined) continue
    const pct = cpuPercent(before.get(r.pid) ?? r.cpuSec, r.cpuSec, wallMs)
    out[label] = Math.round(((out[label] ?? 0) + pct) * 10) / 10
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// G0 verdict

export interface DecoderFacts {
  /** MSE mime go2rtc answered with, e.g. `video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"`. */
  mseMime: string
  videoDecoderName: string | undefined
  isPlatformVideoDecoder: boolean | undefined
  audioDecoderName: string | undefined
  /** `app.getGPUFeatureStatus().video_decode`. */
  gpuVideoDecode: string | undefined
  decodedFrames: number
  /** Growth of `webkitAudioDecodedByteCount` during the run. */
  audioDecodedBytes: number
}

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

const HW_DECODER =
  /VideoToolbox|D3D11|D3D12|MediaFoundation|DXVA|VaapiVideoDecoder|V4L2|Mojo|Platform/i

export function isHevcCodec(codec: string): boolean {
  return /^(hvc1|hev1)(\.|$)/i.test(codec)
}

export function isAudioCodec(codec: string): boolean {
  return /^(mp4a|opus|flac|mp3|ac-3|ec-3)(\.|$)/i.test(codec)
}

/** The macOS/Windows half of Gate G0 for one run: H.265 + hardware decode + audio. */
export function evaluateG0(f: DecoderFacts): { pass: boolean; checks: CheckResult[] } {
  const codecs = codecsOf(f.mseMime)
  const video = codecs.find((c) => !isAudioCodec(c))
  const audio = codecs.find(isAudioCodec)
  const checks: CheckResult[] = [
    {
      name: 'H.265 over MSE',
      pass: video !== undefined && isHevcCodec(video),
      detail: `video codec ${video ?? 'none'}`,
    },
    {
      name: 'frames decoded',
      pass: f.decodedFrames > 0,
      detail: `${String(f.decodedFrames)} frames`,
    },
    {
      name: 'hardware video decode',
      pass:
        f.isPlatformVideoDecoder === true ||
        (f.isPlatformVideoDecoder === undefined && HW_DECODER.test(f.videoDecoderName ?? '')),
      detail: `decoder ${f.videoDecoderName ?? 'unknown'}, platform=${String(f.isPlatformVideoDecoder)}`,
    },
    {
      name: 'GPU video_decode enabled',
      pass: (f.gpuVideoDecode ?? '').startsWith('enabled'),
      detail: `video_decode=${f.gpuVideoDecode ?? 'unknown'}`,
    },
    {
      name: 'audio decoded',
      pass: audio !== undefined && f.audioDecodedBytes > 0,
      detail: `audio codec ${audio ?? 'none'}, decoder ${f.audioDecoderName ?? 'unknown'}, ${String(f.audioDecodedBytes)} bytes`,
    },
  ]
  return { pass: checks.every((c) => c.pass), checks }
}
