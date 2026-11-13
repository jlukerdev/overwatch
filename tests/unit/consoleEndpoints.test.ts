// P1.3/P1.4 (SPEC §5.1, §5.2, §6, CON-1/2, P0.4 §4): turning the saved console settings into the
// two endpoints the app talks to. These rules are load-bearing for TLS pinning, which is per
// host:port — get the port wrong and a pin is stored under a key nothing ever reads again, which
// means the next certificate gets trusted silently (CON-3).
import { ConsoleConfigSchema, type ConsoleConfig } from '@shared/models'
import { describe, expect, it } from 'vitest'
import {
  ConsoleEndpointError,
  DEFAULT_HTTPS_PORT,
  PROTECT_API_PREFIX,
  accessEndpoint,
  parseConsoleHost,
  protectEndpoint,
  protectSubscribeUrl,
} from '../../src/main/console/endpoints'
import { ACCESS_API_PATH, ACCESS_DEFAULT_PORT } from '../../src/main/access/types'

const consoleConfig = (overrides: Partial<ConsoleConfig> = {}): ConsoleConfig =>
  ConsoleConfigSchema.parse({ host: '192.0.2.10', ...overrides })

describe('parseConsoleHost', () => {
  it.each([
    ['192.0.2.10', '192.0.2.10', DEFAULT_HTTPS_PORT],
    ['udm.local', 'udm.local', DEFAULT_HTTPS_PORT],
    ['192.0.2.10:8443', '192.0.2.10', 8443],
    ['https://udm.local', 'udm.local', DEFAULT_HTTPS_PORT],
    ['https://udm.local:8443/', 'udm.local', 8443],
    ['  192.0.2.10  ', '192.0.2.10', DEFAULT_HTTPS_PORT],
    ['UDM.Local', 'udm.local', DEFAULT_HTTPS_PORT],
    ['[2001:db8::1]', '2001:db8::1', DEFAULT_HTTPS_PORT],
    ['[2001:db8::1]:8443', '2001:db8::1', 8443],
  ])('accepts %s', (raw, host, port) => {
    expect(parseConsoleHost(raw)).toEqual({ host, port })
  })

  it('says what to do when no host is set yet (CON-1)', () => {
    expect(() => parseConsoleHost('')).toThrow(ConsoleEndpointError)
    expect(() => parseConsoleHost('   ')).toThrow(/Enter the console IP or host name/)
  })

  it('refuses a non-https scheme rather than upgrading it silently (CON-2)', () => {
    // An http:// console would send the admin-level API key in clear (R5).
    expect(() => parseConsoleHost('http://192.0.2.10')).toThrow(/must be https/)
    expect(() => parseConsoleHost('ftp://192.0.2.10')).toThrow(/must be https/)
  })

  it('rejects input that is not an address', () => {
    expect(() => parseConsoleHost('http://')).toThrow(ConsoleEndpointError)
    expect(() => parseConsoleHost('https://')).toThrow(ConsoleEndpointError)
  })
})

describe('protectEndpoint', () => {
  it('builds the proxied Integration API base URL (SPEC §5.1)', () => {
    const endpoint = protectEndpoint(consoleConfig())
    expect(endpoint).toEqual({
      host: '192.0.2.10',
      port: 443,
      hostPort: '192.0.2.10:443',
      origin: 'https://192.0.2.10',
      baseUrl: `https://192.0.2.10${PROTECT_API_PREFIX}`,
    })
  })

  it('leaves 443 out of the URL but keeps it in the pin key', () => {
    // The URL has to look exactly like the ones P0.3 verified (so does the Host header), while
    // the pin key must always carry a port because pinning is per host:port.
    const endpoint = protectEndpoint(consoleConfig({ host: '192.0.2.10:443' }))
    expect(endpoint.origin).toBe('https://192.0.2.10')
    expect(endpoint.hostPort).toBe('192.0.2.10:443')
  })

  it('carries a non-default port into both the URL and the pin key', () => {
    const endpoint = protectEndpoint(consoleConfig({ host: 'udm.local:8443' }))
    expect(endpoint.baseUrl).toBe(`https://udm.local:8443${PROTECT_API_PREFIX}`)
    expect(endpoint.hostPort).toBe('udm.local:8443')
  })

  it('brackets an IPv6 literal in the URL but not in the connect host', () => {
    const endpoint = protectEndpoint(consoleConfig({ host: '[2001:db8::1]' }))
    // `tls.connect` wants the bare address; the URL and the pin key want brackets.
    expect(endpoint.host).toBe('2001:db8::1')
    expect(endpoint.baseUrl).toBe(`https://[2001:db8::1]${PROTECT_API_PREFIX}`)
    expect(endpoint.hostPort).toBe('[2001:db8::1]:443')
  })
})

describe('accessEndpoint', () => {
  it('derives the developer API on 12445 when no override is set (SPEC §5.2)', () => {
    const endpoint = accessEndpoint(consoleConfig())
    expect(endpoint).toEqual({
      host: '192.0.2.10',
      port: ACCESS_DEFAULT_PORT,
      hostPort: `192.0.2.10:${String(ACCESS_DEFAULT_PORT)}`,
      origin: `https://192.0.2.10:${String(ACCESS_DEFAULT_PORT)}`,
      baseUrl: `https://192.0.2.10:${String(ACCESS_DEFAULT_PORT)}${ACCESS_API_PATH}`,
    })
  })

  it('ignores a port in console.host, because the developer API has its own', () => {
    const endpoint = accessEndpoint(consoleConfig({ host: '192.0.2.10:8443' }))
    expect(endpoint.port).toBe(ACCESS_DEFAULT_PORT)
  })

  it('takes the override as the API root, so the mock and the 443 proxy both just work', () => {
    expect(
      accessEndpoint(consoleConfig({ accessBaseUrl: 'https://127.0.0.1:12446/api/v1/developer' })),
    ).toEqual({
      host: '127.0.0.1',
      port: 12446,
      hostPort: '127.0.0.1:12446',
      origin: 'https://127.0.0.1:12446',
      baseUrl: 'https://127.0.0.1:12446/api/v1/developer',
    })
    // The newer-firmware alternative from SPEC §5.2, which is just another base URL.
    const proxied = accessEndpoint(
      consoleConfig({ accessBaseUrl: 'https://udm.local/proxy/access/api/v1/developer' }),
    )
    expect(proxied.port).toBe(443)
    expect(proxied.baseUrl).toBe('https://udm.local/proxy/access/api/v1/developer')
  })

  it('strips a trailing slash from the override', () => {
    expect(
      accessEndpoint(consoleConfig({ accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer/' }))
        .baseUrl,
    ).toBe('https://127.0.0.1:12445/api/v1/developer')
  })

  it('refuses an http override (CON-2)', () => {
    expect(() =>
      accessEndpoint(consoleConfig({ accessBaseUrl: 'http://127.0.0.1:12445/api/v1/developer' })),
    ).toThrow(/must be https/)
  })

  it('resolves whether or not Access is enabled, because DOOR-0 is the client rule', () => {
    // The endpoint is still needed while the feature is off: that is how its certificate gets
    // shown and pinned before anything is ever unlocked.
    expect(accessEndpoint(consoleConfig({ accessEnabled: false })).port).toBe(ACCESS_DEFAULT_PORT)
    expect(accessEndpoint(consoleConfig({ accessEnabled: true })).port).toBe(ACCESS_DEFAULT_PORT)
  })

  it('reports an unset console host through the same CON-1 message', () => {
    expect(() => accessEndpoint(ConsoleConfigSchema.parse({}))).toThrow(ConsoleEndpointError)
  })
})

describe('protectSubscribeUrl', () => {
  it('builds the two WebSocket URLs from the same base (SPEC §5.1)', () => {
    const endpoint = protectEndpoint(consoleConfig())
    expect(protectSubscribeUrl(endpoint, 'devices')).toBe(
      `wss://192.0.2.10${PROTECT_API_PREFIX}/v1/subscribe/devices`,
    )
    expect(protectSubscribeUrl(endpoint, 'events')).toBe(
      `wss://192.0.2.10${PROTECT_API_PREFIX}/v1/subscribe/events`,
    )
  })

  it('keeps a non-default port', () => {
    const endpoint = protectEndpoint(consoleConfig({ host: 'udm.local:8443' }))
    expect(protectSubscribeUrl(endpoint, 'events')).toBe(
      `wss://udm.local:8443${PROTECT_API_PREFIX}/v1/subscribe/events`,
    )
  })
})
