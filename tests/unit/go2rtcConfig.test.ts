// P2.1: the pure go2rtc values (src/main/streams/go2rtcConfig.ts) — SPEC §5.3, R4, R7, CON-2.
//
// Every assertion here is a security rule rather than a formatting preference, which is why the
// generated config is checked line by line instead of by snapshot: `local_auth: true`, an empty
// `origin`, no RTSP listener, the three allowed paths and the four modules are the difference
// between "loopback only, authenticated" and "any local process can watch the cameras".
//
// The transform and redaction tests are the other half: the `rtspx://` rewrite is what makes the
// unpinned RTSPS leg acceptable at all (R4), and a credential or a source URL surviving into a log
// line would be a CON-2/NFR-9 break.
import { describe, expect, it } from 'vitest'
import {
  GO2RTC_ALLOW_PATHS,
  GO2RTC_CONFIG_FILE,
  GO2RTC_MODULES,
  authSecrets,
  basicAuthHeader,
  buildGo2rtcConfig,
  createGo2rtcAuth,
  go2rtcApiUrl,
  go2rtcWsUrl,
  isSafeStreamName,
  isValidAuthToken,
  redactSecrets,
  redactSourceUrls,
  sourceHostIs,
  summarizeGo2rtcStream,
  toGo2rtcSource,
  type Go2rtcAuth,
} from '../../src/main/streams/go2rtcConfig'

const HOST = 'console.test'
const RTSPS = `rtsps://${HOST}:7441/aBcDeFgHiJkLmNoP?enableSrtp`
const SOURCE = `rtspx://${HOST}:7441/aBcDeFgHiJkLmNoP`

/** Deterministic "random" bytes, so the credential shape can be asserted exactly. */
function fixedRandom(byte: number): (n: number) => Uint8Array {
  return (n) => new Uint8Array(n).fill(byte)
}

const auth: Go2rtcAuth = createGo2rtcAuth(fixedRandom(7))

function configLines(input: Parameters<typeof buildGo2rtcConfig>[0]): string[] {
  return buildGo2rtcConfig(input).split('\n')
}

describe('buildGo2rtcConfig', () => {
  const base = { port: 41234, streams: { cam1_low: SOURCE }, auth } as const

  it('loads only the four modules the MSE path needs', () => {
    expect(GO2RTC_MODULES).toEqual(['api', 'ws', 'rtsp', 'mp4'])
    expect(configLines(base)).toContain('  modules: ["api", "ws", "rtsp", "mp4"]')
  })

  it('binds the API to loopback only and turns the RTSP server off', () => {
    const lines = configLines(base)
    expect(lines).toContain('  listen: "127.0.0.1:41234"')
    // The RTSP *server*: the client still works, which is what the RTSPS upstream uses.
    expect(lines).toContain('rtsp:')
    expect(lines[lines.indexOf('rtsp:') + 1]).toBe('  listen: ""')
    expect(buildGo2rtcConfig(base)).not.toContain('0.0.0.0')
  })

  it('keeps go2rtc’s same-origin check on (never origin: "*")', () => {
    expect(configLines(base)).toContain('  origin: ""')
    expect(buildGo2rtcConfig(base)).not.toContain('"*"')
  })

  it('allows only /api, /api/ws and /api/streams', () => {
    expect(GO2RTC_ALLOW_PATHS).toEqual(['/api', '/api/ws', '/api/streams'])
    expect(configLines(base)).toContain('  allow_paths: ["/api", "/api/ws", "/api/streams"]')
    // No web UI, no config dump (it would hand out the credentials), no remote exit.
    const yaml = buildGo2rtcConfig(base)
    expect(yaml).not.toContain('/api/config')
    expect(yaml).not.toContain('/api/exit')
  })

  it('sets the credentials and local_auth, without which loopback clients skip auth', () => {
    const lines = configLines(base)
    expect(lines).toContain(`  username: ${JSON.stringify(auth.username)}`)
    expect(lines).toContain(`  password: ${JSON.stringify(auth.password)}`)
    expect(lines).toContain('  local_auth: true')
  })

  it('writes the desired streams, and accepts none at all (deviation from the spike)', () => {
    expect(configLines({ ...base, streams: { a_low: SOURCE, b_high: SOURCE } })).toEqual(
      expect.arrayContaining([`  a_low: ${JSON.stringify(SOURCE)}`, '  b_high: "' + SOURCE + '"']),
    )
    // The app starts go2rtc before any camera is known; P2.2 registers streams at runtime.
    const empty = buildGo2rtcConfig({ ...base, streams: {} })
    expect(empty.trimEnd().endsWith('streams:')).toBe(true)
  })

  it('refuses an unsafe stream name', () => {
    for (const name of ['../etc', 'cam 1', 'cam:1', 'a'.repeat(65), '', 'cam\n  x: y'])
      expect(() => buildGo2rtcConfig({ ...base, streams: { [name]: SOURCE } })).toThrow(
        /Unsafe stream name/,
      )
  })

  it('refuses an invalid port', () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN])
      expect(() => buildGo2rtcConfig({ ...base, port })).toThrow(/Invalid port/)
  })

  it('refuses credentials that are not base64url, so no value can reshape the YAML', () => {
    expect(() =>
      buildGo2rtcConfig({ ...base, auth: { username: 'a:b', password: auth.password } }),
    ).toThrow(/Invalid go2rtc API credentials/)
    expect(() =>
      buildGo2rtcConfig({ ...base, auth: { username: auth.username, password: 'short' } }),
    ).toThrow(/Invalid go2rtc API credentials/)
  })

  it('quotes every scalar and names the file it is written as', () => {
    expect(GO2RTC_CONFIG_FILE).toBe('go2rtc.yaml')
    expect(buildGo2rtcConfig(base)).toContain(GO2RTC_CONFIG_FILE)
    expect(configLines({ ...base, logLevel: 'debug' })).toContain('  level: "debug"')
    expect(configLines(base)).toContain('  level: "info"')
  })
})

describe('toGo2rtcSource', () => {
  it('rewrites rtsps:// to rtspx:// and strips enableSrtp', () => {
    expect(toGo2rtcSource(RTSPS)).toBe(SOURCE)
    expect(toGo2rtcSource(`rtsps://${HOST}:7441/alias?enablesrtp`)).toBe(
      `rtspx://${HOST}:7441/alias`,
    )
  })

  it('keeps other query parameters', () => {
    expect(toGo2rtcSource(`rtsps://${HOST}:7441/alias?enableSrtp&foo=1&bar=2`)).toBe(
      `rtspx://${HOST}:7441/alias?foo=1&bar=2`,
    )
  })

  it('refuses anything that is not an rtsps:// URL', () => {
    for (const url of [
      `rtsp://${HOST}/alias`,
      `rtspx://${HOST}/alias`,
      `https://${HOST}/alias`,
      'not a url',
      '',
    ])
      expect(() => toGo2rtcSource(url)).toThrow(/Not an rtsps/)
  })
})

describe('sourceHostIs', () => {
  it('compares the host of the source with the pinned console host (R4)', () => {
    expect(sourceHostIs(SOURCE, HOST)).toBe(true)
    expect(sourceHostIs(SOURCE, HOST.toUpperCase())).toBe(true)
    expect(sourceHostIs(SOURCE, 'evil.test')).toBe(false)
    // A userinfo trick must not pass as the console host.
    expect(sourceHostIs(`rtspx://${HOST}@evil.test:7441/alias`, HOST)).toBe(false)
    expect(sourceHostIs('rtspx://[::1]:7441/alias', '[::1]')).toBe(true)
    expect(sourceHostIs('nonsense', HOST)).toBe(false)
  })

  it('reads the host an RTSP client would connect to, userinfo and all (R4)', () => {
    // The bypass: userinfo *with a colon in it* used to match the pinned host while Go — and so
    // go2rtc — connects to `evil.example`, which is exactly what R4's check exists to prevent.
    expect(sourceHostIs(`rtspx://${HOST}:7441@evil.example:7441/alias`, HOST)).toBe(false)
    expect(sourceHostIs(`rtspx://user:pass@evil.example/alias`, HOST)).toBe(false)
    // Userinfo without a colon, and more than one `@`: the host is what follows the **last** one.
    expect(sourceHostIs(`rtspx://${HOST}@evil.example/alias`, HOST)).toBe(false)
    expect(sourceHostIs(`rtspx://a@b@evil.example/alias`, HOST)).toBe(false)
    expect(sourceHostIs(`rtspx://a@b@${HOST}:7441/alias`, HOST)).toBe(true)
    // Bracketed IPv6, with and without userinfo and port, against both forms of the pinned host:
    // `console/endpoints.ts` hands out an unbracketed `host`, the source URL carries brackets.
    for (const pinned of ['::1', '[::1]', '[::1]'.toUpperCase()]) {
      expect(sourceHostIs('rtspx://[::1]/alias', pinned)).toBe(true)
      expect(sourceHostIs('rtspx://[::1]:7441/alias', pinned)).toBe(true)
      expect(sourceHostIs('rtspx://[2001:db8::1]:7441/alias', pinned)).toBe(false)
      expect(sourceHostIs('rtspx://user:pass@[2001:db8::1]:7441/alias', pinned)).toBe(false)
    }
    expect(sourceHostIs('rtspx://[2001:DB8::1]:7441/alias', '2001:db8::1')).toBe(true)
    expect(sourceHostIs('rtspx://user@[::1]:7441/alias', '::1')).toBe(true)
    // Fail closed on anything that cannot be parsed unambiguously.
    for (const source of [
      'rtspx:///alias',
      'rtspx://@/alias',
      'rtspx://[::1:7441/alias',
      'rtspx://[]:7441/alias',
      `rtspx://${HOST}:7441:7441/alias`,
      `rtspx://${HOST}:not-a-port/alias`,
      `rtspx://[${HOST}]x/alias`,
      '',
    ])
      expect(sourceHostIs(source, HOST)).toBe(false)
    // An empty or whitespace-only pin can never match (the manager refuses it too).
    expect(sourceHostIs(SOURCE, '')).toBe(false)
    expect(sourceHostIs(SOURCE, '  ')).toBe(false)
    // And the pinned host still matches itself in every form the app can produce.
    expect(sourceHostIs(toGo2rtcSource(RTSPS), HOST)).toBe(true)
    expect(sourceHostIs(toGo2rtcSource(`rtsps://${HOST}/alias?enableSrtp`), HOST)).toBe(true)
    expect(sourceHostIs(toGo2rtcSource('rtsps://192.0.2.10:7441/alias'), '192.0.2.10')).toBe(true)
    expect(sourceHostIs(toGo2rtcSource('rtsps://[::1]:7441/alias?enableSrtp'), '::1')).toBe(true)
  })
})

describe('API credentials', () => {
  it('generates base64url values with no ":" and enough entropy', () => {
    const generated = createGo2rtcAuth(fixedRandom(1))
    expect(generated.username.startsWith('vp_')).toBe(true)
    expect(generated.username).not.toContain(':')
    expect(generated.password).not.toContain(':')
    // 18 random bytes -> 24 base64url characters.
    expect(generated.password).toHaveLength(24)
    expect(isValidAuthToken(generated.username)).toBe(true)
    expect(isValidAuthToken(generated.password)).toBe(true)
  })

  it('refuses a random source that returns too few bytes', () => {
    expect(() => createGo2rtcAuth(() => new Uint8Array(2))).toThrow(/too few bytes/)
  })

  it('builds a Basic header that decodes back to the credentials', () => {
    const header = basicAuthHeader(auth)
    expect(header.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')).toBe(
      `${auth.username}:${auth.password}`,
    )
  })
})

describe('redaction (CON-2, NFR-9)', () => {
  it('removes every form of the credentials from a log line', () => {
    const secrets = authSecrets(auth)
    const header = basicAuthHeader(auth)
    const line = `GET /api user=${auth.username} pass=${auth.password} hdr=${header}`
    const redacted = redactSecrets(line, secrets)
    expect(redacted).not.toContain(auth.username)
    expect(redacted).not.toContain(auth.password)
    expect(redacted).not.toContain(header.slice('Basic '.length))
    expect(redacted).toContain('<redacted>')
  })

  it('redacts an unknown Basic or Bearer value too', () => {
    expect(redactSecrets('Authorization: Basic c29tZXRoaW5nTG9uZ0VuMHVnaA==', [])).toBe(
      'Authorization: Basic <redacted>',
    )
    expect(redactSecrets('authorization: bearer abcdefghijkl', [])).toBe(
      'authorization: bearer <redacted>',
    )
  })

  it('redacts any rtsp/rtsps/rtspx URL, whose alias is the stream credential', () => {
    for (const url of [RTSPS, SOURCE, `rtsp://${HOST}:7441/alias`]) {
      const redacted = redactSourceUrls(`[rtsp] connect error ${url} failed`)
      expect(redacted).not.toContain(HOST)
      expect(redacted).toContain('<redacted-source-url>')
    }
  })

  it('leaves an ordinary go2rtc line alone', () => {
    const line = '[api] listen addr=127.0.0.1:41234'
    expect(redactSecrets(redactSourceUrls(line), authSecrets(auth))).toBe(line)
  })
})

describe('loopback URLs', () => {
  it('builds the API and WebSocket URLs on 127.0.0.1 only', () => {
    expect(go2rtcApiUrl(41234)).toBe('http://127.0.0.1:41234/api')
    expect(go2rtcApiUrl(41234, '/api/streams')).toBe('http://127.0.0.1:41234/api/streams')
    expect(go2rtcWsUrl(41234, 'cam1_low')).toBe('ws://127.0.0.1:41234/api/ws?src=cam1_low')
    expect(go2rtcWsUrl(41234, 'a b&c')).toBe('ws://127.0.0.1:41234/api/ws?src=a%20b%26c')
  })
})

describe('isSafeStreamName', () => {
  it('accepts <cameraId>_<quality> and rejects anything else', () => {
    expect(isSafeStreamName('abc123_low')).toBe(true)
    expect(isSafeStreamName('a-b_C-9')).toBe(true)
    for (const bad of ['', 'a'.repeat(65), 'a/b', 'a b', 'a.b', 'a:b', 'a\nb', '?src=x'])
      expect(isSafeStreamName(bad)).toBe(false)
  })
})

describe('summarizeGo2rtcStream (R7)', () => {
  const body = {
    producers: [
      {
        url: RTSPS,
        remote_addr: '203.0.113.9:7441',
        user_agent: 'go2rtc/1.9.15',
        medias: ['video, recvonly, H265', `audio, recvonly, MPEG4-GENERIC, src=${RTSPS}`],
        receivers: [
          { codec: { codec_name: 'H265' }, packets: 10, bytes: 2048, drops: 0 },
          { codec: { codec_name: 'AAC' }, packets: 5, bytes: 256, drops: 1 },
        ],
      },
    ],
    consumers: [
      {
        remote_addr: '127.0.0.1:52000',
        senders: [{ codec: { codec_name: 'H265' }, packets: 9, bytes: 2000, drops: 0 }],
      },
    ],
  }

  it('keeps codecs and counters and drops urls, addresses and user agents', () => {
    const summary = summarizeGo2rtcStream(body)
    expect(summary.producerCodecs).toEqual(['H265', 'AAC'])
    expect(summary.consumerCodecs).toEqual(['H265'])
    expect(summary.consumers).toBe(1)
    expect(summary.tracks).toEqual([
      { side: 'receiver', codec: 'H265', packets: 10, bytes: 2048, drops: 0 },
      { side: 'receiver', codec: 'AAC', packets: 5, bytes: 256, drops: 1 },
      { side: 'sender', codec: 'H265', packets: 9, bytes: 2000, drops: 0 },
    ])
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(HOST)
    expect(serialized).not.toContain('203.0.113.9')
    expect(serialized).not.toContain('go2rtc/1.9.15')
    expect(summary.producerMedias[1]).toContain('<redacted-source-url>')
  })

  it('is lenient: a surprising body gives a thin summary instead of throwing', () => {
    for (const value of [null, undefined, 42, 'text', [], { producers: 'nope' }]) {
      const summary = summarizeGo2rtcStream(value)
      expect(summary).toEqual({
        producerMedias: [],
        producerCodecs: [],
        consumers: 0,
        consumerCodecs: [],
        tracks: [],
      })
    }
    expect(summarizeGo2rtcStream({ producers: [{ receivers: [{}] }] }).tracks).toEqual([
      { side: 'receiver', codec: '?', packets: 0, bytes: 0, drops: 0 },
    ])
  })
})
