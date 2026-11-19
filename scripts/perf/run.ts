// P2.5 perf harness launcher: `npm run perf -- --quality low|medium|high [--duration 1800]
// [--warmup 60] [--interval 5] [--label <text>] [--verbose]`.
//
// Starts the **built** app (`npm run build` first) with VP_PERF_* set, so main enters perf mode
// (src/main/perf/): it connects, shows an in-memory View at that quality, samples for `--duration`
// seconds after `--warmup`, writes its results and quits. The app uses the normal userData (the API
// key is in the OS keystore, the certificate pin in config.json) and never writes config in perf
// mode: the quality override lives only in memory.
//
// Results go to a new directory under scripts/perf/output/ (gitignored): samples.jsonl,
// summary.json and summary.md. summary.md holds the row to paste into docs/perf-results.md.
//
// Only `[perf]` lines from the app are shown by default: the app's own log mentions the console
// address and the go2rtc port, which the harness must not print (CON-2, NFR-9). `--verbose` shows
// everything, for debugging on your own terminal.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isFailedRun, type PerfEndReason } from '../../src/main/perf/perfEnv.ts'
import { parsePerfArgs, PERF_USAGE, runDirName, type PerfArgs } from './args.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const require = createRequire(import.meta.url)

let args: PerfArgs
try {
  args = parsePerfArgs(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  console.error(PERF_USAGE)
  process.exit(2)
}

if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('No build found (out/main/index.js). Run `npm run build` first.')
  process.exit(1)
}

// The `electron` package's main export is the path of its binary when required from Node.
const electronBin = require('electron') as unknown as string
const outDir = join(HERE, 'output', runDirName(new Date(), args.quality))
mkdirSync(outDir, { recursive: true })

const env: NodeJS.ProcessEnv = { ...process.env }
// Electron would run as plain Node with this set (VS Code terminals inherit it; P0.5).
delete env.ELECTRON_RUN_AS_NODE
// The dev server URL must not redirect the built app to a dev server.
delete env.ELECTRON_RENDERER_URL
env.VP_PERF_QUALITY = args.quality
env.VP_PERF_DURATION_S = String(args.durationS)
env.VP_PERF_WARMUP_S = String(args.warmupS)
env.VP_PERF_INTERVAL_S = String(args.intervalS)
env.VP_PERF_OUT = outDir
if (args.label !== null) env.VP_PERF_LABEL = args.label
else delete env.VP_PERF_LABEL

const total = args.warmupS + args.durationS
console.log(
  `perf: ${args.quality}, ${String(args.warmupS)} s warm-up + ${String(args.durationS)} s measured ` +
    `(~${String(Math.ceil(total / 60))} min). Keep the window visible and the Mac awake.`,
)
console.log(`perf: results in ${outDir}`)

const child = spawn(electronBin, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })

let hidden = 0
for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on('line', (line) => {
    if (args.verbose || line.startsWith('[perf]')) console.log(line)
    else hidden++
  })
}

// Ctrl+C reaches the app too (same process group); it ends the run early and still writes what it
// has, so the launcher just waits for it.
process.on('SIGINT', () => {
  console.log('perf: interrupted; waiting for the app to write its results…')
})

child.on('error', (err) => {
  console.error(`perf: could not start Electron: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  const summaryPath = join(outDir, 'summary.md')
  if (!args.verbose && hidden > 0) {
    console.log(`perf: ${String(hidden)} app log line(s) hidden (use --verbose to see them)`)
  }
  if (!existsSync(summaryPath)) {
    console.error(
      `perf: the app exited (${signal ?? `code ${String(code)}`}) without writing a summary. ` +
        'Is OverWatch already running (it allows one instance)? Re-run with --verbose for details.',
    )
    process.exit(1)
  }
  console.log('')
  console.log(readFileSync(summaryPath, 'utf8'))
  // A run that did not complete is not a measurement: exit 1 so scripts notice.
  let endReason: unknown = null
  try {
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')) as {
      run?: { endReason?: unknown }
    }
    endReason = summary.run?.endReason ?? null
  } catch {
    // Unreadable summary.json: treated as a failed run below.
  }
  if (typeof endReason !== 'string' || isFailedRun(endReason as PerfEndReason)) {
    console.error(`perf: the run did not complete (ended: ${String(endReason)})`)
    process.exit(1)
  }
  process.exit(code === 0 ? 0 : 1)
})
