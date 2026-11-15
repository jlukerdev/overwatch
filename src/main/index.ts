// App entry: window creation, single-instance lock, lifecycle, and the one place where the
// main-process services are assembled from their parts (config, secrets, TLS pins, the shared
// Protect request throttle and the two API clients).
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron'
import { IPC_EVENTS } from '@shared/ipc'
import type { View } from '@shared/models'
import { STREAM_RUNTIME_DOWN, type StreamRuntime } from '@shared/streams'
import { createAccessClient, type AccessClient } from './access/client'
import { createConfigStore, type ConfigStore } from './config/store'
import { type Config } from './config/schema'
import { createConnectionManager, type ConnectionManager } from './connection'
import { accessEndpoint, protectEndpoint } from './console/endpoints'
import { createIpcRouter, registerIpcHandlers } from './ipc/handlers'
import { isAppUrl } from './navigation'
import { createRateLimiter, type RateLimiter } from './net/rateLimiter'
import { startPerfRun } from './perf/perfMode'
import { parsePerfEnv, withPerfGridQuality, withPerfView } from './perf/perfStats'
import { createProtectClient, type ProtectClient } from './protect/client'
import {
  createSecretsStore,
  safeStorageCrypto,
  type Secrets,
  type SecretsStore,
} from './secrets/secrets'
import {
  createGo2rtcManager,
  go2rtcBinaryPath,
  type Go2rtcManager,
  type Go2rtcRuntime,
} from './streams/go2rtcManager'
import { createStreamRegistry, type StreamRegistry } from './streams/registry'
import { createConfigPinStore, createPinPersistence } from './tls/configPinStore'
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

// P2.5 perf harness (`npm run perf`): on only with VP_PERF_QUALITY set in an unpackaged build. It
// overrides the grid quality and the Views the renderer is shown (in memory, never saved) and
// drives the window from `startPerfRun` below; see src/main/perf/.
const perfEnv = parsePerfEnv(process.env, app.isPackaged)
if (perfEnv.kind === 'invalid') {
  console.error(`[perf] ${perfEnv.problem}`)
  process.exit(2)
}
if (perfEnv.kind === 'ignored') console.warn(`[perf] ${perfEnv.reason}`)
const perfConfig = perfEnv.kind === 'on' ? perfEnv.config : null
/**
 * The perf run's View (P3.2), set by `startPerfRun` once it knows the cameras and read by the
 * router's `settingsView` on every state answer. Null until then, and always outside a perf run.
 * Lives only here: the stored config never sees it, because while it is set the router refuses
 * every View write (`viewWritesBlocked`).
 */
let perfView: View | null = null

let mainWindow: BrowserWindow | null = null

/**
 * The main-process services, created once at startup. The typed IPC handlers (P1.5) hand the
 * renderer a trimmed view of this and nothing more: `secrets`, `credentials` and the clients never
 * cross the contextBridge (CON-2, NFR-9) — the renderer gets trimmed models, booleans saying
 * whether a credential is stored, and loopback go2rtc names (P2.2) instead.
 */
export interface Services {
  readonly config: ConfigStore
  readonly secrets: SecretsStore
  /** The config as loaded (or defaults). The connection manager replaces it on a console change. */
  current: Config
  /**
   * The decrypted secrets, held in memory because the API clients read them **synchronously** on
   * every request. The `setSecret`/`clearSecret` handlers update these together with `secrets.set()`.
   * Never logged, never sent to the renderer (CON-2, R5).
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

/** CON-5/CAM-1/2: the connection status and the camera inventory. `null` if startup failed. */
let connection: ConnectionManager | null = null

/** Removes every IPC handler again; set once the router is bound to `ipcMain`. */
let disposeIpcHandlers: (() => void) | null = null

/**
 * The go2rtc sidecar (P2.1) and the stream registry (P2.2). `null` if startup failed, and the
 * sidecar is **not** running just because these exist: go2rtc starts lazily, on the first
 * `ensureStream` (see `buildStreaming`).
 */
let go2rtc: Go2rtcManager | null = null
let streams: StreamRegistry | null = null

/**
 * The event sink the connection manager pushes through. Only the main window and only while it
 * exists: `webContents.send` on a destroyed window throws, and the app has exactly one window, so
 * an event with nowhere to go is simply dropped — the renderer asks for `getState` at mount.
 */
function sendToRenderer(channel: string, payload: unknown): void {
  // QUAL-8's "refresh on camera changes", hooked here rather than in `connection.ts`: the
  // inventory event is *already* the signal — it is sent after every connect, reconnect and
  // add/remove (CAM-2) — and this sink is the one place that sees it, so the registry learns about
  // a re-read without the connection manager having to know that streams exist at all. Dropping a
  // cached URL interrupts nothing (see `StreamRegistry.invalidate`), so doing it on every inventory
  // event rather than diffing the list costs at most one GET per camera/quality next time.
  if (channel === IPC_EVENTS.cameras.channel) streams?.invalidate()
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/**
 * The bundled go2rtc binary for this platform, in both layouts it can be in.
 *
 * Unpackaged (`npm run dev`, `electron .`) it sits where `scripts/fetch-go2rtc.ts` installs it:
 * `<repo>/resources/bin/<platform>-<arch>/go2rtc[.exe]`, which is exactly what `go2rtcBinaryPath`
 * builds. Packaged, `electron-builder.yml` copies **one** target's folder with `extraResources:
 * from: resources/bin/<platform>-${arch}, to: bin`, which **flattens** the platform-arch segment
 * away: the binary is at `<process.resourcesPath>/bin/go2rtc[.exe]`. The file name still comes from
 * `go2rtcBinaryPath` (via `basename`) so the `.exe` suffix is decided in one place.
 *
 * Resolved per start, not at import, so a path problem is reportable rather than fatal at launch.
 */
function go2rtcBinary(): string {
  const unpackaged = go2rtcBinaryPath(join(app.getAppPath(), 'resources'))
  return app.isPackaged ? join(process.resourcesPath, 'bin', basename(unpackaged)) : unpackaged
}

/**
 * SPEC §5.3 "Renderer isolation". Injects go2rtc's `Authorization: Basic …` and rewrites `Origin`
 * for the **current** go2rtc port, and nothing else.
 *
 * Both halves are required and both are deliberately narrow:
 *
 *  - The `Origin` rewrite is what lets go2rtc keep its strict default origin check (`api.origin:
 *    ""`). go2rtc accepts a WebSocket only when the `Origin` host equals the `Host`, which rejects
 *    the `file://` page and the dev server's origin alike. **Never `origin: "*"`** — any website
 *    open in the user's browser could then attach to the loopback port and watch the cameras.
 *  - The header injection is what keeps the credential in main (CON-2, NFR-9): the renderer is given
 *    a port and a stream name and can neither authenticate nor name a stream on its own.
 *
 * The filter is rebuilt on every runtime change because **the port changes on every (re)start**
 * (P2.1): a stale filter would keep injecting the credential at a port some other local process may
 * now hold. While go2rtc is down the listener is removed entirely, so nothing is injected anywhere;
 * `authHeader()` is also re-read per request, so even a request that races a restart cannot be sent
 * with the previous launch's credential.
 */
function applyGo2rtcHeaderInjection(runtime: Go2rtcRuntime | null): void {
  const { webRequest } = session.defaultSession
  if (runtime === null) {
    // go2rtc is not up: no port is ours, so nothing may be injected (not even an Origin).
    webRequest.onBeforeSendHeaders(null)
    return
  }
  const port = String(runtime.port)
  const origin = `http://127.0.0.1:${port}`
  webRequest.onBeforeSendHeaders(
    { urls: [`ws://127.0.0.1:${port}/*`, `${origin}/*`] },
    (details, callback) => {
      const header = go2rtc?.authHeader() ?? null
      if (header === null) {
        // Between a crash and the restart the credential is gone: send the request unchanged rather
        // than with a header from the previous launch. go2rtc answers 401 and the player retries.
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      callback({
        requestHeaders: { ...details.requestHeaders, Origin: origin, Authorization: header },
      })
    },
  )
}

/** `IPC_EVENTS.streamRuntime`'s payload for a runtime (SPEC §6.1). */
function streamRuntimePayload(runtime: Go2rtcRuntime | null): StreamRuntime {
  return runtime === null
    ? STREAM_RUNTIME_DOWN
    : { state: 'up', port: runtime.port, epoch: runtime.epoch }
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
  // `current` as a property, for the helpers that replace it (the pin store's writer).
  const live = {
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
  }

  const pins = createPinRegistry(
    createConfigPinStore({
      getConsole: () => current.console,
      // CON-3: the pin goes into `current` at once and is written through `config.update`, which
      // touches only the pin fields (see createPinPersistence).
      setConsole: createPinPersistence({
        live,
        store: config,
        onError: (err) => {
          console.error('[config] Could not save the accepted certificate pin:', err)
        },
      }),
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
    // Write the upgraded file back once, so every later launch loads it directly. Through `update`
    // like every other write, so it cannot race one that is already queued (VIEW-6).
    console.warn(`[config] migrated from schemaVersion ${String(loaded.migratedFrom)}`)
    await config.update((latest) => latest)
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

/**
 * The streaming half of main (P2.1/P2.2): the go2rtc sidecar and the stream registry, built next to
 * the connection manager and from the same live services.
 *
 * **Nothing is spawned here.** go2rtc starts lazily, on the first `ensureStream` (`registry.ts`), so
 * a user who only opens Settings never gets a sidecar — and the app never holds an upstream RTSPS
 * session nobody is watching. NFR-6 ("streams live within 5 s of launch") may later want a
 * *pre-start* as soon as a View is restored, i.e. `void go2rtc.start()` once P3's last-View restore
 * exists (P3/P6); it is deliberately not done now, because today there is no View to open and the
 * only thing a pre-start could do is spawn a process for nothing.
 */
function buildStreaming(started: Services, manager: ConnectionManager): void {
  /**
   * The pinned console host (CON-3, R4), read per call so a mid-session address change is picked
   * up. `null` while nothing is configured: `protectEndpoint` throws a `ConsoleEndpointError` then,
   * and "no host" is exactly what R4's check must see rather than an exception (CON-1).
   */
  const consoleHost = (): string | null => {
    try {
      return protectEndpoint(started.current.console).host
    } catch {
      return null
    }
  }

  const sidecar = createGo2rtcManager({
    // ARCHITECTURE §4: the generated config lives beside config.json, and holds RTSPS URLs, so the
    // manager writes it 0600 and deletes it as soon as go2rtc has read it (SPEC §5.3).
    configDir: app.getPath('userData'),
    binaryPath: go2rtcBinary,
    consoleHost,
    log: (line) => {
      // Already redacted by the manager: no credential and no source URL (CON-2, NFR-9).
      console.log(`[go2rtc] ${line}`)
    },
  })
  go2rtc = sidecar

  streams = createStreamRegistry({
    manager: sidecar,
    // Per call, not bound once: the client is rebuilt when the console address changes.
    protect: () => started.protect(),
    // CAM-1: `GET /v1/cameras` is the authority and the manager caches its last read.
    cameras: () => manager.cachedCameras(),
    consoleHost,
    log: (line) => {
      console.log(`[streams] ${line}`)
    },
  })

  // The port changes on every (re)start, so both the header filter and the renderer follow the
  // runtime instead of remembering a port (P2.1, SPEC §5.3). The runtime is deliberately **not**
  // part of `AppState` (SPEC §6.1), which is why it is pushed.
  sidecar.onRuntimeChange((runtime) => {
    applyGo2rtcHeaderInjection(runtime)
    sendToRenderer(IPC_EVENTS.streamRuntime.channel, streamRuntimePayload(runtime))
  })
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
  // The go2rtc runtime is not part of `AppState` (SPEC §6.1), so a renderer that mounts after the
  // sidecar came up would never hear about it: `onRuntimeChange` had already fired, and the next
  // push may be hours away. One push per completed load — including a reload — is what makes the
  // `streamRuntime` event complete. Sent even when go2rtc is down (as `down`), so the player knows
  // the difference between "no gateway" and "no news yet".
  win.webContents.on('did-finish-load', () => {
    sendToRenderer(
      IPC_EVENTS.streamRuntime.channel,
      streamRuntimePayload(go2rtc?.runtime() ?? null),
    )
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
  // The renderer cancels an unload while the View editor has unsaved changes (VIEW-3,
  // `blockUnload`). Electron shows no prompt for that on its own, so ask here; "Leave" lets the
  // close or reload go ahead.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes to a View. Leave and discard them?',
    })
    if (choice === 0) event.preventDefault()
  })

  const load = rendererDevUrl ? win.loadURL(rendererDevUrl) : win.loadFile(rendererIndexPath)
  load.catch((err: unknown) => {
    console.error('Failed to load renderer:', err)
  })
}

/** P2.5: hands the perf run the window and the few services it drives (see src/main/perf/). */
function startPerf(config: NonNullable<typeof perfConfig>): void {
  const manager = connection
  const win = mainWindow
  if (manager === null || win === null) {
    console.error('[perf] the app services did not start, so there is nothing to measure')
    app.quit()
    return
  }
  startPerfRun({
    config,
    window: win,
    connect: () => manager.connect(),
    cameras: () => manager.cachedCameras(),
    setPerfView: (view) => {
      perfView = view
    },
    go2rtcPid: () => go2rtc?.pid() ?? null,
    stopStreaming: async () => {
      streams?.shutdown()
      await go2rtc?.stop()
    },
  })
}

// SPEC §5.3: never answer an auth challenge — from go2rtc or from anything else — with a prompt or
// with credentials. Without this, a request that reaches the loopback port *without* the injected
// header (a stale filter, a restart in flight, a renderer-built URL) turns go2rtc's 401 into a
// Basic-auth dialog in front of the user's video wall, and a password typed into it would be sent
// to whatever holds that port. `preventDefault()` plus an empty `callback()` cancels the request
// instead, which is the honest outcome: the player sees it fail and re-asks `ensureStream`.
app.on('login', (event, _webContents, _details, _authInfo, callback) => {
  event.preventDefault()
  callback()
})

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
      // The connection manager and the IPC router, in that order. **Nothing connects here**: the
      // manager only derives its status from the config and the stored pins, which are offline
      // reads, so the first request to the console stays a deliberate user action (CON-4, R9).
      const started = getServices()
      if (started !== null) {
        connection = createConnectionManager({
          services: started,
          emit: sendToRenderer,
          log: (line) => {
            console.log(`[connection] ${line}`)
          },
        })
        // P2.1/P2.2, after the connection manager because the registry reads its cached inventory.
        buildStreaming(started, connection)
      }
      // Registered even when startup failed, so a call answers `not-ready` with a kind the UI can
      // branch on instead of arriving as a rejected `invoke` with no handler at all.
      disposeIpcHandlers = registerIpcHandlers(
        ipcMain,
        createIpcRouter({
          getServices,
          getManager: () => connection,
          getRegistry: () => streams,
          appVersion: () => app.getVersion(),
          ...(perfConfig === null
            ? {}
            : {
                settingsView: (s) =>
                  withPerfView(withPerfGridQuality(s, perfConfig.quality), perfView),
                // The renderer is shown only `[perf]` once the perf View is set, so a View write
                // from it would store that list over the user's Views. Refuse them for the run.
                viewWritesBlocked: () =>
                  perfView === null ? null : 'Views cannot be changed during a perf run.',
              }),
        }),
      )
      // A `second-instance` can arrive while the await above is pending and open the window first;
      // creating another one here would orphan it (only the last is tracked as mainWindow).
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      if (perfConfig !== null) startPerf(perfConfig)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((err: unknown) => {
      console.error('App failed to start:', err)
      app.quit()
    })

  app.on('window-all-closed', () => {
    // During a perf run the harness quits by itself once its results are written (perfMode.ts).
    if (perfConfig !== null) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    disposeIpcHandlers?.()
    disposeIpcHandlers = null
    const manager = connection
    connection = null
    const sidecar = go2rtc
    go2rtc = null
    // The registry only holds caches; the sidecar is a process, so it is the one that has to be
    // told. Same not-awaited, failure-logged pattern as the connection shutdown below, and for the
    // same reason: `will-quit` would have to be deferred with `preventDefault()` to await it, and
    // the manager SIGKILLs the child after its grace period anyway (P2.1).
    streams?.shutdown()
    streams = null
    void sidecar?.stop().catch((err: unknown) => {
      console.error('[go2rtc] Shutdown failed:', err)
    })
    // Not awaited: `will-quit` would have to be deferred with `preventDefault()` to do that, and
    // what is left to do — closing the devices socket and the pinned Agents — only matters while
    // the process lives. A failure is logged rather than allowed to hold up the quit.
    void manager?.shutdown().catch((err: unknown) => {
      console.error('[connection] Shutdown failed:', err)
    })
  })
}
