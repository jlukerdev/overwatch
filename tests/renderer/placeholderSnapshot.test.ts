// UX polish (CAM-3): the cached still a connecting player may draw behind its spinner, and how each
// placeholder kind is drawn.
//
// What these tests protect: a still is only ever offered while *connecting* (never beside "Camera
// offline" or an error, where an old picture would contradict the label), only from an entry that
// is `ready` (nothing loading, failed or unavailable), from the channel the cell plays; and every
// placeholder kind has a tone, with the spinner kept for the kinds that resolve on their own.
import type { IpcError } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { ThumbnailEntry } from '../../src/renderer/src/state/camerasStore'
import {
  placeholderCameraIcon,
  placeholderSnapshot,
} from '../../src/renderer/src/player/placeholderSnapshot'
import {
  placeholderTone,
  type PlayerPlaceholder,
} from '../../src/renderer/src/player/playerMachine'

const ERROR: IpcError = { kind: 'internal', message: 'no', endpoint: null, retryable: true }

function ready(byte: number): ThumbnailEntry {
  return { status: 'ready', bytes: new Uint8Array([byte]), mimeType: 'image/jpeg', capturedAt: 1 }
}

const MAIN = ready(1)
const PACKAGE = ready(2)
const ENTRIES: Record<string, ThumbnailEntry> = {
  cam: MAIN,
  loading: { status: 'loading', requestId: 7 },
  unavailable: { status: 'unavailable', reason: 'offline' },
}
const PACKAGES: Record<string, ThumbnailEntry> = { cam: PACKAGE }

const CONNECTING: PlayerPlaceholder = { kind: 'connecting' }

const EVERY_KIND: readonly PlayerPlaceholder[] = [
  { kind: 'camera-offline' },
  { kind: 'camera-connecting' },
  { kind: 'connecting' },
  { kind: 'gateway-down' },
  { kind: 'codec-unsupported', mime: 'video/mp4' },
  { kind: 'stream-error', error: ERROR },
  { kind: 'stream-failed' },
]

describe('placeholderSnapshot', () => {
  it('offers the cached main-channel image while connecting, as the cache holds it', () => {
    for (const quality of ['high', 'medium', 'low'] as const) {
      expect(placeholderSnapshot(CONNECTING, 'cam', quality, ENTRIES, PACKAGES)).toBe(MAIN)
    }
  })

  it('offers the package snapshot to a package-channel cell, never the main one', () => {
    expect(placeholderSnapshot(CONNECTING, 'cam', 'package', ENTRIES, PACKAGES)).toBe(PACKAGE)
    expect(placeholderSnapshot(CONNECTING, 'cam', 'package', ENTRIES, {})).toBeNull()
    expect(placeholderSnapshot(CONNECTING, 'cam', 'high', {}, PACKAGES)).toBeNull()
  })

  it('offers nothing unless the player is connecting', () => {
    for (const placeholder of EVERY_KIND) {
      if (placeholder.kind === 'connecting') continue
      expect(
        placeholderSnapshot(placeholder, 'cam', 'high', ENTRIES, PACKAGES),
        placeholder.kind,
      ).toBeNull()
    }
    expect(placeholderSnapshot(null, 'cam', 'high', ENTRIES, PACKAGES)).toBeNull()
  })

  it('offers nothing for a camera with no ready image', () => {
    for (const cameraId of ['other', 'loading', 'unavailable']) {
      expect(placeholderSnapshot(CONNECTING, cameraId, 'high', ENTRIES, PACKAGES)).toBeNull()
    }
  })
})

describe('placeholderTone', () => {
  it('spins only for the kinds that resolve on their own', () => {
    const tones = EVERY_KIND.map((placeholder) => [placeholder.kind, placeholderTone(placeholder)])
    expect(tones).toEqual([
      ['camera-offline', 'offline'],
      ['camera-connecting', 'progress'],
      ['connecting', 'progress'],
      ['gateway-down', 'alert'],
      ['codec-unsupported', 'alert'],
      ['stream-error', 'alert'],
      ['stream-failed', 'alert'],
    ])
  })
})

describe('RTSP streams mode (RTSP-4)', () => {
  it('never draws a still, whatever the cache holds', () => {
    expect(placeholderSnapshot(CONNECTING, 'cam', 'high', ENTRIES, PACKAGES, 'rtsp')).toBeNull()
  })

  it('draws the camera icon behind the spinner, only while connecting', () => {
    for (const placeholder of EVERY_KIND) {
      expect(placeholderCameraIcon(placeholder, 'rtsp')).toBe(placeholder.kind === 'connecting')
    }
    expect(placeholderCameraIcon(null, 'rtsp')).toBe(false)
  })

  it('keeps Protect mode on its still and draws no icon there', () => {
    expect(placeholderSnapshot(CONNECTING, 'cam', 'high', ENTRIES, PACKAGES, 'protect')).toBe(MAIN)
    expect(placeholderCameraIcon(CONNECTING, 'protect')).toBe(false)
    expect(placeholderCameraIcon(CONNECTING, undefined)).toBe(false)
  })
})
