// Load and save `<userData>/config.json` (SPEC §6, VIEW-6). Validated with zod on the way in and
// on the way out; migrated first (migrations.ts).
//
// **No Electron import.** The directory is a parameter, so the caller passes
// `app.getPath('userData')` at the app edge and the unit tests point this at a temp dir (vitest runs
// in plain Node). Nothing here touches `app`, `dialog` or IPC.
//
// **No secrets** (CON-2, NFR-9): this file is plain JSON. The API key and the Access token live in
// secrets.bin, encrypted (src/main/secrets/secrets.ts).
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { errorCode, removeQuietly, writeFileAtomic } from '../fs/atomic'
import { migrateConfig } from './migrations'
import { ConfigSchema, defaultConfig, type Config } from './schema'

export const CONFIG_FILE_NAME = 'config.json'

export interface ConfigStoreOptions {
  /** Directory holding config.json. The app passes `app.getPath('userData')`. */
  readonly dir: string
  /** Override only for tests; production always uses `config.json`. */
  readonly fileName?: string
}

/** Why a file on disk was not usable, and where it was kept. Carries no secrets. */
export interface ConfigRecovery {
  readonly problem: string
  /** Where the unusable file was moved, or `null` if it could not be moved (it is left in place). */
  readonly backupPath: string | null
}

export type ConfigLoadResult =
  /** No file yet (first run). Nothing was written — the file appears on the first save. */
  | { readonly source: 'defaults'; readonly config: Config }
  /** Loaded from disk. `migratedFrom` is the old `schemaVersion` when migrations ran. */
  | { readonly source: 'file'; readonly config: Config; readonly migratedFrom: number | null }
  /** The file was unusable: it was moved aside and these are defaults (see `recovery`). */
  | { readonly source: 'recovered'; readonly config: Config; readonly recovery: ConfigRecovery }

export interface ConfigStore {
  /** Absolute path of config.json. */
  readonly path: string
  /**
   * Reads, migrates and validates the file. **Never throws for a bad file** — that would stop the
   * app from starting; the result says what happened instead, so the caller can log it or surface
   * it in Settings.
   */
  load(): Promise<ConfigLoadResult>
  /**
   * Validates and writes atomically. Returns the parsed config that was written (defaults filled
   * in). Throws only on a programmer error (invalid config) or a real I/O failure.
   */
  save(config: Config): Promise<Config>
}

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const fileName = options.fileName ?? CONFIG_FILE_NAME
  const dir = options.dir
  const path = join(dir, fileName)

  // Saves run one at a time: two overlapping saves must not interleave their mkdir, temp file and
  // rename, and the last caller to enqueue must be what ends up on disk.
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  /**
   * Keeps an unusable file and returns defaults. Never deletes it: a corrupt, newer or
   * schema-invalid file may be the user's only copy of every View (VIEW-6), so it is renamed to
   * `config.corrupt-<timestamp>.json` next to the original.
   */
  async function recover(
    problem: string,
    reason: 'corrupt' | 'newer-schema' = 'corrupt',
  ): Promise<ConfigLoadResult> {
    let backupPath: string
    try {
      backupPath = await moveAside(reason)
    } catch (err) {
      return {
        source: 'recovered',
        config: defaultConfig(),
        recovery: {
          problem:
            `${problem}\nIt could not be moved aside (${message(err)}), so it is still at ` +
            `${path} and the next save will overwrite it.`,
          backupPath: null,
        },
      }
    }
    return {
      source: 'recovered',
      config: defaultConfig(),
      recovery: { problem: `${problem}\nIt was moved to ${backupPath}.`, backupPath },
    }
  }

  async function moveAside(reason: 'corrupt' | 'newer-schema'): Promise<string> {
    const base = fileName.replace(/\.json$/, '')
    // `:` is not legal in a Windows filename (NFR-1), so the ISO stamp is flattened.
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    for (let attempt = 0; ; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${String(attempt)}`
      const target = join(dir, `${base}.${reason}-${stamp}${suffix}.json`)
      // Reserve the name with an exclusive create, so a second bad load in the same millisecond
      // cannot overwrite the first backup.
      try {
        await (await open(target, 'wx')).close()
      } catch (err) {
        if (errorCode(err) === 'EEXIST' && attempt < 9) continue
        throw err
      }
      try {
        await rename(path, target)
      } catch (err) {
        // Don't leave the empty reservation behind if the move itself fails.
        await removeQuietly(target)
        throw err
      }
      return target
    }
  }

  return {
    path,

    async load(): Promise<ConfigLoadResult> {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return { source: 'defaults', config: defaultConfig() }
        // Unreadable for another reason (permissions, a directory in its place). Moving it aside
        // will probably fail too, which `recovery.backupPath: null` reports.
        return await recover(`config.json could not be read: ${message(err)}`)
      }

      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (err) {
        // Safe to quote the parser: config.json holds no secrets (CON-2).
        return await recover(`config.json is not valid JSON: ${message(err)}`)
      }

      const migrated = migrateConfig(raw)
      if (!migrated.ok) {
        // A file from a *newer* build is not damaged, it is just from the future: this build cannot
        // read it, but the user's Views are all in it. Keep the distinction in the backup name so
        // they can put it back after upgrading again (a real downgrade path is MVP work).
        return await recover(
          migrated.message,
          migrated.reason === 'newer-version' ? 'newer-schema' : 'corrupt',
        )
      }

      const parsed = ConfigSchema.safeParse(migrated.config)
      if (!parsed.success) {
        const detail = z.prettifyError(parsed.error)
        return await recover(`config.json does not match the schema:\n${detail}`)
      }

      return {
        source: 'file',
        config: parsed.data,
        migratedFrom: migrated.applied.length > 0 ? migrated.fromVersion : null,
      }
    },

    async save(config: Config): Promise<Config> {
      // Validate before writing, so a bug in a caller cannot leave an unloadable file on disk.
      const parsed = ConfigSchema.parse(config)
      return await serialize(async () => {
        await mkdir(dir, { recursive: true })
        // 2-space indent and a trailing newline: this file is meant to stay readable.
        await writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`)
        return parsed
      })
    },
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
