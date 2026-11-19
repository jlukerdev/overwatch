// P6.1 (BRAND-2): the application menu, built for OverWatch instead of Electron's default (which
// names "Electron" and carries Help links to electronjs.org). `src/main/index.ts` sets it with
// `Menu.setApplicationMenu` before the window opens.
//
// Pure: it imports only Electron's *types*, so the unit tests build the template in plain Node.
//
// Everything is a `role`, so Electron supplies the platform's accelerators and behaviour. The Edit
// menu is not decoration: on macOS, Cmd+C/V/X/A/Z in a text field only work through menu items
// with these roles. Reload, Force Reload and the developer tools are only in an unpackaged run: in
// the packaged app a stray Cmd+R would drop every live stream, and DevTools are for development.
import type { MenuItemConstructorOptions } from 'electron'

export interface AppMenuOptions {
  /** `process.platform === 'darwin'`. */
  readonly isMac: boolean
  /** `app.isPackaged`. */
  readonly isPackaged: boolean
  /** The name shown in the menu items (`APP_NAME`). */
  readonly appName: string
}

const separator: MenuItemConstructorOptions = { type: 'separator' }

export function buildAppMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const { isMac, isPackaged, appName } = options
  const about: MenuItemConstructorOptions = { role: 'about', label: `About ${appName}` }

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      separator,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      separator,
      { role: 'selectAll' },
    ],
  }

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      ...(isPackaged
        ? []
        : ([
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            separator,
          ] satisfies MenuItemConstructorOptions[])),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      separator,
      { role: 'togglefullscreen' },
    ],
  }

  if (isMac) {
    return [
      {
        label: appName,
        submenu: [
          about,
          separator,
          { role: 'hide', label: `Hide ${appName}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          separator,
          { role: 'quit', label: `Quit ${appName}` },
        ],
      },
      edit,
      view,
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          separator,
          { role: 'front' },
          separator,
          { role: 'close' },
        ],
      },
    ]
  }

  // Windows (and Linux): the menu bar stays hidden until Alt (`autoHideMenuBar`).
  return [
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
    edit,
    view,
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: 'Help', submenu: [about] },
  ]
}
