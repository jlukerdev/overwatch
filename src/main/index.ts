// App entry: window creation, single-instance lock, lifecycle, wires up services.
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { isAppUrl } from './navigation'

let mainWindow: BrowserWindow | null = null

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
    .then(() => {
      createWindow()
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
