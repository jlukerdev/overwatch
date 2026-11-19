// P6.3 (CON-2, NFR-9): the app log's redactor, src/main/log/redact.ts. Every value below is made up.
import { describe, expect, it } from 'vitest'
import { basicHeaderSecrets, redactLogText, REDACTED } from '../../src/main/log/redact'
import * as go2rtcConfig from '../../src/main/streams/go2rtcConfig'
import * as redact from '../../src/main/log/redact'

describe('redactLogText patterns', () => {
  it('redacts Basic and Bearer values', () => {
    expect(redactLogText('sent Basic dXNlcjpwYXNzd29yZA== to go2rtc')).toBe(
      `sent Basic ${REDACTED} to go2rtc`,
    )
    expect(redactLogText('token is bearer abcdefghijklmnop now')).toBe(
      `token is bearer ${REDACTED} now`,
    )
  })

  it('redacts Authorization and X-API-KEY header values in every common shape', () => {
    expect(redactLogText('Authorization: Token abc123xyz')).toBe(`Authorization: Token ${REDACTED}`)
    expect(redactLogText('authorization=abc123xyz&x=1')).toBe(`authorization=${REDACTED}&x=1`)
    expect(redactLogText('X-API-KEY: fakeKeyValue123')).toBe(`X-API-KEY: ${REDACTED}`)
    expect(redactLogText("{ 'x-api-key': 'fakeKeyValue123', accept: 'json' }")).toBe(
      `{ 'x-api-key': '${REDACTED}', accept: 'json' }`,
    )
    expect(redactLogText('{"Authorization":"Bearer abcdefghijkl","a":1}')).toBe(
      `{"Authorization":"Bearer ${REDACTED}","a":1}`,
    )
    // util.inspect of a Map or a fetch Headers object.
    expect(redactLogText("Map(1) { 'x-api-key' => 'fakeKeyValue123' }")).toBe(
      `Map(1) { 'x-api-key' => '${REDACTED}' }`,
    )
    expect(redactLogText("HeadersList { 'authorization' => 'Bearer abc' }")).toBe(
      `HeadersList { 'authorization' => 'Bearer ${REDACTED}' }`,
    )
    // Not a header value: the word on its own is left alone.
    expect(redactLogText('Authorization failed for the request')).toBe(
      'Authorization failed for the request',
    )
    // One token only: the prose after a colon is not swallowed.
    expect(redactLogText('authorization: required for this endpoint')).toBe(
      `authorization: ${REDACTED} for this endpoint`,
    )
  })

  it('redacts a whole RTSP(S) URL', () => {
    expect(redactLogText('connect rtsps://192.0.2.10:7441/AbCdEfGh12345678?enableSrtp x')).toBe(
      `connect ${REDACTED} x`,
    )
    expect(redactLogText('src="rtsp://user:pw@cam.invalid/s1"')).toBe(`src="${REDACTED}"`)
  })

  it('redacts URL userinfo but keeps the host', () => {
    expect(redactLogText('GET https://admin:hunter22@console.invalid/api')).toBe(
      `GET https://${REDACTED}@console.invalid/api`,
    )
    expect(redactLogText('wss://onlytoken@host.invalid/ws')).toBe(
      `wss://${REDACTED}@host.invalid/ws`,
    )
    expect(redactLogText('https://console.invalid/path@thing')).toBe(
      'https://console.invalid/path@thing',
    )
  })

  it('redacts credential-like query parameters only', () => {
    const url =
      'https://h.invalid/x?token=t1t1t1&api_key=k2k2&apikey=k3k3&password=p4p4&client_secret=s5&auth=a6&access_token=a7&camera=front'
    expect(redactLogText(url)).toBe(
      `https://h.invalid/x?token=${REDACTED}&api_key=${REDACTED}&apikey=${REDACTED}` +
        `&password=${REDACTED}&client_secret=${REDACTED}&auth=${REDACTED}` +
        `&access_token=${REDACTED}&camera=front`,
    )
    expect(redactLogText('/v1/cameras?apiKey=abc#frag')).toBe(`/v1/cameras?apiKey=${REDACTED}#frag`)
  })

  it('redacts the rate-limit partition key', () => {
    expect(redactLogText('ratelimit-policy: "10-in-1sec"; q=10; w=1; pk=:ZmFrZWtleQ==:')).toBe(
      `ratelimit-policy: "10-in-1sec"; q=10; w=1; pk=:${REDACTED}:`,
    )
  })

  it('leaves ordinary text alone and is idempotent', () => {
    const plain = '[connection] protect: connected, 4 cameras'
    expect(redactLogText(plain)).toBe(plain)
    const messy =
      'Authorization: Basic abcdefghij https://u:p@h.invalid/?token=x pk=:abc: rtsps://h/a'
    const once = redactLogText(messy, ['some-secret'])
    expect(redactLogText(once, ['some-secret'])).toBe(once)
  })
})

describe('redactLogText live secrets', () => {
  it('redacts each value, longest first, and its URL-encoded form', () => {
    const key = 'FAKE-key/with+chars=='
    const out = redactLogText(`k=${key} enc=${encodeURIComponent(key)} short=abcdef`, [
      key,
      'abcdef',
      'abcdefgh',
    ])
    expect(out).toBe(`k=${REDACTED} enc=${REDACTED} short=${REDACTED}`)
    expect(out).not.toContain('FAKE')
  })

  it('ignores values shorter than 4 characters', () => {
    expect(redactLogText('the cat sat', ['at', 'cat'])).toBe('the cat sat')
  })
})

describe('basicHeaderSecrets', () => {
  it('returns the Basic value, the username and the password', () => {
    const encoded = Buffer.from('vp_user123:pass456789').toString('base64')
    expect(basicHeaderSecrets(`Basic ${encoded}`)).toEqual([encoded, 'vp_user123', 'pass456789'])
  })

  it('returns nothing for no header or a non-Basic one', () => {
    expect(basicHeaderSecrets(null)).toEqual([])
    expect(basicHeaderSecrets('Bearer abc')).toEqual([])
  })
})

describe('go2rtcConfig re-exports', () => {
  it('re-exports the same redactors it had before', () => {
    expect(go2rtcConfig.redactSecrets).toBe(redact.redactSecrets)
    expect(go2rtcConfig.redactSourceUrls).toBe(redact.redactSourceUrls)
  })
})
