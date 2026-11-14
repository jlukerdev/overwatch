// P1.5: the main-process IPC router (src/main/ipc/handlers.ts).
//
// `createIpcRouter` is a pure function of its dependencies, so these tests call the handlers the way
// `ipcMain` would — one payload in, one `IpcResult` out — with a fake services object, a fake
// connection manager and no Electron anywhere.
//
// Four properties are the point of the file, and each one is a bug that would otherwise reach the
// renderer: every reply matches the channel's own `value` schema, a bad payload is refused before
// anything happens (CLAUDE.md), a call that arrives before the services exist says `not-ready`
// rather than throwing, and the CON-3 certificate flow refuses a fingerprint that is no longer the
// one the user was shown.
import { IPC, IPC_CHANNELS, ipcResultSchema, type IpcError, type IpcResult } from '@shared/ipc'
import { CameraSchema, ConsoleConfigSchema } from '@shared/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema, type Config } from '../../src/main/config/schema'
import type { ConnectionManager } from '../../src/main/connection'
import {
  createIpcRouter,
  registerIpcHandlers,
  type IpcHandler,
  type IpcHandlerServices,
  type IpcMainLike,
} from '../../src/main/ipc/handlers'
import { AccessApiError } from '../../src/main/access/client'
import { ConsoleEndpointError } from '../../src/main/console/endpoints'
import { toIpcError } from '../../src/main/ipc/errors'
import { ProtectApiError } from '../../src/main/protect/errors'
import { SecretsError } from '../../src/main/secrets/secrets'
import { PinMismatchError, PinRequiredError } from '../../src/main/tls/pinning'
import type { LeafCertInfo, PinCheckResult } from '../../src/main/tls/pinning'
import type { z } from 'zod'

const FP_A =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'
const FP_B =
  '0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9'

const API_KEY = 'vp-test-api-key-NEVER-LOG-THIS'

function leaf(fingerprint256: string, hostPort = '192.0.2.10:443'): LeafCertInfo {
  return {
    host: hostPort.split(':')[0] ?? '',
    port: Number(hostPort.split(':')[1] ?? '443'),
    hostPort,
    fingerprint256,
    subjectCommonName: 'UniFi Dream Machine',
    issuerCommonName: 'UniFi Dream Machine',
    validFrom: 'Dec  5 00:00:00 2024 GMT',
    validTo: 'Dec  5 00:00:00 2026 GMT',
    selfSigned: true,
  }
}

const EMPTY_STATUS = {
  protect: { endpoint: 'protect' as const, phase: 'idle' as const, updatedAt: 1 },
  access: { endpoint: 'access' as const, phase: 'disabled' as const, updatedAt: 1 },
}

/** The error `pinning.ts` raises for a stored value that is not a fingerprint at all. */
const UNUSABLE_PIN_ERROR = new Error(
  'The stored TLS pin for 192.0.2.10:443 is not a SHA-256 fingerprint. Re-accept the certificate ' +
    'in Settings (repin) to replace it.',
)

interface SetupOptions {
  readonly keystore?: boolean
  readonly check?: PinCheckResult
  /** `config.json` holds something that is not a fingerprint, so the pin cannot be compared. */
  readonly brokenPin?: boolean
  /** What the endpoint presents on the wire right now. */
  readonly presented?: string
}

function setup(options: SetupOptions = {}) {
  let current: Config = ConfigSchema.parse({
    schemaVersion: 1,
    console: ConsoleConfigSchema.parse({ host: '192.0.2.10', certFingerprint: FP_A }),
  })
  const secrets = {
    isEncryptionAvailable: vi.fn(() => options.keystore ?? true),
    set: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  }
  const check: PinCheckResult = options.check ?? {
    state: 'no-pin',
    endpoint: { host: '192.0.2.10', port: 443, hostPort: '192.0.2.10:443' },
    cert: leaf(FP_A),
  }
  const pins = {
    // Both of these throw for an unusable stored pin, exactly as the real registry does: it refuses
    // to read such a value as "unpinned", because that would silently trust the next certificate.
    checkEndpoint: vi.fn(() =>
      options.brokenPin ? Promise.reject(UNUSABLE_PIN_ERROR) : Promise.resolve(check),
    ),
    pinnedFingerprint: vi.fn(() => {
      if (options.brokenPin) throw UNUSABLE_PIN_ERROR
      return check.state === 'no-pin' ? null : FP_A
    }),
    acceptPin: vi.fn(),
    repin: vi.fn(),
  }
  /** The leaf read straight off the wire, with no stored pin involved. */
  const readLeaf = vi.fn((host: string, port: number) =>
    Promise.resolve(leaf(options.presented ?? FP_A, `${host}:${String(port)}`)),
  )
  const services: IpcHandlerServices = {
    secrets,
    credentials: { protectApiKey: API_KEY },
    get current() {
      return current
    },
    pins,
  }
  const manager = {
    status: vi.fn(() => ConnectionStatusFromDefaults()),
    cachedCameras: vi.fn(() => [CameraSchema.parse({ id: 'cam-1' })]),
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    testConnection: vi.fn(() =>
      Promise.resolve({
        protect: { state: 'ok' as const, applicationVersion: '7.3.74' },
        access: { state: 'disabled' as const },
        connection: ConnectionStatusFromDefaults(),
      }),
    ),
    cameras: vi.fn(() => Promise.resolve([CameraSchema.parse({ id: 'cam-1' })])),
    snapshot: vi.fn(() =>
      Promise.resolve({
        state: 'ok' as const,
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3]),
        capturedAt: 7,
      }),
    ),
    applyConsoleChange: vi.fn((next: Config['console']) => {
      current = { ...current, console: next }
      return Promise.resolve()
    }),
    credentialCleared: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
  } satisfies ConnectionManager

  let ready = true
  const router = createIpcRouter({
    getServices: () => (ready ? services : null),
    getManager: () => (ready ? manager : null),
    appVersion: () => '0.1.0',
    readLeaf,
  })

  return {
    router,
    services,
    secrets,
    pins,
    readLeaf,
    manager,
    get console() {
      return current.console
    },
    setReady(next: boolean) {
      ready = next
    },
    /** Calls a channel the way `ipcMain` would, and checks the reply against its value schema. */
    async call<Value>(
      spec: { readonly channel: string },
      payload?: unknown,
    ): Promise<IpcResult<Value>> {
      const result = await handlerFor(router, spec.channel)(payload)
      // The preload validates this for real; doing it here means a handler cannot answer with a
      // shape the renderer would reject.
      ipcResultSchema(valueSchemaFor(spec.channel)).parse(result)
      return result as IpcResult<Value>
    },
  }
}

/** The channel table by channel string, so `call` can validate without a second lookup table. */
const IPC_VALUE = new Map<string, z.ZodType>(
  Object.values(IPC).map((entry) => [entry.channel, entry.value as z.ZodType]),
)

function valueSchemaFor(channel: string): z.ZodType {
  const schema = IPC_VALUE.get(channel)
  if (schema === undefined) throw new Error(`${channel} is not in the channel table`)
  return schema
}

function handlerFor(router: ReadonlyMap<string, IpcHandler>, channel: string): IpcHandler {
  const handler = router.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return handler
}

function ConnectionStatusFromDefaults() {
  return {
    protect: {
      ...EMPTY_STATUS.protect,
      hostPort: '192.0.2.10:443',
      pinned: true,
      credentialStored: true,
      version: null,
      error: null,
    },
    access: {
      ...EMPTY_STATUS.access,
      hostPort: '192.0.2.10:12445',
      pinned: false,
      credentialStored: false,
      version: null,
      error: null,
    },
  }
}

type Harness = ReturnType<typeof setup>

/** The error of a failed result, for an assertion that reads as one line. */
function failure(result: IpcResult<unknown>): IpcError {
  if (result.ok) throw new Error('expected a failure')
  return result.error
}

let h: Harness

beforeEach(() => {
  h = setup()
})

describe('the router', () => {
  it('has one handler per channel in the contract', () => {
    expect([...h.router.keys()].sort()).toEqual([...IPC_CHANNELS].sort())
  })
})

describe('request validation (CLAUDE.md)', () => {
  // One bad payload per channel: main validates even though the preload did, because the preload is
  // not a trust boundary main controls.
  const cases: { channel: string; payload: unknown; why: string }[] = [
    { channel: IPC.getState.channel, payload: 'nope', why: 'an argument where there is none' },
    { channel: IPC.setConsole.channel, payload: {}, why: 'a console block with no fields' },
    {
      channel: IPC.setSecret.channel,
      payload: { key: 'protectApiKey', value: '   ' },
      why: 'a credential that is only whitespace',
    },
    { channel: IPC.clearSecret.channel, payload: { key: 'passphrase' }, why: 'an unknown key' },
    {
      channel: IPC.checkCertificate.channel,
      payload: { endpoint: 'nvr' },
      why: 'no such endpoint',
    },
    {
      channel: IPC.acceptCertificate.channel,
      payload: { endpoint: 'protect' },
      why: 'no fingerprint to accept',
    },
    {
      channel: IPC.repinCertificate.channel,
      payload: { endpoint: 'protect', fingerprint256: '' },
      why: 'an empty fingerprint',
    },
    { channel: IPC.testConnection.channel, payload: 1, why: 'an argument where there is none' },
    { channel: IPC.connect.channel, payload: {}, why: 'an argument where there is none' },
    { channel: IPC.disconnect.channel, payload: 'stop', why: 'an argument where there is none' },
    { channel: IPC.listCameras.channel, payload: null, why: 'an argument where there is none' },
    { channel: IPC.snapshot.channel, payload: { cameraId: '' }, why: 'no camera id' },
  ]

  for (const { channel, payload, why } of cases) {
    it(`refuses ${channel} with ${why}`, async () => {
      const result = await handlerFor(h.router, channel)(payload)
      expect(failure(result).kind).toBe('invalid-request')
      expect(failure(result).message).toContain(channel)
    })
  }

  it('acts on nothing when the payload is refused', async () => {
    await handlerFor(h.router, IPC.setSecret.channel)({ key: 'protectApiKey', value: '' })
    expect(h.secrets.set).not.toHaveBeenCalled()
  })
})

describe('before the services exist', () => {
  for (const channel of IPC_CHANNELS) {
    it(`answers not-ready on ${channel}`, async () => {
      h.setReady(false)
      // A valid-looking payload, so this is the not-ready check and not validation.
      const result = await handlerFor(h.router, channel)(payloadFor(channel))
      expect(failure(result).kind).toBe('not-ready')
      expect(failure(result).retryable).toBe(true)
    })
  }
})

/** A payload each channel accepts, for the tests that are not about validation. */
function payloadFor(channel: string): unknown {
  switch (channel) {
    case IPC.setConsole.channel:
      return { host: '192.0.2.10', accessEnabled: false, accessBaseUrl: null }
    case IPC.setSecret.channel:
      return { key: 'protectApiKey', value: API_KEY }
    case IPC.clearSecret.channel:
      return { key: 'protectApiKey' }
    case IPC.checkCertificate.channel:
      return { endpoint: 'protect' }
    case IPC.acceptCertificate.channel:
    case IPC.repinCertificate.channel:
      return { endpoint: 'protect', fingerprint256: FP_A }
    case IPC.snapshot.channel:
      return { cameraId: 'cam-1', highQuality: false }
    default:
      return undefined
  }
}

describe('getState (contract rule 3)', () => {
  it('builds the whole state, with the version injected rather than imported', async () => {
    const result = await h.call(IPC.getState)
    expect(result).toMatchObject({
      ok: true,
      value: {
        version: '0.1.0',
        keystoreAvailable: true,
        secretsStored: { protectApiKey: true, accessToken: false },
      },
    })
  })

  it('leaves the schemaVersion envelope out of settings, and the secrets out of everything', async () => {
    const result = await h.call(IPC.getState)
    const value = result.ok ? result.value : null
    expect(value).not.toBeNull()
    expect(JSON.stringify(value)).not.toContain('schemaVersion')
    expect(JSON.stringify(value)).not.toContain(API_KEY)
  })
})

describe('setConsole (CON-1, DOOR-0)', () => {
  it('hands the manager the edited block with the stored fingerprints carried over', async () => {
    await h.call(IPC.setConsole, {
      host: 'udm.local',
      accessEnabled: true,
      accessBaseUrl: null,
    })
    expect(h.manager.applyConsoleChange).toHaveBeenCalledWith({
      host: 'udm.local',
      accessEnabled: true,
      accessBaseUrl: null,
      // Not writable from a settings form: only the CON-3 flow may pin anything.
      certFingerprint: FP_A,
      accessCertFingerprint: null,
    })
  })

  it('refuses an Access API URL that is not https, rather than upgrading it (CON-2)', async () => {
    const result = await h.call(IPC.setConsole, {
      host: 'udm.local',
      accessEnabled: true,
      accessBaseUrl: 'http://192.0.2.10:12445/api/v1/developer',
    })
    expect(failure(result).kind).toBe('invalid-request')
    expect(h.manager.applyConsoleChange).not.toHaveBeenCalled()
  })

  it('answers with the new state, read after the save', async () => {
    const result = await h.call(IPC.setConsole, {
      host: 'udm.local',
      accessEnabled: false,
      accessBaseUrl: null,
    })
    expect(
      result.ok &&
        (result.value as { settings: { console: { host: string } } }).settings.console.host,
    ).toBe('udm.local')
  })
})

describe('setSecret / clearSecret (CON-1/2)', () => {
  it('stores the credential and updates the live set the clients read', async () => {
    const result = await h.call(IPC.setSecret, { key: 'accessToken', value: ' token ' })
    // Trimmed by the contract's schema, because a pasted key often carries a newline.
    expect(h.secrets.set).toHaveBeenCalledWith('accessToken', 'token')
    expect(h.services.credentials.accessToken).toBe('token')
    expect(
      result.ok &&
        (result.value as { secretsStored: { accessToken: boolean } }).secretsStored.accessToken,
    ).toBe(true)
  })

  it('refuses to store anything while the keystore is unavailable (CON-2)', async () => {
    const noKeystore = setup({ keystore: false })
    const result = await noKeystore.call(IPC.setSecret, {
      key: 'protectApiKey',
      value: API_KEY,
    })
    expect(failure(result).kind).toBe('internal')
    expect(failure(result).message).toMatch(/cannot be stored/)
    expect(noKeystore.secrets.set).not.toHaveBeenCalled()
  })

  it('removes the credential rather than blanking it', async () => {
    await h.call(IPC.clearSecret, { key: 'protectApiKey' })
    expect(h.secrets.clear).toHaveBeenCalledWith('protectApiKey')
    expect('protectApiKey' in h.services.credentials).toBe(false)
  })

  it('closes the devices feed when the key it authenticates with is deleted (CON-1/2)', async () => {
    // Nothing may keep running on a credential the user has just removed: a socket that outlives
    // the key looks fine until the next launch, when it silently will not reconnect.
    await h.call(IPC.clearSecret, { key: 'protectApiKey' })
    expect(h.manager.credentialCleared).toHaveBeenCalledTimes(1)
  })

  it('has nothing to stop when the Access token is cleared (DOOR-0)', async () => {
    await h.call(IPC.clearSecret, { key: 'accessToken' })
    expect(h.manager.credentialCleared).not.toHaveBeenCalled()
  })

  it('clears even when the keystore is gone, so a stored secret can always be removed', async () => {
    const noKeystore = setup({ keystore: false })
    const result = await noKeystore.call(IPC.clearSecret, { key: 'protectApiKey' })
    expect(result.ok).toBe(true)
  })

  it('reports a keystore failure as a value, not as a throw', async () => {
    h.secrets.set.mockRejectedValueOnce(
      new SecretsError('crypto-failed', 'The OS keystore failed to encrypt secrets.bin.'),
    )
    const result = await h.call(IPC.setSecret, { key: 'protectApiKey', value: API_KEY })
    expect(failure(result).kind).toBe('internal')
  })
})

describe('checkCertificate (CON-3)', () => {
  it('trims the leaf to what the dialog shows', async () => {
    const result = await h.call(IPC.checkCertificate, { endpoint: 'protect' })
    expect(result).toEqual({
      ok: true,
      value: {
        state: 'no-pin',
        cert: {
          hostPort: '192.0.2.10:443',
          fingerprint256: FP_A,
          subjectCommonName: 'UniFi Dream Machine',
          issuerCommonName: 'UniFi Dream Machine',
          validFrom: 'Dec  5 00:00:00 2024 GMT',
          validTo: 'Dec  5 00:00:00 2026 GMT',
          selfSigned: true,
        },
      },
    })
  })

  it('reports a mismatch with both fingerprints and a message ready to show', async () => {
    const mismatch = setup({
      check: {
        state: 'mismatch',
        endpoint: { host: '192.0.2.10', port: 443, hostPort: '192.0.2.10:443' },
        expected: FP_A,
        actual: FP_B,
        cert: leaf(FP_B),
        message: 'TLS certificate pin mismatch for 192.0.2.10:443.',
      },
    })
    const result = await mismatch.call(IPC.checkCertificate, { endpoint: 'protect' })
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'mismatch', expected: FP_A, actual: FP_B },
    })
  })

  it('falls back to the leaf when the stored pin is unusable, so a re-pin is reachable', async () => {
    // `config.json` only requires a non-empty string here, so a hand-edited or truncated value is
    // possible. Answering with the registry's throw would strand the endpoint: its own error text
    // tells the user to re-pin, and the UI can only offer that from a `mismatch`.
    const broken = setup({ brokenPin: true })
    const result = await broken.call(IPC.checkCertificate, { endpoint: 'protect' })
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'mismatch', actual: FP_A, cert: { fingerprint256: FP_A } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { expected: string; message: string }
      expect(value.expected).toMatch(/not a SHA-256 fingerprint/)
      expect(value.message).toMatch(/re-pin/i)
    }
  })

  it('answers not-configured while there is no usable address (CON-1)', async () => {
    const unset = setup()
    await unset.call(IPC.setConsole, { host: '', accessEnabled: false, accessBaseUrl: null })
    const result = await unset.call(IPC.checkCertificate, { endpoint: 'protect' })
    expect(failure(result).kind).toBe('not-configured')
  })
})

describe('acceptCertificate (CON-3)', () => {
  it('pins the fingerprint the user accepted', async () => {
    const result = await h.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(result.ok).toBe(true)
    expect(h.pins.acceptPin).toHaveBeenCalledWith('192.0.2.10', 443, FP_A)
  })

  it('re-reads the leaf and refuses a fingerprint that no longer matches', async () => {
    // The certificate was swapped between the dialog opening and the click: pinning what the
    // console presents *now* would trust a certificate the user never saw.
    const result = await h.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_B,
    })
    expect(failure(result).kind).toBe('pin-mismatch')
    expect(failure(result).endpoint).toBe('192.0.2.10:443')
    expect(h.pins.acceptPin).not.toHaveBeenCalled()
  })

  it('is an error on an already-pinned endpoint rather than a silent re-pin', async () => {
    const pinned = setup({
      check: {
        state: 'match',
        endpoint: { host: '192.0.2.10', port: 443, hostPort: '192.0.2.10:443' },
        fingerprint256: FP_A,
        cert: leaf(FP_A),
      },
    })
    const result = await pinned.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(result.ok).toBe(false)
    expect(pinned.pins.acceptPin).not.toHaveBeenCalled()
  })

  it('refuses while the stored pin and the presented certificate disagree', async () => {
    const mismatch = setup({
      check: {
        state: 'mismatch',
        endpoint: { host: '192.0.2.10', port: 443, hostPort: '192.0.2.10:443' },
        expected: FP_B,
        actual: FP_A,
        cert: leaf(FP_A),
        message: 'TLS certificate pin mismatch for 192.0.2.10:443.',
      },
    })
    const result = await mismatch.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(failure(result).kind).toBe('pin-mismatch')
    expect(mismatch.pins.acceptPin).not.toHaveBeenCalled()
  })

  it('does not accept over an unusable stored pin: that recovery is a re-pin (CON-3)', async () => {
    const broken = setup({ brokenPin: true })
    const result = await broken.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(result.ok).toBe(false)
    expect(broken.pins.acceptPin).not.toHaveBeenCalled()
  })

  it('reports the registry refusing the pin as a value', async () => {
    h.pins.acceptPin.mockImplementationOnce(() => {
      throw new Error('192.0.2.10:443 is already pinned to a different certificate.')
    })
    const result = await h.call(IPC.acceptCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(failure(result).kind).toBe('internal')
  })
})

describe('repinCertificate (CON-3)', () => {
  it('recovers an endpoint whose stored pin is not a fingerprint at all', async () => {
    // `repin()` is written to work whatever is stored (pinning.ts) — this is the state it exists
    // for — so the handler must not route through a comparison against the unusable value.
    const broken = setup({ brokenPin: true })
    const result = await broken.call(IPC.repinCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(result.ok).toBe(true)
    expect(broken.pins.repin).toHaveBeenCalledWith('192.0.2.10', 443, FP_A)
    // Read off the wire, not through the stored pin.
    expect(broken.readLeaf).toHaveBeenCalledWith('192.0.2.10', 443)
    expect(broken.pins.checkEndpoint).not.toHaveBeenCalled()
  })

  it('still re-reads the leaf in that state, and refuses a fingerprint that moved on', async () => {
    const broken = setup({ brokenPin: true, presented: FP_B })
    const result = await broken.call(IPC.repinCertificate, {
      endpoint: 'protect',
      fingerprint256: FP_A,
    })
    expect(failure(result).kind).toBe('pin-mismatch')
    expect(broken.pins.repin).not.toHaveBeenCalled()
  })

  it('replaces the pin once the presented certificate is confirmed', async () => {
    const result = await h.call(IPC.repinCertificate, { endpoint: 'protect', fingerprint256: FP_A })
    expect(result.ok).toBe(true)
    expect(h.pins.repin).toHaveBeenCalledWith('192.0.2.10', 443, FP_A)
  })

  it('refuses a fingerprint that is not the one presented now', async () => {
    const result = await h.call(IPC.repinCertificate, { endpoint: 'protect', fingerprint256: FP_B })
    expect(failure(result).kind).toBe('pin-mismatch')
    expect(h.pins.repin).not.toHaveBeenCalled()
  })
})

describe('the connection channels', () => {
  it('delegates connect and answers with the state', async () => {
    const result = await h.call(IPC.connect)
    expect(h.manager.connect).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  it('delegates disconnect', async () => {
    await h.call(IPC.disconnect)
    expect(h.manager.disconnect).toHaveBeenCalledTimes(1)
  })

  it('delegates testConnection and passes its two probes through', async () => {
    const result = await h.call(IPC.testConnection)
    expect(result).toMatchObject({
      ok: true,
      value: { protect: { state: 'ok' }, access: { state: 'disabled' } },
    })
  })

  it('delegates listCameras', async () => {
    const result = await h.call(IPC.listCameras)
    expect(h.manager.cameras).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  it('delegates snapshot with the validated input', async () => {
    await h.call(IPC.snapshot, { cameraId: 'cam-1', highQuality: true })
    expect(h.manager.snapshot).toHaveBeenCalledWith({ cameraId: 'cam-1', highQuality: true })
  })

  it('never throws out of a handler, whatever the manager does (contract rule 2)', async () => {
    h.manager.connect.mockRejectedValueOnce(new Error('something went wrong in main'))
    const result = await h.call(IPC.connect)
    expect(failure(result)).toMatchObject({
      kind: 'internal',
      message: 'something went wrong in main',
    })
  })
})

describe('registerIpcHandlers', () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      removeHandler: (channel) => {
        handlers.delete(channel)
      },
    }
    return { ipcMain, handlers }
  }

  it('binds every channel and removes every channel again', () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const dispose = registerIpcHandlers(ipcMain, h.router)
    expect([...handlers.keys()].sort()).toEqual([...IPC_CHANNELS].sort())
    dispose()
    expect(handlers.size).toBe(0)
    // Idempotent, so a second shutdown path cannot remove someone else's handler.
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('drops the Electron event and passes only the payload', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    registerIpcHandlers(ipcMain, h.router)
    const listener = handlers.get(IPC.snapshot.channel)
    expect(listener).toBeDefined()
    await listener?.({ sender: 'must not be used' }, { cameraId: 'cam-1', highQuality: false })
    expect(h.manager.snapshot).toHaveBeenCalledWith({ cameraId: 'cam-1', highQuality: false })
  })
})

describe('toIpcError (src/main/ipc/errors.ts)', () => {
  const cases: {
    name: string
    error: unknown
    kind: IpcError['kind']
    endpoint?: string | null
    retryable?: boolean
  }[] = [
    {
      name: 'an endpoint with no accepted certificate yet runs the CON-3 dialog',
      error: new PinRequiredError('192.0.2.10:443'),
      kind: 'pin-required',
      endpoint: '192.0.2.10:443',
    },
    {
      name: 'a certificate that does not match the pin is blocked, not re-pinned',
      error: new PinMismatchError({
        endpoint: '192.0.2.10:443',
        expected: FP_A,
        actual: FP_B,
      }),
      kind: 'pin-mismatch',
      endpoint: '192.0.2.10:443',
      retryable: false,
    },
    {
      name: "the client's single `pin` kind, when the cause is a missing pin",
      error: new ProtectApiError('pin', {
        kind: 'pin',
        endpoint: '192.0.2.10:443',
        // As `fetch` delivers it: the real reason is wrapped (P1.3).
        cause: new TypeError('fetch failed', { cause: new PinRequiredError('192.0.2.10:443') }),
      }),
      kind: 'pin-required',
    },
    {
      name: "the client's single `pin` kind, when the cause is a mismatch",
      error: new ProtectApiError('pin', {
        kind: 'pin',
        cause: new PinMismatchError({ expected: FP_A, actual: FP_B }),
      }),
      kind: 'pin-mismatch',
    },
    {
      name: 'a `pin` failure with no cause at all errs towards blocking',
      error: new ProtectApiError('pin', { kind: 'pin' }),
      kind: 'pin-mismatch',
    },
    {
      name: 'a subscription the console closed is a connection problem',
      error: new ProtectApiError('closed', { kind: 'closed', endpoint: '192.0.2.10:443' }),
      kind: 'network',
    },
    {
      name: 'a timeout keeps its retry affordance (CON-5)',
      error: new ProtectApiError('too slow', { kind: 'timeout' }),
      kind: 'timeout',
      retryable: true,
    },
    {
      name: 'Access being switched off (DOOR-0)',
      error: new AccessApiError('off', { kind: 'disabled', endpoint: '192.0.2.10:12445' }),
      kind: 'disabled',
      endpoint: '192.0.2.10:12445',
    },
    {
      name: 'an Access refusal, which the user fixes in Settings like any other 403',
      error: new AccessApiError('refused', { kind: 'forbidden' }),
      kind: 'auth',
    },
    {
      name: 'no usable console address (CON-1)',
      error: new ConsoleEndpointError('No console address is set yet.'),
      kind: 'not-configured',
    },
    {
      name: 'a keystore failure (CON-2)',
      error: new SecretsError('crypto-failed', 'The OS keystore failed to encrypt secrets.bin.'),
      kind: 'internal',
    },
    {
      name: 'anything else in main',
      error: new Error('something went wrong in main'),
      kind: 'internal',
    },
  ]

  for (const { name, error, kind, endpoint, retryable } of cases) {
    it(`maps ${name} to ${kind}`, () => {
      const mapped = toIpcError(error, { endpoint: null })
      expect(mapped.kind).toBe(kind)
      if (endpoint !== undefined) expect(mapped.endpoint).toBe(endpoint)
      if (retryable !== undefined) expect(mapped.retryable).toBe(retryable)
    })
  }

  it('reuses the error`s own message, which is already safe to show', () => {
    const error = new ProtectApiError('GET /v1/cameras failed with HTTP 401.', { kind: 'auth' })
    expect(toIpcError(error).message).toBe(error.message)
  })

  it('falls back to the caller`s endpoint when the failure does not name one', () => {
    const mapped = toIpcError(new ProtectApiError('boom', { kind: 'server' }), {
      endpoint: '192.0.2.10:443',
    })
    expect(mapped.endpoint).toBe('192.0.2.10:443')
  })

  it('never carries a stack, and says nothing specific about a non-Error', () => {
    const thrown = new Error('with a stack')
    expect(JSON.stringify(toIpcError(thrown))).not.toContain('ipcHandlers.test')
    expect(toIpcError('a bare string').message).toMatch(/unexpected error/)
  })
})
