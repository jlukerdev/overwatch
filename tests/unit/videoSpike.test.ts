// P0.5 video spike: pure helpers (source URL transform, go2rtc config and API auth, listener
// ownership, quality/camera selection, CPU parsing, go2rtc stream summary, G0 verdict) and the
// overlay/summary statistics.
import { describe, expect, it } from 'vitest'
import {
  asBool,
  authSecrets,
  basicAuthHeader,
  buildGo2rtcConfig,
  createGo2rtcAuth,
  decideOwnership,
  isValidAuthToken,
  parseLsofPids,
  parseNetstatListenPids,
  redactSecrets,
  candidateCameras,
  cheapestQuality,
  cpuByLabel,
  cpuPercent,
  evaluateG0,
  existingQualities,
  go2rtcWsUrl,
  isG4OrG5,
  isHevcCodec,
  isSafeStreamName,
  mediaCodecs,
  parsePsCpuTime,
  parsePsRows,
  parseSpikeArgs,
  processLabel,
  redactSourceUrls,
  sourceHostIs,
  summarizeGo2rtcStream,
  toGo2rtcSource,
} from '../../scripts/spikes/video-spike/lib.ts'
import type { DecoderFacts } from '../../scripts/spikes/video-spike/lib.ts'
import {
  bufferLatency,
  codecsOf,
  droppedPercent,
  formatOverlay,
  fpsBetween,
  hasAudioTrack,
  summarizeSamples,
} from '../../scripts/spikes/video-spike/stats.ts'
import type { PlayerSample } from '../../scripts/spikes/video-spike/stats.ts'

// Fake values only (`.invalid` is reserved, RFC 2606).
const RTSPS = 'rtsps://console.invalid:7441/AbCdEfGh12345678?enableSrtp'

describe('parseSpikeArgs', () => {
  it('has safe defaults', () => {
    expect(parseSpikeArgs([])).toEqual({
      camera: undefined,
      quality: 'high',
      durationSec: 60,
      keepOpen: false,
      trimKeepSec: 15,
      bare: false,
      list: false,
      help: false,
    })
  })

  it('parses every flag', () => {
    const a = parseSpikeArgs([
      '--camera',
      'Carport',
      '--quality',
      'LOW',
      '--duration',
      '20',
      '--trim-keep',
      '0',
      '--bare',
      '--keep-open',
    ])
    expect(a).toMatchObject({
      camera: 'Carport',
      quality: 'low',
      durationSec: 20,
      trimKeepSec: 0,
      bare: true,
      keepOpen: true,
    })
    expect(parseSpikeArgs(['--list']).list).toBe(true)
    expect(parseSpikeArgs(['-h']).help).toBe(true)
  })

  it('rejects bad values and unknown flags', () => {
    expect(() => parseSpikeArgs(['--quality', 'package'])).toThrow(/high, medium or low/)
    expect(() => parseSpikeArgs(['--duration', '2'])).toThrow(/seconds/)
    expect(() => parseSpikeArgs(['--duration', 'x'])).toThrow(/seconds/)
    expect(() => parseSpikeArgs(['--trim-keep', '-1'])).toThrow(/trim-keep/)
    expect(() => parseSpikeArgs(['--camera'])).toThrow(/camera name/)
    expect(() => parseSpikeArgs(['--post'])).toThrow(/Unknown argument/)
  })
})

describe('quality and camera selection', () => {
  it('lists existing qualities high → low, ignoring null, empty and package', () => {
    expect(existingQualities({ high: null, medium: 'u', low: 'u', package: 'u' })).toEqual([
      'medium',
      'low',
    ])
    expect(existingQualities({ high: '', medium: null })).toEqual([])
  })

  it('picks the cheapest existing quality for probing', () => {
    expect(cheapestQuality(['high', 'medium', 'low'])).toBe('low')
    expect(cheapestQuality(['high', 'medium'])).toBe('medium')
    expect(cheapestQuality([])).toBeUndefined()
  })

  it('recognises G4/G5 models', () => {
    expect(isG4OrG5('UVC G4 Instant')).toBe(true)
    expect(isG4OrG5('UVC G5 Flex')).toBe(true)
    expect(isG4OrG5('UVC G3 Instant')).toBe(false)
    expect(isG4OrG5('UVC AI G4X')).toBe(false)
  })

  const cams = [
    { id: '1', name: 'Shop', type: 'UVC G3 Instant', state: 'CONNECTED' },
    { id: '2', name: 'Side Yard', type: 'UVC G4 Instant', state: 'CONNECTED' },
    { id: '3', name: 'Carport', type: 'UVC G4 Instant', state: 'CONNECTED' },
    { id: '4', name: 'Office', type: 'UVC G5 Flex', state: 'DISCONNECTED' },
  ]

  it('defaults to connected G4/G5 cameras sorted by name', () => {
    expect(candidateCameras(cams, undefined).map((c) => c.name)).toEqual(['Carport', 'Side Yard'])
  })

  it('matches --camera case-insensitively, connected only, any model', () => {
    expect(candidateCameras(cams, 'shop').map((c) => c.id)).toEqual(['1'])
    expect(candidateCameras(cams, 'Office')).toEqual([])
  })
})

describe('toGo2rtcSource', () => {
  it('switches to rtspx:// and drops ?enableSrtp', () => {
    expect(toGo2rtcSource(RTSPS)).toBe('rtspx://console.invalid:7441/AbCdEfGh12345678')
  })

  it('keeps other query parameters and handles a missing query', () => {
    expect(toGo2rtcSource('rtsps://h.invalid:7441/abc?x=1&enableSrtp&y=2')).toBe(
      'rtspx://h.invalid:7441/abc?x=1&y=2',
    )
    expect(toGo2rtcSource('rtsps://h.invalid:7441/abc?enableSrtp=true')).toBe(
      'rtspx://h.invalid:7441/abc',
    )
    expect(toGo2rtcSource('RTSPS://h.invalid/abc')).toBe('rtspx://h.invalid/abc')
  })

  it('rejects anything that is not rtsps://', () => {
    expect(() => toGo2rtcSource('rtsp://h.invalid/abc')).toThrow(/rtsps/)
    expect(() => toGo2rtcSource('https://h.invalid/abc')).toThrow(/rtsps/)
    expect(() => toGo2rtcSource('rtsps://h.invalid/a b')).toThrow(/rtsps/)
  })

  it('checks the source host', () => {
    const src = toGo2rtcSource(RTSPS)
    expect(sourceHostIs(src, 'console.invalid')).toBe(true)
    expect(sourceHostIs(src, 'CONSOLE.invalid')).toBe(true)
    expect(sourceHostIs(src, 'other.invalid')).toBe(false)
    expect(sourceHostIs('rtspx://evil.invalid.console.invalid:7441/x', 'console.invalid')).toBe(
      false,
    )
  })
})

// Fake credentials (fixed bytes), never used against a real go2rtc.
const AUTH = createGo2rtcAuth((n) => new Uint8Array(n).fill(7))

describe('buildGo2rtcConfig', () => {
  const yaml = buildGo2rtcConfig({
    port: 41234,
    streams: { spike_high: 'rtspx://c.invalid/a' },
    auth: AUTH,
  })

  it('binds the API to loopback and turns the other listeners off', () => {
    expect(yaml).toContain('  listen: "127.0.0.1:41234"')
    expect(yaml).toMatch(/^rtsp:\n {2}listen: ""$/m)
    expect(yaml).toContain('  modules: ["api", "ws", "rtsp", "mp4"]')
    expect(yaml).toContain('  allow_paths: ["/api", "/api/ws", "/api/streams"]')
    expect(yaml).toContain('  origin: ""')
    expect(yaml).not.toMatch(/webrtc|0\.0\.0\.0|:8554|:8555/)
  })

  it('requires API credentials for every client, loopback included', () => {
    expect(yaml).toContain(`  username: "${AUTH.username}"`)
    expect(yaml).toContain(`  password: "${AUTH.password}"`)
    expect(yaml).toMatch(/^api:\n(?: {2}.*\n)* {2}local_auth: true$/m)
  })

  it('rejects missing or unsafe credentials', () => {
    const streams = { a: 'x' }
    expect(() =>
      buildGo2rtcConfig({ port: 1984, streams, auth: { username: '', password: AUTH.password } }),
    ).toThrow(/credentials/)
    expect(() =>
      buildGo2rtcConfig({
        port: 1984,
        streams,
        auth: { username: AUTH.username, password: 'short' },
      }),
    ).toThrow(/credentials/)
    expect(() =>
      buildGo2rtcConfig({
        port: 1984,
        streams,
        auth: { username: AUTH.username, password: 'has:colon"and-quote0000' },
      }),
    ).toThrow(/credentials/)
  })

  it('quotes the stream sources', () => {
    expect(yaml).toContain('  spike_high: "rtspx://c.invalid/a"')
  })

  it('rejects bad ports, unsafe names and empty stream sets', () => {
    const auth = AUTH
    expect(() => buildGo2rtcConfig({ port: 0, streams: { a: 'x' }, auth })).toThrow(/port/)
    expect(() => buildGo2rtcConfig({ port: 70000, streams: { a: 'x' }, auth })).toThrow(/port/)
    expect(() => buildGo2rtcConfig({ port: 1984, streams: { 'a: b': 'x' }, auth })).toThrow(
      /Unsafe/,
    )
    expect(() => buildGo2rtcConfig({ port: 1984, streams: {}, auth })).toThrow(/At least one/)
  })

  it('builds the renderer URL from the stream name only', () => {
    expect(go2rtcWsUrl(41234, 'spike_high')).toBe('ws://127.0.0.1:41234/api/ws?src=spike_high')
    expect(isSafeStreamName('cam_1-low')).toBe(true)
    expect(isSafeStreamName('a/b')).toBe(false)
  })
})

describe('go2rtc API credentials', () => {
  it('creates base64url credentials from the random source', () => {
    expect(AUTH.username).toMatch(/^vp_[A-Za-z0-9_-]{24}$/)
    expect(AUTH.password).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(isValidAuthToken(AUTH.password)).toBe(true)
    let i = 0
    const a = createGo2rtcAuth((n) => new Uint8Array(n).fill(i++))
    expect(a.username).not.toContain(a.password)
    expect(() => createGo2rtcAuth(() => new Uint8Array(2))).toThrow(/too few/)
  })

  it('builds the Basic header', () => {
    const h = basicAuthHeader({ username: 'user', password: 'pass' })
    expect(h).toBe(`Basic ${btoa('user:pass')}`)
  })

  it('redacts every form of the credentials and any Basic/Bearer value', () => {
    const header = basicAuthHeader(AUTH)
    const line = `auth=${header} user=${AUTH.username} pass=${AUTH.password} raw=${header.slice(6)}`
    const out = redactSecrets(line, authSecrets(AUTH))
    expect(out).not.toContain(AUTH.password)
    expect(out).not.toContain(AUTH.username)
    expect(out).not.toContain(header.slice(6))
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==', [])).toBe(
      'Authorization: Basic <redacted>',
    )
    expect(redactSecrets('nothing here', authSecrets(AUTH))).toBe('nothing here')
  })
})

describe('listener ownership', () => {
  it('parses lsof -Fp output', () => {
    expect(parseLsofPids('p4242\nf7\n')).toEqual([4242])
    expect(parseLsofPids('p1\np2\np1\n')).toEqual([1, 2])
    expect(parseLsofPids('')).toEqual([])
  })

  it('parses netstat -ano listeners for the port only', () => {
    const text = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:41234        0.0.0.0:0              LISTENING       5150',
      '  TCP    127.0.0.1:41234        127.0.0.1:50000        ESTABLISHED     5150',
      '  TCP    0.0.0.0:41234          0.0.0.0:0              LISTENING       6000',
      '  TCP    127.0.0.1:412345       0.0.0.0:0              LISTENING       7000',
      '  TCP    192.168.0.2:41234      0.0.0.0:0              LISTENING       8000',
      '  TCP    127.0.0.1:1984         0.0.0.0:0              LISTENING       9000',
    ].join('\r\n')
    expect(parseNetstatListenPids(text, 41234)).toEqual([5150, 6000])
  })

  const ok = {
    childPid: 100,
    authStatus: 200,
    unauthStatus: 401,
    listenerPids: [100],
    pidCheckRequired: true,
  }

  it('accepts our child enforcing auth', () => {
    expect(decideOwnership(ok).ok).toBe(true)
  })

  it('rejects a listener that refuses our credentials or does not enforce auth', () => {
    expect(decideOwnership({ ...ok, authStatus: 401 }).ok).toBe(false)
    expect(decideOwnership({ ...ok, authStatus: 404 }).ok).toBe(false)
    expect(decideOwnership({ ...ok, authStatus: null }).ok).toBe(false)
    expect(decideOwnership({ ...ok, unauthStatus: 200 }).ok).toBe(false)
  })

  it('rejects another PID on the port, even when auth looks right', () => {
    expect(decideOwnership({ ...ok, listenerPids: [999] }).reason).toMatch(/999/)
    expect(decideOwnership({ ...ok, listenerPids: [100, 999] }).ok).toBe(false)
    expect(decideOwnership({ ...ok, listenerPids: [] }).ok).toBe(false)
  })

  it('needs the PID on macOS/Linux and treats it as best effort on Windows', () => {
    expect(decideOwnership({ ...ok, listenerPids: null }).ok).toBe(false)
    expect(decideOwnership({ ...ok, listenerPids: null, pidCheckRequired: false }).ok).toBe(true)
    expect(decideOwnership({ ...ok, listenerPids: [999], pidCheckRequired: false }).ok).toBe(false)
  })
})

describe('redaction and go2rtc stream summary', () => {
  it('redacts rtsp, rtsps and rtspx URLs in log lines', () => {
    expect(redactSourceUrls('ERR url=rtspx://c.invalid:7441/abc, x')).toBe(
      'ERR url=<redacted-source-url>, x',
    )
    expect(redactSourceUrls(`"${RTSPS}"`)).toBe('"<redacted-source-url>"')
  })

  const body = {
    producers: [
      {
        id: 1,
        format_name: 'rtsp',
        url: 'rtspx://c.invalid:7441/secret',
        remote_addr: '192.0.2.1:7441',
        medias: [
          'video, recvonly, H264',
          'audio, recvonly, MPEG4-GENERIC/16000',
          'audio, recvonly, OPUS/48000/2',
        ],
        receivers: [
          { id: 1, codec: { codec_name: 'h264' }, packets: 300, bytes: 9000 },
          { id: 2, codec: { codec_name: 'aac' }, packets: 150 },
        ],
      },
    ],
    consumers: [
      {
        format_name: 'mse/fmp4',
        remote_addr: '127.0.0.1:5000',
        user_agent: 'Electron',
        senders: [{ id: 3, codec: { codec_name: 'h264' }, packets: 299, drops: 1 }],
      },
    ],
  }

  it('keeps medias, codecs and counters only', () => {
    const s = summarizeGo2rtcStream(body)
    expect(s.producerCodecs).toEqual(['h264', 'aac'])
    expect(s.consumers).toBe(1)
    expect(s.consumerCodecs).toEqual(['h264'])
    expect(s.tracks).toContainEqual({
      side: 'sender',
      codec: 'h264',
      packets: 299,
      bytes: 0,
      drops: 1,
    })
    const text = JSON.stringify(s)
    expect(text).not.toMatch(/secret|192\.0\.2\.1|rtspx|Electron/)
    expect(mediaCodecs(s.producerMedias, 'video')).toEqual(['H264'])
    expect(mediaCodecs(s.producerMedias, 'audio')).toEqual(['MPEG4-GENERIC', 'OPUS'])
  })

  it('tolerates junk', () => {
    expect(summarizeGo2rtcStream(null)).toEqual({
      producerMedias: [],
      producerCodecs: [],
      consumers: 0,
      consumerCodecs: [],
      tracks: [],
    })
    expect(summarizeGo2rtcStream({ producers: 'x', consumers: [1] }).consumers).toBe(1)
  })
})

describe('CPU', () => {
  it('parses ps time formats', () => {
    expect(parsePsCpuTime('0:01.23')).toBeCloseTo(1.23)
    expect(parsePsCpuTime(' 17:03.95 ')).toBeCloseTo(1023.95)
    expect(parsePsCpuTime('01:02:03')).toBe(3723)
    expect(parsePsCpuTime('2-01:00:00')).toBe(2 * 86400 + 3600)
    expect(() => parsePsCpuTime('abc')).toThrow(/Unrecognised/)
  })

  it('computes CPU % from cumulative seconds', () => {
    expect(cpuPercent(10, 11, 10_000)).toBeCloseTo(10)
    expect(cpuPercent(10, 9, 1000)).toBe(0)
    expect(cpuPercent(0, 1, 0)).toBe(0)
  })

  const ps = (sec: (pid: number) => number): string =>
    [
      `  100     1   ${String(sec(100))}:00.00 /path/go2rtc -c /x/go2rtc.yaml`,
      `  200     1   0:${String(sec(200)).padStart(2, '0')}.00 /path/Electron /x/electron-main.ts`,
      `  201   200   0:${String(sec(201)).padStart(2, '0')}.00 /p/Electron Helper --type=gpu-process`,
      `  202   200   0:${String(sec(202)).padStart(2, '0')}.00 /p/Electron Helper (Renderer) --type=renderer`,
      `  203   200   0:${String(sec(203)).padStart(2, '0')}.00 /p/Electron Helper --type=utility`,
      `  300     1   0:01.00 /other/app`,
      'garbage line',
    ].join('\n')

  it('parses ps rows and labels the spike processes', () => {
    const rows = parsePsRows(ps(() => 1))
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => processLabel(r, 100, 200))).toEqual([
      'go2rtc',
      'Electron main',
      'GPU',
      'Renderer',
      'Utility',
      undefined,
    ])
  })

  it('aggregates CPU % per label between snapshots', () => {
    const a = parsePsRows(ps(() => 1))
    const b = parsePsRows(ps((pid) => (pid === 202 ? 6 : pid === 100 ? 1 : 2)))
    // 10 s apart: renderer used 5 s (50 %), go2rtc 0, others 1 s (10 %).
    expect(cpuByLabel(a, b, 10_000, 100, 200)).toEqual({
      go2rtc: 0,
      'Electron main': 10,
      GPU: 10,
      Renderer: 50,
      Utility: 10,
    })
  })
})

describe('G0 verdict', () => {
  const facts: DecoderFacts = {
    mseMime: 'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"',
    videoDecoderName: 'VideoToolboxVideoDecoder',
    isPlatformVideoDecoder: true,
    audioDecoderName: 'FFmpegAudioDecoder',
    gpuVideoDecode: 'enabled',
    decodedFrames: 1800,
    audioDecodedBytes: 400_000,
  }

  it('passes H.265 + hardware decode + audio', () => {
    expect(evaluateG0(facts).pass).toBe(true)
  })

  it('fails H.264, software decode, no audio, or no frames', () => {
    const fail = (f: Partial<DecoderFacts>): string[] =>
      evaluateG0({ ...facts, ...f })
        .checks.filter((c) => !c.pass)
        .map((c) => c.name)
    expect(fail({ mseMime: 'video/mp4; codecs="avc1.4D4029,mp4a.40.2"' })).toEqual([
      'H.265 over MSE',
    ])
    expect(fail({ isPlatformVideoDecoder: false, videoDecoderName: 'FFmpegVideoDecoder' })).toEqual(
      ['hardware video decode'],
    )
    expect(fail({ mseMime: 'video/mp4; codecs="hev1.1.6.L153.B0"' })).toEqual(['audio decoded'])
    expect(fail({ audioDecodedBytes: 0 })).toEqual(['audio decoded'])
    expect(fail({ decodedFrames: 0 })).toEqual(['frames decoded'])
    expect(fail({ gpuVideoDecode: 'unavailable_software' })).toEqual(['GPU video_decode enabled'])
  })

  it('falls back to the decoder name when the platform flag is missing', () => {
    expect(
      evaluateG0({
        ...facts,
        isPlatformVideoDecoder: undefined,
        videoDecoderName: 'D3D11VideoDecoder',
      }).pass,
    ).toBe(true)
    expect(
      evaluateG0({ ...facts, isPlatformVideoDecoder: undefined, videoDecoderName: undefined }).pass,
    ).toBe(false)
  })

  it('reads Media-domain booleans and HEVC codec strings', () => {
    expect(asBool('true')).toBe(true)
    expect(asBool(false)).toBe(false)
    expect(asBool('yes')).toBeUndefined()
    expect(isHevcCodec('hvc1.1.6.L153.B0')).toBe(true)
    expect(isHevcCodec('hev1.2.4.L120.90')).toBe(true)
    expect(isHevcCodec('avc1.640029')).toBe(false)
  })
})

describe('overlay statistics', () => {
  const base: PlayerSample = {
    t: 0,
    mseMime: 'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"',
    width: 2688,
    height: 1512,
    currentTime: 10,
    bufferedEnd: 11,
    totalFrames: 300,
    droppedFrames: 3,
    presentedFrames: 297,
    audioDecodedBytes: 1000,
    videoDecodedBytes: 5000,
    audioRms: 0.02,
    muted: false,
    paused: false,
    readyState: 4,
    playbackRate: 1,
    firstFrameMs: 450,
    error: null,
    appends: { count: 1, bytes: 1, maxBytes: 1, errors: 0, lastError: null, largeAppendsAt: [] },
    trimsClamped: 0,
  }
  const at = (t: number, over: Partial<PlayerSample> = {}): PlayerSample => ({
    ...base,
    t,
    ...over,
  })

  it('derives latency, fps and dropped %', () => {
    expect(bufferLatency(base)).toBe(1)
    expect(bufferLatency(at(0, { bufferedEnd: null }))).toBeNull()
    expect(bufferLatency(at(0, { bufferedEnd: 9 }))).toBe(0)
    expect(fpsBetween(at(0), at(2000, { presentedFrames: 357 }))).toBe(30)
    expect(fpsBetween(at(1000), at(1000))).toBeNull()
    expect(droppedPercent(base)).toBe(1)
    expect(droppedPercent(at(0, { totalFrames: 0 }))).toBe(0)
  })

  it('parses MSE codecs and the audio track', () => {
    expect(codecsOf(base.mseMime)).toEqual(['hvc1.1.6.L153.B0', 'mp4a.40.2'])
    expect(codecsOf('')).toEqual([])
    expect(hasAudioTrack(base.mseMime)).toBe(true)
    expect(hasAudioTrack('video/mp4; codecs="avc1.640029"')).toBe(false)
  })

  it('formats the overlay', () => {
    const lines = formatOverlay(at(1000, { presentedFrames: 327 }), base)
    expect(lines[0]).toBe('codecs     hvc1.1.6.L153.B0, mp4a.40.2')
    expect(lines).toContain('resolution 2688×1512')
    expect(lines).toContain('fps        30.0')
    expect(lines).toContain('latency    1.00 s (buffer)')
    expect(lines.join('\n')).toMatch(/audio {6}track present, unmuted, level 0\.020/)
    expect(formatOverlay(at(0, { mseMime: '', error: '3 decode' }), undefined)).toEqual(
      expect.arrayContaining(['codecs     negotiating…', 'fps        –', 'error      3 decode']),
    )
  })

  it('summarizes the steady state after the first frame', () => {
    const samples = [
      at(0, { firstFrameMs: null, bufferedEnd: null, presentedFrames: 0, audioDecodedBytes: 0 }),
      at(1000, { presentedFrames: 30, bufferedEnd: 15 }), // first frame, warm-up (latency 5)
      at(7000, { presentedFrames: 210, audioRms: 0.1 }),
      at(9000, { presentedFrames: 270, bufferedEnd: 12, audioDecodedBytes: 9000 }),
    ]
    const s = summarizeSamples(samples, 5000)
    expect(s.firstFrameMs).toBe(450)
    expect(s.meanFps).toBe(30)
    expect(s.latency.mean).toBe(1.5)
    expect(s.latency.max).toBe(2)
    expect(s.latency.p95).toBe(2)
    expect(s.audioDecodedBytes).toBe(9000)
    expect(s.maxAudioRms).toBe(0.1)
    expect(summarizeSamples([]).samples).toBe(0)
  })
})
