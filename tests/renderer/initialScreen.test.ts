// The screen the app opens on (src/renderer/src/initialScreen.ts): Settings for a fresh install
// (CON-1), Live when main connects by itself at launch and a View exists (CON-4, VIEW-6), Cameras
// otherwise; in RTSP mode Live when there is a View and a stream, Streams otherwise (MODE-3).
import type { SecretsStored } from '@shared/ipc'
import { SettingsSchema, type Settings } from '@shared/models'
import { describe, expect, it } from 'vitest'
import { initialScreen } from '../../src/renderer/src/initialScreen'

const VIEW = {
  id: 'v1',
  name: 'Perimeter',
  cols: 1,
  rows: 1,
  cells: [{ col: 0, row: 0, cameraIds: ['cam-1'] }],
}

function settings(
  options: {
    host?: string
    connectOnLaunch?: boolean
    views?: number
    pinned?: boolean
    mode?: 'protect' | 'rtsp'
    streams?: number
  } = {},
): Settings {
  return SettingsSchema.parse({
    mode: options.mode ?? 'protect',
    rtsp: {
      streams: Array.from({ length: options.streams ?? 0 }, (_, i) => ({
        id: `rtsp-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Stream ${String(i)}`,
      })),
    },
    console: {
      host: options.host ?? 'udm.local',
      connectOnLaunch: options.connectOnLaunch ?? false,
      certFingerprint: (options.pinned ?? true) ? 'AA:BB' : null,
    },
    views: Array.from({ length: options.views ?? 0 }, (_, i) => ({ ...VIEW, id: `v${String(i)}` })),
  })
}

const KEY: SecretsStored = { protectApiKey: true, accessToken: false, rtspUrls: {} }
const NO_KEY: SecretsStored = { protectApiKey: false, accessToken: false, rtspUrls: {} }

describe('initialScreen', () => {
  it('opens Settings while there are no settings yet', () => {
    expect(initialScreen(null, KEY)).toBe('settings')
  })

  it('opens Settings while there is no console address, whatever the flag says (CON-1)', () => {
    expect(initialScreen(settings({ host: '' }), KEY)).toBe('settings')
    expect(initialScreen(settings({ host: '', connectOnLaunch: true, views: 1 }), KEY)).toBe(
      'settings',
    )
  })

  it('opens Live when main connects at launch and there is a View (CON-4, VIEW-6)', () => {
    expect(initialScreen(settings({ connectOnLaunch: true, views: 1 }), KEY)).toBe('grid')
    expect(initialScreen(settings({ connectOnLaunch: true, views: 3 }), KEY)).toBe('grid')
  })

  it('opens Cameras when main connects at launch but no View is defined', () => {
    expect(initialScreen(settings({ connectOnLaunch: true, views: 0 }), KEY)).toBe('cameras')
  })

  it('opens Cameras when nothing connects at launch, Views or not', () => {
    expect(initialScreen(settings(), KEY)).toBe('cameras')
    expect(initialScreen(settings({ views: 2 }), KEY)).toBe('cameras')
  })

  it('opens Cameras when the flag is set but main will skip the launch connect (no key or pin)', () => {
    expect(initialScreen(settings({ connectOnLaunch: true, views: 1 }), NO_KEY)).toBe('cameras')
    expect(initialScreen(settings({ connectOnLaunch: true, views: 1, pinned: false }), KEY)).toBe(
      'cameras',
    )
  })
})

describe('initialScreen in RTSP mode (MODE-3)', () => {
  // `views` here stands for the active mode's list, which is what main shows the renderer (MODE-4).
  it('opens Live when there is a View and a stream', () => {
    expect(initialScreen(settings({ mode: 'rtsp', views: 1, streams: 1 }), NO_KEY)).toBe('grid')
    expect(initialScreen(settings({ mode: 'rtsp', views: 2, streams: 3 }), KEY)).toBe('grid')
  })

  it('opens Streams when there is no stream or no View', () => {
    expect(initialScreen(settings({ mode: 'rtsp' }), NO_KEY)).toBe('streams')
    expect(initialScreen(settings({ mode: 'rtsp', views: 1 }), NO_KEY)).toBe('streams')
    expect(initialScreen(settings({ mode: 'rtsp', streams: 1 }), NO_KEY)).toBe('streams')
  })

  it('ignores the console address and the launch connect flag', () => {
    expect(initialScreen(settings({ mode: 'rtsp', host: '' }), NO_KEY)).toBe('streams')
    expect(initialScreen(settings({ mode: 'rtsp', host: '', views: 1, streams: 1 }), NO_KEY)).toBe(
      'grid',
    )
    expect(initialScreen(settings({ mode: 'rtsp', connectOnLaunch: true, views: 1 }), KEY)).toBe(
      'streams',
    )
  })

  it('leaves a first run in Protect mode on Settings', () => {
    expect(initialScreen(settings({ host: '', streams: 1, views: 1 }), NO_KEY)).toBe('settings')
  })
})
