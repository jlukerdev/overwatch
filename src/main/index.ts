// App entry: window creation, single-instance lock, lifecycle, wires up services.
import { join } from 'node:path'
import { app, BrowserWindow, safeStorage } from 'electron'
import { createConfigStore, type ConfigStore } from './config/store'
import { type Config } from './config/schema'
import { isAppUrl } from './navigation'
import { createSecretsStore, safeStorageCrypto, type SecretsStore } from './secrets/secrets'

// With ELECTRON_RUN_AS_NODE set, the Electron binary runs as a plain Node interpreter: `app` and
// `BrowserWindow` are undefined and every line below fails with a confusing TypeError. VS Code
// terminals inherit the variable from the extension host (P0.5 hit it on Windows), and `npm run
// dev` strips it (scripts/electron-vite.ts) — this catches a direct `electron .` launch.
if (process.env.ELECTRON_RUN_AS_NODE !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '') {
  console.error(
    'View Protect is being run as a Node script, not as an Electron app, because ' +
      'ELECTRON_RUN_AS_NODE is set in this environment. Unset it and start the app again.',
  )
  process.exit(1)
}

let mainWindow: BrowserWindow | null = null

/**
 * The main-process services, created once at startup. The typed IPC handlers that hand this to the
 * renderer arrive in P1.5; nothing crosses the contextBridge yet, and `secrets` never will
 * (CON-2, NFR-9).
 */
export interface Services {
  readonly config: ConfigStore
  readonly secrets: SecretsStore
  /** The config as loaded (or defaults). P1.5 owns keeping this current as the user edits it. */
  current: Config
}

let services: Services | null = null

/** The services, or `null` before `startServices()` has finished. */
export function getServices(): Services | null {
  return services
}

/**
 * Loads config and opens the secrets store. This is the only place that touches Electron's `app`
 * and `safeStorage` for them: both stores take their directory and crypto as parameters so they
 * stay unit-testable (see their headers).
 *
 * Nothing here is fatal. A corrupt config has already been moved aside and replaced with defaults
 * by the store, and an unavailable keystore only means the user cannot save a key yet — in both
 * cases the app must still start so they can see and fix it in Settings (P1.6).
 */
async function startServices(): Promise<void> {
  const dir = app.getPath('userData')
  const config = createConfigStore({ dir })
  const secrets = createSecretsStore({ dir, crypto: safeStorageCrypto(safeStorage) })

  const loaded = await config.load()
  if (loaded.source === 'recovered') {
    // config.json holds no secrets (CON-2), so this text is safe to log as is.
    console.error(`[config] ${loaded.recovery.problem}`)
  }
  // Published before anything that can fail below, so a write-back or keystore problem cannot
  // leave the app with no services for the rest of the session.
  services = { config, secrets, current: loaded.config }

  if (loaded.source === 'file' && loaded.migratedFrom !== null) {
    // Write the upgraded file back once, so every later launch loads it directly.
    console.warn(`[config] migrated from schemaVersion ${String(loaded.migratedFrom)}`)
    await config.save(loaded.config)
  }

  if (!secrets.isEncryptionAvailable()) {
    // CON-2 allows no plaintext fallback, so this is a real limitation, not a warning to swallow.
    console.error(
      '[secrets] The OS keystore is unavailable, so the API key cannot be stored. ' +
        'Connecting will need the key re-entered every launch.',
    )
  } else {
    const stored = await secrets.read()
    if (stored.status === 'unreadable' || stored.status === 'io-error') {
      console.error(`[secrets] ${stored.problem}`)
    }
  }
}

const rendererIndexPath = join(__dirname, '../renderer/index.html')
// The dev server URL is only honoured in unpackaged runs.
const rendererDevUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const navigationOptions = { devUrl: rendererDevUrl, rendererIndexPath }

/** Chromium net error for a load that was aborted (e.g. superseded by another navigation). */
const ERR_ABORTED = -3

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'View Protect',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  mainWindow = win

  win.once('ready-to-show', () => {
    win.show()
  })
  // If the renderer fails to load, ready-to-show may never fire: show the window anyway.
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === ERR_ABORTED) return
    console.error(`Renderer failed to load ${validatedURL}: ${errorDescription}`, errorCode)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const load = rendererDevUrl ? win.loadURL(rendererDevUrl) : win.loadFile(rendererIndexPath)
  load.catch((err: unknown) => {
    console.error('Failed to load renderer:', err)
  })
}

// Security baseline for every web contents the app creates.
app.on('web-contents-created', (_event, contents) => {
  // No new windows and no external links: the app has none, so deny everything.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // No navigation away from the app (also covers drag-and-drop of files/links onto the window).
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, navigationOptions)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, navigationOptions)) event.preventDefault()
  })
  // No <webview> tags.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // On macOS the app can stay alive with no window; open a fresh one.
    if (!mainWindow) {
      if (app.isReady()) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      // Before the window, so a recovered config or an unavailable keystore is reported at launch.
      // A failure here must not stop the app: the user needs Settings to fix whatever it was.
      await startServices().catch((err: unknown) => {
        console.error('[services] Failed to start:', err)
      })
      // A `second-instance` can arrive while the await above is pending and open the window first;
      // creating another one here would orphan it (only the last is tracked as mainWindow).
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((err: unknown) => {
      console.error('App failed to start:', err)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
