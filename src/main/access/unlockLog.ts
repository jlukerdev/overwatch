// Append-only unlock audit log (DOOR-5, P5.4): one JSON line per unlock attempt at
// `<userData>/logs/unlock.log`.
//
// **Every attempt, not only the ones that reached the console.** A press refused before anything
// was sent — Access switched off (DOOR-0), a camera with no door link, no token saved, a
// certificate not accepted — is still a person trying to open a door from this app, and is exactly
// what someone reading the log after the fact wants to see. So the caller writes a line for those
// too, with the reason as `errorKind`/`message`.
//
// Four rules this module keeps:
//  1. **JSON Lines, one object per line**, fields in a fixed order (see {@link UnlockLogEntry}).
//     Machine-readable without a parser of our own, and `tail -f` still reads like a log.
//  2. **No secret ever** (CON-2, NFR-9). The entry has no field for a token, a URL or an RTSPS URL,
//     and the `message` is an `IpcError` message, which `AccessApiError` and `toIpcError` already
//     guarantee carries no token (src/main/access/client.ts rule 5).
//  3. **Writes are serialized** through one promise chain, so two quick unlocks cannot interleave
//     their lines or race the rotation (one renaming the file while the other appends to it).
//  4. **A failed write never fails the unlock** (DOOR-3: the user must learn what the *door* did).
//     `append` never rejects; a write error goes to `onError` — `console.error('[unlock-log] …')`
//     by default — and the next append tries again from scratch. Even an `onError` that throws
//     cannot poison the queue. The connection manager does not await `append` at all, so a stalled
//     disk cannot hold the answer back either; `flushed()` is for whoever needs the lines on disk.
//
// Rotation is deliberately simple: when the file is already over `maxBytes` before an append, it is
// renamed to `unlock.log.1` (replacing an older one) and a fresh file is started. An unlock is a
// deliberate press, so 1 MiB is many thousands of attempts; one generation of history is plenty for
// a prototype, and nothing here ever deletes the current file.
//
// No Electron import: the directory, the clock and the fs functions are injected, so the tests run
// against a temp dir in plain Node and `src/main/index.ts` passes `app.getPath('userData')`.
import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcErrorKind } from '@shared/ipc'

/** Rotate once the file is over this size (1 MiB). */
export const DEFAULT_UNLOCK_LOG_MAX_BYTES = 1024 * 1024

export const UNLOCK_LOG_FILE = 'unlock.log'
export const UNLOCK_LOG_ROTATED_FILE = 'unlock.log.1'

/**
 * One attempt, as the caller knows it once the outcome is known (after the PUT resolved or
 * rejected, or at the refusal). `time` is not here: the log stamps it, so every line uses the same
 * clock and format.
 */
export interface UnlockAttempt {
  /** What the renderer sent: `<cameraId>` or `<cameraId>:package`. */
  readonly cameraRef: string
  /** From main's Protect inventory, falling back to the camera id. */
  readonly cameraName: string
  /** The linked Access door, or `null` when the camera has no link (nothing was sent). */
  readonly doorId: string | null
  /**
   * `unknown`: the PUT may have reached the console but no answer came back, so the door may have
   * opened (user decision 2026-11-18; `UnlockResult.outcome`).
   */
  readonly result: 'success' | 'failure' | 'unknown'
  /** The `IpcError` kind on failure or unknown, `null` on success. */
  readonly errorKind: IpcErrorKind | null
  /** The `IpcError` message on failure or unknown (already safe: no token), `null` on success. */
  readonly message: string | null
}

/** One line of `unlock.log`, in this key order. */
export interface UnlockLogEntry extends UnlockAttempt {
  /** ISO 8601, UTC (`2026-11-18T09:15:02.123Z`). */
  readonly time: string
}

/** The fs calls this module makes, so a test can make one of them fail. */
export interface UnlockLogFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  stat(path: string): Promise<{ size: number }>
  rename(from: string, to: string): Promise<void>
  appendFile(path: string, data: string, options: { encoding: 'utf8' }): Promise<void>
}

export interface UnlockLogOptions {
  /** `<userData>/logs`. Created on the first append. */
  readonly dir: string
  readonly maxBytes?: number
  readonly now?: () => Date
  readonly fs?: UnlockLogFs
  /** Where a write failure is reported. Default: `console.error('[unlock-log] …')`. */
  readonly onError?: (message: string) => void
}

export interface UnlockLog {
  /** Absolute path of the current log file. */
  readonly path: string
  /**
   * Appends one line. Resolves once that line is written (or its write has failed and been
   * reported): **never rejects** (rule 4), so a caller can await it without a catch.
   */
  append(attempt: UnlockAttempt): Promise<void>
  /** Resolves once every append made so far has been written or reported. Never rejects. */
  flushed(): Promise<void>
}

/** The line for an entry: fixed key order, one line, newline-terminated (rule 1). */
export function formatUnlockLogLine(entry: UnlockLogEntry): string {
  // Built field by field rather than spreading the caller's object, so nothing the caller happens
  // to carry (a stray extra field) can reach the file, and the key order never depends on it.
  const line = {
    time: entry.time,
    cameraRef: entry.cameraRef,
    cameraName: entry.cameraName,
    doorId: entry.doorId,
    result: entry.result,
    errorKind: entry.errorKind,
    message: entry.message,
  }
  // JSON.stringify escapes any newline inside a value, so one entry is always one line.
  return `${JSON.stringify(line)}\n`
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

export function createUnlockLog(options: UnlockLogOptions): UnlockLog {
  const fs: UnlockLogFs = options.fs ?? nodeFs
  const maxBytes = options.maxBytes ?? DEFAULT_UNLOCK_LOG_MAX_BYTES
  const now = options.now ?? ((): Date => new Date())
  const onError =
    options.onError ??
    ((message: string): void => {
      console.error(`[unlock-log] ${message}`)
    })
  const path = join(options.dir, UNLOCK_LOG_FILE)
  const rotated = join(options.dir, UNLOCK_LOG_ROTATED_FILE)

  /** Rule 3: every write waits for the previous one, whether it succeeded or not. */
  let queue: Promise<void> = Promise.resolve()

  async function write(line: string): Promise<void> {
    await fs.mkdir(options.dir, { recursive: true })
    let size = 0
    try {
      size = (await fs.stat(path)).size
    } catch (err) {
      // No file yet is the normal first-append case; anything else is a real failure.
      if (!isMissing(err)) throw err
    }
    if (size > maxBytes) {
      // `rename` replaces an existing `unlock.log.1` on every platform Node supports.
      await fs.rename(path, rotated)
    }
    await fs.appendFile(path, line, { encoding: 'utf8' })
  }

  return {
    path,
    append(attempt) {
      // Stamped at call time, not when the queue reaches it: the time is when the attempt ended.
      const line = formatUnlockLogLine({ time: now().toISOString(), ...attempt })
      const run = queue.then(() =>
        write(line).catch((err: unknown) => {
          // The error's code and message only (a path at most, never a secret: the line is not
          // quoted back). The unlock result has already been decided by the caller (rule 4).
          const code =
            typeof err === 'object' && err !== null && 'code' in err ? ` (${String(err.code)})` : ''
          try {
            onError(
              `could not write ${UNLOCK_LOG_FILE}${code}: ${err instanceof Error ? err.message : String(err)}`,
            )
          } catch {
            // A reporter that throws must not reject this append or the ones queued behind it.
          }
        }),
      )
      // Belt and braces: whatever happens above, the next append starts from a settled promise.
      queue = run.catch(() => undefined)
      return queue
    },
    flushed() {
      return queue
    },
  }
}
