import { join } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildAppMenuTemplate } from '../../src/main/appMenu'
import {
  APP_NAME,
  USER_DATA_DIR_NAME,
  appIconPath,
  userDataOverride,
} from '../../src/main/branding'

/** A menu as `label: [role or label of each item]`, separators as `-`, for compact assertions. */
function outline(template: MenuItemConstructorOptions[]): Record<string, string[]> {
  return Object.fromEntries(
    template.map((menu) => {
      const items = Array.isArray(menu.submenu) ? menu.submenu : []
      return [
        menu.label ?? '',
        items.map((item) =>
          item.type === 'separator'
            ? '-'
            : `${item.role ?? ''}${item.label ? `:${item.label}` : ''}`,
        ),
      ]
    }),
  )
}

const base = { appName: APP_NAME }

describe('buildAppMenuTemplate (macOS)', () => {
  it('names OverWatch in the app menu and has Edit, View and Window', () => {
    const menu = outline(buildAppMenuTemplate({ ...base, isMac: true, isPackaged: true }))
    expect(Object.keys(menu)).toEqual(['OverWatch', 'Edit', 'View', 'Window'])
    expect(menu.OverWatch).toEqual([
      'about:About OverWatch',
      '-',
      'hide:Hide OverWatch',
      'hideOthers',
      'unhide',
      '-',
      'quit:Quit OverWatch',
    ])
    expect(menu.Window).toEqual(['minimize', 'zoom', '-', 'front', '-', 'close'])
  })

  it('has the edit roles text fields need for Cmd+C/V', () => {
    const menu = outline(buildAppMenuTemplate({ ...base, isMac: true, isPackaged: true }))
    expect(menu.Edit).toEqual(['undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'selectAll'])
  })

  it('never says Electron', () => {
    const json = JSON.stringify(buildAppMenuTemplate({ ...base, isMac: true, isPackaged: false }))
    expect(json).not.toMatch(/electron/i)
  })
})

describe('buildAppMenuTemplate (Windows)', () => {
  it('has File/Exit, Edit, View, Window and Help/About OverWatch', () => {
    const menu = outline(buildAppMenuTemplate({ ...base, isMac: false, isPackaged: true }))
    expect(Object.keys(menu)).toEqual(['File', 'Edit', 'View', 'Window', 'Help'])
    expect(menu.File).toEqual(['quit:Exit'])
    expect(menu.Help).toEqual(['about:About OverWatch'])
    expect(menu.Window).toEqual(['minimize', 'close'])
  })
})

describe('buildAppMenuTemplate View menu', () => {
  it('offers reload and DevTools only in an unpackaged run', () => {
    for (const isMac of [true, false]) {
      const dev = outline(buildAppMenuTemplate({ ...base, isMac, isPackaged: false }))
      const packaged = outline(buildAppMenuTemplate({ ...base, isMac, isPackaged: true }))
      expect(dev.View).toEqual([
        'reload',
        'forceReload',
        'toggleDevTools',
        '-',
        'resetZoom',
        'zoomIn',
        'zoomOut',
        '-',
        'togglefullscreen',
      ])
      expect(packaged.View).toEqual(['resetZoom', 'zoomIn', 'zoomOut', '-', 'togglefullscreen'])
    }
  })
})

describe('userDataOverride', () => {
  it('keeps the pre-rename "View Protect" folder', () => {
    expect(USER_DATA_DIR_NAME).toBe('View Protect')
    expect(userDataOverride({ appData: '/appdata', hasUserDataDirSwitch: false })).toBe(
      join('/appdata', 'View Protect'),
    )
  })

  it('leaves an explicit --user-data-dir alone', () => {
    expect(userDataOverride({ appData: '/appdata', hasUserDataDirSwitch: true })).toBeNull()
  })
})

describe('appIconPath', () => {
  it('uses the repo copy unpackaged and the resources copy packaged', () => {
    const paths = { mainDir: '/repo/out/main', resourcesPath: '/app/resources' }
    expect(appIconPath({ ...paths, isPackaged: false })).toBe(
      join('/repo', 'resources', 'icons', 'icon.png'),
    )
    expect(appIconPath({ ...paths, isPackaged: true })).toBe(
      join('/app/resources', 'icons', 'icon.png'),
    )
  })
})
