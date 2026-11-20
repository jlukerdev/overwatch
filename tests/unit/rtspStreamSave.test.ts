// RTSP-1/2 (F1.0.2-5): the shapes and rules of a stream save before main writes anything — the
// `vp:rtsp/streams/save` and `vp:rtsp/streams/delete` payload schemas (src/shared/ipc.ts), the
// name rule shared by the Add/Edit dialog and main (src/shared/rtsp.ts), and how a save's
// per-quality changes combine with the stored URLs (src/main/streams/rtspStreams.ts).
// RTSP-3 (F1.0.2-6): the RTSP inventory and the stored-URL → go2rtc source transform.
//
// CON-2: a refusal never quotes the URL, which usually carries a camera password.
import { describe, expect, it } from 'vitest'
import { DeleteRtspStreamInputSchema, SaveRtspStreamInputSchema } from '../../src/shared/ipc'
import { MAX_RTSP_STREAM_NAME_LENGTH } from '../../src/shared/models'
import { MAX_RTSP_URL_LENGTH, validateRtspStreamName } from '../../src/shared/rtsp'
import { CameraSchema } from '../../src/shared/models'
import {
  RTSP_STREAM_MESSAGES,
  hasRtspUrl,
  mergeRtspUrls,
  rtspInventory,
  sameRtspUrls,
  toRtspGo2rtcSource,
} from '../../src/main/streams/rtspStreams'

const ID = 'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER_ID = 'rtsp-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const URL_A = 'rtsp://admin:hunter2-secret@cam.invalid:554/stream1'

describe('SaveRtspStreamInputSchema (RTSP-2)', () => {
  it('accepts each quality absent, null or a valid address', () => {
    const parsed = SaveRtspStreamInputSchema.parse({
      id: ID,
      name: '  Garden  ',
      urls: { high: URL_A, medium: null },
    })
    expect(parsed).toEqual({ id: ID, name: 'Garden', urls: { high: URL_A, medium: null } })
    expect('low' in parsed.urls).toBe(false)
  })

  it('accepts a create (no id) with rtsps:// and an empty urls object', () => {
    expect(
      SaveRtspStreamInputSchema.safeParse({
        name: 'Garden',
        urls: { low: 'rtsps://cam.invalid:7441/x' },
      }).success,
    ).toBe(true)
    // Shape only: "at least one URL" is main's rule, since it depends on what is stored.
    expect(SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: {} }).success).toBe(true)
  })

  it.each([
    ['exec:', 'exec:/bin/sh -c id'],
    ['http:', 'http://cam.invalid/stream'],
    ['rtspx:', 'rtspx://cam.invalid/stream'],
    ['ffmpeg:', 'ffmpeg:rtsp://cam.invalid/x#video=copy'],
    ['a leading space', ` ${URL_A}`],
    ['a trailing newline', `${URL_A}\n`],
    ['an empty string', ''],
    ['an address over the limit', `rtsp://cam.invalid/${'a'.repeat(MAX_RTSP_URL_LENGTH)}`],
  ])('refuses %s, without quoting it', (_why, url) => {
    const result = SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: { high: url } })
    expect(result.success).toBe(false)
    if (url !== '') expect(JSON.stringify(result.error?.issues)).not.toContain(url.trim())
  })

  it('never quotes a refused address that carries a password', () => {
    const url = 'http://admin:hunter2-secret@cam.invalid/stream'
    const result = SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: { medium: url } })
    expect(result.success).toBe(false)
    const text = JSON.stringify(result.error?.issues)
    expect(text).not.toContain('hunter2-secret')
    expect(text).not.toContain('cam.invalid')
  })

  it('refuses a quality key that does not exist', () => {
    expect(
      SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: { package: URL_A } }).success,
    ).toBe(false)
    expect(
      SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: { ultra: null } }).success,
    ).toBe(false)
  })

  it('refuses a missing urls object and a URL that is not a string', () => {
    expect(SaveRtspStreamInputSchema.safeParse({ name: 'Garden' }).success).toBe(false)
    expect(SaveRtspStreamInputSchema.safeParse({ name: 'Garden', urls: { high: 1 } }).success).toBe(
      false,
    )
  })

  it.each([
    ['a Protect camera id', 'cam-1'],
    ['upper-case hex', ID.toUpperCase()],
    ['no prefix', ID.slice('rtsp-'.length)],
    ['an empty id', ''],
    ['an object key', '__proto__'],
  ])('refuses %s as the id', (_why, id) => {
    expect(SaveRtspStreamInputSchema.safeParse({ id, name: 'Garden', urls: {} }).success).toBe(
      false,
    )
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['65 characters', 'a'.repeat(MAX_RTSP_STREAM_NAME_LENGTH + 1)],
  ])('refuses a name that is %s', (_why, name) => {
    expect(SaveRtspStreamInputSchema.safeParse({ name, urls: {} }).success).toBe(false)
  })

  it('accepts a 64-character name', () => {
    const name = 'a'.repeat(MAX_RTSP_STREAM_NAME_LENGTH)
    expect(SaveRtspStreamInputSchema.safeParse({ name, urls: {} }).success).toBe(true)
  })
})

describe('DeleteRtspStreamInputSchema (RTSP-1)', () => {
  it('accepts a stream id and refuses anything else', () => {
    expect(DeleteRtspStreamInputSchema.safeParse({ id: ID }).success).toBe(true)
    expect(DeleteRtspStreamInputSchema.safeParse({ id: 'cam-1' }).success).toBe(false)
    expect(DeleteRtspStreamInputSchema.safeParse({}).success).toBe(false)
  })
})

describe('validateRtspStreamName (RTSP-1)', () => {
  const streams = [
    { id: ID, name: 'Garden' },
    { id: OTHER_ID, name: 'Front Door' },
  ]

  it('refuses an empty or whitespace-only name', () => {
    expect(validateRtspStreamName('', streams).ok).toBe(false)
    expect(validateRtspStreamName('  \t ', streams).ok).toBe(false)
  })

  it('allows 64 characters and refuses 65, counted after trimming', () => {
    const max = 'a'.repeat(MAX_RTSP_STREAM_NAME_LENGTH)
    expect(validateRtspStreamName(max, []).ok).toBe(true)
    expect(validateRtspStreamName(`  ${max}  `, []).ok).toBe(true)
    expect(validateRtspStreamName(`${max}a`, []).ok).toBe(false)
  })

  it('refuses a name another stream has, ignoring case and surrounding spaces', () => {
    const result = validateRtspStreamName('  gARDEN ', streams)
    expect(result).toEqual({ ok: false, reason: 'Another stream already has this name.' })
  })

  it('lets a stream keep its own name (exceptId), but not take another one', () => {
    expect(validateRtspStreamName('garden', streams, ID).ok).toBe(true)
    expect(validateRtspStreamName('front door', streams, ID).ok).toBe(false)
  })

  it('accepts a new name', () => {
    expect(validateRtspStreamName('Garage', streams)).toEqual({ ok: true })
  })
})

describe('mergeRtspUrls (RTSP-2)', () => {
  const stored = { high: 'rtsp://cam.invalid/high', low: 'rtsp://cam.invalid/low' }

  it('keeps an absent quality, clears a null one and sets a string', () => {
    expect(mergeRtspUrls(stored, { medium: 'rtsp://cam.invalid/med', low: null })).toEqual({
      high: 'rtsp://cam.invalid/high',
      medium: 'rtsp://cam.invalid/med',
    })
    // The stored set is not touched.
    expect(stored).toEqual({ high: 'rtsp://cam.invalid/high', low: 'rtsp://cam.invalid/low' })
  })

  it('starts from nothing for a new stream', () => {
    expect(mergeRtspUrls(undefined, { low: null })).toEqual({})
    expect(mergeRtspUrls(undefined, { high: URL_A })).toEqual({ high: URL_A })
  })

  it('tells whether a set has a URL and whether two sets are the same', () => {
    expect(hasRtspUrl({})).toBe(false)
    expect(hasRtspUrl({ low: URL_A })).toBe(true)
    expect(sameRtspUrls(stored, { ...stored })).toBe(true)
    expect(sameRtspUrls(stored, { high: stored.high })).toBe(false)
    expect(sameRtspUrls(undefined, {})).toBe(true)
  })
})

describe('rtspInventory (RTSP-3)', () => {
  it('makes each stream a connected camera with no Protect features, in name order ignoring case', () => {
    const cameras = rtspInventory([
      { id: OTHER_ID, name: 'porch' },
      { id: ID, name: 'Garden' },
    ])
    expect(cameras.map((c) => [c.id, c.name])).toEqual([
      [ID, 'Garden'],
      [OTHER_ID, 'porch'],
    ])
    for (const camera of cameras) {
      expect(CameraSchema.parse(camera)).toEqual(camera)
      expect(camera).toMatchObject({
        model: 'RTSP stream',
        state: 'CONNECTED',
        hasMic: false,
        micEnabled: false,
        hasSpeaker: false,
        smartDetectTypes: [],
        supportsFullHdSnapshot: false,
        hasPackageCamera: false,
      })
    }
  })

  it('does not reorder the list it was given', () => {
    const streams = [
      { id: OTHER_ID, name: 'b' },
      { id: ID, name: 'A' },
    ]
    rtspInventory(streams)
    expect(streams.map((s) => s.name)).toEqual(['b', 'A'])
    expect(rtspInventory([])).toEqual([])
  })
})

describe('toRtspGo2rtcSource (RTSP-3, RTSP-5)', () => {
  it('turns rtsps:// into rtspx://, matching the scheme ignoring case, and keeps the rest verbatim', () => {
    expect(toRtspGo2rtcSource('rtsps://u:p@cam.invalid:7441/a/b?x=1&y')).toBe(
      'rtspx://u:p@cam.invalid:7441/a/b?x=1&y',
    )
    expect(toRtspGo2rtcSource('RTSPS://Cam.Invalid/Live')).toBe('rtspx://Cam.Invalid/Live')
  })

  it('passes rtsp:// as is', () => {
    expect(toRtspGo2rtcSource(URL_A)).toBe(URL_A)
    expect(toRtspGo2rtcSource('RTSP://cam.invalid/x')).toBe('RTSP://cam.invalid/x')
  })

  it('drops enableSrtp (a UniFi console address) and keeps every other parameter', () => {
    expect(toRtspGo2rtcSource('rtsps://console.invalid:7441/AbCdEf?enableSrtp')).toBe(
      'rtspx://console.invalid:7441/AbCdEf',
    )
    expect(toRtspGo2rtcSource('rtsps://cam.invalid/a?x=1&EnableSRTP=true&y=2')).toBe(
      'rtspx://cam.invalid/a?x=1&y=2',
    )
    expect(toRtspGo2rtcSource('rtsp://cam.invalid/a?enableSrtp#frag')).toBe(
      'rtsp://cam.invalid/a#frag',
    )
    expect(toRtspGo2rtcSource('rtsp://cam.invalid/a?enableSrtpX=1')).toBe(
      'rtsp://cam.invalid/a?enableSrtpX=1',
    )
  })

  it('only rewrites the scheme at the start', () => {
    expect(toRtspGo2rtcSource('rtsp://cam.invalid/rtsps://x')).toBe('rtsp://cam.invalid/rtsps://x')
  })
})

describe('the playback refusals (RTSP-3, CON-2)', () => {
  it('are fixed sentences that name no URL', () => {
    for (const message of Object.values(RTSP_STREAM_MESSAGES)) {
      expect(message).not.toMatch(/rtsp[sx]?:\/\/\w/)
      expect(message).not.toContain('rtsp-')
    }
  })
})
