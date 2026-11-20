// `<userData>/secrets.bin`: the Protect Integration API key, the Access token and the RTSP stream
// URLs, encrypted with the OS keystore (ARCHITECTURE §4, CON-1/2, NFR-9, RTSP-2). Never reaches the
// renderer.
//
// The file holds one JSON object, encrypted as a whole:
//   { "protectApiKey"?: string, "accessToken"?: string,
//     "rtspUrls"?: { "<streamId>": { "high"?: string, "medium"?: string, "low"?: string } } }
// An absent key means "not stored"; nothing is ever stored as an empty string or an empty object,
// and with nothing left at all the file is removed. A file written before RTSP mode existed simply
// has no `rtspUrls` and reads as "no stream URLs".
//
// The two credential strings go through `set` / `clear` / `get` (`SecretKey`); the stream URLs have
// their own methods (`setRtspUrls`, `clearRtspStream`) because they are a map, not a string. Both
// kinds share one file, one queue and the same refusal rules, so a write to one never drops the
// other.
//
// RTSP-2/RTSP-5: every stream URL is validated with `validateRtspUrl` (@shared/rtsp) before it is
// stored, and again on every read: a stored URL that fails the rules (a hand-crafted file, a rule
// tightened in a later build) is dropped on read, with its quality, rather than costing the whole
// file. Main registers in go2rtc only URLs that came out of `read()`, so this is the gate that keeps
// a command-running go2rtc scheme (`exec:` …) from ever becoming a source.
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
import { RTSP_STREAM_ID_PATTERN } from '@shared/models'
import { RTSP_QUALITIES, validateRtspUrl, type RtspStreamUrls } from '@shared/rtsp'
import { z } from 'zod'
import { errorCode, removeIfPresent, writeFileAtomic } from '../fs/atomic'

export const SECRETS_FILE_NAME = 'secrets.bin'

/** CON-1: the API key, plus the Access token when Access is enabled (DOOR-0). */
export type SecretKey = 'protectApiKey' | 'accessToken'

export const SECRET_KEYS: readonly SecretKey[] = ['protectApiKey', 'accessToken']

/** RTSP-2: `{ "<streamId>": { high?, medium?, low? } }`. A stream with no URL has no entry. */
export type RtspUrls = Record<string, RtspStreamUrls>

/**
 * Everything secrets.bin holds. A stored secret is present or absent; it is never an empty string
 * (see `set`), and `rtspUrls` is never `{}` nor holds a stream with no URL.
 */
export type Secrets = Partial<Record<SecretKey, string>> & { rtspUrls?: RtspUrls }

// Typed as a Record<SecretKey, …> so adding a SecretKey without a field here is a type error.
const secretsShape: Record<SecretKey, z.ZodOptional<z.ZodString>> = {
  protectApiKey: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
}

/** One stream's URLs as written: each quality absent or a non-empty string (RTSP-2). */
const RtspStreamUrlsSchema = z.object({
  high: z.string().min(1).optional(),
  medium: z.string().min(1).optional(),
  low: z.string().min(1).optional(),
})

/** What `write` serializes. Strict: a malformed value is a bug, refused before it reaches disk. */
const SecretsSchema = z.object({
  ...secretsShape,
  rtspUrls: z.record(z.string().min(1), RtspStreamUrlsSchema).optional(),
})

/**
 * What `read` accepts. The two credential strings keep their strict rules (a wrong one makes the
 * file `unreadable`, as before), but the `rtspUrls` block is parsed **loosely**: anything that is not
 * an object of objects is ignored, and each URL is then checked on its own in `pickRtspUrls`. So a
 * bad stream entry costs that entry, never the API key or the token next to it (RTSP-2).
 */
const ReadSecretsSchema = z.object({
  ...secretsShape,
  rtspUrls: z
    .record(
      z.string(),
      z.record(z.string(), z.unknown()).catch(() => ({})),
    )
    .optional()
    .catch(undefined),
})

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
  /**
   * RTSP-2: replaces one stream's URL set with `urls`. Every URL is checked with `validateRtspUrl`
   * first; an invalid one throws `SecretsError('invalid-value')` with fixed text and nothing is
   * stored. A set with no URL at all removes the stream's entry. Throws `SecretsError` if the
   * keystore is unavailable (CON-2).
   */
  setRtspUrls(streamId: string, urls: RtspStreamUrls): Promise<void>
  /** RTSP-1: removes one stream's URLs (a deleted stream). Nothing to do if it has none. */
  clearRtspStream(streamId: string): Promise<void>
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
    const parsed = ReadSecretsSchema.safeParse(raw)
    if (!parsed.success) return unusable
    return { status: 'ok', secrets: pickSecrets(parsed.data) }
  }

  async function write(secrets: Secrets): Promise<void> {
    if (isEmpty(secrets)) {
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
        'A secret was not a non-empty string or a valid stream address; nothing was stored.',
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

  /**
   * Read-modify-write under the queue, with the refusal rules `set` and `clear` share. `mutate` gets
   * a copy of what is stored and returns the new set, or `null` for "nothing to change".
   */
  async function update(
    mutate: (current: Secrets) => Secrets | null,
    options: { readonly writing: boolean },
  ): Promise<void> {
    // Refuse before reading, so an unavailable keystore reports exactly that.
    if (options.writing && !keystore.isEncryptionAvailable()) throw encryptionUnavailable()
    const current = await read()
    if (current.status === 'io-error') {
      // Writing now would replace a file we could not read, taking every other secret with it.
      throw new SecretsError(
        'read-failed',
        `${current.problem} ${options.writing ? 'Nothing was stored.' : 'Nothing was changed.'}`,
      )
    }
    if (!options.writing && current.status === 'empty') return
    if (!options.writing && current.status === 'unreadable') {
      // Nothing in it can be read, so there is nothing to preserve.
      await removeIfPresent(path)
      return
    }
    // An `unreadable` file on a write is different: its contents are genuinely unrecoverable, so
    // the write starts from an empty set and replaces it.
    const next = mutate(copySecrets(current.secrets))
    if (next !== null) await write(next)
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
        await update(
          (current) => {
            current[key] = value
            return current
          },
          { writing: true },
        )
      }),

    clear: (key) =>
      serialize(() =>
        update(
          // Rebuilt without `key`, so the secret is removed rather than blanked.
          (current) => (current[key] === undefined ? null : without(current, key)),
          { writing: false },
        ),
      ),

    setRtspUrls: (streamId, urls) =>
      serialize(async () => {
        // The id becomes an object key: the `rtsp-<uuid>` pattern also keeps out `__proto__` & co.
        if (!RTSP_STREAM_ID_PATTERN.test(streamId)) {
          throw new SecretsError('invalid-value', 'The stream id is not valid; nothing was stored.')
        }
        const clean: RtspStreamUrls = {}
        for (const quality of RTSP_QUALITIES) {
          const url = urls[quality]
          if (url === undefined) continue
          // Fixed text only: the URL is a secret and must not reach an error or a log (CON-2).
          if (!validateRtspUrl(url).ok) {
            throw new SecretsError(
              'invalid-value',
              `The ${quality} quality stream address is not a valid rtsp:// or rtsps:// address; ` +
                'nothing was stored.',
            )
          }
          clean[quality] = url
        }
        const removing = Object.keys(clean).length === 0
        // Removing a stream's last URL is a clear: it must work without a keystore too (see `write`).
        await update(
          (current) => {
            const rtspUrls = current.rtspUrls ?? {}
            if (removing) {
              if (!Object.hasOwn(rtspUrls, streamId)) return null
              return withRtspUrls(current, withoutStream(rtspUrls, streamId))
            }
            return withRtspUrls(current, { ...rtspUrls, [streamId]: clean })
          },
          { writing: !removing },
        )
      }),

    clearRtspStream: (streamId) =>
      serialize(() =>
        update(
          (current) => {
            if (current.rtspUrls === undefined || !Object.hasOwn(current.rtspUrls, streamId))
              return null
            return withRtspUrls(current, withoutStream(current.rtspUrls, streamId))
          },
          { writing: false },
        ),
      ),

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

/** Every stored secret but `omit`. The stream URLs are kept. */
function without(secrets: Secrets, omit: SecretKey): Secrets {
  const out: Secrets = {}
  for (const key of SECRET_KEYS) {
    const value = secrets[key]
    if (key !== omit && value !== undefined) out[key] = value
  }
  if (secrets.rtspUrls !== undefined) out.rtspUrls = secrets.rtspUrls
  return out
}

/** A copy deep enough that mutating its `rtspUrls` map cannot touch the original. */
function copySecrets(secrets: Secrets): Secrets {
  const out: Secrets = { ...secrets }
  if (secrets.rtspUrls !== undefined) out.rtspUrls = { ...secrets.rtspUrls }
  return out
}

/** Every stream's URLs but `streamId`'s, rebuilt rather than deleted from. */
function withoutStream(rtspUrls: RtspUrls, streamId: string): RtspUrls {
  return Object.fromEntries(Object.entries(rtspUrls).filter(([id]) => id !== streamId))
}

/** `secrets` with `rtspUrls` replaced, or removed when it is empty (never stored as `{}`). */
function withRtspUrls(secrets: Secrets, rtspUrls: RtspUrls): Secrets {
  const out: Secrets = { ...secrets }
  if (Object.keys(rtspUrls).length === 0) delete out.rtspUrls
  else out.rtspUrls = rtspUrls
  return out
}

/** Nothing left to store: the file is removed rather than written. */
function isEmpty(secrets: Secrets): boolean {
  return (
    SECRET_KEYS.every((key) => secrets[key] === undefined) &&
    Object.keys(secrets.rtspUrls ?? {}).length === 0
  )
}

/** Drops explicit `undefined`s and anything outside `SECRET_KEYS` and `rtspUrls`. */
function pickSecrets(parsed: z.infer<typeof ReadSecretsSchema>): Secrets {
  const out: Secrets = {}
  for (const key of SECRET_KEYS) {
    const value = parsed[key]
    if (value !== undefined) out[key] = value
  }
  const rtspUrls = pickRtspUrls(parsed.rtspUrls)
  if (rtspUrls !== undefined) out.rtspUrls = rtspUrls
  return out
}

/**
 * RTSP-2/RTSP-5 on read: keeps only the URLs that pass `validateRtspUrl`. A URL that fails is
 * dropped with its quality, and a stream left with none is dropped too, so a bad entry never costs
 * the API key, the token or the other streams. `undefined` when no stream has a usable URL.
 */
function pickRtspUrls(stored: z.infer<typeof ReadSecretsSchema>['rtspUrls']): RtspUrls | undefined {
  if (stored === undefined) return undefined
  const out: RtspUrls = {}
  for (const [streamId, urls] of Object.entries(stored)) {
    // Same id rule as config.json (RTSP-2); it also keeps `__proto__` & co. out of the map.
    if (!RTSP_STREAM_ID_PATTERN.test(streamId)) continue
    const kept: RtspStreamUrls = {}
    for (const quality of RTSP_QUALITIES) {
      const url = urls[quality]
      if (typeof url === 'string' && validateRtspUrl(url).ok) kept[quality] = url
    }
    if (Object.keys(kept).length > 0) out[streamId] = kept
  }
  return Object.keys(out).length > 0 ? out : undefined
}
