// P6.1 branding: the app's external name (OverWatch) and the few paths that follow from it. "View
// Protect" stays the internal and repo name (package.json `name`, `window.viewProtect`, the code).
//
// Pure: no Electron import, so the unit tests run it in plain Node. `src/main/index.ts` passes in
// what it reads from `app` and `process`.
import { join } from 'node:path'

/** The name the user sees: menus, About panel, window title, dialogs (BRAND-1). */
export const APP_NAME = 'OverWatch'

/**
 * The `userData` folder's name, kept from before the rename (BRAND-5). Electron derives the default
 * from the product name, which is now OverWatch, so without this every existing install would start
 * blank: Views, settings, the accepted certificate pins, `secrets.bin` and, on Windows, the DPAPI key
 * in Chromium's `Local State` all live in `<appData>/View Protect`.
 */
export const USER_DATA_DIR_NAME = 'View Protect'

/**
 * Where `userData` must point, or `null` to leave it alone. A `--user-data-dir=<dir>` on the command
 * line wins (Chromium already set `userData` from it): the blank-profile checks in CLAUDE.md rely on
 * it, and overriding it would silently run them against the real profile.
 */
export function userDataOverride(input: {
  readonly appData: string
  readonly hasUserDataDirSwitch: boolean
}): string | null {
  return input.hasUserDataDirSwitch ? null : join(input.appData, USER_DATA_DIR_NAME)
}

/**
 * The 1024×1024 PNG app icon, for the window and taskbar (Windows/Linux), the About panel
 * (Windows/Linux) and the Dock in an unpackaged macOS run (BRAND-4). Unpackaged it is the repo's
 * `resources/icons/icon.png`; packaged, `electron-builder.yml` copies it to `<resources>/icons/`,
 * the same flattening the go2rtc binary gets (see `go2rtcBinary` in index.ts).
 *
 * Unpackaged it is found from the bundled main's own folder (`out/main`), not `app.getAppPath()`:
 * `npx electron out/main/index.js` (the CLAUDE.md blank-profile check) makes the app path
 * `out/main`, where `resources/` does not exist.
 */
export function appIconPath(input: {
  readonly isPackaged: boolean
  readonly mainDir: string
  readonly resourcesPath: string
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'icons', 'icon.png')
    : join(input.mainDir, '..', '..', 'resources', 'icons', 'icon.png')
}
