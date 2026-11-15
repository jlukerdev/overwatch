// Pure measurement helpers shared by the P0.5 video spike (`scripts/spikes/video-spike/lib.ts`
// re-exports these) and the P2.5 perf harness: per-process CPU from cumulative CPU-time readings
// (`ps -o time=`) and the CDP Media-domain boolean parse. Deliberately free of imports, so Node can
// run it directly under type stripping from the spike.
//
// Why `ps` and not `app.getAppMetrics()`: Electron's `percentCPUUsage` is a share of the *whole
// machine*, not of one core (docs/spikes/P0.5-video.md, "Problems hit" 5). Here 100 = one core.

/** Parses `ps -o time=` output (`[[dd-]hh:]mm:ss[.cc]`) into seconds. */
export function parsePsCpuTime(text: string): number {
  const s = text.trim()
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  if (!m) throw new Error(`Unrecognised ps time "${s}"`)
  const [, d = '0', h = '0', min = '0', sec = '0'] = m
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(sec)
}

/** A `ps -o` column this module can parse. `args` takes the rest of the line, so it must be last. */
export type PsColumn = 'pid' | 'ppid' | 'time' | 'rss' | 'args'

/** One `ps` line; a field is null when its column was not asked for. */
export interface PsFields {
  pid: number
  ppid: number | null
  cpuSec: number | null
  rssKb: number | null
  command: string | null
}

const COLUMN_PATTERN: Record<PsColumn, string> = {
  pid: '(\\d+)',
  ppid: '(\\d+)',
  time: '(\\S+)',
  rss: '(\\d+)',
  args: '(.*)',
}

/**
 * Parses `ps -o <columns joined with =,>=` output (no header), e.g. `['pid', 'time', 'rss']` for
 * `ps -o pid=,time=,rss=`. `pid` is required; unparseable lines are skipped.
 */
export function parsePsColumns(text: string, columns: readonly PsColumn[]): PsFields[] {
  if (!columns.includes('pid')) throw new Error('parsePsColumns needs the pid column')
  const argsAt = columns.indexOf('args')
  if (argsAt !== -1 && argsAt !== columns.length - 1)
    throw new Error('args must be the last column')
  const re = new RegExp(`^\\s*${columns.map((c) => COLUMN_PATTERN[c]).join('\\s+')}\\s*$`)
  return text.split('\n').flatMap((line) => {
    const m = re.exec(line)
    if (!m) return []
    const cell = (c: PsColumn): string | undefined => {
      const i = columns.indexOf(c)
      return i === -1 ? undefined : m[i + 1]
    }
    const num = (c: PsColumn): number | null => {
      const v = cell(c)
      return v === undefined ? null : Number(v)
    }
    let cpuSec: number | null = null
    const time = cell('time')
    if (time !== undefined) {
      try {
        cpuSec = parsePsCpuTime(time)
      } catch {
        return []
      }
    }
    return [
      {
        pid: Number(cell('pid')),
        ppid: num('ppid'),
        cpuSec,
        rssKb: num('rss'),
        command: cell('args') ?? null,
      },
    ]
  })
}

export interface PsRow {
  pid: number
  ppid: number
  cpuSec: number
  command: string
}

/** Parses `ps -A -o pid=,ppid=,time=,args=` output. Unparseable lines are skipped. */
export function parsePsRows(text: string): PsRow[] {
  return parsePsColumns(text, ['pid', 'ppid', 'time', 'args']).map((r) => ({
    pid: r.pid,
    ppid: r.ppid ?? 0,
    cpuSec: r.cpuSec ?? 0,
    command: r.command ?? '',
  }))
}

export interface PsResourceRow {
  readonly pid: number
  readonly cpuSec: number
  readonly rssKb: number
}

/** Parses `ps -o pid=,time=,rss= -p …` output (the P2.5 perf harness). */
export function parsePsResourceRows(text: string): PsResourceRow[] {
  return parsePsColumns(text, ['pid', 'time', 'rss']).map((r) => ({
    pid: r.pid,
    cpuSec: r.cpuSec ?? 0,
    rssKb: r.rssKb ?? 0,
  }))
}

/** Average CPU % (100 = one core) between two cumulative CPU-time readings. */
export function cpuPercent(prevCpuSec: number, nowCpuSec: number, wallMs: number): number {
  if (wallMs <= 0) return 0
  return Math.max(0, ((nowCpuSec - prevCpuSec) * 1000 * 100) / wallMs)
}

// ---------------------------------------------------------------------------------------------
// CDP Media domain

/** Media-domain property values arrive as strings (`"true"`); accept both forms. */
export function asBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}
