import { describe, expect, it } from 'vitest'
import {
  FAKE_HOST,
  createSanitizer,
  isSensitiveKey,
  isVersionKey,
  keyWords,
  redactRtspsUrl,
} from '../../scripts/spikes/lib/sanitize.ts'

const CAM_A = '66d025b301ebc903e80003ea'
const CAM_B = '672094f900e26303e800062a'
const EVENT = '6731a0f2003c4b03e8001234'

describe('keyWords / isSensitiveKey', () => {
  it('splits camelCase, snake_case and header names', () => {
    expect(keyWords('macAddress')).toEqual(['mac', 'address'])
    expect(keyWords('host_name')).toEqual(['host', 'name'])
    expect(keyWords('X-API-KEY')).toEqual(['x', 'api', 'key'])
  })

  it.each([
    'mac',
    'macAddress',
    'host',
    'hostname',
    'ip',
    'ipAddress',
    'url',
    'streamUrl',
    'guid',
    'token',
    'accessToken',
    'email',
    'owner',
    'userId',
    'apiKey',
    'X-API-KEY',
    'password',
  ])('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true)
  })

  it.each([
    'id',
    'name',
    'modelKey',
    'type',
    'state',
    'zip',
    'description',
    'isMicEnabled',
    'device',
  ])('%s is not sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false)
  })
})

describe('redactRtspsUrl', () => {
  it('keeps scheme, port and query but drops host and token', () => {
    expect(
      redactRtspsUrl('rtsps://192.0.2.1:7441/5nPr7RCmueGTKMP7?enableSrtp', 'redacted-low'),
    ).toBe(`rtsps://${FAKE_HOST}:7441/<redacted-low>?enableSrtp`)
  })

  it('handles a URL without port or query', () => {
    expect(redactRtspsUrl('rtsp://cam.local/abc')).toBe(`rtsp://${FAKE_HOST}/<redacted>`)
  })
})

describe('createSanitizer', () => {
  it('maps camera ids by modelKey and keeps references consistent', () => {
    const s = createSanitizer()
    const out = s.sanitize({
      cameras: [
        { id: CAM_A, modelKey: 'camera', name: 'Front Door' },
        { id: CAM_B, modelKey: 'camera', name: 'Garage' },
      ],
      event: { id: EVENT, modelKey: 'event', type: 'motion', device: CAM_B },
    })
    expect(out).toEqual({
      cameras: [
        { id: 'cam-001', modelKey: 'camera', name: 'Front Door' },
        { id: 'cam-002', modelKey: 'camera', name: 'Garage' },
      ],
      event: { id: 'evt-001', modelKey: 'event', type: 'motion', device: 'cam-002' },
    })
    // Same instance, later call: the mapping is stable.
    expect(s.sanitize({ device: CAM_A })).toEqual({ device: 'cam-001' })
    expect(s.mapId(CAM_B.toUpperCase(), 'cam')).toBe('cam-002')
  })

  it('maps an unknown 24-hex id to a generic fake id', () => {
    const s = createSanitizer()
    expect(s.sanitize({ nvr: CAM_A, again: CAM_A })).toEqual({ nvr: 'id-001', again: 'id-001' })
  })

  it('redacts sensitive keys, mapping MACs, GUIDs and users consistently', () => {
    const s = createSanitizer()
    const out = s.sanitize({
      mac: '24A43C3DFEB9',
      guid: '6b8fdd7c-7e4c-4156-bb39-be05ca855491',
      host: 'unifi.example.lan',
      ipAddress: '192.0.2.1',
      email: 'someone@example.com',
      userId: 'abc',
      owner: 'abc',
      streamUrl: 'rtsps://198.51.100.1:7441/tok?enableSrtp',
      apiKey: 'secret-key',
      other: { mac: '24A43C3DFEB9' },
      isMicEnabled: true,
      featureFlags: { hasMic: true },
      lastSeen: null,
    })
    expect(out).toEqual({
      mac: 'mac-001',
      guid: 'guid-001',
      host: '<redacted-host>',
      ipAddress: '<redacted-ipAddress>',
      email: '<redacted-email>',
      userId: 'user-001',
      owner: 'user-001',
      streamUrl: `rtsps://${FAKE_HOST}:7441/<redacted-streamUrl>?enableSrtp`,
      apiKey: '<redacted-apiKey>',
      other: { mac: 'mac-001' },
      isMicEnabled: true,
      featureFlags: { hasMic: true },
      lastSeen: null,
    })
  })

  it('labels RTSPS placeholders with the quality key', () => {
    const s = createSanitizer()
    expect(
      s.sanitize({
        high: 'rtsps://192.0.2.1:7441/5nPr7RCmueGTKMP7?enableSrtp',
        medium: 'rtsps://192.0.2.1:7441/AbUgnDb5IqIEMidk?enableSrtp',
        low: null,
      }),
    ).toEqual({
      high: `rtsps://${FAKE_HOST}:7441/<redacted-high>?enableSrtp`,
      medium: `rtsps://${FAKE_HOST}:7441/<redacted-medium>?enableSrtp`,
      low: null,
    })
  })

  it('redacts value patterns inside free text', () => {
    const s = createSanitizer()
    const text = s.sanitizeString(
      'cam 24:a4:3c:3d:fe:b9 at 192.0.2.20 id 66d025b301ebc903e80003ea mail a.b@example.org ' +
        'uuid 6b8fdd7c-7e4c-4156-bb39-be05ca855491',
    )
    expect(text).toBe('cam mac-001 at <redacted-ip> id id-001 mail <redacted-email> uuid uuid-001')
  })

  it('treats separated and bare MACs as the same device', () => {
    const s = createSanitizer()
    expect(s.sanitizeString('24:A4:3C:3D:FE:B9 / 24A43C3DFEB9')).toBe('mac-001 / mac-001')
  })

  it('replaces explicit secrets anywhere, including object keys', () => {
    const s = createSanitizer({ secrets: ['console.home.arpa', 'k3y-value'] })
    expect(
      s.sanitize({ note: 'https://console.home.arpa/x?k=k3y-value', 'console.home.arpa': 1 }),
    ).toEqual({ note: 'https://<redacted>/x?k=<redacted>', '<redacted>': 1 })
  })

  it('leaves version strings, timestamps and names alone', () => {
    const s = createSanitizer()
    const input = {
      applicationVersion: '7.3.74',
      start: 1731430000000,
      name: 'Back Yard',
      type: 'UVC G5 Pro',
    }
    expect(s.sanitize(input)).toEqual(input)
  })

  it('does not mutate its input', () => {
    const s = createSanitizer()
    const input = { id: CAM_A, modelKey: 'camera', mac: '24A43C3DFEB9' }
    const copy = structuredClone(input)
    s.sanitize(input)
    expect(input).toEqual(copy)
  })
})

describe('type preservation under sensitive keys', () => {
  it('numbers become 0, strings become placeholders, booleans and null stay', () => {
    const s = createSanitizer()
    expect(
      s.sanitize({
        hostPort: 7441,
        ipAddress: '203.0.113.9',
        tokenExpiry: 1731430000,
        hostEnabled: true,
        token: null,
      }),
    ).toEqual({
      hostPort: 0,
      ipAddress: '<redacted-ipAddress>',
      tokenExpiry: 0,
      hostEnabled: true,
      token: null,
    })
  })

  it('walks arrays and objects under sensitive keys, keeping element types', () => {
    const s = createSanitizer()
    expect(
      s.sanitize({ ips: ['198.51.100.4', 42], host: { name: 'nvr', port: 443, ok: false } }),
    ).toEqual({
      ips: ['<redacted-ip>', 42],
      host: { name: 'nvr', port: 443, ok: false },
    })
  })
})

describe('IPv4 rule and version keys', () => {
  it('isVersionKey matches version / firmware / fw words only', () => {
    expect(isVersionKey('firmwareVersion')).toBe(true)
    expect(isVersionKey('fwVersion')).toBe(true)
    expect(isVersionKey('version')).toBe(true)
    expect(isVersionKey('firmware_build')).toBe(true)
    expect(isVersionKey('address')).toBe(false)
    expect(isVersionKey(undefined)).toBe(false)
  })

  it('keeps a dotted-quad firmware version', () => {
    const s = createSanitizer()
    const input = { firmwareVersion: '4.74.30.67', fwVersion: '1.2.3.4', version: '10.0.0.1' }
    expect(s.sanitize(input)).toEqual(input)
  })

  it('still redacts an IP under an address-like key', () => {
    const s = createSanitizer()
    expect(s.sanitize({ host: '192.0.2.1', ipAddress: '198.51.100.2' })).toEqual({
      host: '<redacted-host>',
      ipAddress: '<redacted-ipAddress>',
    })
  })

  it('still redacts an IP inside free text, even under a version key', () => {
    const s = createSanitizer()
    expect(
      s.sanitize({
        description: 'reachable at 192.0.2.7 since boot',
        firmwareVersion: 'updated from 192.0.2.7',
      }),
    ).toEqual({
      description: 'reachable at <redacted-ip> since boot',
      firmwareVersion: 'updated from <redacted-ip>',
    })
  })

  it('redacts a bare IP under a non-version key', () => {
    const s = createSanitizer()
    expect(s.sanitize({ gateway: '203.0.113.1' })).toEqual({ gateway: '<redacted-ip>' })
  })
})
