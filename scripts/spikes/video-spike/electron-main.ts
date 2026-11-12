// P0.5 spike: bare Electron main. Started by launch.ts (Electron's Node 24 strips the types).
// It never sees the API key, the console host or RTSPS URLs: only the go2rtc loopback port, the
// stream name and go2rtc's per-launch `Authorization` header value, passed in VP_SPIKE_*
// environment variables. The header value is removed from process.env at startup (so Chromium's
// helper processes don't inherit it) and only ever added to requests in main
// (onBeforeSendHeaders): the renderer never sees it.
//
// It opens one sandboxed window with the staged spike page, attaches the in-process DevTools
// protocol (webContents.debugger, no remote-debugging port) to read the Media domain (decoder
// names, platform decoder flag), polls the page's stats and app.getAppMetrics() once a second,
// and after VP_SPIKE_DURATION_SEC writes a JSON result + a screenshot and quits.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'
import type { WebContents } from 'electron'
import type { PlayerSample } from './stats.ts'
import { summarizeSamples } from './stats.ts'

function env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '')
    throw new Error(`${name} is not set (run via npm run spike:video)`)
  return v
}

// Read first and unset before Electron starts any helper process.
const go2rtcAuthHeader = env('VP_SPIKE_GO2RTC_AUTH')
delete process.env.VP_SPIKE_GO2RTC_AUTH
if (!/^Basic [A-Za-z0-9+/=]+$/.test(go2rtcAuthHeader))
  throw new Error('VP_SPIKE_GO2RTC_AUTH is not a Basic auth header value')
const port = Number(env('VP_SPIKE_PORT'))
const stream = env('VP_SPIKE_STREAM')
const stageDir = env('VP_SPIKE_STAGE_DIR')
const outFile = env('VP_SPIKE_RESULT_FILE')
const durationMs = Number(env('VP_SPIKE_DURATION_SEC')) * 1000
const keepOpen = process.env.VP_SPIKE_KEEP_OPEN === '1'
const trimKeepSec = process.env.VP_SPIKE_TRIM_KEEP_SEC ?? '0'
const bare = process.env.VP_SPIKE_BARE === '1' ? '1' : '0'
const indexPath = join(stageDir, 'index.html')
const indexUrl = pathToFileURL(indexPath).href
const goOrigin = `http://127.0.0.1:${String(port)}`

app.setPath('userData', join(stageDir, 'userData'))

interface MediaPlayerLog {
  properties: Record<string, unknown>
  events: string[]
  messages: string[]
  errors: unknown[]
}

const media = new Map<string, MediaPlayerLog>()
function playerLog(id: string): MediaPlayerLog {
  let p = media.get(id)
  if (!p) {
    p = { properties: {}, events: [], messages: [], errors: [] }
    media.set(id, p)
  }
  return p
}

/** Properties that identify the page (local paths), not the decoder: never recorded. */
const DROP_PROPERTIES = new Set(['kFrameUrl', 'kFrameTitle'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function onCdpMessage(method: string, params: unknown): void {
  if (!isRecord(params)) return
  const id = typeof params.playerId === 'string' ? params.playerId : 'unknown'
  const p = playerLog(id)
  if (method === 'Media.playerPropertiesChanged' && Array.isArray(params.properties)) {
    for (const prop of params.properties as unknown[]) {
      if (isRecord(prop) && typeof prop.name === 'string' && !DROP_PROPERTIES.has(prop.name)) {
        p.properties[prop.name] = prop.value
      }
    }
  } else if (method === 'Media.playerEventsAdded' && Array.isArray(params.events)) {
    for (const e of params.events as unknown[]) {
      if (isRecord(e) && p.events.length < 200) p.events.push(String(e.value))
    }
  } else if (method === 'Media.playerMessagesLogged' && Array.isArray(params.messages)) {
    for (const m of params.messages as unknown[]) {
      if (isRecord(m) && p.messages.length < 200)
        p.messages.push(`${String(m.level)}: ${String(m.message)}`)
    }
  } else if (method === 'Media.playerErrorsRaised' && Array.isArray(params.errors)) {
    p.errors.push(...(params.errors as unknown[]).slice(0, 50))
  }
}

interface MetricsSample {
  t: number
  /** Process type (Browser, GPU, Tab, Utility:<name>) → summed CPU % and working set (KB). */
  byType: Record<string, { cpu: number; workingSetKb: number; pids: number[] }>
}

function readMetrics(t: number): MetricsSample {
  const byType: MetricsSample['byType'] = {}
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Utility' ? `Utility:${m.serviceName ?? m.name ?? '?'}` : m.type
    const cur = byType[key] ?? { cpu: 0, workingSetKb: 0, pids: [] }
    cur.cpu += m.cpu.percentCPUUsage
    cur.workingSetKb += m.memory.workingSetSize
    cur.pids.push(m.pid)
    byType[key] = cur
  }
  return { t, byType }
}

/** Mean CPU % per process type over metrics taken after `fromT`. */
function meanCpu(samples: readonly MetricsSample[], fromT: number): Record<string, number> {
  const steady = samples.filter((s) => s.t >= fromT)
  const sums: Record<string, number> = {}
  for (const s of steady) {
    for (const [k, v] of Object.entries(s.byType)) sums[k] = (sums[k] ?? 0) + v.cpu
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(sums)) out[k] = Math.round((v / steady.length) * 10) / 10
  return out
}

async function attachMediaDebugger(wc: WebContents): Promise<void> {
  wc.debugger.attach('1.3')
  wc.debugger.on('message', (_event, method, params) => {
    onCdpMessage(method, params)
  })
  await wc.debugger.sendCommand('Media.enable')
}

async function run(): Promise<void> {
  // go2rtc's default WebSocket origin check only accepts same-host origins, and a file:// page
  // sends `Origin: file://`. Present the loopback origin for requests to go2rtc only, so go2rtc
  // can keep its strict default (no `origin: "*"`, which would let any web page connect).
  // The same hook adds go2rtc's Basic auth header, so the credential stays in main.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`ws://127.0.0.1:${String(port)}/*`, `${goOrigin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Origin: goOrigin,
          Authorization: go2rtcAuthHeader,
        },
      })
    },
  )
  // Never answer an auth challenge (from go2rtc or anything else) with a prompt or credentials.
  app.on('login', (event, _wc, _details, _authInfo, callback) => {
    event.preventDefault()
    callback()
  })
  // No permission prompts (camera/mic/notifications...): the spike needs none.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => {
    cb(false)
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    backgroundColor: '#0b0d10',
    title: 'View Protect – video spike',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Audio must start without a click for the unattended run.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event, url) => {
    if (url.split('?')[0] !== indexUrl) event.preventDefault()
  })
  wc.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning')
      console.log(`[page ${details.level}] ${details.message}`)
  })

  // The protocol needs a live renderer: load about:blank first, enable the Media domain, then
  // navigate to the page so the player's creation is captured from the start.
  console.log('loading about:blank')
  await wc.loadURL('about:blank')
  console.log('attaching debugger')
  await attachMediaDebugger(wc)
  console.log('loading page')
  const started = Date.now()
  await win.loadFile(indexPath, {
    query: { port: String(port), stream, trimKeep: trimKeepSec, bare },
  })
  console.log('page loaded')

  const samples: PlayerSample[] = []
  const metrics: MetricsSample[] = []
  readMetrics(0) // the first reading only primes percentCPUUsage

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const t = Date.now() - started
      void (async () => {
        try {
          const s = (await wc.executeJavaScript(
            'window.__vpSpike?.sample() ?? null',
          )) as PlayerSample | null
          if (s) samples.push(s)
        } catch {
          // page not ready yet
        }
        metrics.push(readMetrics(t))
        if (t >= durationMs) {
          clearInterval(timer)
          resolve()
        }
      })()
    }, 1000)
  })

  const probe: unknown = await wc
    .executeJavaScript('window.__vpSpike?.probe() ?? null')
    .catch((err: unknown) => ({ error: String(err) }))
  const shot = await wc.capturePage()
  const screenshot = outFile.replace(/\.json$/, '.png')
  await writeFile(screenshot, shot.toPNG())

  const summary = summarizeSamples(samples)
  const firstFrameSample = samples.find((s) => s.firstFrameMs !== null)
  // Process CPU from 5 s after the first frame (page time ≈ wall time since load).
  const steadyFrom = firstFrameSample ? firstFrameSample.t + 5000 : durationMs
  const players = Object.fromEntries(media)
  const result = {
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    stream,
    durationSec: durationMs / 1000,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuInfo: await app.getGPUInfo('basic').catch((err: unknown) => ({ error: String(err) })),
    summary,
    probe,
    media: players,
    cpuPercentByProcessType: meanCpu(metrics, steadyFrom),
    lastMetrics: metrics.at(-1) ?? null,
    samples,
  }
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`VP_SPIKE_DONE ${outFile}`)

  if (keepOpen && !win.isDestroyed()) {
    console.log('--keep-open: close the window to finish.')
    await new Promise<void>((resolve) =>
      win.once('closed', () => {
        resolve()
      }),
    )
  }
}

app.on('window-all-closed', () => {
  app.quit()
})

app
  .whenReady()
  .then(run)
  .then(() => {
    app.quit()
  })
  .catch((err: unknown) => {
    console.error('spike main failed:', err)
    app.exit(1)
  })
