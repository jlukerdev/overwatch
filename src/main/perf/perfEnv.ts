// P2.5 perf harness: the variables, defaults and number rules shared by main (`parsePerfEnv` in
// perfStats.ts) and the launcher (`scripts/perf/args.ts`), so the two cannot disagree. Free of
// imports, so the launcher can load it under plain Node type stripping without Electron.

export const PERF_ENV = {
  quality: 'VP_PERF_QUALITY',
  durationS: 'VP_PERF_DURATION_S',
  warmupS: 'VP_PERF_WARMUP_S',
  intervalS: 'VP_PERF_INTERVAL_S',
  outDir: 'VP_PERF_OUT',
  label: 'VP_PERF_LABEL',
} as const

export const PERF_DEFAULTS = { durationS: 1800, warmupS: 60, intervalS: 5 } as const

/** The smallest value each setting accepts. */
export const PERF_MINIMUMS = { durationS: 1, warmupS: 0, intervalS: 1 } as const

export type SecondsResult =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly problem: string }

/**
 * A whole number of seconds ≥ `min`. `undefined` or blank gives `fallback` (pass `undefined` to
 * make the value required). `name` is the env var or flag, for the message.
 */
export function parseSeconds(
  name: string,
  raw: string | undefined,
  min: number,
  fallback: number | undefined,
): SecondsResult {
  if (raw === undefined || raw.trim() === '') {
    return fallback === undefined
      ? { ok: false, problem: `${name} needs a whole number of seconds` }
      : { ok: true, value: fallback }
  }
  const t = raw.trim()
  if (!/^\d+$/.test(t)) {
    return { ok: false, problem: `${name} must be a whole number of seconds (got "${raw}")` }
  }
  const n = Number(t)
  if (n < min)
    return { ok: false, problem: `${name} must be at least ${String(min)} (got ${String(n)})` }
  return { ok: true, value: n }
}

/** The measured duration must hold at least one sample. Null when fine. */
export function timingProblem(
  durationS: number,
  intervalS: number,
  names: { readonly duration: string; readonly interval: string },
): string | null {
  return durationS < intervalS
    ? `${names.duration} (${String(durationS)}) must be at least ${names.interval} (${String(intervalS)})`
    : null
}

/**
 * `quit`: the app was asked to quit (e.g. Cmd+Q) before the end. `renderer-gone`: the renderer
 * process crashed or was killed. `error`: the harness could not set the run up or keep it going.
 */
export type PerfEndReason =
  'completed' | 'window-closed' | 'signal' | 'quit' | 'renderer-gone' | 'error'

/** Whether a run counts as a failed measurement (the launcher exits 1 for these). */
export function isFailedRun(reason: PerfEndReason): boolean {
  return reason !== 'completed'
}
