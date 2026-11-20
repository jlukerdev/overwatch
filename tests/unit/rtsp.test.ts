// RTSP-2 / RTSP-5: the stream URL rules (src/shared/rtsp.ts) that the Add/Edit stream dialog and
// main both run, and the booleans-only view of the stored URLs the renderer gets (CON-2).
//
// The refusals matter more than the acceptances: go2rtc runs some source schemes as commands
// (`exec:`, `ffmpeg:` …), so anything but rtsp:// and rtsps:// must never pass. And no `reason` may
// echo the URL, which usually carries a camera password.
import { describe, expect, it } from 'vitest'
import {
  isValidRtspUrl,
  MAX_RTSP_URL_LENGTH,
  RTSP_QUALITIES,
  RtspUrlsStoredSchema,
  rtspUrlsStored,
  validateRtspUrl,
} from '../../src/shared/rtsp'

describe('validateRtspUrl (RTSP-2)', () => {
  it.each([
    'rtsp://192.0.2.10:554/stream1',
    'rtsps://192.0.2.10:7441/AbCdEf?enableSrtp',
    'rtsp://user:pass@cam.invalid:554/x',
    'rtsp://cam.invalid/',
    'rtsp://cam.invalid',
    'RTSP://cam.invalid/live',
    'Rtsps://cam.invalid/live',
    'rtsp://[2001:db8::1]:554/live',
    'rtsp://[::1]/live',
    'rtsp://cam.invalid/cam/realmonitor?channel=1&subtype=0',
  ])('accepts %s', (url) => {
    expect(validateRtspUrl(url)).toEqual({ ok: true })
    expect(isValidRtspUrl(url)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['other scheme: http', 'http://cam.invalid/live'],
    ['other scheme: https', 'https://cam.invalid/live'],
    ['go2rtc exec source', 'exec:ffmpeg -i rtsp://cam.invalid/x -f rtsp {output}'],
    ['go2rtc ffmpeg source', 'ffmpeg:rtsp://cam.invalid/x#video=h264'],
    ['go2rtc rtspx (insecure rtsps)', 'rtspx://cam.invalid/live'],
    ['rtmp', 'rtmp://cam.invalid/live'],
    ['no scheme', 'cam.invalid:554/live'],
    ['scheme without //', 'rtsp:cam.invalid/live'],
    ['missing host', 'rtsp:///live'],
    ['missing host with port', 'rtsp://:554/live'],
    ['userinfo but no host', 'rtsp://user:pass@/live'],
    ['leading whitespace', ' rtsp://cam.invalid/live'],
    ['trailing whitespace', 'rtsp://cam.invalid/live '],
    ['trailing newline', 'rtsp://cam.invalid/live\n'],
    ['embedded newline', 'rtsp://cam.invalid/live\nexec:rm'],
    ['embedded tab', 'rtsp://cam.invalid/li\tve'],
    ['embedded space', 'rtsp://cam.invalid/my live'],
    ['NUL', 'rtsp://cam.invalid/live\u0000'],
    ['DEL', 'rtsp://cam.invalid/live\u007f'],
    ['C1 control', 'rtsp://cam.invalid/live\u0085'],
    ['Unicode line separator', 'rtsp://cam.invalid/live '],
    ['no-break space', 'rtsp://cam.invalid/ live'],
  ])('refuses %s', (_label, url) => {
    const result = validateRtspUrl(url)
    expect(result.ok).toBe(false)
    expect(isValidRtspUrl(url)).toBe(false)
  })

  it('accepts exactly 2048 characters and refuses 2049', () => {
    const base = 'rtsp://cam.invalid/'
    const at = base + 'a'.repeat(MAX_RTSP_URL_LENGTH - base.length)
    expect(at).toHaveLength(2048)
    expect(isValidRtspUrl(at)).toBe(true)
    expect(isValidRtspUrl(`${at}a`)).toBe(false)
  })

  it('never echoes the URL or its password in the reason (CON-2)', () => {
    const secret = 'hunter2-camera-password'
    for (const url of [
      `http://admin:${secret}@cam.invalid/live`,
      `rtsp://admin:${secret}@/live`,
      ` rtsp://admin:${secret}@cam.invalid/live`,
      `rtsp://admin:${secret}@cam.invalid/${'a'.repeat(MAX_RTSP_URL_LENGTH)}`,
      `exec:${secret}`,
    ]) {
      const result = validateRtspUrl(url)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).not.toContain(secret)
        expect(result.reason).not.toContain('cam.invalid')
        expect(result.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('rtspUrlsStored (RTSP-2, CON-2)', () => {
  it('maps every stored URL to true and every missing quality to false', () => {
    expect(
      rtspUrlsStored({
        'rtsp-a': { high: 'rtsp://cam.invalid/1', low: 'rtsp://cam.invalid/3' },
        'rtsp-b': { medium: 'rtsps://cam.invalid/2' },
      }),
    ).toEqual({
      'rtsp-a': { high: true, medium: false, low: true },
      'rtsp-b': { high: false, medium: true, low: false },
    })
  })

  it('leaves out a stream with no URL, and treats undefined as nothing stored', () => {
    expect(rtspUrlsStored({ 'rtsp-a': {}, 'rtsp-b': { high: '' } })).toEqual({})
    expect(rtspUrlsStored(undefined)).toEqual({})
  })

  it('holds only booleans, never a URL', () => {
    const out = rtspUrlsStored({ 'rtsp-a': { high: 'rtsp://user:pw@cam.invalid/1' } })
    expect(JSON.stringify(out)).not.toContain('rtsp://')
    expect(RtspUrlsStoredSchema.safeParse(out).success).toBe(true)
  })

  it('has a schema that refuses a URL where a boolean belongs', () => {
    expect(
      RtspUrlsStoredSchema.safeParse({
        'rtsp-a': { high: 'rtsp://cam.invalid/1', medium: false, low: false },
      }).success,
    ).toBe(false)
  })

  it('covers the same three qualities as the quality picker', () => {
    expect([...RTSP_QUALITIES]).toEqual(['high', 'medium', 'low'])
  })
})
