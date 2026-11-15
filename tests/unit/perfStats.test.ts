// P2.5 perf harness: the pure half (src/main/perf/perfStats.ts) — env parsing, the settings
// override, the perf View and its size, ps/ioreg parsing, per-role CPU/RAM, playback stats, the summary and its
// markdown row.
import { describe, expect, it } from 'vitest'
import { SettingsSchema, ViewSchema } from '@shared/models'
import { asBool, parsePsColumns } from '../../src/main/perf/measure'
import {
  bufferLag,
  PERF_GRID_SIZES,
  buildPerfView,
  droppedPercentOver,
  isFailedRun,
  metricTypeRole,
  notPlayingCells,
  parseIoregDeviceUtilization,
  parsePerfEnv,
  parsePsResourceRows,
  renderSummaryMarkdown,
  RESULTS_TABLE_HEADER,
  rolesFromReadings,
  sanitizeLabel,
  slopePerHour,
  stat,
  summarizeDecoders,
  summarizePerf,
  summaryTableRow,
  sumRoles,
  withPerfGridQuality,
  withPerfView,
  type CellStat,
  type PerfRunInfo,
  type PerfSample,
  type ProcReading,
  type VideoStat,
} from '../../src/main/perf/perfStats'

const OUT = '/tmp/vp-perf-out'

describe('parsePerfEnv', () => {
  it('is off without VP_PERF_QUALITY', () => {
    expect(parsePerfEnv({}, false)).toEqual({ kind: 'off' })
    expect(parsePerfEnv({ VP_PERF_QUALITY: '' }, false)).toEqual({ kind: 'off' })
  })

  it('is ignored in a packaged build', () => {
    expect(parsePerfEnv({ VP_PERF_QUALITY: 'low', VP_PERF_OUT: OUT }, true).kind).toBe('ignored')
  })

  it('applies the defaults', () => {
    expect(parsePerfEnv({ VP_PERF_QUALITY: 'medium', VP_PERF_OUT: OUT }, false)).toEqual({
      kind: 'on',
      config: {
        quality: 'medium',
        durationS: 1800,
        warmupS: 60,
        intervalS: 5,
        outDir: OUT,
        label: null,
      },
    })
  })

  it('reads every variable', () => {
    const r = parsePerfEnv(
      {
        VP_PERF_QUALITY: 'high',
        VP_PERF_DURATION_S: '60',
        VP_PERF_WARMUP_S: '0',
        VP_PERF_INTERVAL_S: '2',
        VP_PERF_OUT: OUT,
        VP_PERF_LABEL: 'on battery',
      },
      false,
    )
    expect(r).toMatchObject({
      kind: 'on',
      config: { quality: 'high', durationS: 60, warmupS: 0, intervalS: 2, label: 'on battery' },
    })
  })

  it.each([
    [{ VP_PERF_QUALITY: 'ultra', VP_PERF_OUT: OUT }, /low, medium or high/],
    [{ VP_PERF_QUALITY: 'low', VP_PERF_OUT: OUT, VP_PERF_DURATION_S: '1.5' }, /whole number/],
    [{ VP_PERF_QUALITY: 'low', VP_PERF_OUT: OUT, VP_PERF_INTERVAL_S: '0' }, /at least 1/],
    [{ VP_PERF_QUALITY: 'low', VP_PERF_OUT: OUT, VP_PERF_DURATION_S: '3' }, /at least/],
    [{ VP_PERF_QUALITY: 'low' }, /absolute/],
    [{ VP_PERF_QUALITY: 'low', VP_PERF_OUT: 'relative/dir' }, /absolute/],
  ])('rejects %o', (env, problem) => {
    const r = parsePerfEnv(env, false)
    expect(r.kind).toBe('invalid')
    expect(r.kind === 'invalid' ? r.problem : '').toMatch(problem)
  })

  it('sanitizes the label for a markdown table', () => {
    expect(sanitizeLabel(' a | b\nc ')).toBe('a b c')
    expect(sanitizeLabel('   ')).toBeNull()
    expect(sanitizeLabel('x'.repeat(200))?.length).toBe(80)
  })
})

describe('withPerfGridQuality', () => {
  it('overrides the grid default on a copy', () => {
    const settings = SettingsSchema.parse({})
    const shown = withPerfGridQuality(settings, 'high')
    expect(shown.streams.defaultGridQuality).toBe('high')
    expect(shown.streams.defaultFillQuality).toBe(settings.streams.defaultFillQuality)
    expect(settings.streams.defaultGridQuality).toBe('low')
  })
})

describe('buildPerfView', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `cam${String(i)}`)

  it.each([
    [0, '3×3', 0],
    [1, '3×3', 1],
    [9, '3×3', 9],
    [10, '4×3', 10],
    [11, '4×3', 11],
    [12, '4×3', 12],
    [15, '4×3', 12],
  ])('%i cameras → %s with %i streams', (cameras, label, streams) => {
    const perf = buildPerfView(ids(cameras))
    expect(perf).toMatchObject({ label, streams })
    expect(perf.slots).toBe(perf.view.cols * perf.view.rows)
    expect(perf.view.cells).toHaveLength(perf.slots)
  })

  it('fills 1×1 cells with the first N cameras in (row, col) order, the rest empty', () => {
    const { view } = buildPerfView(ids(11))
    expect(view.cells.map((c) => [c.row, c.col, c.colSpan, c.rowSpan])).toEqual(
      Array.from({ length: 12 }, (_, i) => [Math.floor(i / 4), i % 4, 1, 1]),
    )
    expect(view.cells.map((c) => c.cameraIds)).toEqual([...ids(11).map((id) => [id]), []])
  })

  it('leaves cameras beyond the slots out', () => {
    const { view } = buildPerfView(ids(15))
    expect(view.cells.flatMap((c) => c.cameraIds)).toEqual(ids(12))
  })

  it('is a schema-valid View with the defaults a new View gets', () => {
    const { view } = buildPerfView(ids(9))
    expect(ViewSchema.parse(view)).toEqual(view)
    expect(view).toMatchObject({
      id: 'perf',
      name: 'Perf',
      aspect: { w: 16, h: 9 },
      gap: 0,
      fit: 'contain',
      gridQuality: null,
      fillQuality: null,
    })
  })

  it('PERF_GRID_SIZES is declared smallest first, which buildPerfView relies on', () => {
    const areas = PERF_GRID_SIZES.map((s) => s.cols * s.rows)
    expect(areas).toEqual([...areas].sort((a, b) => a - b))
  })

  it('does not mutate its input', () => {
    const input = ids(10)
    const copy = [...input]
    buildPerfView(input)
    expect(input).toEqual(copy)
  })
})

describe('withPerfView', () => {
  const userView = ViewSchema.parse({
    id: 'mine',
    name: 'Mine',
    cols: 1,
    rows: 1,
    cells: [{ col: 0, row: 0 }],
  })
  const settings = SettingsSchema.parse({ views: [userView], lastViewId: 'mine' })

  it('shows only the perf View, as the active one', () => {
    const { view } = buildPerfView(['a', 'b'])
    const shown = withPerfView(settings, view)
    expect(shown.views).toEqual([view])
    expect(shown.lastViewId).toBe('perf')
    expect(shown.streams).toEqual(settings.streams)
  })

  it('leaves the stored settings untouched', () => {
    const before = structuredClone(settings)
    withPerfView(settings, buildPerfView(['a']).view)
    expect(settings).toEqual(before)
  })

  it('returns the settings as they are before a View is built', () => {
    expect(withPerfView(settings, null)).toBe(settings)
  })

  it('composes with withPerfGridQuality', () => {
    const shown = withPerfView(withPerfGridQuality(settings, 'high'), buildPerfView(['a']).view)
    expect(shown.streams.defaultGridQuality).toBe('high')
    expect(shown.lastViewId).toBe('perf')
  })
})

describe('process parsing', () => {
  it('parses ps pid/time/rss rows', () => {
    const text = '  123   1:02.50  204800\n 9 0:00.01 10\ngarbage\n'
    expect(parsePsResourceRows(text)).toEqual([
      { pid: 123, cpuSec: 62.5, rssKb: 204800 },
      { pid: 9, cpuSec: 0.01, rssKb: 10 },
    ])
  })

  it('parses ps by column spec, and refuses a spec it cannot parse', () => {
    expect(parsePsColumns(' 7  3 0:01.00 /bin/a b\n', ['pid', 'ppid', 'time', 'args'])).toEqual([
      { pid: 7, ppid: 3, cpuSec: 1, rssKb: null, command: '/bin/a b' },
    ])
    expect(() => parsePsColumns('', ['time'])).toThrow(/pid/)
    expect(() => parsePsColumns('', ['pid', 'args', 'rss'])).toThrow(/last/)
  })

  it('reads the highest IOAccelerator Device Utilization %, or null', () => {
    const text =
      '"PerformanceStatistics" = {"Tiler Utilization %"=7,"Device Utilization %"=11}\n' +
      '"PerformanceStatistics" = {"Device Utilization %"=23}'
    expect(parseIoregDeviceUtilization(text)).toBe(23)
    expect(parseIoregDeviceUtilization('nothing here')).toBeNull()
  })

  it('maps getAppMetrics types to roles', () => {
    expect(metricTypeRole('Browser')).toBe('main')
    expect(metricTypeRole('Tab')).toBe('renderer')
    expect(metricTypeRole('GPU')).toBe('gpu')
    expect(metricTypeRole('Utility')).toBe('utility')
  })

  it('computes CPU from ps deltas (100 = one core) and falls back to getAppMetrics × cores', () => {
    const reading = (over: Partial<ProcReading>): ProcReading => ({
      pid: 1,
      role: 'main',
      cpuSec: null,
      rssKb: null,
      appMetricsCpu: null,
      workingSetKb: null,
      ...over,
    })
    const prev = new Map([
      [1, 10],
      [2, 20],
    ])
    const { cpu, rssMb } = rolesFromReadings(
      prev,
      [
        reading({ pid: 1, role: 'renderer', cpuSec: 11, rssKb: 1024 }), // 1 s over 5 s = 20 %
        reading({ pid: 2, role: 'renderer', cpuSec: 22.5, rssKb: 2048 }), // 50 %
        reading({ pid: 3, role: 'gpu', cpuSec: 5 }), // new pid: 0
        reading({ pid: 4, role: 'utility', appMetricsCpu: 1.5, workingSetKb: 512 }), // × 10 cores
        reading({ pid: 5, role: 'go2rtc' }), // not measured
      ],
      5000,
      10,
    )
    expect(cpu).toEqual({ main: null, renderer: 70, gpu: 0, utility: 15, go2rtc: null })
    expect(rssMb).toEqual({ main: null, renderer: 3, gpu: null, utility: 0.5, go2rtc: null })
    expect(sumRoles(cpu)).toBe(85)
  })
})

function video(over: Partial<VideoStat> = {}): VideoStat {
  return {
    id: 1,
    bufferedEnd: 11,
    currentTime: 10,
    playbackRate: 1,
    totalFrames: 100,
    droppedFrames: 1,
    width: 640,
    height: 360,
    readyState: 4,
    paused: false,
    ...over,
  }
}

function cell(i: number, videos: VideoStat[], empty = false): CellStat {
  return { cell: i, empty, videos }
}

describe('playback stats', () => {
  it('buffer lag is buffered.end − currentTime, never negative', () => {
    expect(bufferLag(video())).toBe(1)
    expect(bufferLag(video({ bufferedEnd: null }))).toBeNull()
    expect(bufferLag(video({ bufferedEnd: 9 }))).toBe(0)
  })

  it('counts camera cells that are not playing, comparing each element with itself', () => {
    const prev = [
      cell(0, [video({ id: 10 })]),
      cell(1, [video({ id: 11 })]),
      cell(2, [], true),
      // a big old layer next to a small new one
      cell(6, [video({ id: 16, totalFrames: 500 })]),
    ]
    const cur = [
      cell(0, [video({ id: 10, totalFrames: 130 })]), // playing
      cell(1, [video({ id: 11, totalFrames: 100 })]), // frozen: no new frames
      cell(2, [], true), // empty slot: ignored
      cell(3, []), // camera cell without a video
      cell(4, [video({ id: 14, paused: true, totalFrames: 5 })]),
      cell(5, [video({ id: 15, readyState: 1, totalFrames: 5 })]),
      // the old layer froze, but the new element (fewer frames) plays: the cell is playing
      cell(6, [video({ id: 16, totalFrames: 500 }), video({ id: 26, totalFrames: 20 })]),
    ]
    expect(notPlayingCells(prev, cur, 0)).toBe(4)
    // Without a previous sample, frame progress is not required.
    expect(notPlayingCells(null, [cell(0, [video()])], 1)).toBe(0)
  })

  it('counts an unreadable page or missing camera cells as not playing', () => {
    expect(notPlayingCells(null, null, 9)).toBe(9)
    expect(notPlayingCells(null, [], 9)).toBe(9)
    expect(notPlayingCells(null, [cell(0, [video()]), cell(1, [], true)], 3)).toBe(2)
  })

  it('computes dropped % per element across replacements and failed reads', () => {
    const samples = [
      // baseline: warm-up frames do not count
      [
        cell(0, [video({ id: 1, totalFrames: 100, droppedFrames: 1 })]),
        cell(1, [video({ id: 2 })]),
      ],
      // +100 frames / +1 dropped on id 1; id 2 replaced by id 3 (created since: all 50 / 2 count)
      [
        cell(0, [video({ id: 1, totalFrames: 200, droppedFrames: 2 })]),
        cell(1, [video({ id: 3, totalFrames: 50, droppedFrames: 2 })]),
      ],
      null,
      // +100 / +1 on id 1, +50 / +0 on id 3
      [
        cell(0, [video({ id: 1, totalFrames: 300, droppedFrames: 3 })]),
        cell(1, [video({ id: 3, totalFrames: 100, droppedFrames: 2 })]),
      ],
    ]
    // 4 dropped of 300 decoded
    expect(droppedPercentOver(samples)).toBe(1.33)
    expect(droppedPercentOver([])).toBeNull()
    expect(droppedPercentOver([null])).toBeNull()
  })
})

describe('stat and slope', () => {
  it('summarizes mean / p95 / max, skipping nulls', () => {
    const values = [...Array.from({ length: 20 }, (_, i) => i + 1), null]
    expect(stat(values)).toEqual({ mean: 10.5, p95: 19, max: 20, n: 20 })
    expect(stat([null])).toBeNull()
  })

  it('is the least-squares slope per hour', () => {
    // 1 MB per minute = 60 MB/h, with noise that cancels out
    const pts = Array.from({ length: 31 }, (_, i) => ({
      t: i * 60,
      y: 500 + i + (i % 2 === 0 ? 0.5 : -0.5),
    }))
    expect(slopePerHour(pts)).toBeCloseTo(60, 0)
    expect(slopePerHour([{ t: 0, y: 1 }])).toBeNull()
    expect(
      slopePerHour([
        { t: 5, y: 1 },
        { t: 5, y: 2 },
      ]),
    ).toBeNull()
    expect(
      slopePerHour([
        { t: 0, y: 400 },
        { t: 1800, y: 400 },
      ]),
    ).toBe(0)
  })
})

describe('decoders', () => {
  it('counts decoder names and parses the string booleans', () => {
    const players = new Map<string, Record<string, unknown>>([
      ['a', { kVideoDecoderName: 'VideoToolboxVideoDecoder', kIsPlatformVideoDecoder: 'true' }],
      ['b', { kVideoDecoderName: 'VideoToolboxVideoDecoder', kIsPlatformVideoDecoder: true }],
      ['c', {}],
    ])
    expect(summarizeDecoders(players, 'enabled', asBool)).toEqual({
      players: 3,
      videoDecoders: { VideoToolboxVideoDecoder: 2 },
      platformDecoder: { yes: 2, no: 0, unknown: 1 },
      gpuVideoDecode: 'enabled',
    })
  })
})

const RUN: PerfRunInfo = {
  quality: 'low',
  label: 'smoke',
  os: 'macOS 27.0.1',
  arch: 'arm64',
  cpuModel: 'Apple M5 Pro',
  cores: 15,
  totalMemGb: 48,
  electron: '45.3.1',
  chrome: '156.0.8078.96',
  startedAt: '2026-11-14T10:00:00.000Z',
  warmupS: 60,
  durationS: 10,
  intervalS: 5,
  cameras: 9,
  preset: '3×3',
  expectedStreams: 2,
  windowSize: '1280×800',
  endReason: 'completed',
  endNote: null,
}

function sample(t: number, frames: number, rss: number, notPlaying = 0): PerfSample {
  const cpu = { main: 2, renderer: 20, gpu: 10, utility: 1, go2rtc: 3 }
  const rssMb = { main: rss, renderer: 200, gpu: 100, utility: 50, go2rtc: 30 }
  return {
    t,
    cpu,
    cpuTotal: sumRoles(cpu),
    rssMb,
    rssTotalMb: sumRoles(rssMb),
    gpuPercent: 12,
    cells: [
      cell(0, [video({ id: 1, totalFrames: frames, droppedFrames: 0 })]),
      cell(1, [video({ id: 2, totalFrames: frames, droppedFrames: frames / 100 })]),
      cell(2, [], true),
    ],
    cellsError: null,
    notPlaying,
  }
}

describe('summarizePerf and markdown', () => {
  const decoders = summarizeDecoders(
    new Map([
      ['a', { kVideoDecoderName: 'VideoToolboxVideoDecoder', kIsPlatformVideoDecoder: 'true' }],
    ]),
    'enabled',
    asBool,
  )
  const summary = summarizePerf(RUN, [sample(5, 100, 100), sample(10, 300, 100, 1)], decoders)

  it('summarizes the run', () => {
    expect(summary.samples).toBe(2)
    expect(summary.measuredS).toBe(10)
    expect(summary.maxVideos).toBe(2)
    expect(summary.cpu.total).toEqual({ mean: 36, p95: 36, max: 36, n: 2 })
    expect(summary.rssMb.total?.mean).toBe(480)
    expect(summary.rssGrowthMbPerHour).toBe(0)
    expect(summary.gpuPercent?.mean).toBe(12)
    expect(summary.bufferLagS).toEqual({ mean: 1, p95: 1, max: 1, n: 4 })
    // cell 1 dropped 2 of 200 new frames, cell 0 none: 2 / 400
    expect(summary.droppedPercent).toBe(0.5)
    expect(summary.notPlaying).toEqual({ maxCells: 1, samplesWithAny: 1 })
    expect(summary.cellReadFailures).toEqual({ count: 0, reasons: {} })
  })

  it('counts failed page reads by reason', () => {
    const failed: PerfSample = {
      ...sample(15, 0, 100, 2),
      cells: null,
      cellsError: 'renderer-gone',
    }
    const s = summarizePerf(RUN, [sample(5, 100, 100), failed], decoders)
    expect(s.cellReadFailures).toEqual({ count: 1, reasons: { 'renderer-gone': 1 } })
    expect(s.notPlaying.maxCells).toBe(2)
    expect(renderSummaryMarkdown(s)).toContain('Page reads that failed: 1')
  })

  it('treats every end other than completed as a failed run', () => {
    expect(isFailedRun('completed')).toBe(false)
    for (const r of ['window-closed', 'signal', 'quit', 'renderer-gone', 'error'] as const) {
      expect(isFailedRun(r)).toBe(true)
    }
  })

  it('renders a table row that matches the header', () => {
    const row = summaryTableRow(summary)
    const columns = (line: string): number => line.split('|').length
    expect(columns(row)).toBe(columns(RESULTS_TABLE_HEADER.split('\n')[0] ?? ''))
    expect(row).toContain('| low | 2 |')
    expect(row).toContain('VideoToolboxVideoDecoder (platform; gpu enabled)')
    expect(row).toContain('2026-11-14, 0.2 min, smoke')
  })

  it('renders summary.md without anything that looks like an address', () => {
    const md = renderSummaryMarkdown(summary)
    expect(md).toContain(RESULTS_TABLE_HEADER)
    expect(md).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
    expect(md).not.toMatch(/(rtsps?|wss?|https?):\/\//)
  })

  it('says how a run ended early', () => {
    const early = summarizePerf(
      { ...RUN, endReason: 'window-closed', endNote: 'closed' },
      [],
      decoders,
    )
    expect(summaryTableRow(early)).toContain('ended: window-closed')
    expect(early.droppedPercent).toBeNull()
    expect(early.cpu.total).toBeNull()
  })
})
