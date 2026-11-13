// P1.1: the safeStorage-backed secrets store (src/main/secrets/secrets.ts). The crypto port is
// injected, so these run in plain Node with no Electron: the real `safeStorage` is adapted at the
// app edge. Covers CON-2 end to end — no plaintext on disk, no plaintext fallback when the keystore
// is unavailable, and no secret in any error, message or inspected value.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSecretsStore,
  SecretsError,
  SECRETS_FILE_NAME,
  safeStorageCrypto,
  type CryptoPort,
} from '../../src/main/secrets/secrets'

const API_KEY = 'protect-key-QQQQ-never-log-me'
const TOKEN = 'access-token-WWWW-never-log-me'

const MARKER = 'vp1:'

/**
 * Stand-in for the OS keystore. Reversible but not readable, so "no plaintext on disk" is a real
 * assertion: the bytes are the marker plus the reversed UTF-8 of the payload.
 */
function fakeKeystore(
  options: { available?: boolean; encryptError?: string } = {},
): CryptoPort & { encryptCalls: number } {
  const available = options.available ?? true
  const port: CryptoPort & { encryptCalls: number } = {
    encryptCalls: 0,
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string): Uint8Array => {
      port.encryptCalls += 1
      if (options.encryptError !== undefined) {
        // A hostile/clumsy keystore that quotes the plaintext in its own error.
        throw new Error(`${options.encryptError}: ${plainText}`)
      }
      return Buffer.concat([Buffer.from(MARKER), Buffer.from(plainText, 'utf8').reverse()])
    },
    decryptString: (encrypted: Uint8Array): string => {
      const buf = Buffer.from(encrypted)
      if (!buf.subarray(0, MARKER.length).equals(Buffer.from(MARKER))) {
        throw new Error('not encrypted by this keystore')
      }
      return Buffer.from(buf.subarray(MARKER.length)).reverse().toString('utf8')
    },
  }
  return port
}

/** What the fake wrote, decoded the way the fake would. */
function decode(bytes: Buffer): unknown {
  const parsed: unknown = JSON.parse(fakeKeystore().decryptString(bytes))
  return parsed
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'view-protect-secrets-'))
  path = join(dir, SECRETS_FILE_NAME)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('read, set, get', () => {
  it('stores and reads each secret independently (CON-1)', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    expect(store.path).toBe(path)
    expect(await store.read()).toEqual({ status: 'empty', secrets: {} })
    expect(await store.get('protectApiKey')).toBeUndefined()

    await store.set('protectApiKey', API_KEY)
    expect(await store.get('protectApiKey')).toBe(API_KEY)
    expect(await store.get('accessToken')).toBeUndefined()

    await store.set('accessToken', TOKEN)
    expect(await store.read()).toEqual({
      status: 'ok',
      secrets: { protectApiKey: API_KEY, accessToken: TOKEN },
    })
  })

  it('overwrites one secret without disturbing the other', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    await store.set('accessToken', TOKEN)
    await store.set('protectApiKey', 'rotated-key')
    expect(await store.read()).toEqual({
      status: 'ok',
      secrets: { protectApiKey: 'rotated-key', accessToken: TOKEN },
    })
  })

  it('keeps no plaintext on disk and leaves no temp file (CON-2)', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    const bytes = await readFile(path)
    expect(bytes.includes(API_KEY)).toBe(false)
    expect(bytes.toString('utf8')).not.toContain(API_KEY)
    expect(decode(bytes)).toEqual({ protectApiKey: API_KEY })
    expect(await readdir(dir)).toEqual([SECRETS_FILE_NAME])
  })

  it.skipIf(process.platform === 'win32')('writes the file 0600 (NFR-9)', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('refuses an empty value instead of storing a blank secret', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await expect(store.set('accessToken', '')).rejects.toMatchObject({ code: 'invalid-value' })
    expect(await store.read()).toEqual({ status: 'empty', secrets: {} })
  })

  it('serializes overlapping writes, so neither secret is lost', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await Promise.all([store.set('protectApiKey', API_KEY), store.set('accessToken', TOKEN)])
    expect(await store.read()).toEqual({
      status: 'ok',
      secrets: { protectApiKey: API_KEY, accessToken: TOKEN },
    })
  })
})

describe('clear', () => {
  it('removes the key rather than blanking it', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    await store.set('accessToken', TOKEN)
    await store.clear('accessToken')
    expect(decode(await readFile(path))).toEqual({ protectApiKey: API_KEY })
    expect(await store.get('accessToken')).toBeUndefined()
  })

  it('deletes the file once nothing is left', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    await store.clear('protectApiKey')
    expect(await readdir(dir)).toEqual([])
    expect(await store.read()).toEqual({ status: 'empty', secrets: {} })
  })

  it('is a no-op when there is nothing stored', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.clear('protectApiKey')
    await store.clearAll()
    expect(await readdir(dir)).toEqual([])
  })

  it('clearAll removes everything', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    await store.set('accessToken', TOKEN)
    await store.clearAll()
    expect(await readdir(dir)).toEqual([])
  })

  it('discards a file it cannot decrypt (nothing in it is recoverable)', async () => {
    await writeFile(path, 'rubbish')
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.clear('protectApiKey')
    expect(await readdir(dir)).toEqual([])
  })
})

describe('encryption unavailable (CON-2)', () => {
  it('refuses to write and never falls back to plaintext', async () => {
    const keystore = fakeKeystore({ available: false })
    const store = createSecretsStore({ dir, crypto: keystore })
    expect(store.isEncryptionAvailable()).toBe(false)

    const error = await store.set('protectApiKey', API_KEY).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(SecretsError)
    expect(error).toMatchObject({ code: 'encryption-unavailable' })
    if (error instanceof SecretsError) expect(error.message).toContain('keystore')
    // Nothing was written, and the keystore was never asked to encrypt.
    expect(await readdir(dir)).toEqual([])
    expect(keystore.encryptCalls).toBe(0)
  })

  it('leaves an existing file alone when the keystore disappears', async () => {
    await createSecretsStore({ dir, crypto: fakeKeystore() }).set('protectApiKey', API_KEY)
    const before = await readFile(path)
    const store = createSecretsStore({ dir, crypto: fakeKeystore({ available: false }) })
    await expect(store.set('accessToken', TOKEN)).rejects.toBeInstanceOf(SecretsError)
    expect(await readFile(path)).toEqual(before)
  })
})

describe('a secrets.bin it cannot use', () => {
  it('reads as "no secrets stored" with a warning, and never throws', async () => {
    await writeFile(path, 'not encrypted by anything')
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    const result = await store.read()
    expect(result).toMatchObject({ status: 'unreadable', secrets: {} })
    if (result.status === 'unreadable') {
      expect(result.problem).toContain('could not be decrypted')
      expect(result.problem).toContain('Settings')
    }
    expect(await store.get('protectApiKey')).toBeUndefined()
  })

  it('treats an empty file as nothing stored', async () => {
    await writeFile(path, '')
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    expect(await store.read()).toEqual({ status: 'empty', secrets: {} })
  })

  it('treats a decryptable blob that is not the expected shape as unusable', async () => {
    const keystore = fakeKeystore()
    for (const payload of [
      'not json at all',
      '{"protectApiKey":5}',
      '{"protectApiKey":""}',
      '[]',
    ]) {
      await writeFile(path, keystore.encryptString(payload))
      const result = await createSecretsStore({ dir, crypto: keystore }).read()
      expect(result.status).toBe('unreadable')
      if (result.status === 'unreadable') expect(result.problem).toContain('did not contain')
    }
  })

  it('ignores keys it does not know', async () => {
    const keystore = fakeKeystore()
    await writeFile(path, keystore.encryptString(`{"protectApiKey":"${API_KEY}","other":"x"}`))
    const result = await createSecretsStore({ dir, crypto: keystore }).read()
    expect(result).toEqual({ status: 'ok', secrets: { protectApiKey: API_KEY } })
  })

  it('is replaced by the next successful write', async () => {
    await writeFile(path, 'rubbish')
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    expect(await store.read()).toEqual({ status: 'ok', secrets: { protectApiKey: API_KEY } })
  })
})

describe('secrets never leak into errors or output (CON-2)', () => {
  /** Every place a value could surface: message, stack, String(), JSON and util.inspect. */
  function textOf(value: unknown): string {
    const parts = [String(value), inspect(value, { depth: 8 }), JSON.stringify(value)]
    if (value instanceof Error) parts.push(value.message, value.stack ?? '')
    return parts.join('\n')
  }

  it('drops the keystore’s own message when encryption fails', async () => {
    const store = createSecretsStore({
      dir,
      crypto: fakeKeystore({ encryptError: 'keychain said no' }),
    })
    const error = await store.set('protectApiKey', API_KEY).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(SecretsError)
    expect(error).toMatchObject({ code: 'crypto-failed' })
    expect(textOf(error)).not.toContain(API_KEY)
    // No `cause` chain either: a logger would walk it.
    expect(error instanceof Error ? error.cause : undefined).toBeUndefined()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps the secret out of a decrypt failure report', async () => {
    // Decryptable, but not the expected JSON: Node's JSON.parse message quotes its input.
    const keystore = fakeKeystore()
    await writeFile(path, keystore.encryptString(`{"protectApiKey": ${API_KEY}}`))
    const result = await createSecretsStore({ dir, crypto: keystore }).read()
    expect(result.status).toBe('unreadable')
    expect(textOf(result)).not.toContain(API_KEY)
  })

  it('holds no secret in the store object itself', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await store.set('protectApiKey', API_KEY)
    await store.set('accessToken', TOKEN)
    expect(await store.get('protectApiKey')).toBe(API_KEY)
    for (const secret of [API_KEY, TOKEN]) expect(textOf(store)).not.toContain(secret)
  })

  it('keeps the empty-value error free of the key’s value', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    const error = await store.set('accessToken', '').catch((err: unknown) => err)
    expect(textOf(error)).toContain('accessToken')
    expect(textOf(error)).not.toContain(API_KEY)
  })
})

describe('safeStorageCrypto', () => {
  it('adapts Electron’s Buffer-based safeStorage to the injected port', () => {
    const calls: string[] = []
    const port = safeStorageCrypto({
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => {
        calls.push(`encrypt:${plainText}`)
        return Buffer.from(plainText, 'utf8')
      },
      decryptString: (encrypted) => {
        // Electron's signature wants a Buffer, whatever the port was handed.
        expect(Buffer.isBuffer(encrypted)).toBe(true)
        return encrypted.toString('utf8')
      },
    })
    expect(port.isEncryptionAvailable()).toBe(true)
    expect(Buffer.from(port.encryptString('secret')).toString('utf8')).toBe('secret')
    expect(port.decryptString(new Uint8Array([0x68, 0x69]))).toBe('hi')
    expect(calls).toEqual(['encrypt:secret'])
  })
})

// A file that cannot be *read* is not the same as a file whose contents are unusable. Using a
// directory where secrets.bin belongs makes every read fail with EISDIR on every platform, which
// is a deterministic stand-in for a lock or a permissions change.
describe('a secrets.bin that cannot be read', () => {
  beforeEach(async () => {
    await mkdir(path)
  })

  it('reads as io-error, not as "nothing stored"', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    const result = await store.read()
    expect(result.status).toBe('io-error')
    expect(result.secrets).toEqual({})
  })

  it('refuses to set a secret rather than replacing what it could not read', async () => {
    const keystore = fakeKeystore()
    const store = createSecretsStore({ dir, crypto: keystore })
    await expect(store.set('protectApiKey', API_KEY)).rejects.toMatchObject({
      name: 'SecretsError',
      code: 'read-failed',
    })
    // Nothing was written, and the keystore was never asked to encrypt: a transient read failure
    // must not cost the user the other stored secret (CON-1).
    expect(keystore.encryptCalls).toBe(0)
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it('refuses to clear one secret rather than deleting the file', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    await expect(store.clear('accessToken')).rejects.toMatchObject({ code: 'read-failed' })
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it('reports a failed clearAll instead of claiming the secret is gone', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    // A swallowed EPERM/EISDIR here would tell the user their credential was removed while it is
    // still on disk.
    await expect(store.clearAll()).rejects.toThrow()
  })

  it('still contains no secret in the error it throws', async () => {
    const store = createSecretsStore({ dir, crypto: fakeKeystore() })
    const err: unknown = await store.set('protectApiKey', API_KEY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecretsError)
    const text = `${String(err)} ${err instanceof Error ? (err.stack ?? '') : ''} ${inspect(err)}`
    expect(text).not.toContain(API_KEY)
  })
})
