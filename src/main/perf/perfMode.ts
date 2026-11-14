// P2.5 perf harness: the Electron glue. Started from `src/main/index.ts` only when
// `parsePerfEnv` says perf mode is on (VP_PERF_QUALITY set, unpackaged build), normally by
// `npm run perf` (scripts/perf/run.ts). Everything that can be computed without Electron lives in
// `perfStats.ts`; this file only drives the window and reads the OS.
//
// What a run does:
//  1. Waits for the renderer, attaches the in-process CDP debugger (no remote port) and enables
//     the Media domain, which reports each player's decoder (NFR-3).
//  2. Connects to the console — `npm run perf` is the deliberate user action CON-4 asks for — and
//     waits for the camera list.
//  3. Opens the Live screen and picks the temp-grid preset by clicking the existing buttons by
//     their visible text, so no renderer code exists for the harness. The grid quality comes from
//     the in-memory settings override (`withPerfGridQuality`, wired in index.ts).
//  4. Waits out the warm-up, then samples every interval: CPU and RSS per process role (`ps`
//     CPU-time deltas, 100 = one core), go2rtc by pid, macOS GPU utilisation (`ioreg`), and every
//     `<video>`'s playback counters (`PAGE_STATS_SCRIPT`).
//  5. Writes `samples.jsonl`, `summary.json` and `summary.md` to the output dir, stops go2rtc and
//     quits. A closed window or a signal ends the run early with what it has.
//
// Secrets (CON-2, NFR-9): nothing recorded or logged here contains a URL, host, port, key or
// camera name. Errors from the connect are reduced to their kind, because a message can carry the
// console's address.
import { execFile } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, powerSaveBlocker, type BrowserWindow, type WebContents } from 'electron'
import { asBool } from './measure'
import {
  CellStatsSchema,
  choosePerfPreset,
  KEPT_MEDIA_PROPERTIES,
  metricTypeRole,
  notPlayingCells,
  PAGE_STATS_SCRIPT,
  parseIoregDeviceUtilization,
  parsePsResourceRows,
  renderSummaryMarkdown,
  rolesFromReadings,
  summarizeDecoders,
  summarizePerf,
  sumRoles,
  type CellStat,
  type PerfConfig,
  type PerfEndReason,
  type PerfPreset,
  type PerfSample,
  type ProcReading,
  type PsResourceRow,
} from './perfStats'

const execFileAsync = promisify(execFile)

export interface PerfRunDeps {
  readonly config: PerfConfig
  readonly window: BrowserWindow
  /** `ConnectionManager.connect()`: loads the inventory and opens the devices feed. */
  readonly connect: () => Promise<void>
  readonly cameraCount: () => number
  /** go2rtc's pid while it is up (`Go2rtcManager.pid()`). */
  readonly go2rtcPid: () => number | null
  /** Stops go2rtc and waits for it, so a finished run leaves no process behind. */
  readonly stopStreaming: () => Promise<void>
}

const STEP_TIMEOUT_MS = 30_000
const POLL_MS = 250

function log(line: string): void {
  console.log(`[perf] ${line}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** An error reduced to something safe to log: its `kind` (Protect/Access errors) or class name. */
function errorKind(err: unknown): string {
  if (err instanceof Error) {
    const kind = (err as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : err.name
  }
  return 'unknown'
}

function osName(): string {
  const v = process.getSystemVersion()
  if (process.platform === 'darwin') return `macOS ${v}`
  if (process.platform === 'win32') return `Windows ${v}`
  return `${process.platform} ${v}`
}

/** `ps` for a pid list. Exit status 1 just means some pid is gone; its stdout is still good. */
async function psRows(pids: readonly number[]): Promise<PsResourceRow[] | null> {
  if (process.platform === 'win32' || pids.length === 0) return null
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')], {
      timeout: 5000,
    })
    return parsePsResourceRows(stdout)
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    return typeof stdout === 'string' ? parsePsResourceRows(stdout) : null
  }
}

/** macOS only; null elsewhere or when ioreg has no IOAccelerator statistics. */
async function gpuUtilization(): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], {
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseIoregDeviceUtilization(stdout)
  } catch {
    return null
  }
}

/**
 * Every process's reading, and `at`: the moment the CPU times were read (the midpoint of the `ps`
 * call), so the CPU delta's denominator is the time between two `ps` reads and nothing else.
 */
async function readProcesses(
  go2rtcPid: number | null,
): Promise<{ readings: ProcReading[]; at: number }> {
  const metrics = app.getAppMetrics()
  const pids = metrics.map((m) => m.pid)
  if (go2rtcPid !== null) pids.push(go2rtcPid)
  const before = performance.now()
  const ps = await psRows(pids)
  const at = (before + performance.now()) / 2
  const byPid = new Map((ps ?? []).map((r) => [r.pid, r]))
  const readings: ProcReading[] = metrics.map((m) => {
    const row = byPid.get(m.pid)
    return {
      pid: m.pid,
      role: metricTypeRole(m.type),
      cpuSec: row?.cpuSec ?? null,
      rssKb: row?.rssKb ?? null,
      appMetricsCpu: m.cpu.percentCPUUsage,
      workingSetKb: m.memory.workingSetSize,
    }
  })
  if (go2rtcPid !== null) {
    const row = byPid.get(go2rtcPid)
    // Windows: no ps, and go2rtc is not an Electron process, so it is "not measured" (null).
    readings.push({
      pid: go2rtcPid,
      role: 'go2rtc',
      cpuSec: row?.cpuSec ?? null,
      rssKb: row?.rssKb ?? null,
      appMetricsCpu: null,
      workingSetKb: null,
    })
  }
  return { readings, at }
}

/**
 * The grid's playback counters, or a reason they could not be read. A failure is recorded as such
 * (and counted as every stream not playing), never as an empty — healthy-looking — grid.
 */
async function readCells(
  wc: WebContents,
): Promise<{ cells: CellStat[]; error: null } | { cells: null; error: string }> {
  if (wc.isDestroyed()) return { cells: null, error: 'window-destroyed' }
  if (wc.isCrashed()) return { cells: null, error: 'renderer-gone' }
  try {
    const raw: unknown = await wc.executeJavaScript(PAGE_STATS_SCRIPT, true)
    const parsed = CellStatsSchema.safeParse(raw)
    return parsed.success
      ? { cells: parsed.data, error: null }
      : { cells: null, error: 'invalid-shape' }
  } catch (err) {
    return { cells: null, error: `script-failed:${errorKind(err)}` }
  }
}

/** Chromium net error for a load that was aborted (superseded by another navigation). */
const ERR_ABORTED = -3

/** Resolves once the page has loaded; rejects on a failed load or after {@link STEP_TIMEOUT_MS}. */
function pageLoaded(wc: WebContents): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const done = (err: Error | null): void => {
      clearTimeout(timer)
      wc.off('did-finish-load', onLoad)
      wc.off('did-fail-load', onFail)
      if (err === null) resolve()
      else reject(err)
    }
    const onLoad = (): void => {
      done(null)
    }
    const onFail = (_event: unknown, code: number): void => {
      if (code !== ERR_ABORTED)
        done(new Error(`the renderer failed to load (net error ${String(code)})`))
    }
    const timer = setTimeout(() => {
      done(new Error(`the renderer did not load within ${String(STEP_TIMEOUT_MS / 1000)} s`))
    }, STEP_TIMEOUT_MS)
    wc.on('did-finish-load', onLoad)
    wc.on('did-fail-load', onFail)
  })
}

/** Runs `script` in the page until it returns true, or gives up after {@link STEP_TIMEOUT_MS}. */
async function untilPage(wc: WebContents, script: string): Promise<boolean> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false
    try {
      if ((await wc.executeJavaScript(script, true)) === true) return true
    } catch {
      // The page may be mid-load; try again.
    }
    await sleep(POLL_MS)
  }
  return false
}

/** Clicks the button with this exact text inside `scope` (a CSS selector). True once clicked. */
function clickButtonScript(scope: string, text: string, pressedAttr: string | null): string {
  return `(() => {
  const root = document.querySelector(${JSON.stringify(scope)});
  if (root === null) return false;
  const b = Array.from(root.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)});
  if (b === undefined) return false;
  ${pressedAttr === null ? 'b.click(); return true;' : `if (b.getAttribute(${JSON.stringify(pressedAttr)}) === 'true') return true; b.click(); return false;`}
})()`
}

async function untilTrue(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(POLL_MS)
  }
  return false
}

export function startPerfRun(deps: PerfRunDeps): void {
  const { config, window: win } = deps
  const wc = win.webContents
  const startedAt = new Date().toISOString()
  const samplesPath = join(config.outDir, 'samples.jsonl')
  const players = new Map<string, Record<string, unknown>>()
  const samples: PerfSample[] = []
  const cores = os.availableParallelism()
  const [width, height] = win.getContentSize()
  let cameras = 0
  let preset: PerfPreset = choosePerfPreset(0)
  let finished = false
  /** A function, so TypeScript does not narrow `finished` across the awaits in `run`. */
  const isFinished = (): boolean => finished
  let stopTimer: (() => void) | null = null
  /** Set once the results are written and go2rtc is stopped: only then may the app quit. */
  let quitAllowed = false
  const blocker = powerSaveBlocker.start('prevent-display-sleep')

  log(
    `quality ${config.quality}, warm-up ${String(config.warmupS)} s, duration ${String(config.durationS)} s, interval ${String(config.intervalS)} s`,
  )

  const finish = async (reason: PerfEndReason, note: string | null): Promise<void> => {
    if (finished) return
    finished = true
    stopTimer?.()
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
    try {
      const gpu = app.getGPUFeatureStatus().video_decode
      const summary = summarizePerf(
        {
          quality: config.quality,
          label: config.label,
          os: osName(),
          arch: process.arch,
          cpuModel: os.cpus()[0]?.model.trim() ?? 'unknown CPU',
          cores,
          totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          startedAt,
          warmupS: config.warmupS,
          durationS: config.durationS,
          intervalS: config.intervalS,
          cameras,
          preset: preset.label,
          expectedStreams: preset.streams,
          windowSize: `${String(width)}×${String(height)}`,
          endReason: reason,
          endNote: note,
        },
        samples,
        summarizeDecoders(players, gpu, asBool),
      )
      await writeFile(join(config.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      await writeFile(join(config.outDir, 'summary.md'), renderSummaryMarkdown(summary))
      log(
        `finished (${reason}${note === null ? '' : `: ${note}`}); ${String(samples.length)} samples written`,
      )
    } catch (err) {
      console.error(`[perf] could not write the summary (${errorKind(err)})`)
    }
    // The window goes first: a live player whose socket closes asks `ensureStream` again, which
    // would start a fresh go2rtc behind the stop below and leave it running after the quit.
    if (!win.isDestroyed()) win.destroy()
    try {
      await deps.stopStreaming()
    } catch (err) {
      console.error(`[perf] go2rtc stop failed (${errorKind(err)})`)
    }
    quitAllowed = true
    app.quit()
  }

  win.once('closed', () => {
    void finish('window-closed', 'the window was closed before the end')
  })
  // A quit from elsewhere (Cmd+Q, the menu, the OS) waits for the results: hold it, finish, and
  // let `finish` quit again. index.ts also skips its `window-all-closed` quit during a run.
  app.on('before-quit', (event) => {
    if (quitAllowed) return
    event.preventDefault()
    void finish('quit', 'the app was asked to quit before the end')
  })
  wc.on('render-process-gone', (_event, details) => {
    void finish('renderer-gone', `the renderer process is gone (${details.reason})`)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void finish('signal', signal)
    })
  }

  const fail = (note: string): void => {
    console.error(`[perf] ${note}`)
    void finish('error', note)
  }

  const run = async (): Promise<void> => {
    await mkdir(config.outDir, { recursive: true })
    await writeFile(samplesPath, '')

    try {
      await pageLoaded(wc)
    } catch (err) {
      fail(err instanceof Error ? err.message : 'the renderer did not load')
      return
    }
    if (isFinished()) return
    // Perf numbers from a throttled background page would be meaningless.
    wc.setBackgroundThrottling(false)

    try {
      wc.debugger.attach('1.3')
      wc.debugger.on('message', (_event, method, params: unknown) => {
        if (method !== 'Media.playerPropertiesChanged') return
        const p = params as { playerId?: unknown; properties?: unknown }
        if (typeof p.playerId !== 'string' || !Array.isArray(p.properties)) return
        const props = players.get(p.playerId) ?? {}
        for (const prop of p.properties as { name?: unknown; value?: unknown }[]) {
          if (typeof prop.name === 'string' && KEPT_MEDIA_PROPERTIES.has(prop.name)) {
            props[prop.name] = prop.value
          }
        }
        players.set(p.playerId, props)
      })
      await wc.debugger.sendCommand('Media.enable')
    } catch (err) {
      // Decoder facts are then "unknown" in the summary; the rest of the run is still useful.
      log(`CDP Media domain unavailable (${errorKind(err)}); decoders will be unknown`)
    }

    try {
      await deps.connect()
    } catch (err) {
      fail(`connecting to the console failed (${errorKind(err)}); check Settings in a normal run`)
      return
    }
    if (!(await untilTrue(() => deps.cameraCount() > 0))) {
      fail('the console reported no cameras')
      return
    }
    cameras = deps.cameraCount()
    preset = choosePerfPreset(cameras)
    log(
      `${String(cameras)} camera(s); temp grid ${preset.label}, ${String(preset.streams)} stream(s)`,
    )

    if (!(await untilPage(wc, clickButtonScript('nav.app__nav', 'Live', null)))) {
      fail('could not open the Live screen')
      return
    }
    const presetScript = clickButtonScript(
      '[role="toolbar"][aria-label="Grid size"]',
      preset.label,
      'aria-pressed',
    )
    if (!(await untilPage(wc, presetScript))) {
      fail(`could not select the ${preset.label} preset`)
      return
    }
    log(`grid open; warming up for ${String(config.warmupS)} s`)
    await sleep(config.warmupS * 1000)
    if (isFinished()) return

    // Baseline for the first CPU delta, timed at its own ps read.
    const baseline = await readProcesses(deps.go2rtcPid())
    let prevAt = baseline.at
    let prevCpu = new Map(
      baseline.readings.flatMap((r) => (r.cpuSec === null ? [] : [[r.pid, r.cpuSec] as const])),
    )
    const measureStart = baseline.at
    let prevCells: CellStat[] | null = null
    log('measuring')

    const tick = async (): Promise<void> => {
      const [{ readings, at }, gpuPercent, { cells, error }] = await Promise.all([
        readProcesses(deps.go2rtcPid()),
        gpuUtilization(),
        readCells(wc),
      ])
      const { cpu, rssMb } = rolesFromReadings(prevCpu, readings, at - prevAt, cores)
      prevAt = at
      prevCpu = new Map(
        readings.flatMap((r) => (r.cpuSec === null ? [] : [[r.pid, r.cpuSec] as const])),
      )
      const sample: PerfSample = {
        t: Math.round((at - measureStart) / 100) / 10,
        cpu,
        cpuTotal: sumRoles(cpu),
        rssMb,
        rssTotalMb: sumRoles(rssMb),
        gpuPercent,
        cells,
        cellsError: error,
        notPlaying: notPlayingCells(prevCells, cells, preset.streams),
      }
      if (cells !== null) prevCells = cells
      if (isFinished()) return
      samples.push(sample)
      await appendFile(samplesPath, `${JSON.stringify(sample)}\n`)
    }

    // Scheduled against the start time, so a slow tick does not shift every later one.
    await new Promise<void>((resolve) => {
      let k = 1
      let timer: NodeJS.Timeout | null = null
      stopTimer = () => {
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      const schedule = (): void => {
        const due = measureStart + k * config.intervalS * 1000
        timer = setTimeout(
          () => {
            void tick()
              .catch((err: unknown) => {
                log(`sample failed (${errorKind(err)})`)
              })
              .then(() => {
                if (isFinished()) return
                if (k * config.intervalS >= config.durationS) {
                  resolve()
                  return
                }
                k++
                schedule()
              })
          },
          Math.max(0, due - performance.now()),
        )
      }
      schedule()
    })
    await finish('completed', null)
  }

  void run().catch((err: unknown) => {
    fail(`the run stopped (${errorKind(err)})`)
  })
}
