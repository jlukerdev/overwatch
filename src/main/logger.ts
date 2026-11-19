// The rotating app log (P6.3, NFR-9): `<userData>/logs/app.log`, plain-text lines, every one of
// them redacted before it is written (`src/main/log/redact.ts`).
//
// Rules this module keeps:
//  1. **One entry, one line to spot**: `<ISO-8601 UTC> <LEVEL> <message>`, LEVEL one of
//     DEBUG/INFO/WARN/ERROR. A multi-line message (a stack) is kept whole, each continuation line
//     indented by two spaces, so an entry's first line is the only one that starts at column 0.
//  2. **No secret ever** (CON-2, NFR-9). The live secret values are read through `secrets()` at
//     write time, so a key saved or cleared mid-session is covered from the next line on, and the
//     credential patterns are redacted whatever the provider says. A provider that throws costs only
//     its own values for that line (the patterns still run) and is never fatal. `write` returns the
//     redacted text, so the console tee prints exactly what was written, redacted once.
//  3. **Size rotation**: before a line that would take the file over `maxBytes` (5 MiB), `app.log`
//     becomes `app.log.1`, `.1` → `.2`, `.2` → `.3`, and the oldest is dropped (`maxFiles` = 3 old
//     files, so at most ~20 MiB). The size is read once per open (`fstat`) and tracked in memory
//     after that, not stat'ed per line. The live file is moved aside **first** (to
//     `app.log.rotating`): if that fails (Windows `EBUSY` from a virus scanner, say) nothing has been
//     touched, the line is appended to the oversized file, and rotation is not tried again until
//     the file has grown another `maxBytes` — so a stuck rename can neither drop lines nor wipe the
//     history by re-shifting it on every line. If a later step (the shift of the old files) fails,
//     the new file is started anyway and `app.log.rotating` stays behind; it is reported.
//  4. **Synchronous writes** through one file descriptor kept open (`openSync(…, 'a')` once,
//     `writeSync` per line; closed and reopened around a rotation and after an error). The volume
//     is low (no per-request lines), and a sync write keeps the order and survives a crash right
//     after the line. `close()` releases the descriptor; a later line simply reopens it.
//  5. **Never throws into the caller.** A write failure is reported once through `reportError`
//     (the original stderr in the app) and the next line tries again from scratch (re-opening the
//     file). After a line succeeds again, a later failure is reported again: one report per
//     outage, not one per line.
//
// No Electron import: the directory, the clock, the fs functions and the secrets provider are
// injected, so the tests run in plain Node and `src/main/index.ts` passes `app.getPath('userData')`.
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { redactLogText } from './log/redact'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** Rotate before a line would take `app.log` over this size (5 MiB). */
export const DEFAULT_APP_LOG_MAX_BYTES = 5 * 1024 * 1024
/** How many rotated files are kept (`app.log.1` … `app.log.3`). */
export const DEFAULT_APP_LOG_MAX_FILES = 3

export const APP_LOG_FILE = 'app.log'

/** The fs calls this module makes, so a test can make one of them fail. */
export interface AppLogFs {
  mkdirSync(path: string, options: { recursive: true }): unknown
  openSync(path: string, flags: 'a'): number
  fstatSync(fd: number): { size: number }
  writeSync(fd: number, data: string): number
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { force: true }): void
}

export interface AppLoggerOptions {
  /** `<userData>/logs`. Created on the first write. */
  readonly dir: string
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly now?: () => Date
  readonly fs?: AppLogFs
  /** The live secret values to redact, read on every line. Default: none (patterns only). */
  readonly secrets?: () => readonly string[]
  /** Where a write failure is reported, once per outage. Default: `process.stderr`. */
  readonly reportError?: (message: string) => void
}

export interface AppLogger {
  /** `<dir>/app.log`. */
  readonly path: string
  readonly dir: string
  /**
   * Redacts and appends one entry, and returns the redacted message (rule 2) for the terminal.
   * Never throws (rule 5).
   */
  write(level: LogLevel, message: string): string
  /** Closes the file descriptor (at quit). A later `write` reopens it. Never throws. */
  close(): void
}

/**
 * One entry as written: `<time> <LEVEL> <message>\n`, continuation lines indented (rule 1). The
 * message is expected to be redacted already. A trailing newline in the message is dropped and
 * CRLF is normalised, so an entry never ends in an empty indented line.
 */
export function formatLogLine(time: Date, level: LogLevel, message: string): string {
  const lines = message.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  return `${time.toISOString()} ${level} ${lines.join('\n  ')}\n`
}

/** Console arguments as Node prints them: `util.format`, so objects inspect and Errors carry a stack. */
export function formatArgs(args: readonly unknown[]): string {
  return format(...args)
}

function errorText(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? ` (${String(err.code)})` : ''
  return `${code}: ${err instanceof Error ? err.message : String(err)}`
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

export function createAppLogger(options: AppLoggerOptions): AppLogger {
  const fs: AppLogFs = options.fs ?? nodeFs
  const maxBytes = options.maxBytes ?? DEFAULT_APP_LOG_MAX_BYTES
  const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_APP_LOG_MAX_FILES)
  const now = options.now ?? ((): Date => new Date())
  const secrets = options.secrets ?? ((): readonly string[] => [])
  const reportError =
    options.reportError ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`)
    })
  const dir = options.dir
  const path = join(dir, APP_LOG_FILE)
  const staging = `${path}.rotating`

  /** The open descriptor, or `null` before the first line, after `close()` and after an error. */
  let fd: number | null = null
  /** Bytes in `app.log` as far as this process knows (read at each open). */
  let size = 0
  /** Rotate before a line would take the file past this; raised after a failed rotation (rule 3). */
  let rotateAt = maxBytes
  /** Rule 5: a write failure is reported once, until a line gets written again. */
  let reported = false

  function report(message: string): void {
    try {
      reportError(message)
    } catch {
      // A reporter that throws must not throw into the caller either.
    }
  }

  function liveSecrets(): readonly string[] {
    try {
      return secrets()
    } catch {
      // Rule 2: the patterns still run; a broken provider must not stop the log.
      return []
    }
  }

  function openFile(): number {
    fs.mkdirSync(dir, { recursive: true })
    const opened = fs.openSync(path, 'a')
    try {
      size = fs.fstatSync(opened).size
    } catch (err) {
      fs.closeSync(opened)
      throw err
    }
    fd = opened
    return opened
  }

  function closeFile(): void {
    const open = fd
    fd = null
    if (open === null) return
    try {
      fs.closeSync(open)
    } catch {
      // Already gone; nothing to release.
    }
  }

  /** Rule 3. `false` when the live file could not be moved aside, so nothing was changed. */
  function rotate(): boolean {
    try {
      fs.renameSync(path, staging)
    } catch (err) {
      if (isMissing(err)) return true
      report(
        `[app-log] could not rotate ${APP_LOG_FILE}${errorText(err)}; ` +
          'appending to it and trying again once it has grown further',
      )
      return false
    }
    try {
      if (maxFiles === 0) {
        fs.rmSync(staging, { force: true })
        return true
      }
      // Oldest first: `.3` goes, then each file moves up one, then the live one becomes `.1`.
      fs.rmSync(`${path}.${String(maxFiles)}`, { force: true })
      for (let i = maxFiles - 1; i >= 1; i--) {
        try {
          fs.renameSync(`${path}.${String(i)}`, `${path}.${String(i + 1)}`)
        } catch (err) {
          if (!isMissing(err)) throw err
        }
      }
      fs.renameSync(staging, `${path}.1`)
    } catch (err) {
      report(
        `[app-log] rotation of ${APP_LOG_FILE} incomplete${errorText(err)}; ` +
          `the previous file was left as ${APP_LOG_FILE}.rotating`,
      )
    }
    return true
  }

  function append(line: string): void {
    let open = fd ?? openFile()
    const bytes = Buffer.byteLength(line, 'utf8')
    if (size > 0 && size + bytes > rotateAt) {
      closeFile()
      const rotated = rotate()
      open = openFile()
      rotateAt = rotated ? maxBytes : size + maxBytes
    }
    fs.writeSync(open, line)
    size += bytes
  }

  return {
    path,
    dir,
    write(level, message) {
      let text: string
      try {
        text = redactLogText(message, liveSecrets())
      } catch {
        // Nothing unredacted may be written or printed.
        text = '[app-log] a line could not be redacted and was dropped'
      }
      try {
        append(formatLogLine(now(), level, text))
        reported = false
      } catch (err: unknown) {
        // Re-open (re-stat) on the next line: the file may have been moved or the disk freed.
        closeFile()
        if (!reported) {
          reported = true
          report(`[app-log] could not write ${APP_LOG_FILE}${errorText(err)}`)
        }
      }
      return text
    },
    close() {
      closeFile()
    },
  }
}

/** The console methods the tee replaces, and the level each one is logged at. */
export const CONSOLE_LEVELS = {
  debug: 'DEBUG',
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
} as const satisfies Record<string, LogLevel>

export type ConsoleMethod = keyof typeof CONSOLE_LEVELS

export type ConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>

/**
 * Tees `console.debug/log/info/warn/error` into `logger`: each call is formatted as Node would
 * (`formatArgs`), redacted and written by the logger, and then passed to the original method as
 * the redacted string `write` returned — so the terminal never shows a secret either. Returns a function that
 * puts the original methods back (for tests). The originals are returned too, for a caller that
 * needs to report without going through the tee (e.g. the logger's own `reportError`).
 */
export function teeConsole(
  target: ConsoleLike,
  logger: Pick<AppLogger, 'write'>,
): { readonly original: ConsoleLike; restore(): void } {
  const original = {} as Record<ConsoleMethod, (...args: unknown[]) => void>
  const unbound = {} as Record<ConsoleMethod, (...args: unknown[]) => void>
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    const level = CONSOLE_LEVELS[method]
    unbound[method] = target[method]
    const passThrough = target[method].bind(target)
    original[method] = passThrough
    target[method] = (...args: unknown[]): void => {
      let formatted: string
      try {
        formatted = formatArgs(args)
      } catch {
        formatted = '[app-log] a console call could not be formatted'
      }
      // Redacted once, by the logger; the terminal gets exactly what the file got.
      const text = logger.write(level, formatted)
      try {
        passThrough(text)
      } catch {
        // A closed stdout (EPIPE) must not turn a log line into a crash.
      }
    }
  }
  return {
    original,
    restore() {
      for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[])
        target[method] = unbound[method]
    },
  }
}
