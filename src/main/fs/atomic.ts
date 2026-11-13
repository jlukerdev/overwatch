// Crash-safe file writes for the main process. Shared by config/store.ts (config.json) and
// secrets/secrets.ts (secrets.bin): both hold data whose loss costs the user real work — every
// View (VIEW-6) or the API key they have to go and re-create (CON-1).
import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'

/**
 * Writes `data` by creating a temp file in the **same directory** and renaming it over the target.
 * A rename within one filesystem is atomic, so a crash, a power cut or a full disk leaves either
 * the old file or the new one — never a half-written one.
 *
 * `mode` is applied when the temp file is **created**, not after the rename, so a file that must
 * not be world-readable (secrets.bin, 0600) is never briefly readable.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const tmp = `${target}.tmp-${randomUUID()}`
  try {
    // 'wx' = create exclusively: never reuse a temp file left behind by an earlier crash.
    const handle = await open(tmp, 'wx', mode)
    try {
      await handle.writeFile(data)
      // Flush before the rename, or the rename can land while the data has not.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, target)
  } catch (err) {
    await removeQuietly(tmp)
    throw err
  }
}

/** Deletes `path` if it is there. Used on cleanup paths where a failure to delete changes nothing. */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Already gone, or not ours to remove.
  }
}

/**
 * Deletes `path`, tolerating only "it was already gone". Use this where the caller is telling the
 * user something was removed: a swallowed EPERM or EBUSY would report success while the file — and
 * in secrets.bin's case an encrypted credential — is still on disk.
 */
export async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return
    throw err
  }
}

/** Node fs error code (`ENOENT` etc.), if any. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  return typeof err.code === 'string' ? err.code : undefined
}
