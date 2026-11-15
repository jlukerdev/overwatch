// The screen the app opens on (src/renderer/src/initialScreen.ts): Settings for a fresh install
// (CON-1), Live when main connects by itself at launch and a View exists (CON-4, VIEW-6), Cameras
// otherwise.
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
  options: { host?: string; connectOnLaunch?: boolean; views?: number; pinned?: boolean } = {},
): Settings {
  return SettingsSchema.parse({
    console: {
      host: options.host ?? 'udm.local',
      connectOnLaunch: options.connectOnLaunch ?? false,
      certFingerprint: (options.pinned ?? true) ? 'AA:BB' : null,
    },
    views: Array.from({ length: options.views ?? 0 }, (_, i) => ({ ...VIEW, id: `v${String(i)}` })),
  })
}

const KEY: SecretsStored = { protectApiKey: true, accessToken: false }
const NO_KEY: SecretsStored = { protectApiKey: false, accessToken: false }

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
