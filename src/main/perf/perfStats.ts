// P2.5 perf harness: the pure half. Env parsing, the in-memory settings override and the View it
// shows (since P3.2 an in-memory View of the sizes the P2.4 temp grid offered), the sample shapes,
// parsers for `ps` and `ioreg`, per-role CPU/RAM, the run summary (mean / p95 / max, memory-growth
// slope, dropped frames, cells not playing, decoders) and its markdown. No Electron import, so all of it is unit-tested in plain
// Node (tests/unit/perfStats.test.ts); `perfMode.ts` is the Electron glue around it.
//
// Units: CPU is percent of **one core** (100 = one core, as in docs/spikes/P0.5-video.md), memory
// is MB (1 MB = 1024 × 1024 bytes), time is seconds since the end of the warm-up.
//
// Secrets (CON-2, NFR-9): nothing in here takes or produces a URL, host, port, key or camera name.
// Cells are identified by their grid position only. `buildPerfView` takes camera ids — the renderer
// already has them — and they go only into the View the renderer is shown, never into a result.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { ViewSchema, type Settings, type View } from '@shared/models'
import { QualitySchema, type Quality } from '@shared/quality'
import { assignCameras, uniformCells } from '@shared/viewLayout'
import { cpuPercent } from './measure'
import {
  PERF_DEFAULTS,
  PERF_ENV,
  PERF_MINIMUMS,
  parseSeconds,
  timingProblem,
  type PerfEndReason,
  type SecondsResult,
} from './perfEnv'

// ---------------------------------------------------------------------------------------------
// Env

export { PERF_DEFAULTS, PERF_ENV } from './perfEnv'

export interface PerfConfig {
  readonly quality: Quality
  /** Measured time, after the warm-up. */
  readonly durationS: number
  readonly warmupS: number
  readonly intervalS: number
  /** Absolute directory the results are written to. */
  readonly outDir: string
  /** Free text for the results table, or null. Sanitised: no `|`, no newlines, ≤ 80 chars. */
  readonly label: string | null
}

export type PerfEnvResult =
  | { readonly kind: 'off' }
  /** Set, but a packaged build never enters perf mode. */
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'on'; readonly config: PerfConfig }

export function sanitizeLabel(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const clean = raw
    .replace(/[\r\n|`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return clean === '' ? null : clean
}

/**
 * Perf mode is on only when `VP_PERF_QUALITY` is set **and** the app is not packaged: a shipped
 * build ignores the variables entirely, so nobody can put an installed app into a mode that
 * overrides its settings and quits on a timer.
 */
export function parsePerfEnv(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): PerfEnvResult {
  const q = env[PERF_ENV.quality]
  if (q === undefined || q === '') return { kind: 'off' }
  if (isPackaged)
    return { kind: 'ignored', reason: `${PERF_ENV.quality} is ignored in a packaged build` }
  const quality = QualitySchema.safeParse(q)
  if (!quality.success) {
    return {
      kind: 'invalid',
      problem: `${PERF_ENV.quality} must be low, medium or high (got "${q}")`,
    }
  }
  const seconds = (key: 'durationS' | 'warmupS' | 'intervalS'): SecondsResult =>
    parseSeconds(PERF_ENV[key], env[PERF_ENV[key]], PERF_MINIMUMS[key], PERF_DEFAULTS[key])
  const durationS = seconds('durationS')
  const warmupS = seconds('warmupS')
  const intervalS = seconds('intervalS')
  if (!durationS.ok) return { kind: 'invalid', problem: durationS.problem }
  if (!warmupS.ok) return { kind: 'invalid', problem: warmupS.problem }
  if (!intervalS.ok) return { kind: 'invalid', problem: intervalS.problem }
  const timing = timingProblem(durationS.value, intervalS.value, {
    duration: PERF_ENV.durationS,
    interval: PERF_ENV.intervalS,
  })
  if (timing !== null) return { kind: 'invalid', problem: timing }
  const outDir = env[PERF_ENV.outDir] ?? ''
  if (outDir === '' || !isAbsolute(outDir)) {
    return { kind: 'invalid', problem: `${PERF_ENV.outDir} must be an absolute directory path` }
  }
  return {
    kind: 'on',
    config: {
      quality: quality.data,
      durationS: durationS.value,
      warmupS: warmupS.value,
      intervalS: intervalS.value,
      outDir,
      label: sanitizeLabel(env[PERF_ENV.label]),
    },
  }
}

/**
 * The settings the renderer sees during a perf run: the stored ones with the grid default replaced
 * by the run's quality. A copy — main's own config object is never touched, so nothing that saves
 * `services.current` (a console change, an accepted pin) can persist the override.
 */
export function withPerfGridQuality(settings: Settings, quality: Quality): Settings {
  return { ...settings, streams: { ...settings.streams, defaultGridQuality: quality } }
}

// ---------------------------------------------------------------------------------------------
// The perf View

/** NFR-2's grid stream count. */
export const PERF_TARGET_STREAMS = 10

/** The perf View's id. Never stored: it exists only in the settings the renderer is shown. */
export const PERF_VIEW_ID = 'perf'

/**
 * The grid sizes the harness chooses from, smallest first. They are the two sizes the P2.4 temp
 * grid offered, kept here as the harness's own constant rather than taken from the layout presets:
 * 3×3 is nine streams and 4×3 twelve, which brackets NFR-2's ten, and keeping exactly these sizes
 * is what keeps new runs comparable with the ones already in docs/perf-results.md.
 */
export const PERF_GRID_SIZES: readonly { readonly cols: number; readonly rows: number }[] = [
  { cols: 3, rows: 3 },
  { cols: 4, rows: 3 },
]

export interface PerfPreset {
  /** The grid size, e.g. `3×3`: the summary's and the results table's "preset". */
  readonly label: string
  readonly slots: number
  /** How many streams the View shows: one per camera, up to `slots`. */
  readonly streams: number
}

export interface PerfView extends PerfPreset {
  readonly view: View
}

/**
 * The View a perf run shows. Its size is the smallest of {@link PERF_GRID_SIZES} with room for
 * `min(cameras, 10)` streams, else the largest — so nine cameras give 3×3 and nine streams, ten or
 * eleven give 4×3 and that many, twelve or more give 4×3 and twelve. Every cell is 1×1 and the
 * first N cameras of `cameraIds` fill them in canonical (row, then column) order, one camera per
 * cell, the rest left empty; pass the ids in list order (`sortCameras`), which is the order the
 * temp grid used, so the same cameras are measured as before.
 *
 * Parsed through `ViewSchema`, so every default (aspect, gap, fit, inherited quality) is the one a
 * new View gets and the tiling check runs: a broken perf View fails here, not as a blank grid.
 */
export function buildPerfView(cameraIds: readonly string[]): PerfView {
  const want = Math.min(cameraIds.length, PERF_TARGET_STREAMS)
  // PERF_GRID_SIZES is declared smallest first (a test holds it to that), so no sort here.
  const size = PERF_GRID_SIZES.find((s) => s.cols * s.rows >= want) ??
    PERF_GRID_SIZES.at(-1) ?? { cols: 1, rows: 1 }
  const slots = size.cols * size.rows
  const cells = assignCameras(uniformCells(size.cols, size.rows), cameraIds)
  const view = ViewSchema.parse({
    id: PERF_VIEW_ID,
    name: 'Perf',
    cols: size.cols,
    rows: size.rows,
    cells,
  })
  return {
    view,
    label: `${String(size.cols)}×${String(size.rows)}`,
    slots,
    streams: Math.min(cameraIds.length, slots),
  }
}

/**
 * The settings the renderer is shown with the perf View in place: `views` is **only** that View and
 * `lastViewId` points at it, so the Live screen opens on it with nothing to click. The user's own
 * Views are hidden for the run rather than kept beside it, so the active View is unambiguous: with
 * them in the list, the switcher's fallback rules or a stray keyboard shortcut (1–9) could leave
 * another View active, and the run would measure a grid nobody chose. A copy, like
 * {@link withPerfGridQuality}: the stored config is not touched here. That alone would not keep the
 * perf View out of the file — a `setViews` from the renderer would store the list it was shown,
 * `[perf]`, over the user's Views — so main also refuses every View write while a perf View is set
 * (`viewWritesBlocked` in src/main/ipc/handlers.ts, wired in index.ts). `null` (no View built yet)
 * returns `settings` unchanged.
 */
export function withPerfView(settings: Settings, view: View | null): Settings {
  if (view === null) return settings
  return { ...settings, views: [view], lastViewId: view.id }
}

// ---------------------------------------------------------------------------------------------
// Processes

export const PROCESS_ROLES = ['main', 'renderer', 'gpu', 'utility', 'go2rtc'] as const
export type ProcessRole = (typeof PROCESS_ROLES)[number]

/** `app.getAppMetrics()[].type` → role. */
export function metricTypeRole(type: string): Exclude<ProcessRole, 'go2rtc'> {
  if (type === 'Browser') return 'main'
  if (type === 'Tab') return 'renderer'
  if (type === 'GPU') return 'gpu'
  return 'utility'
}

export { parsePsResourceRows, type PsResourceRow } from './measure'

/**
 * macOS GPU utilisation from `ioreg -r -d 1 -c IOAccelerator`: the `"Device Utilization %"` in
 * each accelerator's `PerformanceStatistics`. The highest one if there are several, null if none.
 */
export function parseIoregDeviceUtilization(text: string): number | null {
  let best: number | null = null
  for (const m of text.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) best = best === null ? v : Math.max(best, v)
  }
  return best
}

/** One process at one instant. */
export interface ProcReading {
  readonly pid: number
  readonly role: ProcessRole
  /** Cumulative CPU seconds from `ps`, or null where `ps` is unavailable (Windows). */
  readonly cpuSec: number | null
  /** RSS from `ps`, or null. */
  readonly rssKb: number | null
  /** Electron's machine-normalized `percentCPUUsage`, or null (go2rtc has none). */
  readonly appMetricsCpu: number | null
  /** Electron's `memory.workingSetSize` (KB), or null. */
  readonly workingSetKb: number | null
}

export type RoleValues = Record<ProcessRole, number | null>

function emptyRoles(): RoleValues {
  return { main: null, renderer: null, gpu: null, utility: null, go2rtc: null }
}

function addRole(out: RoleValues, role: ProcessRole, v: number | null): void {
  if (v === null) return
  out[role] = (out[role] ?? 0) + v
}

function round(v: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/**
 * CPU (100 = one core) and RSS (MB) per role. CPU comes from the `ps` CPU-time delta against the
 * previous reading of the same pid; a process with no previous reading (just started) counts 0. A
 * process without `ps` data falls back to Electron's normalized figure × `cores`.
 */
export function rolesFromReadings(
  prevCpuSec: ReadonlyMap<number, number>,
  cur: readonly ProcReading[],
  wallMs: number,
  cores: number,
): { cpu: RoleValues; rssMb: RoleValues } {
  const cpu = emptyRoles()
  const rssMb = emptyRoles()
  for (const r of cur) {
    let c: number | null = null
    if (r.cpuSec !== null) {
      const before = prevCpuSec.get(r.pid)
      c = before === undefined ? 0 : cpuPercent(before, r.cpuSec, wallMs)
    } else if (r.appMetricsCpu !== null) {
      c = r.appMetricsCpu * cores
    }
    addRole(cpu, r.role, c)
    const kb = r.rssKb ?? r.workingSetKb
    addRole(rssMb, r.role, kb === null ? null : kb / 1024)
  }
  for (const role of PROCESS_ROLES) {
    const c = cpu[role]
    const m = rssMb[role]
    if (c !== null) cpu[role] = round(c)
    if (m !== null) rssMb[role] = round(m)
  }
  return { cpu, rssMb }
}

export function sumRoles(v: RoleValues): number {
  return round(PROCESS_ROLES.reduce((acc, r) => acc + (v[r] ?? 0), 0))
}

// ---------------------------------------------------------------------------------------------
// Videos

export const VideoStatSchema = z.object({
  /**
   * Identity of the `<video>` element, stable across samples and unique across a page reload (the
   * script hands out ids from a WeakMap seeded with the time). Counters are per element, so this is
   * what lets a replaced element (reconnect, quality swap) be told apart from a counter reset.
   */
  id: z.number().int().nonnegative(),
  bufferedEnd: z.number().nullable(),
  currentTime: z.number(),
  playbackRate: z.number(),
  totalFrames: z.number(),
  droppedFrames: z.number(),
  width: z.number(),
  height: z.number(),
  readyState: z.number(),
  paused: z.boolean(),
})
export type VideoStat = z.infer<typeof VideoStatSchema>

/** One grid cell: its position, whether it is an empty slot, and every `<video>` in it. */
export const CellStatSchema = z.object({
  cell: z.number().int().nonnegative(),
  empty: z.boolean(),
  videos: z.array(VideoStatSchema).max(8),
})
export type CellStat = z.infer<typeof CellStatSchema>

export const CellStatsSchema = z.array(CellStatSchema).max(64)

/**
 * The page script `perfMode.ts` runs with `executeJavaScript`. Reads only playback counters and
 * geometry — never `src`, a URL or a camera name. The element ids live in a WeakMap on `window`,
 * so the DOM is not touched.
 */
export const PAGE_STATS_SCRIPT = `(() => {
  const w = window;
  if (w.__vpPerf === undefined) w.__vpPerf = { ids: new WeakMap(), next: Date.now() * 1000 };
  const reg = w.__vpPerf;
  const idOf = (v) => {
    let id = reg.ids.get(v);
    if (id === undefined) { id = reg.next++; reg.ids.set(v, id); }
    return id;
  };
  return Array.from(document.querySelectorAll('.gridView .gridCell')).map((cell, i) => ({
    cell: i,
    empty: cell.classList.contains('gridCell--empty'),
    videos: Array.from(cell.querySelectorAll('video')).slice(0, 8).map((v) => {
      const q = v.getVideoPlaybackQuality();
      const b = v.buffered;
      return {
        id: idOf(v),
        bufferedEnd: b.length > 0 ? b.end(b.length - 1) : null,
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
        totalFrames: q.totalVideoFrames,
        droppedFrames: q.droppedVideoFrames,
        width: v.videoWidth,
        height: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
      };
    }),
  }));
})()`

/** `buffered.end − currentTime` in seconds: the player's buffer lag (the NFR-5 proxy). */
export function bufferLag(v: VideoStat): number | null {
  if (v.bufferedEnd === null) return null
  return Math.max(0, v.bufferedEnd - v.currentTime)
}

/** HAVE_CURRENT_DATA: there is a frame to show. */
const HAVE_CURRENT_DATA = 2

function framesById(cells: readonly CellStat[]): Map<number, number> {
  return new Map(cells.flatMap((c) => c.videos.map((v) => [v.id, v.totalFrames] as const)))
}

/**
 * Camera cells that are not playing. A cell plays when one of its `<video>` elements is unpaused,
 * has a frame and — compared with **the same element** in the previous sample — decoded new
 * frames (an element that is new since then counts if it has frames at all). With no previous
 * sample, progress is not required.
 *
 * `cur === null` (the page could not be read) counts every expected stream as not playing, and so
 * do camera cells that are missing: a crashed renderer or a page that left the grid must not look
 * healthy.
 */
export function notPlayingCells(
  prev: readonly CellStat[] | null,
  cur: readonly CellStat[] | null,
  expectedStreams: number,
): number {
  if (cur === null) return expectedStreams
  const before = prev === null ? null : framesById(prev)
  const cameraCells = cur.filter((c) => !c.empty)
  let n = Math.max(0, expectedStreams - cameraCells.length)
  for (const c of cameraCells) {
    const playing = c.videos.some((v) => {
      if (v.paused || v.readyState < HAVE_CURRENT_DATA || v.totalFrames <= 0) return false
      if (before === null) return true
      const was = before.get(v.id)
      return was === undefined || v.totalFrames > was
    })
    if (!playing) n++
  }
  return n
}

/**
 * Dropped frames as a percentage of decoded frames over a run, summed per `<video>` element:
 * each element contributes the growth of its own counters between the samples it appears in.
 * Elements already present in the first readable sample start from that reading (their earlier
 * frames belong to the warm-up); an element that appears later was created after the previous
 * reading, so all its frames count. Unreadable samples (`null`) are skipped.
 */
export function droppedPercentOver(
  samples: readonly (readonly CellStat[] | null)[],
): number | null {
  const last = new Map<number, { total: number; dropped: number }>()
  let baseline = true
  let total = 0
  let dropped = 0
  for (const cells of samples) {
    if (cells === null) continue
    for (const c of cells) {
      if (c.empty) continue
      for (const v of c.videos) {
        const prev = last.get(v.id)
        if (prev !== undefined) {
          total += Math.max(0, v.totalFrames - prev.total)
          dropped += Math.max(0, v.droppedFrames - prev.dropped)
        } else if (!baseline) {
          total += v.totalFrames
          dropped += v.droppedFrames
        }
        last.set(v.id, { total: v.totalFrames, dropped: v.droppedFrames })
      }
    }
    baseline = false
  }
  return total > 0 ? round((dropped / total) * 100, 2) : null
}

// ---------------------------------------------------------------------------------------------
// Samples and summary

export interface PerfSample {
  /** Seconds since the end of the warm-up. */
  readonly t: number
  readonly cpu: RoleValues
  readonly cpuTotal: number
  readonly rssMb: RoleValues
  readonly rssTotalMb: number
  /** macOS IOAccelerator "Device Utilization %", or null where not measured. */
  readonly gpuPercent: number | null
  /** Null when the page could not be read (renderer gone, script failed, unexpected shape). */
  readonly cells: readonly CellStat[] | null
  /** Why `cells` is null: an error kind or `invalid-shape`, never a message. */
  readonly cellsError: string | null
  readonly notPlaying: number
}

export interface Stat {
  readonly mean: number
  readonly p95: number
  readonly max: number
  readonly n: number
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)] ?? null
}

export function stat(values: readonly (number | null)[], digits = 1): Stat | null {
  const v = values
    .filter((x): x is number => x !== null && Number.isFinite(x))
    .sort((a, b) => a - b)
  if (v.length === 0) return null
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  return {
    mean: round(mean, digits),
    p95: round(percentile(v, 95) ?? 0, digits),
    max: round(v[v.length - 1] ?? 0, digits),
    n: v.length,
  }
}

/**
 * Least-squares slope of `y` against `t` (seconds), scaled to units per hour. Null with fewer than
 * two points or no spread in `t`. G2 wants "no memory growth" over 30 minutes; this is the number.
 */
export function slopePerHour(points: readonly { t: number; y: number }[]): number | null {
  const n = points.length
  if (n < 2) return null
  const mt = points.reduce((a, p) => a + p.t, 0) / n
  const my = points.reduce((a, p) => a + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - mt) * (p.y - my)
    den += (p.t - mt) ** 2
  }
  if (den === 0) return null
  return round((num / den) * 3600, 1)
}

export interface DecoderSummary {
  /** Media players Chromium reported (a reconnect or a quality swap creates a new one). */
  readonly players: number
  /** `kVideoDecoderName` → number of players. */
  readonly videoDecoders: Record<string, number>
  /** `kIsPlatformVideoDecoder` (a string in CDP; parsed). */
  readonly platformDecoder: { readonly yes: number; readonly no: number; readonly unknown: number }
  /** `app.getGPUFeatureStatus().video_decode`. */
  readonly gpuVideoDecode: string | null
}

/** CDP Media properties kept per player; everything else (e.g. `kFrameUrl`, a local path) is dropped. */
export const KEPT_MEDIA_PROPERTIES = new Set([
  'kVideoDecoderName',
  'kIsPlatformVideoDecoder',
  'kAudioDecoderName',
])

export function summarizeDecoders(
  players: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  gpuVideoDecode: string | null,
  parseBool: (v: unknown) => boolean | undefined,
): DecoderSummary {
  const videoDecoders: Record<string, number> = {}
  const platformDecoder = { yes: 0, no: 0, unknown: 0 }
  for (const props of players.values()) {
    const name = props.kVideoDecoderName
    if (typeof name === 'string' && name !== '')
      videoDecoders[name] = (videoDecoders[name] ?? 0) + 1
    const b = parseBool(props.kIsPlatformVideoDecoder)
    if (b === true) platformDecoder.yes++
    else if (b === false) platformDecoder.no++
    else platformDecoder.unknown++
  }
  return { players: players.size, videoDecoders, platformDecoder, gpuVideoDecode }
}

export { isFailedRun, type PerfEndReason } from './perfEnv'

export interface PerfRunInfo {
  readonly quality: Quality
  readonly label: string | null
  /** e.g. `macOS 27.0.1` / `Windows 10.0.26100`. */
  readonly os: string
  readonly arch: string
  readonly cpuModel: string
  readonly cores: number
  readonly totalMemGb: number
  readonly electron: string
  readonly chrome: string
  readonly startedAt: string
  readonly warmupS: number
  readonly durationS: number
  readonly intervalS: number
  readonly cameras: number
  readonly preset: string
  readonly expectedStreams: number
  /** Window content size, e.g. `1280×800`: the cell size drives compositing cost. */
  readonly windowSize: string
  readonly endReason: PerfEndReason
  /** A safe, generic note on why the run ended early (never an error message from the network). */
  readonly endNote: string | null
}

export interface PerfSummary {
  readonly run: PerfRunInfo
  readonly samples: number
  /** Seconds actually measured (last sample's `t`). */
  readonly measuredS: number
  /** Most `<video>` elements in camera cells seen in one sample. */
  readonly maxVideos: number
  readonly cpu: Record<ProcessRole | 'total', Stat | null>
  readonly rssMb: Record<ProcessRole | 'total', Stat | null>
  readonly rssGrowthMbPerHour: number | null
  readonly gpuPercent: Stat | null
  readonly bufferLagS: Stat | null
  readonly playbackRate: Stat | null
  readonly droppedPercent: number | null
  readonly notPlaying: { readonly maxCells: number; readonly samplesWithAny: number }
  /** Samples whose page read failed, by reason (they count as all-not-playing). */
  readonly cellReadFailures: { readonly count: number; readonly reasons: Record<string, number> }
  readonly decoders: DecoderSummary
}

export function summarizePerf(
  run: PerfRunInfo,
  samples: readonly PerfSample[],
  decoders: DecoderSummary,
): PerfSummary {
  const cpu = {} as Record<ProcessRole | 'total', Stat | null>
  const rssMb = {} as Record<ProcessRole | 'total', Stat | null>
  for (const role of PROCESS_ROLES) {
    cpu[role] = stat(samples.map((s) => s.cpu[role]))
    rssMb[role] = stat(samples.map((s) => s.rssMb[role]))
  }
  cpu.total = stat(samples.map((s) => s.cpuTotal))
  rssMb.total = stat(samples.map((s) => s.rssTotalMb))

  const cameraCells = (s: PerfSample): CellStat[] => (s.cells ?? []).filter((c) => !c.empty)
  const videos = samples.flatMap((s) => cameraCells(s).flatMap((c) => c.videos))
  const playing = videos.filter((v) => !v.paused && v.readyState >= HAVE_CURRENT_DATA)
  const last = samples.at(-1)
  const reasons: Record<string, number> = {}
  for (const s of samples) {
    if (s.cells === null) {
      const why = s.cellsError ?? 'unknown'
      reasons[why] = (reasons[why] ?? 0) + 1
    }
  }
  return {
    run,
    samples: samples.length,
    measuredS: last?.t ?? 0,
    maxVideos: Math.max(
      0,
      ...samples.map((s) => cameraCells(s).reduce((a, c) => a + c.videos.length, 0)),
    ),
    cpu,
    rssMb,
    rssGrowthMbPerHour: slopePerHour(samples.map((s) => ({ t: s.t, y: s.rssTotalMb }))),
    gpuPercent: stat(samples.map((s) => s.gpuPercent)),
    bufferLagS: stat(playing.map(bufferLag), 2),
    playbackRate: stat(
      playing.map((v) => v.playbackRate),
      2,
    ),
    droppedPercent: droppedPercentOver(samples.map((s) => s.cells)),
    notPlaying: {
      maxCells: Math.max(0, ...samples.map((s) => s.notPlaying)),
      samplesWithAny: samples.filter((s) => s.notPlaying > 0).length,
    },
    cellReadFailures: {
      count: samples.filter((s) => s.cells === null).length,
      reasons,
    },
    decoders,
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown

function f(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits)
}

function mp(s: Stat | null, digits = 1): string {
  return s === null ? '–' : `${f(s.mean, digits)} / ${f(s.p95, digits)}`
}

/** The results table's header, shared by `summary.md` and docs/perf-results.md. */
export const RESULTS_TABLE_HEADER =
  '| Machine | Quality | Streams | CPU total % (mean / p95) | Renderer % | GPU proc % | go2rtc % | GPU util % (mean / p95) | RAM MB (mean / max) | RAM growth MB/h | Buffer lag s (mean / p95 / max) | Dropped % | Not playing (max cells / samples) | Decoder | Run |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'

export function decoderCell(d: DecoderSummary): string {
  const names = Object.entries(d.videoDecoders)
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
  const name = names.length > 0 ? names.join(', ') : 'unknown'
  const platform =
    d.platformDecoder.yes > 0 && d.platformDecoder.no === 0
      ? 'platform'
      : d.platformDecoder.no > 0
        ? `${String(d.platformDecoder.no)} not platform`
        : 'platform ?'
  return `${name} (${platform}; gpu ${d.gpuVideoDecode ?? '?'})`
}

/** One row for docs/perf-results.md. Contains no host, URL, port or camera name. */
export function summaryTableRow(s: PerfSummary): string {
  const r = s.run
  const machine = `${r.os} (${r.arch}, ${r.cpuModel}, ${String(r.cores)} cores, ${String(r.totalMemGb)} GB)`
  const streams =
    s.maxVideos === r.expectedStreams
      ? String(r.expectedStreams)
      : `${String(r.expectedStreams)} (${String(s.maxVideos)} seen)`
  const lag =
    s.bufferLagS === null
      ? '–'
      : `${f(s.bufferLagS.mean, 2)} / ${f(s.bufferLagS.p95, 2)} / ${f(s.bufferLagS.max, 2)}`
  const ram =
    s.rssMb.total === null ? '–' : `${f(s.rssMb.total.mean, 0)} / ${f(s.rssMb.total.max, 0)}`
  const date = r.startedAt.slice(0, 10)
  const mins = f(s.measuredS / 60, s.measuredS < 600 ? 1 : 0)
  const end = r.endReason === 'completed' ? '' : `, ended: ${r.endReason}`
  const run = `${date}, ${mins} min${end}${r.label === null ? '' : `, ${r.label}`}`
  return [
    '',
    machine,
    r.quality,
    streams,
    mp(s.cpu.total),
    mp(s.cpu.renderer),
    mp(s.cpu.gpu),
    mp(s.cpu.go2rtc),
    mp(s.gpuPercent, 0),
    ram,
    f(s.rssGrowthMbPerHour, 1),
    lag,
    f(s.droppedPercent, 2),
    `${String(s.notPlaying.maxCells)} / ${String(s.notPlaying.samplesWithAny)}`,
    decoderCell(s.decoders),
    run,
    '',
  ]
    .join(' | ')
    .trim()
}

function statLine(name: string, st: Stat | null, unit: string, digits = 1): string {
  return st === null
    ? `| ${name} | – | – | – | 0 |`
    : `| ${name} | ${f(st.mean, digits)}${unit} | ${f(st.p95, digits)}${unit} | ${f(st.max, digits)}${unit} | ${String(st.n)} |`
}

/** The whole `summary.md`: the table row ready to paste, then the detail behind it. */
export function renderSummaryMarkdown(s: PerfSummary): string {
  const r = s.run
  const lines = [
    `# Perf run — ${r.quality}`,
    '',
    `Started ${r.startedAt}; warm-up ${String(r.warmupS)} s, measured ${String(Math.round(s.measuredS))} s of ${String(r.durationS)} s, a sample every ${String(r.intervalS)} s (${String(s.samples)} samples). Ended: ${r.endReason}${r.endNote === null ? '' : ` (${r.endNote})`}.`,
    '',
    `Electron ${r.electron}, Chromium ${r.chrome}. ${String(r.cameras)} camera(s) on the console; View ${r.preset} in a ${r.windowSize} window, ${String(r.expectedStreams)} stream(s) expected, at most ${String(s.maxVideos)} <video> element(s) seen in camera cells.`,
    '',
    '## Row for docs/perf-results.md',
    '',
    RESULTS_TABLE_HEADER,
    summaryTableRow(s),
    '',
    '## CPU (% of one core)',
    '',
    '| Process | Mean | p95 | Max | Samples |',
    '|---|---|---|---|---|',
    ...PROCESS_ROLES.map((role) => statLine(role, s.cpu[role], '')),
    statLine('total', s.cpu.total, ''),
    '',
    '## Memory (RSS, MB)',
    '',
    '| Process | Mean | p95 | Max | Samples |',
    '|---|---|---|---|---|',
    ...PROCESS_ROLES.map((role) => statLine(role, s.rssMb[role], '')),
    statLine('total', s.rssMb.total, ''),
    '',
    `Growth (least-squares slope of total RSS): ${f(s.rssGrowthMbPerHour, 1)} MB/h.`,
    '',
    '## GPU and playback',
    '',
    '| Measure | Mean | p95 | Max | Samples |',
    '|---|---|---|---|---|',
    statLine('GPU utilisation (ioreg Device Utilization)', s.gpuPercent, ' %', 0),
    statLine('Buffer lag (buffered.end − currentTime)', s.bufferLagS, ' s', 2),
    statLine('playbackRate', s.playbackRate, '', 2),
    '',
    `Dropped frames: ${f(s.droppedPercent, 2)} % of decoded frames over the measured window. Camera cells not playing: at most ${String(s.notPlaying.maxCells)} in one sample, ${String(s.notPlaying.samplesWithAny)} sample(s) with any. Page reads that failed: ${String(s.cellReadFailures.count)}${s.cellReadFailures.count === 0 ? '' : ` ${JSON.stringify(s.cellReadFailures.reasons)}`} (each counts as every stream not playing).`,
    '',
    `Decoders: ${String(s.decoders.players)} media player(s); video decoders ${JSON.stringify(s.decoders.videoDecoders)}; platform decoder yes ${String(s.decoders.platformDecoder.yes)} / no ${String(s.decoders.platformDecoder.no)} / unknown ${String(s.decoders.platformDecoder.unknown)}; GPU video_decode ${s.decoders.gpuVideoDecode ?? 'unknown'}.`,
    '',
  ]
  return lines.join('\n')
}
