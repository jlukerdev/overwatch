// App entry: window creation, single-instance lock, lifecycle, and the one place where the
// main-process services are assembled from their parts (config, secrets, TLS pins, the shared
// Protect request throttle and the two API clients).
import { join } from 'node:path'
import { app, BrowserWindow, safeStorage } from 'electron'
import { createAccessClient, type AccessClient } from './access/client'
import { createConfigStore, type ConfigStore } from './config/store'
import { type Config } from './config/schema'
import { accessEndpoint, protectEndpoint } from './console/endpoints'
import { isAppUrl } from './navigation'
import { createRateLimiter, type RateLimiter } from './net/rateLimiter'
import { createProtectClient, type ProtectClient } from './protect/client'
import {
  createSecretsStore,
  safeStorageCrypto,
  type Secrets,
  type SecretsStore,
} from './secrets/secrets'
import { createConfigPinStore } from './tls/configPinStore'
import { createPinRegistry, type PinRegistry } from './tls/pinning'

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
 * renderer arrive in P1.5; nothing crosses the contextBridge yet, and `secrets`, `credentials` and
 * the clients never will (CON-2, NFR-9) — the renderer gets trimmed models and loopback go2rtc
 * names instead.
 */
export interface Services {
  readonly config: ConfigStore
  readonly secrets: SecretsStore
  /** The config as loaded (or defaults). P1.5 owns keeping this current as the user edits it. */
  current: Config
  /**
   * The decrypted secrets, held in memory because the API clients read them **synchronously** on
   * every request. P1.6 updates these together with `secrets.set()`. Never logged, never sent to
   * the renderer (CON-2, R5).
   */
  readonly credentials: Secrets
  /** TOFU certificate pins (CON-3), stored in the two `console` fingerprint fields of SPEC §6. */
  readonly pins: PinRegistry
  /** One throttle for every Protect call, REST and WebSocket, because R9's budget is per key. */
  readonly limiter: RateLimiter
  /**
   * A Protect client for the console **as configured right now**, built on first use and rebuilt
   * when the address changes. Throws a `ConsoleEndpointError` while no host is set (CON-1) and a
   * `PinRequiredError` on the first request to an unpinned console (CON-3) — both of which are
   * Settings' business to resolve (P1.6), not this module's.
   */
  protect(): ProtectClient
  /** The same for the Access developer API. It makes no call at all while Access is off (DOOR-0). */
  access(): AccessClient
}

let services: Services | null = null

/** The services, or `null` before `startServices()` has finished. */
export function getServices(): Services | null {
  return services
}

/**
 * Loads config, opens the secrets store and assembles everything that talks to the console: the
 * pin registry over the config's two fingerprint fields (CON-3), the shared request throttle (R9)
 * and the two API clients. This is the only place that touches Electron's `app` and `safeStorage`:
 * every module below takes its directory, crypto, endpoint, credentials and dispatcher as
 * parameters, which is what keeps them unit-testable in plain Node (see their headers).
 *
 * **Nothing here connects.** Resolving an address and reading a pin are offline; the first request
 * happens when the user asks for one (CON-4, P1.6).
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

  // The live config and the decrypted secrets. Everything below closes over these rather than
  // taking a copy, so editing the address or the key in Settings (P1.6) reaches the clients without
  // anything being rebuilt by hand.
  let current = loaded.config
  const credentials: Secrets = {}

  const pins = createPinRegistry(
    createConfigPinStore({
      getConsole: () => current.console,
      setConsole: (next) => {
        current = { ...current, console: next }
        // CON-3: a pin the user accepted has to survive a restart, so it is written at once. A
        // failed write is reported rather than thrown — the pin is already in memory, so the
        // session works; it is the next launch that would ask again.
        void config.save(current).catch((err: unknown) => {
          console.error('[config] Could not save the accepted certificate pin:', err)
        })
      },
    }),
  )

  // One limiter for both clients and, later, both subscriptions: the console's 10 requests per
  // second are counted per API key, and a WebSocket upgrade spends one too (SPEC §5.1, R9).
  const limiter = createRateLimiter()

  // The clients are cached per resolved base URL. Rebuilding on an address change matters because
  // the pinned Agent and the pin are both keyed by host:port.
  let protectCache: { baseUrl: string; client: ProtectClient } | null = null
  const protect = (): ProtectClient => {
    const endpoint = protectEndpoint(current.console)
    const cached = protectCache
    if (cached !== null && cached.baseUrl === endpoint.baseUrl) return cached.client
    const client = createProtectClient({
      endpoint,
      apiKey: () => credentials.protectApiKey ?? null,
      // Read per request, so re-accepting a certificate takes effect without a new client.
      dispatcher: () => pins.agentFor(endpoint.host, endpoint.port),
      limiter,
      log: (line) => {
        console.log(`[protect] ${line}`)
      },
    })
    protectCache = { baseUrl: endpoint.baseUrl, client }
    return client
  }

  let accessCache: { baseUrl: string; client: AccessClient } | null = null
  const access = (): AccessClient => {
    const endpoint = accessEndpoint(current.console)
    const cached = accessCache
    if (cached !== null && cached.baseUrl === endpoint.baseUrl) return cached.client
    const client = createAccessClient({
      endpoint,
      // DOOR-0, read per call: the feature is off by default and the switch is in Settings (P5.2).
      enabled: () => current.console.accessEnabled,
      token: () => credentials.accessToken ?? null,
      dispatcher: () => pins.agentFor(endpoint.host, endpoint.port),
      log: (line) => {
        console.log(`[access] ${line}`)
      },
    })
    accessCache = { baseUrl: endpoint.baseUrl, client }
    return client
  }

  // Published before anything that can fail below, so a write-back or keystore problem cannot
  // leave the app with no services for the rest of the session. `current` is an accessor pair over
  // the closure variable, so a later assignment is visible to the pin store and both clients.
  services = {
    config,
    secrets,
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    credentials,
    pins,
    limiter,
    protect,
    access,
  }

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
    // Into the existing object, not over it: the clients hold this reference.
    Object.assign(credentials, stored.secrets)
  }

  reportConnectionReadiness(current, pins, credentials)
}

/**
 * One offline line per endpoint saying whether the app *could* connect: it resolves the addresses
 * and reads the stored pins but **sends nothing**. Testing the connection is a deliberate user
 * action in Settings (CON-4, P1.6), and an app that silently reached for the console at every
 * launch would also spend rate-limit permits nobody asked for (R9).
 *
 * Nothing here can print a secret: the API key and token appear only as "stored" or "not stored".
 */
function reportConnectionReadiness(config: Config, pins: PinRegistry, credentials: Secrets): void {
  const describe = (
    label: string,
    resolve: () => { host: string; port: number; hostPort: string },
    credential: string | undefined,
    credentialName: string,
  ): void => {
    let endpoint: { host: string; port: number; hostPort: string }
    try {
      endpoint = resolve()
    } catch (err) {
      console.log(`[${label}] not configured yet: ${message(err)}`)
      return
    }
    let pinned: string
    try {
      pinned =
        pins.pinnedFingerprint(endpoint.host, endpoint.port) === null
          ? 'certificate not accepted yet'
          : 'certificate pinned'
    } catch (err) {
      // A stored pin that is not a fingerprint at all: the user has to re-accept it (CON-3).
      pinned = `certificate pin unusable (${message(err)})`
    }
    const held = credential === undefined ? 'not stored' : 'stored'
    console.log(`[${label}] ${endpoint.hostPort}: ${pinned}, ${credentialName} ${held}`)
  }

  describe('protect', () => protectEndpoint(config.console), credentials.protectApiKey, 'API key')
  if (!config.console.accessEnabled) {
    // DOOR-0: off by default, and while it is off the app makes no Access call at all.
    console.log('[access] disabled (DOOR-0)')
    return
  }
  describe('access', () => accessEndpoint(config.console), credentials.accessToken, 'token')
}

/** An error's message, for a log line. Never carries a secret: these errors are built from config. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
