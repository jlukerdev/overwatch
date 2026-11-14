// P2.5 perf launcher: command-line parsing (pure, unit-tested in tests/unit/perfArgs.test.ts).
// The values are handed to the app as VP_PERF_* variables, which main validates again with the
// same rules (`src/main/perf/perfEnv.ts`, used by `parsePerfEnv`).
import {
  PERF_DEFAULTS,
  PERF_MINIMUMS,
  parseSeconds,
  timingProblem,
} from '../../src/main/perf/perfEnv.ts'
import { QualitySchema, type Quality } from '../../src/shared/quality.ts'

export interface PerfArgs {
  quality: Quality
  durationS: number
  warmupS: number
  intervalS: number
  label: string | null
  /** Pass every app log line through, not only `[perf]` ones. They can include the console address. */
  verbose: boolean
}

export const PERF_USAGE =
  `usage: npm run perf -- --quality ${QualitySchema.options.join('|')} ` +
  `[--duration ${String(PERF_DEFAULTS.durationS)}] [--warmup ${String(PERF_DEFAULTS.warmupS)}] ` +
  `[--interval ${String(PERF_DEFAULTS.intervalS)}] [--label <text>] [--verbose]`

const SECONDS_FLAGS = {
  '--duration': 'durationS',
  '--warmup': 'warmupS',
  '--interval': 'intervalS',
} as const

export function parsePerfArgs(argv: readonly string[]): PerfArgs {
  let quality: Quality | null = null
  const times: Record<'durationS' | 'warmupS' | 'intervalS', number> = { ...PERF_DEFAULTS }
  let label: string | null = null
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? ''
    const value = argv[i + 1]
    if (flag === '--quality') {
      const q = QualitySchema.safeParse(value)
      if (!q.success) throw new Error(`--quality must be ${QualitySchema.options.join(', ')}`)
      quality = q.data
      i++
    } else if (Object.hasOwn(SECONDS_FLAGS, flag)) {
      const key = SECONDS_FLAGS[flag as keyof typeof SECONDS_FLAGS]
      const r = parseSeconds(flag, value, PERF_MINIMUMS[key], undefined)
      if (!r.ok) throw new Error(r.problem)
      times[key] = r.value
      i++
    } else if (flag === '--label') {
      if (value === undefined || value.startsWith('--')) throw new Error('--label needs text')
      label = value
      i++
    } else if (flag === '--verbose') {
      verbose = true
    } else {
      throw new Error(`unknown argument ${flag}`)
    }
  }
  if (quality === null) throw new Error('--quality is required')
  const timing = timingProblem(times.durationS, times.intervalS, {
    duration: '--duration',
    interval: '--interval',
  })
  if (timing !== null) throw new Error(timing)
  return { quality, ...times, label, verbose }
}

/** `2026-11-14T10-05-00Z-low`: sortable and safe as a directory name on both OSes. */
export function runDirName(now: Date, quality: Quality): string {
  return `${now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-')}-${quality}`
}
