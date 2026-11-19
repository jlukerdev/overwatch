// `<userData>/secrets.bin`: the Protect Integration API key and the Access token, encrypted with
// the OS keystore (ARCHITECTURE §4, CON-1/2, NFR-9). Never reaches the renderer.
//
// CON-2 is absolute — "never written in plaintext and never logged" — so:
//  - **no plaintext fallback.** If `isEncryptionAvailable()` is false, a write is refused with a
//    clear error. A readable secrets.bin is never an acceptable substitute for a keystore.
//  - **no secret in any message, error or stack.** Errors thrown by the crypto port are swallowed
//    and replaced with fixed text: `safeStorage` is not expected to put the plaintext in its
//    message, but `JSON.parse` of a wrongly decrypted blob certainly does (Node quotes the input),
//    and a `cause` chain would carry it into any logger. Nothing here holds a secret in a field
//    either, so inspecting or stringifying the store cannot leak one.
//  - nothing is cached: every read goes back to the file.
//
// **No Electron import.** The crypto port is injected, so the unit tests (plain Node) can drive both
// the available and the unavailable paths. Wire the real thing at the app edge with
// `safeStorageCrypto(safeStorage)` from Electron's main process.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { errorCode, removeIfPresent, writeFileAtomic } from '../fs/atomic'

export const SECRETS_FILE_NAME = 'secrets.bin'

/** CON-1: the API key, plus the Access token when Access is enabled (DOOR-0). */
export type SecretKey = 'protectApiKey' | 'accessToken'

export const SECRET_KEYS: readonly SecretKey[] = ['protectApiKey', 'accessToken']

/** A stored secret is present or absent; it is never an empty string (see `set`). */
export type Secrets = Partial<Record<SecretKey, string>>

// Typed as a Record<SecretKey, …> so adding a SecretKey without a field here is a type error.
const secretsShape: Record<SecretKey, z.ZodOptional<z.ZodString>> = {
  protectApiKey: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
}
const SecretsSchema = z.object(secretsShape)

/**
 * The slice of Electron's `safeStorage` this module uses. Injected so nothing here imports Electron:
 * `safeStorage` satisfies it as is (see `safeStorageCrypto`).
 */
export interface CryptoPort {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Uint8Array
  decryptString(encrypted: Uint8Array): string
}

/** Electron's `safeStorage`, structurally. Declared here so this file imports no Electron types. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Thin adapter for the real keystore, to be called at the app edge: `safeStorageCrypto(safeStorage)`
 * in main. It only converts `Uint8Array` to the `Buffer` Electron's signature wants, so this module
 * can stay Electron-free.
 */
export function safeStorageCrypto(safeStorage: SafeStorageLike): CryptoPort {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) =>
      safeStorage.decryptString(Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted)),
  }
}

export type SecretsErrorCode =
  /** The OS keystore is not available. Writing plaintext instead is not an option (CON-2). */
  | 'encryption-unavailable'
  /** `set` was called with an empty value; use `clear` to remove a secret. */
  | 'invalid-value'
  /** The injected crypto port threw. Its message is discarded on purpose (see the header). */
  | 'crypto-failed'
  /** The existing file could not be read, so writing would have destroyed what is in it. */
  | 'read-failed'

export class SecretsError extends Error {
  readonly code: SecretsErrorCode

  constructor(code: SecretsErrorCode, message: string) {
    // No `cause`: an underlying error could carry the plaintext into a log (CON-2).
    super(message)
    this.name = 'SecretsError'
    this.code = code
  }
}

export type SecretsReadResult =
  /** The file was read and decrypted. `secrets` may still be `{}` if everything was cleared. */
  | { readonly status: 'ok'; readonly secrets: Secrets }
  /** No secrets stored yet (no file, or an empty one). */
  | { readonly status: 'empty'; readonly secrets: Secrets }
  /**
   * There is a file but it cannot be used: a different keystore, a corrupt blob, another app's
   * data. Treated as "no secrets stored" so the app still starts; the user re-enters the key in
   * Settings (P1.6). `problem` is fixed text and never contains a secret.
   */
  | { readonly status: 'unreadable'; readonly secrets: Secrets; readonly problem: string }
  /**
   * The file is there but could not be read at all — a lock, a permissions change, too many open
   * files. Unlike `unreadable` this says **nothing about the contents**: the stored secrets are
   * probably fine, so overwriting or deleting the file here would destroy a credential the user
   * would have to go and re-create. `set` and `clear` refuse instead of merging into `{}`.
   */
  | { readonly status: 'io-error'; readonly secrets: Secrets; readonly problem: string }

export interface SecretsStoreOptions {
  /** Directory holding secrets.bin. The app passes `app.getPath('userData')`. */
  readonly dir: string
  /** The OS keystore. `safeStorageCrypto(safeStorage)` in the app; a fake in tests. */
  readonly crypto: CryptoPort
  /** Override only for tests. */
  readonly fileName?: string
}

export interface SecretsStore {
  /** Absolute path of secrets.bin. */
  readonly path: string
  /** CON-2: false means the keystore is unavailable, so secrets cannot be stored at all. */
  isEncryptionAvailable(): boolean
  /** Reads every stored secret. Never throws: a bad file comes back as `unreadable`. */
  read(): Promise<SecretsReadResult>
  /** One secret, or `undefined` if it is absent or the file is unusable. */
  get(key: SecretKey): Promise<string | undefined>
  /** Stores one secret. Throws `SecretsError` if the keystore is unavailable (CON-2). */
  set(key: SecretKey, value: string): Promise<void>
  /** Removes one secret: the key is deleted, never blanked. */
  clear(key: SecretKey): Promise<void>
  /** Removes the file and every secret in it. */
  clearAll(): Promise<void>
}

export function createSecretsStore(options: SecretsStoreOptions): SecretsStore {
  const fileName = options.fileName ?? SECRETS_FILE_NAME
  const dir = options.dir
  const path = join(dir, fileName)
  const keystore = options.crypto

  // Read-modify-write, so two overlapping calls must not interleave and drop one another's secret.
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  async function read(): Promise<SecretsReadResult> {
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return { status: 'empty', secrets: {} }
      // Not "unreadable": the bytes may be perfectly good, we just could not get at them.
      return {
        status: 'io-error',
        secrets: {},
        problem: `${fileName} could not be read (${errorCode(err) ?? 'unknown error'}).`,
      }
    }
    // A zero-length file means nothing is stored (and cannot be decrypted); not worth a warning.
    if (bytes.length === 0) return { status: 'empty', secrets: {} }

    let plain: string
    try {
      plain = keystore.decryptString(bytes)
    } catch {
      return {
        status: 'unreadable',
        secrets: {},
        problem: `${fileName} could not be decrypted with this machine's keystore. Re-enter the API key in Settings.`,
      }
    }

    // Fixed text only: a JSON.parse message quotes its input, which here is the decrypted
    // plaintext, and zod issues could echo a value (CON-2).
    const unusable: SecretsReadResult = {
      status: 'unreadable',
      secrets: {},
      problem: `${fileName} did not contain the expected secrets. Re-enter the API key in Settings.`,
    }
    let raw: unknown
    try {
      raw = JSON.parse(plain)
    } catch {
      return unusable
    }
    const parsed = SecretsSchema.safeParse(raw)
    if (!parsed.success) return unusable
    return { status: 'ok', secrets: pickSecrets(parsed.data) }
  }

  async function write(secrets: Secrets): Promise<void> {
    if (Object.keys(secrets).length === 0) {
      // A cleared secret is removed, not blanked: with nothing left, the file goes away. This also
      // works while the keystore is unavailable, so a user can always get rid of a stored secret.
      await removeIfPresent(path)
      return
    }
    if (!keystore.isEncryptionAvailable()) throw encryptionUnavailable()

    // A zod issue can carry the offending input, so the error is replaced, not re-thrown (CON-2).
    let payload: string
    try {
      payload = JSON.stringify(SecretsSchema.parse(secrets))
    } catch {
      throw new SecretsError(
        'invalid-value',
        'A secret was not a non-empty string; nothing was stored.',
      )
    }

    let encrypted: Uint8Array
    try {
      encrypted = keystore.encryptString(payload)
    } catch {
      // The underlying message is dropped deliberately: it could quote the plaintext (CON-2).
      throw new SecretsError(
        'crypto-failed',
        `The OS keystore failed to encrypt ${fileName}. The secret was not stored.`,
      )
    }

    await mkdir(dir, { recursive: true })
    // 0600: the blob is encrypted, but there is no reason for another account to read it (NFR-9).
    // Ignored on Windows, where the ACL inherited from userData is the protection.
    await writeFileAtomic(path, encrypted, 0o600)
  }

  return {
    path,

    isEncryptionAvailable: () => keystore.isEncryptionAvailable(),

    read: () => serialize(read),

    get: (key) =>
      serialize(async () => {
        const result = await read()
        return result.secrets[key]
      }),

    set: (key, value) =>
      serialize(async () => {
        if (value.length === 0) {
          throw new SecretsError(
            'invalid-value',
            `${key} cannot be stored as an empty value; clear it instead.`,
          )
        }
        // Refuse before reading, so an unavailable keystore reports exactly that.
        if (!keystore.isEncryptionAvailable()) throw encryptionUnavailable()
        const current = await read()
        if (current.status === 'io-error') {
          // Writing now would replace a file we could not read, taking the other secret with it.
          throw new SecretsError('read-failed', `${current.problem} Nothing was stored.`)
        }
        // An `unreadable` file is different: its contents are genuinely unrecoverable, so the write
        // starts from an empty set and replaces it.
        const next: Secrets = { ...current.secrets }
        next[key] = value
        await write(next)
      }),

    clear: (key) =>
      serialize(async () => {
        const current = await read()
        if (current.status === 'empty') return
        if (current.status === 'io-error') {
          // Deleting now would take the other secret with it (see `set`).
          throw new SecretsError('read-failed', `${current.problem} Nothing was changed.`)
        }
        if (current.status === 'unreadable') {
          // Nothing in it can be read, so there is nothing to preserve.
          await removeIfPresent(path)
          return
        }
        if (current.secrets[key] === undefined) return
        // Rebuilt without `key`, so the secret is removed rather than blanked.
        await write(without(current.secrets, key))
      }),

    clearAll: () => serialize(() => removeIfPresent(path)),
  }
}

function encryptionUnavailable(): SecretsError {
  return new SecretsError(
    'encryption-unavailable',
    'The OS keystore (Keychain on macOS, DPAPI on Windows) is not available, so the API key ' +
      'cannot be stored. OverWatch never writes secrets in plaintext (CON-2).',
  )
}

/** Every stored secret but `omit`. */
function without(secrets: Secrets, omit: SecretKey): Secrets {
  const out: Secrets = {}
  for (const key of SECRET_KEYS) {
    const value = secrets[key]
    if (key !== omit && value !== undefined) out[key] = value
  }
  return out
}

/** Drops explicit `undefined`s and anything outside `SECRET_KEYS`. */
function pickSecrets(parsed: z.infer<typeof SecretsSchema>): Secrets {
  const out: Secrets = {}
  for (const key of SECRET_KEYS) {
    const value = parsed[key]
    if (value !== undefined) out[key] = value
  }
  return out
}
