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
import {
  IPC,
  IPC_CHANNELS,
  ipcResultSchema,
  emptyDoorsScreenState,
  type AppState,
  type DoorActionInput,
  type DoorActionResult,
  type DoorEmergencyInput,
  type DoorEmergencyResult,
  type DoorsScreenState,
  type IpcError,
  type IpcResult,
  type UnlockResult,
} from '@shared/ipc'
import {
  CameraSchema,
  ConsoleConfigSchema,
  DoorSchema,
  type Door,
  type DoorStates,
  type Settings,
} from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import type { RtspStreamUrls } from '@shared/rtsp'
import { streamHandle } from '@shared/streams'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'
import type { ConnectionManager } from '../../src/main/connection'
import {
  createIpcRouter,
  registerIpcHandlers,
  type IpcHandler,
  type IpcHandlerServices,
  type IpcMainLike,
} from '../../src/main/ipc/handlers'
import { AccessApiError } from '../../src/main/access/client'
import { AppModeError, RTSP_MODE_MESSAGES } from '../../src/main/appMode'
import { ConsoleEndpointError } from '../../src/main/console/endpoints'
import { toIpcError } from '../../src/main/ipc/errors'
import { ProtectApiError } from '../../src/main/protect/errors'
import { SecretsError } from '../../src/main/secrets/secrets'
import { withPerfGridQuality } from '../../src/main/perf/perfStats'
import {
  StreamRegistryError,
  type StreamRegistry,
  type StreamRegistryErrorKind,
} from '../../src/main/streams/registry'
import { RtspStreamError } from '../../src/main/streams/rtspStreams'
import { PinMismatchError, PinRequiredError } from '../../src/main/tls/pinning'
import type { LeafCertInfo, PinCheckResult } from '../../src/main/tls/pinning'
import type { z } from 'zod'

const FP_A =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'
const FP_B =
  '0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9'

const API_KEY = 'vp-test-api-key-NEVER-LOG-THIS'

/** The loopback runtime the fake registry builds its handles on (P2.1 takes a new port per launch). */
const GO2RTC_PORT = 18555
const GO2RTC_EPOCH = 3

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
/** A door as the manager hands it over (already trimmed by the Access client's `toDoor`). */
const FRONT_DOOR: Door = DoorSchema.parse({
  id: 'door-1',
  name: 'Front Door',
  fullName: 'Ground Floor - Front Door',
  floorId: 'floor-1',
  type: 'door',
  boundToHub: true,
  relay: 'lock',
  position: 'close',
})

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
  /** The P2.5 perf harness's in-memory settings override. */
  readonly settingsView?: (settings: Settings) => Settings
  /** The perf harness's View-write block. */
  readonly viewWritesBlocked?: () => string | null
  /** The perf harness's QUAL-1 defaults write block. */
  readonly streamsWritesBlocked?: () => string | null
  /** The perf harness's MODE-1/4 mode write block. */
  readonly modeWritesBlocked?: () => string | null
}

function setup(options: SetupOptions = {}) {
  let current: Config = ConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    console: ConsoleConfigSchema.parse({ host: '192.0.2.10', certFingerprint: FP_A }),
  })
  /** RTSP-2: what the fake secrets.bin holds under `rtspUrls`, written like the real store does. */
  let storedRtspUrls: Record<string, RtspStreamUrls> = {}
  const secrets = {
    isEncryptionAvailable: vi.fn(() => options.keystore ?? true),
    set: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    setRtspUrls: vi.fn((streamId: string, urls: RtspStreamUrls) => {
      const rest = Object.fromEntries(
        Object.entries(storedRtspUrls).filter(([id]) => id !== streamId),
      )
      storedRtspUrls = Object.keys(urls).length === 0 ? rest : { ...rest, [streamId]: { ...urls } }
      return Promise.resolve()
    }),
    clearRtspStream: vi.fn((streamId: string) => {
      storedRtspUrls = Object.fromEntries(
        Object.entries(storedRtspUrls).filter(([id]) => id !== streamId),
      )
      return Promise.resolve()
    }),
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
  /**
   * The config store over an in-memory "disk": `update` applies the mutator to what was last written
   * and validates like the real one (it throws on an invalid config).
   */
  let stored: Config = current
  const config = {
    update: vi.fn((mutate: (latest: Config) => Config) => {
      stored = ConfigSchema.parse(mutate(structuredClone(stored)))
      return Promise.resolve(stored)
    }),
  }
  const services: IpcHandlerServices = {
    secrets,
    credentials: { protectApiKey: API_KEY },
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    config,
    pins,
  }
  const manager = {
    status: vi.fn(() => ConnectionStatusFromDefaults()),
    cachedCameras: vi.fn(() => [CameraSchema.parse({ id: 'cam-1' })]),
    connect: vi.fn(() => Promise.resolve()),
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
    // QUAL-7: booleans, which is all the real manager hands back (it drops the URLs itself).
    streamQualities: vi.fn(() =>
      Promise.resolve({ high: true, medium: false, low: true, package: false }),
    ),
    // DOOR-3: the real manager's refusals, logging and single PUT are tested in
    // connectionManager.test.ts; here it answers a success unless a test injects otherwise.
    unlockDoor: vi.fn<(cameraRef: string) => Promise<IpcResult<UnlockResult>>>(() =>
      Promise.resolve({
        ok: true,
        value: {
          doorId: 'door-1',
          cameraName: 'Front Door Cam',
          outcome: 'unlocked',
          reason: null,
        },
      }),
    ),
    // DOOR-6: the real manager's conditions (DOOR-0, token, links) are tested in
    // connectionManager.test.ts; here it answers one known door unless a test injects otherwise.
    watchDoors: vi.fn<(watching: boolean) => IpcResult<DoorStates>>(() => ({
      ok: true,
      value: { 'door-1': { relay: 'lock', position: null } },
    })),
    // P5.6: the real manager's rules for these are tested in connectionManagerDoorsScreen.test.ts;
    // here each answers a plain success unless a test injects otherwise.
    watchDoorsScreen: vi.fn<(open: boolean) => IpcResult<DoorsScreenState>>(() => ({
      ok: true,
      value: { ...emptyDoorsScreenState(), doors: [FRONT_DOOR] },
    })),
    doorAction: vi.fn<(input: DoorActionInput) => Promise<IpcResult<DoorActionResult>>>((input) =>
      Promise.resolve({
        ok: true,
        value: {
          doorId: input.doorId,
          doorName: 'Front Door',
          action: input.action,
          sent: input.action === 'lock' ? 'lock_now' : input.action,
          minutes: input.minutes ?? null,
          outcome: 'done',
          reason: null,
        },
      }),
    ),
    setDoorEmergency: vi.fn<(input: DoorEmergencyInput) => Promise<IpcResult<DoorEmergencyResult>>>(
      (input) => Promise.resolve({ ok: true, value: { ...input, outcome: 'done', reason: null } }),
    ),
    accessPollingChanged: vi.fn<() => void>(),
    recover: vi.fn<(reason: 'resume' | 'network') => void>(),
    accessInputsChanged:
      vi.fn<(reason: string, options?: { readonly trustChanged?: boolean }) => void>(),
    applyConsoleChange: vi.fn((next: Config['console']) => {
      current = { ...current, console: next }
      return Promise.resolve()
    }),
    connectOnLaunch: vi.fn(() => Promise.resolve()),
    // MODE-4: the real manager's teardown is tested in connectionManagerMode.test.ts.
    modeChanged: vi.fn(() => Promise.resolve()),
    credentialCleared: vi.fn(() => Promise.resolve()),
    credentialReplaced: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
  } satisfies ConnectionManager

  /**
   * The P2.2 stream registry. Its answer is a real `streamHandle`, so the schema check in `call`
   * is a check of the handler and not of a hand-written object, and the fake is what the
   * `ensureStream` tests make fail in each of the ways the registry can.
   */
  const registry = {
    ensureStream: vi.fn((cameraId: string, quality: StreamQuality) =>
      Promise.resolve(streamHandle({ cameraId, quality, port: GO2RTC_PORT, epoch: GO2RTC_EPOCH })),
    ),
    invalidate: vi.fn(),
    unregisterAll: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(),
  } satisfies StreamRegistry

  /** P6.2: the display-sleep blocker, as a recorder (NFR-8). */
  let holding = false
  const power = {
    setViewVisible: vi.fn((visible: boolean) => {
      holding = visible
      return { preventingDisplaySleep: holding }
    }),
  }

  let ready = true
  const router = createIpcRouter({
    getServices: () => (ready ? services : null),
    getManager: () => (ready ? manager : null),
    getRegistry: () => (ready ? registry : null),
    getPower: () => (ready ? power : null),
    appVersion: () => '0.1.0',
    readLeaf,
    ...(options.settingsView === undefined ? {} : { settingsView: options.settingsView }),
    ...(options.viewWritesBlocked === undefined
      ? {}
      : { viewWritesBlocked: options.viewWritesBlocked }),
    ...(options.streamsWritesBlocked === undefined
      ? {}
      : { streamsWritesBlocked: options.streamsWritesBlocked }),
    ...(options.modeWritesBlocked === undefined
      ? {}
      : { modeWritesBlocked: options.modeWritesBlocked }),
  })

  return {
    router,
    services,
    config,
    secrets,
    pins,
    readLeaf,
    manager,
    registry,
    power,
    get console() {
      return current.console
    },
    /** What the fake config store last wrote. */
    get disk() {
      return stored
    },
    /** What the fake secrets store holds under `rtspUrls`. */
    get secretsDisk() {
      return storedRtspUrls
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
    { channel: IPC.listCameras.channel, payload: null, why: 'an argument where there is none' },
    { channel: IPC.snapshot.channel, payload: { cameraId: '' }, why: 'no camera id' },
    {
      channel: IPC.ensureStream.channel,
      payload: { cameraId: 'cam-1', quality: 'ultra' },
      why: 'a quality that does not exist',
    },
    {
      channel: IPC.setViews.channel,
      payload: { views: [testView('v1', { cells: [] })], lastViewId: null, mode: 'protect' },
      why: 'a View whose cells do not tile its grid',
    },
    {
      channel: IPC.setViews.channel,
      payload: { views: [], lastViewId: null },
      why: 'no mode (MODE-4: the mode whose list was edited)',
    },
    {
      channel: IPC.setLastView.channel,
      payload: { viewId: '', mode: 'protect' },
      why: 'an empty View id',
    },
    {
      channel: IPC.setLastView.channel,
      payload: { viewId: null, mode: 'nvr' },
      why: 'a mode that does not exist',
    },
    { channel: IPC.setMode.channel, payload: { mode: 'nvr' }, why: 'a mode that does not exist' },
    { channel: IPC.setMode.channel, payload: {}, why: 'no mode' },
    {
      channel: IPC.setStreams.channel,
      payload: { defaultGridQuality: 'package', defaultFillQuality: 'high' },
      why: 'the package channel as a default (it is a source, not a quality)',
    },
    {
      channel: IPC.setStreams.channel,
      payload: { defaultGridQuality: 'low' },
      why: 'one default missing, which must not be filled in for the renderer',
    },
    {
      channel: IPC.cameraStreamQualities.channel,
      payload: { cameraId: '' },
      why: 'no camera id',
    },
    { channel: IPC.watchDoors.channel, payload: undefined, why: 'no payload' },
    {
      channel: IPC.watchDoors.channel,
      payload: { watching: 'yes' },
      why: 'a flag that is no boolean',
    },
    { channel: IPC.watchDoorsScreen.channel, payload: {}, why: 'no flag' },
    { channel: IPC.setViewVisible.channel, payload: {}, why: 'no flag' },
    {
      channel: IPC.setViewVisible.channel,
      payload: { visible: 'true' },
      why: 'a flag that is no boolean',
    },
    {
      channel: IPC.watchDoorsScreen.channel,
      payload: { open: 1 },
      why: 'a flag that is no boolean',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: '', action: 'unlock' },
      why: 'an empty door id',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { action: 'unlock' },
      why: 'no door id',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'lock_now' },
      why: 'a wire rule the renderer may not choose itself',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'custom' },
      why: 'a custom unlock with no minutes',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'keep_unlock', minutes: 30 },
      why: 'minutes on an action that takes none',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'custom', minutes: 0 },
      why: 'zero minutes',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'custom', minutes: 1441 },
      why: 'more than a day',
    },
    {
      channel: IPC.doorAction.channel,
      payload: { doorId: 'door-1', action: 'custom', minutes: 1.5 },
      why: 'a fraction of a minute',
    },
    {
      channel: IPC.setDoorEmergency.channel,
      payload: { lockdown: true, evacuation: true },
      why: 'lockdown and evacuation together',
    },
    {
      channel: IPC.setDoorEmergency.channel,
      payload: { lockdown: true },
      why: 'one flag missing, which must not be filled in for the renderer',
    },
    {
      channel: IPC.setDoorEmergency.channel,
      payload: { lockdown: 'true', evacuation: false },
      why: 'a flag that is a string',
    },
    {
      channel: IPC.setAccessPolling.channel,
      payload: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1 },
      why: 'one interval missing, which must not be defaulted',
    },
    {
      channel: IPC.setAccessPolling.channel,
      payload: { withSocketSec: 1, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 },
      why: 'a baseline below its floor',
    },
    {
      channel: IPC.setAccessPolling.channel,
      payload: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 0, detailsSec: 30 },
      why: 'an unlocked interval of zero',
    },
    {
      channel: IPC.setAccessPolling.channel,
      payload: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 601 },
      why: 'a details interval above its ceiling',
    },
    {
      channel: IPC.setAccessPolling.channel,
      payload: { withSocketSec: 5, withoutSocketSec: 2.5, unlockedSec: 1, detailsSec: 30 },
      why: 'a fraction of a second',
    },
    {
      channel: IPC.setDoorLinks.channel,
      payload: {},
      why: 'no links, which must not be defaulted to an empty map (it would erase every link)',
    },
    {
      channel: IPC.setDoorLinks.channel,
      payload: { links: { 'cam-1': '' } },
      why: 'an empty door id',
    },
    {
      channel: IPC.setDoorLinks.channel,
      payload: { links: { '': 'door-1' } },
      why: 'an empty camera id',
    },
    {
      channel: IPC.setDoorLinks.channel,
      payload: { links: { 'cam-1': 7 } },
      why: 'a door id that is not a string',
    },
    {
      channel: IPC.saveRtspStream.channel,
      payload: { name: 'Garden', urls: { high: 'exec:rm -rf /' } },
      why: 'a URL with a scheme go2rtc would run (RTSP-2)',
    },
    {
      channel: IPC.saveRtspStream.channel,
      payload: { name: '  ', urls: {} },
      why: 'a name that is only whitespace',
    },
    {
      channel: IPC.deleteRtspStream.channel,
      payload: { id: 'cam-1' },
      why: 'an id that is not an RTSP stream id',
    },
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
    case IPC.cameraStreamQualities.channel:
      return { cameraId: 'cam-1' }
    case IPC.setStreams.channel:
      return { defaultGridQuality: 'low', defaultFillQuality: 'high' }
    case IPC.ensureStream.channel:
      return { cameraId: 'cam-1', quality: 'low' }
    case IPC.setViews.channel:
      return { views: [], lastViewId: null, mode: 'protect' }
    case IPC.setLastView.channel:
      return { viewId: null, mode: 'protect' }
    case IPC.setMode.channel:
      return { mode: 'rtsp' }
    case IPC.setDoorLinks.channel:
      return { links: {} }
    case IPC.unlockDoor.channel:
      return { cameraRef: 'cam-1' }
    case IPC.watchDoors.channel:
      return { watching: true }
    case IPC.watchDoorsScreen.channel:
      return { open: true }
    case IPC.doorAction.channel:
      return { doorId: 'door-1', action: 'unlock' }
    case IPC.setDoorEmergency.channel:
      return { lockdown: false, evacuation: false }
    case IPC.setAccessPolling.channel:
      return { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 }
    case IPC.setViewVisible.channel:
      return { visible: true }
    case IPC.saveRtspStream.channel:
      return { name: 'Garden', urls: { high: 'rtsp://cam.invalid/1' } }
    case IPC.deleteRtspStream.channel:
      return { id: 'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }
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
        secretsStored: { protectApiKey: true, accessToken: false, rtspUrls: {} },
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

  it('reports which stream qualities have a URL, as booleans only (RTSP-2, CON-2)', async () => {
    const url = 'rtsp://admin:cam-password@cam.invalid:554/stream1'
    h.services.credentials.rtspUrls = {
      'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b': { high: url, low: url },
    }
    const result = await h.call<AppState>(IPC.getState)
    expect(result.ok && result.value.secretsStored.rtspUrls).toEqual({
      'rtsp-0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b': { high: true, medium: false, low: true },
    })
    expect(JSON.stringify(result)).not.toContain('cam-password')
    expect(JSON.stringify(result)).not.toContain('rtsp://')
  })
})

describe('settingsView (P2.5 perf harness)', () => {
  it('changes what the renderer is shown and never the stored config', async () => {
    const p = setup({ settingsView: (s) => withPerfGridQuality(s, 'high') })
    const before = JSON.stringify(p.services.current)
    const state = await p.call<AppState>(IPC.getState)
    expect(state.ok && state.value.settings.streams.defaultGridQuality).toBe('high')
    const saved = await p.call<AppState>(IPC.setConsole, {
      host: 'udm.local',
      accessEnabled: false,
      accessBaseUrl: null,
    })
    expect(saved.ok && saved.value.settings.streams.defaultGridQuality).toBe('high')
    // The stored config keeps its own default; only the console block changed.
    expect(p.services.current.streams.defaultGridQuality).toBe('low')
    expect(JSON.parse(before)).toMatchObject({ streams: p.services.current.streams })
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
      // Not writable from a settings form either: main alone owns CON-4's launch flag.
      connectOnLaunch: false,
    })
  })

  it('carries a stored connectOnLaunch over rather than resetting it (CON-4)', async () => {
    h.services.current = {
      ...h.services.current,
      console: { ...h.services.current.console, connectOnLaunch: true },
    }
    await h.call(IPC.setConsole, { host: 'udm.local', accessEnabled: false, accessBaseUrl: null })
    // Whether it survives is the manager's call (a moved Protect endpoint clears it, connection.ts).
    expect(h.manager.applyConsoleChange).toHaveBeenCalledWith(
      expect.objectContaining({ connectOnLaunch: true }),
    )
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

  it('clears connect-on-launch when a different Protect key is stored, not the same one (CON-4)', async () => {
    await h.call(IPC.setSecret, { key: 'protectApiKey', value: 'a-new-key' })
    expect(h.manager.credentialReplaced).toHaveBeenCalledTimes(1)
    await h.call(IPC.setSecret, { key: 'protectApiKey', value: 'a-new-key' })
    expect(h.manager.credentialReplaced).toHaveBeenCalledTimes(1)
    await h.call(IPC.setSecret, { key: 'accessToken', value: 'another-token' })
    expect(h.manager.credentialReplaced).toHaveBeenCalledTimes(1)
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

/** A 2×2 View with one camera top-left, as the renderer would send it (raw, pre-parse). */
function testView(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `View ${id}`,
    cols: 2,
    rows: 2,
    cells: [
      { col: 0, row: 0, cameraIds: ['cam-1'] },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 },
    ],
    ...overrides,
  }
}

describe('setViews / setLastView (P3.1, VIEW-3/4/6)', () => {
  it('saves the Views through the config store and answers with the new state', async () => {
    const result = await h.call<AppState>(IPC.setViews, {
      views: [testView('v1'), testView('v2', { gap: 4 })],
      lastViewId: 'v2',
      mode: 'protect',
    })
    expect(h.config.update).toHaveBeenCalledTimes(1)
    expect(h.disk).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      views: [{ id: 'v1' }, { id: 'v2', gap: 4 }],
      lastViewId: 'v2',
      // The rest of the config goes along untouched.
      console: { host: '192.0.2.10', certFingerprint: FP_A },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.views.map((v) => v.id)).toEqual(['v1', 'v2'])
    expect(result.value.settings.views[1]?.aspect).toEqual({ w: 16, h: 9 })
    expect(result.value.settings.lastViewId).toBe('v2')
    // And it is the live config from now on.
    expect(h.services.current.views).toHaveLength(2)
  })

  it('refuses duplicate View ids, naming the second one, and saves nothing', async () => {
    const result = await h.call(IPC.setViews, {
      views: [testView('v1'), testView('v1')],
      lastViewId: 'v1',
      mode: 'protect',
    })
    expect(failure(result).kind).toBe('invalid-request')
    expect(failure(result).message).toContain('views.1.id')
    expect(failure(result).message).toContain('duplicate View id')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('refuses a View whose cells overlap, naming the cell (SPEC §6)', async () => {
    const overlapping = testView('v1', {
      cells: [
        { col: 0, row: 0, colSpan: 2 },
        { col: 1, row: 0 },
        { col: 0, row: 1 },
        { col: 1, row: 1 },
      ],
    })
    const result = await h.call(IPC.setViews, {
      views: [overlapping],
      lastViewId: null,
      mode: 'protect',
    })
    expect(failure(result).kind).toBe('invalid-request')
    expect(failure(result).message).toContain('views.0.cells.1')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('refuses a lastViewId that names none of the Views sent', async () => {
    const result = await h.call(IPC.setViews, {
      views: [testView('v1')],
      lastViewId: 'gone',
      mode: 'protect',
    })
    expect(failure(result).message).toContain('lastViewId')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('does not undo a console change that lands while the save is in flight', async () => {
    let release = (): void => undefined
    h.config.update.mockImplementationOnce(
      (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve) => {
          release = () => {
            resolve(ConfigSchema.parse(mutate(h.disk)))
          }
        }),
    )
    const pending = h.call<AppState>(IPC.setViews, {
      views: [testView('v1')],
      lastViewId: 'v1',
      mode: 'protect',
    })
    await Promise.resolve()
    // A certificate accepted (or a host saved) meanwhile replaces `current`.
    h.services.current = { ...h.services.current, console: { ...h.console, host: 'udm.local' } }
    release()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(h.services.current.console.host).toBe('udm.local')
    expect(h.services.current.views.map((v) => v.id)).toEqual(['v1'])
  })

  it('switches the active View with setLastView, keeping the Views as stored', async () => {
    await h.call(IPC.setViews, {
      views: [testView('v1'), testView('v2')],
      lastViewId: 'v1',
      mode: 'protect',
    })
    h.config.update.mockClear()
    const result = await h.call<AppState>(IPC.setLastView, { viewId: 'v2', mode: 'protect' })
    expect(result.ok && result.value.settings.lastViewId).toBe('v2')
    expect(h.config.update).toHaveBeenCalledTimes(1)
    expect(h.disk.views.map((v) => v.id)).toEqual(['v1', 'v2'])
    expect(h.disk.lastViewId).toBe('v2')
  })

  it('refuses to switch to a View that is not stored', async () => {
    const result = await h.call(IPC.setLastView, { viewId: 'nope', mode: 'protect' })
    expect(failure(result).kind).toBe('not-found')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('reports a failed save as a failure, not a throw', async () => {
    h.config.update.mockRejectedValueOnce(new Error('disk full'))
    const result = await h.call(IPC.setLastView, { viewId: null, mode: 'protect' })
    expect(result.ok).toBe(false)
  })
})

describe('viewWritesBlocked (P3.2 perf harness)', () => {
  // While the perf View is shown the renderer only sees `[perf]`; a write would store it over the
  // user's Views, so both View channels are refused and nothing reaches the config store.
  it('refuses setViews and setLastView with the reason, writing nothing', async () => {
    const p = setup({ viewWritesBlocked: () => 'Views cannot be changed during a perf run.' })
    const views = await p.call(IPC.setViews, {
      views: [testView('perf')],
      lastViewId: 'perf',
      mode: 'protect',
    })
    expect(failure(views)).toMatchObject({
      kind: 'bad-request',
      message: 'Views cannot be changed during a perf run.',
    })
    const last = await p.call(IPC.setLastView, { viewId: null, mode: 'protect' })
    expect(failure(last).kind).toBe('bad-request')
    expect(p.config.update).not.toHaveBeenCalled()
    expect(p.services.current.views).toEqual([])
  })

  it('lets View writes through while it answers null', async () => {
    let blocked: string | null = 'blocked'
    const p = setup({ viewWritesBlocked: () => blocked })
    expect((await p.call(IPC.setLastView, { viewId: null, mode: 'protect' })).ok).toBe(false)
    blocked = null
    const result = await p.call(IPC.setViews, {
      views: [testView('v1')],
      lastViewId: 'v1',
      mode: 'protect',
    })
    expect(result.ok).toBe(true)
    expect(p.config.update).toHaveBeenCalledTimes(1)
  })
})

describe('per-mode Views (MODE-4)', () => {
  /** Puts the live config (and the fake disk, through a write) into `mode`. */
  async function switchTo(p: Harness, mode: 'protect' | 'rtsp'): Promise<void> {
    const result = await p.call(IPC.setMode, { mode })
    expect(result.ok).toBe(true)
  }

  it('writes setViews into the active mode`s list and leaves the other one alone', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    await switchTo(h, 'rtsp')
    const result = await h.call<AppState>(IPC.setViews, {
      views: [testView('r1'), testView('r2')],
      lastViewId: 'r2',
      mode: 'rtsp',
    })
    expect(result.ok).toBe(true)
    // On disk: Protect's pair at the top level, RTSP's in the block, each where it belongs.
    expect(h.disk.views.map((v) => v.id)).toEqual(['p1'])
    expect(h.disk.lastViewId).toBe('p1')
    expect(h.disk.rtsp.views.map((v) => v.id)).toEqual(['r1', 'r2'])
    expect(h.disk.rtsp.lastViewId).toBe('r2')
    // And in memory, the same.
    expect(h.services.current.views.map((v) => v.id)).toEqual(['p1'])
    expect(h.services.current.rtsp.views.map((v) => v.id)).toEqual(['r1', 'r2'])
  })

  it('shows the renderer only the active mode`s Views, never the other list', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    await switchTo(h, 'rtsp')
    await h.call(IPC.setViews, { views: [testView('r1')], lastViewId: 'r1', mode: 'rtsp' })

    const rtsp = await h.call<AppState>(IPC.getState)
    if (!rtsp.ok) throw new Error('getState failed')
    expect(rtsp.value.settings.mode).toBe('rtsp')
    expect(rtsp.value.settings.views.map((v) => v.id)).toEqual(['r1'])
    expect(rtsp.value.settings.lastViewId).toBe('r1')
    // The RTSP list is not sent twice, and the Protect list not at all.
    expect(rtsp.value.settings.rtsp.views).toEqual([])
    expect(rtsp.value.settings.rtsp.lastViewId).toBeNull()
    expect(JSON.stringify(rtsp.value)).not.toContain('"p1"')

    await switchTo(h, 'protect')
    const protect = await h.call<AppState>(IPC.getState)
    if (!protect.ok) throw new Error('getState failed')
    expect(protect.value.settings.views.map((v) => v.id)).toEqual(['p1'])
    expect(protect.value.settings.lastViewId).toBe('p1')
    expect(protect.value.settings.rtsp.views).toEqual([])
    expect(JSON.stringify(protect.value)).not.toContain('"r1"')
  })

  it('keeps each mode`s list and last View across switches', async () => {
    await h.call(IPC.setViews, {
      views: [testView('p1'), testView('p2')],
      lastViewId: 'p1',
      mode: 'protect',
    })
    await h.call(IPC.setLastView, { viewId: 'p2', mode: 'protect' })
    await switchTo(h, 'rtsp')
    await h.call(IPC.setViews, {
      views: [testView('r1'), testView('r2')],
      lastViewId: 'r1',
      mode: 'rtsp',
    })
    await h.call(IPC.setLastView, { viewId: 'r2', mode: 'rtsp' })
    await switchTo(h, 'protect')
    await switchTo(h, 'rtsp')
    expect(h.disk).toMatchObject({ lastViewId: 'p2', rtsp: { lastViewId: 'r2' } })
    expect(h.disk.views.map((v) => v.id)).toEqual(['p1', 'p2'])
    expect(h.disk.rtsp.views.map((v) => v.id)).toEqual(['r1', 'r2'])
  })

  it('checks setLastView against the active mode`s list only', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    await switchTo(h, 'rtsp')
    h.config.update.mockClear()
    // `p1` exists, but in the Protect list: from RTSP mode it is not a View that can be switched to.
    const result = await h.call(IPC.setLastView, { viewId: 'p1', mode: 'rtsp' })
    expect(failure(result).kind).toBe('not-found')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('keeps the RTSP streams the block holds when its Views are written', async () => {
    const stream = { id: 'rtsp-00000000-0000-4000-8000-000000000001', name: 'Garage' }
    await switchTo(h, 'rtsp')
    // A stream saved by another writer, already on disk but not yet in `current`.
    let saved: Config | null = null
    h.config.update.mockImplementationOnce((mutate: (latest: Config) => Config) => {
      const latest = ConfigSchema.parse({ ...h.disk, rtsp: { ...h.disk.rtsp, streams: [stream] } })
      saved = ConfigSchema.parse(mutate(latest))
      return Promise.resolve(saved)
    })
    await h.call(IPC.setViews, { views: [testView('r1')], lastViewId: 'r1', mode: 'rtsp' })
    // Built from `latest` inside the write, so the stream survives next to the new Views.
    expect(saved).toMatchObject({
      rtsp: { streams: [stream], views: [{ id: 'r1' }], lastViewId: 'r1' },
    })
  })

  it('refuses a View write whose mode was switched before it was applied, saving nothing', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    let release = (): void => undefined
    h.config.update.mockImplementationOnce(
      (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve, reject) => {
          release = () => {
            // A mode switch was written while this one waited in the queue.
            const latest = ConfigSchema.parse({ ...h.disk, mode: 'rtsp' })
            try {
              resolve(ConfigSchema.parse(mutate(latest)))
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          }
        }),
    )
    const pending = h.call(IPC.setViews, {
      views: [testView('x1')],
      lastViewId: 'x1',
      mode: 'protect',
    })
    await Promise.resolve()
    release()
    const result = await pending
    expect(failure(result)).toMatchObject({ kind: 'bad-request', retryable: false })
    expect(failure(result).message).toContain('mode changed')
    // Neither list took it.
    expect(h.services.current.views.map((v) => v.id)).toEqual(['p1'])
    expect(h.services.current.rtsp.views).toEqual([])
  })
})

describe('setMode (MODE-1/4)', () => {
  it('saves the mode, stands the Protect side down and unregisters every stream (to RTSP)', async () => {
    h.services.current = {
      ...h.services.current,
      doorLinks: { 'cam-1': 'door-1' },
      console: { ...h.console, accessEnabled: true, connectOnLaunch: true },
    }
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    const before = structuredClone(h.services.current)
    const beforeDisk = structuredClone(h.disk)
    const result = await h.call<AppState>(IPC.setMode, { mode: 'rtsp' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.mode).toBe('rtsp')
    expect(h.disk.mode).toBe('rtsp')
    expect(h.services.current.mode).toBe('rtsp')
    expect(h.manager.modeChanged).toHaveBeenCalledTimes(1)
    expect(h.registry.unregisterAll).toHaveBeenCalledTimes(1)
    expect(h.manager.connectOnLaunch).not.toHaveBeenCalled()
    // Nothing else changed: console (pins and launch flag included), door links, Protect's Views.
    expect(h.services.current.console).toEqual(before.console)
    expect(h.services.current.doorLinks).toEqual(before.doorLinks)
    expect(h.services.current.views).toEqual(before.views)
    expect(h.services.current.lastViewId).toBe('p1')
    expect(h.disk).toEqual({ ...beforeDisk, mode: 'rtsp' })
    // No secret was touched.
    expect(h.secrets.set).not.toHaveBeenCalled()
    expect(h.secrets.clear).not.toHaveBeenCalled()
    expect(h.services.credentials.protectApiKey).toBe(API_KEY)
  })

  it('behaves like a launch when switching back to Protect (CON-4)', async () => {
    await h.call(IPC.setMode, { mode: 'rtsp' })
    h.manager.modeChanged.mockClear()
    h.registry.unregisterAll.mockClear()
    const result = await h.call<AppState>(IPC.setMode, { mode: 'protect' })
    expect(result.ok && result.value.settings.mode).toBe('protect')
    expect(h.disk.mode).toBe('protect')
    expect(h.manager.modeChanged).toHaveBeenCalledTimes(1)
    expect(h.manager.connectOnLaunch).toHaveBeenCalledTimes(1)
    expect(h.registry.unregisterAll).not.toHaveBeenCalled()
  })

  it('does not wait for, or fail on, the launch connect', async () => {
    await h.call(IPC.setMode, { mode: 'rtsp' })
    h.manager.connectOnLaunch.mockImplementationOnce(() => new Promise<void>(() => undefined))
    const result = await h.call(IPC.setMode, { mode: 'protect' })
    expect(result.ok).toBe(true)
  })

  it('answers the state and does nothing else for the mode it is already in', async () => {
    const result = await h.call<AppState>(IPC.setMode, { mode: 'protect' })
    expect(result.ok && result.value.settings.mode).toBe('protect')
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.manager.modeChanged).not.toHaveBeenCalled()
    expect(h.manager.connectOnLaunch).not.toHaveBeenCalled()
    expect(h.registry.unregisterAll).not.toHaveBeenCalled()
  })

  it('is refused during a perf run, before anything is written or torn down', async () => {
    const p = setup({
      modeWritesBlocked: () => 'The app mode cannot be changed during a perf run.',
    })
    const result = await p.call(IPC.setMode, { mode: 'rtsp' })
    expect(failure(result)).toMatchObject({
      kind: 'bad-request',
      message: 'The app mode cannot be changed during a perf run.',
    })
    expect(p.config.update).not.toHaveBeenCalled()
    expect(p.manager.modeChanged).not.toHaveBeenCalled()
    expect(p.registry.unregisterAll).not.toHaveBeenCalled()
    expect(p.services.current.mode).toBe('protect')
  })

  it('refuses an invalid mode before anything happens', async () => {
    const result = await h.call(IPC.setMode, { mode: 'RTSP' })
    expect(failure(result).kind).toBe('invalid-request')
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.manager.modeChanged).not.toHaveBeenCalled()
  })

  it('reports a failed save as a failure and tears nothing down', async () => {
    h.config.update.mockRejectedValueOnce(new Error('disk full'))
    const result = await h.call(IPC.setMode, { mode: 'rtsp' })
    expect(result.ok).toBe(false)
    expect(h.services.current.mode).toBe('protect')
    expect(h.manager.modeChanged).not.toHaveBeenCalled()
    expect(h.registry.unregisterAll).not.toHaveBeenCalled()
  })

  it('still switches before the stream registry exists', async () => {
    const router = createIpcRouter({
      getServices: () => h.services,
      getManager: () => h.manager,
      getRegistry: () => null,
      appVersion: () => '0.1.0',
    })
    const result = await handlerFor(router, IPC.setMode.channel)({ mode: 'rtsp' })
    expect(result.ok).toBe(true)
    expect(h.services.current.mode).toBe('rtsp')
  })
})

describe('setMode ordering and teardown (MODE-1/4)', () => {
  it('runs quick switches one after another, so protect→rtsp→protect ends in Protect', async () => {
    // The first save is held, as a slow disk would: the second call must see its committed mode.
    let release = (): void => undefined
    h.config.update.mockImplementationOnce(
      (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve) => {
          release = () => {
            resolve(ConfigSchema.parse(mutate(h.disk)))
          }
        }),
    )
    const toRtsp = h.call<AppState>(IPC.setMode, { mode: 'rtsp' })
    const toProtect = h.call<AppState>(IPC.setMode, { mode: 'protect' })
    await vi.waitFor(() => {
      expect(h.config.update).toHaveBeenCalledTimes(1)
    })
    release()
    expect((await toRtsp).ok).toBe(true)
    const result = await toProtect
    expect(result.ok && result.value.settings.mode).toBe('protect')
    expect(h.services.current.mode).toBe('protect')
    expect(h.config.update).toHaveBeenCalledTimes(2)
    expect(h.manager.modeChanged).toHaveBeenCalledTimes(2)
    expect(h.registry.unregisterAll).toHaveBeenCalledTimes(1)
    expect(h.manager.connectOnLaunch).toHaveBeenCalledTimes(1)
  })

  it('unregisters the go2rtc streams without waiting for the manager`s queue', async () => {
    // A connect in progress holds the manager's queue: the streams must go regardless.
    let release = (): void => undefined
    h.manager.modeChanged.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const pending = h.call(IPC.setMode, { mode: 'rtsp' })
    await vi.waitFor(() => {
      expect(h.registry.unregisterAll).toHaveBeenCalledTimes(1)
    })
    expect(h.manager.modeChanged).toHaveBeenCalledTimes(1)
    release()
    expect((await pending).ok).toBe(true)
  })
})

describe('certificate calls in RTSP mode (MODE-4)', () => {
  it('refuses check, accept and re-pin before any TLS contact', async () => {
    await h.call(IPC.setMode, { mode: 'rtsp' })
    const results = [
      await h.call(IPC.checkCertificate, { endpoint: 'protect' }),
      await h.call(IPC.acceptCertificate, { endpoint: 'access', fingerprint256: FP_A }),
      await h.call(IPC.repinCertificate, { endpoint: 'protect', fingerprint256: FP_A }),
    ]
    for (const result of results) {
      expect(failure(result)).toMatchObject({ kind: 'bad-request', retryable: false })
      expect(failure(result).message).toContain('RTSP streams mode')
    }
    expect(h.pins.checkEndpoint).not.toHaveBeenCalled()
    expect(h.readLeaf).not.toHaveBeenCalled()
    expect(h.pins.acceptPin).not.toHaveBeenCalled()
    expect(h.pins.repin).not.toHaveBeenCalled()
    expect(h.manager.accessInputsChanged).not.toHaveBeenCalled()
  })

  it('still answers them in Protect mode', async () => {
    const result = await h.call(IPC.checkCertificate, { endpoint: 'protect' })
    expect(result.ok).toBe(true)
  })
})

describe('View writes made against a mode that is no longer stored (MODE-4)', () => {
  it('refuses a setViews built from the Protect list once the app is in RTSP mode', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    await h.call(IPC.setMode, { mode: 'rtsp' })
    h.config.update.mockClear()
    // A late save from the Protect list: Protect camera ids must not become RTSP Views.
    const result = await h.call(IPC.setViews, {
      views: [testView('p1'), testView('p2')],
      lastViewId: 'p2',
      mode: 'protect',
    })
    expect(failure(result)).toMatchObject({ kind: 'bad-request', retryable: false })
    expect(failure(result).message).toContain('mode changed')
    expect(h.services.current.rtsp.views).toEqual([])
    expect(h.services.current.views.map((v) => v.id)).toEqual(['p1'])
    expect(h.disk.rtsp.views).toEqual([])
  })

  it('refuses a setLastView picked from the other mode`s list, before any lookup or write', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: 'p1', mode: 'protect' })
    h.config.update.mockClear()
    const result = await h.call(IPC.setLastView, { viewId: 'p1', mode: 'rtsp' })
    expect(failure(result)).toMatchObject({ kind: 'bad-request', retryable: false })
    expect(failure(result).message).toContain('mode changed')
    expect(h.config.update).not.toHaveBeenCalled()
  })

  it('refuses a setLastView whose mode was switched while the write waited', async () => {
    await h.call(IPC.setViews, { views: [testView('p1')], lastViewId: null, mode: 'protect' })
    h.config.update.mockImplementationOnce((mutate: (latest: Config) => Config) => {
      // A mode switch was written ahead of this one in the store's queue.
      const latest = ConfigSchema.parse({ ...h.disk, mode: 'rtsp' })
      return Promise.resolve(ConfigSchema.parse(mutate(latest)))
    })
    const result = await h.call(IPC.setLastView, { viewId: 'p1', mode: 'protect' })
    expect(failure(result).kind).toBe('bad-request')
    expect(h.services.current.lastViewId).toBeNull()
    expect(h.services.current.rtsp.lastViewId).toBeNull()
  })
})

describe('setStreams (QUAL-1)', () => {
  it('saves both defaults through the config store and answers with the new state', async () => {
    const result = await h.call<AppState>(IPC.setStreams, {
      defaultGridQuality: 'medium',
      defaultFillQuality: 'low',
    })
    expect(h.config.update).toHaveBeenCalledTimes(1)
    expect(h.disk).toMatchObject({
      streams: { defaultGridQuality: 'medium', defaultFillQuality: 'low' },
      // The rest of the config goes along untouched.
      console: { host: '192.0.2.10', certFingerprint: FP_A },
    })
    expect(result.ok && result.value.settings.streams).toEqual({
      defaultGridQuality: 'medium',
      defaultFillQuality: 'low',
    })
    expect(h.services.current.streams.defaultGridQuality).toBe('medium')
  })

  it('does not undo a console change that lands while the save is in flight', async () => {
    let release = (): void => undefined
    h.config.update.mockImplementationOnce(
      (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve) => {
          release = () => {
            resolve(ConfigSchema.parse(mutate(h.disk)))
          }
        }),
    )
    const pending = h.call<AppState>(IPC.setStreams, {
      defaultGridQuality: 'high',
      defaultFillQuality: 'high',
    })
    await Promise.resolve()
    h.services.current = { ...h.services.current, console: { ...h.console, host: 'udm.local' } }
    release()
    expect((await pending).ok).toBe(true)
    expect(h.services.current.console.host).toBe('udm.local')
    expect(h.services.current.streams.defaultGridQuality).toBe('high')
  })

  it('is refused while the perf harness blocks it, writing nothing', async () => {
    const p = setup({ streamsWritesBlocked: () => 'blocked for the perf run' })
    const result = await p.call(IPC.setStreams, {
      defaultGridQuality: 'high',
      defaultFillQuality: 'high',
    })
    expect(failure(result)).toMatchObject({
      kind: 'bad-request',
      message: 'blocked for the perf run',
    })
    expect(p.config.update).not.toHaveBeenCalled()
  })

  it('is not blocked by the View-write block, which is about Views only', async () => {
    const p = setup({ viewWritesBlocked: () => 'Views blocked' })
    const result = await p.call(IPC.setStreams, {
      defaultGridQuality: 'low',
      defaultFillQuality: 'high',
    })
    expect(result.ok).toBe(true)
  })
})

describe('cameraStreamQualities (QUAL-7)', () => {
  it("passes the manager's booleans through", async () => {
    const result = await h.call(IPC.cameraStreamQualities, { cameraId: 'cam-1' })
    expect(h.manager.streamQualities).toHaveBeenCalledWith('cam-1')
    expect(result).toEqual({
      ok: true,
      value: { high: true, medium: false, low: true, package: false },
    })
  })

  it('reports a failure as a value, with the kind the client decided on', async () => {
    h.manager.streamQualities.mockRejectedValueOnce(
      new ProtectApiError('GET /v1/cameras/{id}/rtsps-stream failed with HTTP 429.', {
        kind: 'rate-limit',
      }),
    )
    const result = await h.call(IPC.cameraStreamQualities, { cameraId: 'cam-1' })
    expect(failure(result).kind).toBe('rate-limit')
  })
})

describe('the removed door list call (DOOR-1, P5.6)', () => {
  it('registers no handler for vp:doors/list', () => {
    // The one-shot list went with Settings' Door links card (user decision 2026-11-18).
    expect(Object.values(IPC).map((spec) => spec.channel)).not.toContain('vp:doors/list')
  })
})

describe('unlockDoor (DOOR-3/4/5, P5.4)', () => {
  it('passes only the camera ref to the manager and its answer back', async () => {
    const result = await h.call(IPC.unlockDoor, { cameraRef: 'cam-1:package' })
    expect(h.manager.unlockDoor).toHaveBeenCalledExactlyOnceWith('cam-1:package')
    expect(result).toEqual({
      ok: true,
      value: { doorId: 'door-1', cameraName: 'Front Door Cam', outcome: 'unlocked', reason: null },
    })
  })

  it('refuses a payload without a camera ref, or one carrying only a door id, before acting', async () => {
    for (const payload of [{}, { cameraRef: '' }, { doorId: 'door-1' }, undefined]) {
      const result = await h.call(IPC.unlockDoor, payload)
      expect(failure(result).kind).toBe('invalid-request')
    }
    expect(h.manager.unlockDoor).not.toHaveBeenCalled()
  })

  it("passes the manager's failure through unchanged", async () => {
    const error: IpcError = {
      kind: 'auth',
      message: 'PUT /doors/door-1/unlock failed with HTTP 403 CODE_OPERATION_FORBIDDEN.',
      endpoint: '192.0.2.10:12445',
      retryable: false,
    }
    h.manager.unlockDoor.mockResolvedValueOnce({ ok: false, error })
    const result = await h.call(IPC.unlockDoor, { cameraRef: 'cam-1' })
    expect(failure(result)).toEqual(error)
    expect(h.manager.unlockDoor).toHaveBeenCalledTimes(1)
  })

  it('still never throws if the manager does', async () => {
    h.manager.unlockDoor.mockRejectedValueOnce(new Error('a bug in main'))
    const result = await h.call(IPC.unlockDoor, { cameraRef: 'cam-1' })
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'a bug in main' })
    expect(h.manager.unlockDoor).toHaveBeenCalledTimes(1)
  })
})

describe('watchDoors (DOOR-6, P5.5)', () => {
  it('passes the flag to the manager and its states back', async () => {
    const result = await h.call(IPC.watchDoors, { watching: true })
    expect(h.manager.watchDoors).toHaveBeenCalledExactlyOnceWith(true)
    expect(result).toEqual({ ok: true, value: { 'door-1': { relay: 'lock', position: null } } })
    h.manager.watchDoors.mockReturnValueOnce({ ok: true, value: {} })
    expect(await h.call(IPC.watchDoors, { watching: false })).toEqual({ ok: true, value: {} })
    expect(h.manager.watchDoors).toHaveBeenLastCalledWith(false)
  })

  it('takes no door id from the renderer: an unknown key is not passed on', async () => {
    await h.call(IPC.watchDoors, { watching: true, doorIds: ['door-9'] })
    expect(h.manager.watchDoors).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('is allowed during a perf run: it changes no config', async () => {
    const perf = setup({
      viewWritesBlocked: () => 'Views cannot be changed during a perf run.',
      streamsWritesBlocked: () => 'Stream quality defaults cannot be changed during a perf run.',
    })
    const result = await perf.call(IPC.watchDoors, { watching: true })
    expect(result.ok).toBe(true)
    expect(perf.manager.watchDoors).toHaveBeenCalledTimes(1)
    expect(perf.config.update).not.toHaveBeenCalled()
  })

  it('still never throws if the manager does', async () => {
    h.manager.watchDoors.mockImplementationOnce(() => {
      throw new Error('a bug in main')
    })
    const result = await h.call(IPC.watchDoors, { watching: true })
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'a bug in main' })
  })
})

describe('telling the door-state monitor what changed (DOOR-6, P5.5)', () => {
  it('after the Access token is saved, and not after the Protect key', async () => {
    await h.call(IPC.setSecret, { key: 'protectApiKey', value: 'another-key' })
    expect(h.manager.accessInputsChanged).not.toHaveBeenCalled()
    await h.call(IPC.setSecret, { key: 'accessToken', value: 'a-token' })
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(1)
    // P5.6: the Doors screen's door list was read with the old token.
    expect(h.manager.accessInputsChanged).toHaveBeenLastCalledWith(expect.any(String), {
      trustChanged: true,
    })
    // By then the token is where the manager reads it.
    expect(h.services.credentials.accessToken).toBe('a-token')
  })

  it('after the Access token is cleared, once it is gone from memory', async () => {
    h.services.credentials.accessToken = 'a-token'
    let heldAtCall: string | undefined = 'not called'
    h.manager.accessInputsChanged.mockImplementationOnce(() => {
      heldAtCall = h.services.credentials.accessToken
    })
    await h.call(IPC.clearSecret, { key: 'accessToken' })
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(1)
    expect(h.manager.accessInputsChanged).toHaveBeenLastCalledWith(expect.any(String), {
      trustChanged: true,
    })
    expect(heldAtCall).toBeUndefined()
    await h.call(IPC.clearSecret, { key: 'protectApiKey' })
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(1)
  })

  it('after a certificate is accepted or re-accepted, and not when either is refused', async () => {
    await h.call(IPC.acceptCertificate, { endpoint: 'protect', fingerprint256: FP_B })
    await h.call(IPC.repinCertificate, { endpoint: 'protect', fingerprint256: FP_B })
    expect(h.pins.acceptPin).not.toHaveBeenCalled()
    expect(h.pins.repin).not.toHaveBeenCalled()
    expect(h.manager.accessInputsChanged).not.toHaveBeenCalled()

    await h.call(IPC.acceptCertificate, { endpoint: 'protect', fingerprint256: FP_A })
    expect(h.pins.acceptPin).toHaveBeenCalledTimes(1)
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(1)
    await h.call(IPC.repinCertificate, { endpoint: 'protect', fingerprint256: FP_A })
    expect(h.pins.repin).toHaveBeenCalledTimes(1)
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(2)
    // P5.6: a re-accepted certificate may be another machine's, so the door list is dropped.
    for (const call of h.manager.accessInputsChanged.mock.calls) {
      expect(call[1]).toEqual({ trustChanged: true })
    }
  })

  it('after the door links are saved, once they are the live config', async () => {
    let linksAtCall: unknown = null
    h.manager.accessInputsChanged.mockImplementationOnce(() => {
      linksAtCall = h.services.current.doorLinks
    })
    await h.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    expect(h.manager.accessInputsChanged).toHaveBeenCalledTimes(1)
    expect(linksAtCall).toEqual({ 'cam-1': 'door-1' })
    // Links are not a matter of trust: the Doors screen keeps its door list through a link save.
    expect(h.manager.accessInputsChanged.mock.calls[0]).toHaveLength(1)
  })
})

describe('watchDoorsScreen (P5.6)', () => {
  it('passes the flag to the manager and its state back', async () => {
    const result = await h.call<DoorsScreenState>(IPC.watchDoorsScreen, { open: true })
    expect(h.manager.watchDoorsScreen).toHaveBeenCalledExactlyOnceWith(true)
    expect(result.ok && result.value.doors).toEqual([FRONT_DOOR])
    h.manager.watchDoorsScreen.mockReturnValueOnce({ ok: true, value: emptyDoorsScreenState() })
    expect(await h.call(IPC.watchDoorsScreen, { open: false })).toEqual({
      ok: true,
      value: emptyDoorsScreenState(),
    })
    expect(h.manager.watchDoorsScreen).toHaveBeenLastCalledWith(false)
  })

  it('carries a reason nothing is read as the state, not as a failed call', async () => {
    h.manager.watchDoorsScreen.mockReturnValueOnce({
      ok: true,
      value: {
        ...emptyDoorsScreenState(),
        error: { kind: 'disabled', message: 'Access is off.', endpoint: null, retryable: false },
      },
    })
    const result = await h.call<DoorsScreenState>(IPC.watchDoorsScreen, { open: true })
    expect(result.ok && result.value.error?.kind).toBe('disabled')
  })

  it('is allowed during a perf run: it changes no config', async () => {
    const perf = setup({
      viewWritesBlocked: () => 'Views cannot be changed during a perf run.',
      streamsWritesBlocked: () => 'Stream quality defaults cannot be changed during a perf run.',
    })
    expect((await perf.call(IPC.watchDoorsScreen, { open: true })).ok).toBe(true)
    expect(perf.config.update).not.toHaveBeenCalled()
  })

  it('still never throws if the manager does', async () => {
    h.manager.watchDoorsScreen.mockImplementationOnce(() => {
      throw new Error('a bug in main')
    })
    const result = await h.call(IPC.watchDoorsScreen, { open: true })
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'a bug in main' })
  })
})

describe('doorAction (DOOR-3/4/5, P5.6)', () => {
  it('passes the validated action to the manager, once, and its answer back', async () => {
    const result = await h.call<DoorActionResult>(IPC.doorAction, {
      doorId: 'door-1',
      action: 'custom',
      minutes: 45,
    })
    expect(h.manager.doorAction).toHaveBeenCalledExactlyOnceWith({
      doorId: 'door-1',
      action: 'custom',
      minutes: 45,
    })
    expect(result).toEqual({
      ok: true,
      value: {
        doorId: 'door-1',
        doorName: 'Front Door',
        action: 'custom',
        sent: 'custom',
        minutes: 45,
        outcome: 'done',
        reason: null,
      },
    })
  })

  it('passes on nothing but the three fields: an extra key never reaches the manager', async () => {
    await h.call(IPC.doorAction, { doorId: 'door-1', action: 'lock', sent: 'keep_unlock', n: 2 })
    expect(h.manager.doorAction).toHaveBeenCalledExactlyOnceWith({
      doorId: 'door-1',
      action: 'lock',
    })
  })

  it('never reaches the manager with a payload the schema refuses', async () => {
    for (const payload of [
      { doorId: 'door-1', action: 'custom' },
      { doorId: 'door-1', action: 'unlock', minutes: 5 },
      { doorId: '', action: 'lock' },
      { doorId: 'door-1', action: 'open' },
    ]) {
      const result = await handlerFor(h.router, IPC.doorAction.channel)(payload)
      expect(failure(result).kind).toBe('invalid-request')
    }
    expect(h.manager.doorAction).not.toHaveBeenCalled()
  })

  it("passes the manager's refusal through unchanged, never retryable", async () => {
    h.manager.doorAction.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'not-found',
        message: 'Not a door main read.',
        endpoint: null,
        retryable: false,
      },
    })
    const result = await h.call(IPC.doorAction, { doorId: 'door-9', action: 'unlock' })
    expect(failure(result)).toEqual({
      kind: 'not-found',
      message: 'Not a door main read.',
      endpoint: null,
      retryable: false,
    })
    // One call per request: the handler repeats nothing (DOOR-3/4).
    expect(h.manager.doorAction).toHaveBeenCalledTimes(1)
  })

  it('still never throws if the manager does, and does not call it again', async () => {
    h.manager.doorAction.mockRejectedValueOnce(new Error('a bug in main'))
    const result = await h.call(IPC.doorAction, { doorId: 'door-1', action: 'unlock' })
    expect(failure(result)).toMatchObject({ kind: 'internal', retryable: false })
    expect(h.manager.doorAction).toHaveBeenCalledTimes(1)
  })

  it('is allowed during a perf run, like the cell unlock, and writes no config', async () => {
    const perf = setup({
      viewWritesBlocked: () => 'Views cannot be changed during a perf run.',
      streamsWritesBlocked: () => 'Stream quality defaults cannot be changed during a perf run.',
    })
    expect((await perf.call(IPC.doorAction, { doorId: 'door-1', action: 'lock' })).ok).toBe(true)
    expect(perf.config.update).not.toHaveBeenCalled()
  })
})

describe('setDoorEmergency (DOOR-3/4/5, P5.6)', () => {
  it('passes both flags to the manager, once, and its answer back', async () => {
    const result = await h.call<DoorEmergencyResult>(IPC.setDoorEmergency, {
      lockdown: false,
      evacuation: true,
    })
    expect(h.manager.setDoorEmergency).toHaveBeenCalledExactlyOnceWith({
      lockdown: false,
      evacuation: true,
    })
    expect(result).toEqual({
      ok: true,
      value: { lockdown: false, evacuation: true, outcome: 'done', reason: null },
    })
  })

  it('refuses both flags on before the manager hears of it', async () => {
    const result = await handlerFor(
      h.router,
      IPC.setDoorEmergency.channel,
    )({ lockdown: true, evacuation: true })
    expect(failure(result).kind).toBe('invalid-request')
    expect(h.manager.setDoorEmergency).not.toHaveBeenCalled()
  })

  it("passes the manager's failure through and never calls it twice", async () => {
    h.manager.setDoorEmergency.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'disabled', message: 'Access is off.', endpoint: null, retryable: false },
    })
    const result = await h.call(IPC.setDoorEmergency, { lockdown: true, evacuation: false })
    expect(failure(result).kind).toBe('disabled')
    expect(h.manager.setDoorEmergency).toHaveBeenCalledTimes(1)
  })
})

describe('setAccessPolling (DOOR-6, P5.6)', () => {
  const POLLING = { withSocketSec: 10, withoutSocketSec: 3, unlockedSec: 2, detailsSec: 60 }

  it('saves the four intervals through the config store and answers with the new state', async () => {
    const result = await h.call<AppState>(IPC.setAccessPolling, POLLING)
    expect(h.config.update).toHaveBeenCalledTimes(1)
    expect(h.disk).toMatchObject({
      accessPolling: POLLING,
      // The rest of the config goes along untouched.
      console: { host: '192.0.2.10', certFingerprint: FP_A },
    })
    expect(result.ok && result.value.settings.accessPolling).toEqual(POLLING)
    expect(h.services.current.accessPolling).toEqual(POLLING)
  })

  it('tells the manager once the new values are the live config, so they apply without a restart', async () => {
    let liveAtCall: unknown = null
    h.manager.accessPollingChanged.mockImplementationOnce(() => {
      liveAtCall = h.services.current.accessPolling
    })
    await h.call(IPC.setAccessPolling, POLLING)
    expect(h.manager.accessPollingChanged).toHaveBeenCalledTimes(1)
    expect(liveAtCall).toEqual(POLLING)
  })

  it('accepts each bound itself and refuses one step outside it, in main', async () => {
    const lowest = { withSocketSec: 2, withoutSocketSec: 1, unlockedSec: 1, detailsSec: 10 }
    const highest = { withSocketSec: 60, withoutSocketSec: 30, unlockedSec: 10, detailsSec: 600 }
    expect((await h.call(IPC.setAccessPolling, lowest)).ok).toBe(true)
    expect((await h.call(IPC.setAccessPolling, highest)).ok).toBe(true)
    expect(h.disk.accessPolling).toEqual(highest)
    h.config.update.mockClear()
    for (const [field, value] of [
      ['withSocketSec', 1],
      ['withSocketSec', 61],
      ['withoutSocketSec', 0],
      ['withoutSocketSec', 31],
      ['unlockedSec', 0],
      ['unlockedSec', 11],
      ['detailsSec', 9],
      ['detailsSec', 601],
    ] as const) {
      const result = await handlerFor(
        h.router,
        IPC.setAccessPolling.channel,
      )({ ...POLLING, [field]: value })
      expect(failure(result).kind).toBe('invalid-request')
      expect(failure(result).message).toContain(field)
    }
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.disk.accessPolling).toEqual(highest)
  })

  it('makes no Access call and is accepted while Access is off (DOOR-0: local config only)', async () => {
    expect(h.console.accessEnabled).toBe(false)
    expect((await h.call(IPC.setAccessPolling, POLLING)).ok).toBe(true)
    expect(h.manager.watchDoorsScreen).not.toHaveBeenCalled()
  })

  it('is allowed during a perf run: the harness shows the renderer none of these values', async () => {
    const perf = setup({
      settingsView: (s) => withPerfGridQuality(s, 'high'),
      viewWritesBlocked: () => 'Views cannot be changed during a perf run.',
      streamsWritesBlocked: () => 'Stream quality defaults cannot be changed during a perf run.',
    })
    const result = await perf.call<AppState>(IPC.setAccessPolling, POLLING)
    expect(result.ok && result.value.settings.accessPolling).toEqual(POLLING)
    expect(perf.disk.accessPolling).toEqual(POLLING)
  })

  it('answers a failed write as a failure and leaves the live config alone', async () => {
    h.config.update.mockRejectedValueOnce(new Error('disk full'))
    const before = h.services.current.accessPolling
    const result = await h.call(IPC.setAccessPolling, POLLING)
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'disk full' })
    expect(h.services.current.accessPolling).toEqual(before)
    expect(h.manager.accessPollingChanged).not.toHaveBeenCalled()
  })
})

describe('setDoorLinks (DOOR-2, P5.3)', () => {
  it('replaces the whole map through the config store and answers with the new state', async () => {
    await h.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1', 'cam-2': 'door-1' } })
    const result = await h.call<AppState>(IPC.setDoorLinks, {
      links: { 'cam-2': 'door-2', 'cam-gone': 'door-9' },
    })
    expect(h.config.update).toHaveBeenCalledTimes(2)
    // Replaced, not merged: cam-1 is gone because the renderer left it out.
    expect(h.disk.doorLinks).toEqual({ 'cam-2': 'door-2', 'cam-gone': 'door-9' })
    // A camera the inventory does not have is kept: links are never pruned (DOOR-0/2).
    expect(result.ok && result.value.settings.doorLinks).toEqual({
      'cam-2': 'door-2',
      'cam-gone': 'door-9',
    })
    expect(h.services.current.doorLinks).toEqual({ 'cam-2': 'door-2', 'cam-gone': 'door-9' })
    // The rest of the config goes along untouched.
    expect(h.disk.console).toMatchObject({ host: '192.0.2.10', certFingerprint: FP_A })
  })

  it('saves while Access is off and makes no Access call (DOOR-0 keeps the links)', async () => {
    expect(h.services.current.console.accessEnabled).toBe(false)
    const result = await h.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    expect(result.ok).toBe(true)
    expect(h.manager.watchDoorsScreen).not.toHaveBeenCalled()
    expect(h.disk.doorLinks).toEqual({ 'cam-1': 'door-1' })
  })

  it('clears every link with an empty map', async () => {
    await h.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    await h.call(IPC.setDoorLinks, { links: {} })
    expect(h.disk.doorLinks).toEqual({})
  })

  it('does not undo a console change that lands while the save is in flight', async () => {
    let release = (): void => undefined
    h.config.update.mockImplementationOnce(
      (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve) => {
          release = () => {
            resolve(ConfigSchema.parse(mutate(h.disk)))
          }
        }),
    )
    const pending = h.call<AppState>(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    await Promise.resolve()
    h.services.current = { ...h.services.current, console: { ...h.console, host: 'udm.local' } }
    release()
    expect((await pending).ok).toBe(true)
    expect(h.services.current.console.host).toBe('udm.local')
    expect(h.services.current.doorLinks).toEqual({ 'cam-1': 'door-1' })
  })

  it('is not blocked by the perf harness, whose settingsView never touches the links', async () => {
    const p = setup({
      viewWritesBlocked: () => 'Views blocked',
      streamsWritesBlocked: () => 'streams blocked',
    })
    const result = await p.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    expect(result.ok).toBe(true)
  })

  it('reports a failed save as a failure, not a throw', async () => {
    h.config.update.mockRejectedValueOnce(new Error('disk full'))
    const result = await h.call(IPC.setDoorLinks, { links: { 'cam-1': 'door-1' } })
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'disk full' })
  })
})

describe('ensureStream (P2.2, QUAL-8)', () => {
  it("answers with the registry's handle and nothing else", async () => {
    const result = await h.call(IPC.ensureStream, { cameraId: 'cam-1', quality: 'medium' })
    expect(h.registry.ensureStream).toHaveBeenCalledWith('cam-1', 'medium')
    expect(result).toMatchObject({
      ok: true,
      value: {
        cameraId: 'cam-1',
        quality: 'medium',
        name: 'cam-1_medium',
        port: GO2RTC_PORT,
        epoch: GO2RTC_EPOCH,
        wsUrl: `ws://127.0.0.1:${String(GO2RTC_PORT)}/api/ws?src=cam-1_medium`,
      },
    })
  })

  it('carries no RTSPS URL and no credential, whatever the registry read (CON-2, NFR-9)', async () => {
    const result = await h.call(IPC.ensureStream, { cameraId: 'cam-1', quality: 'high' })
    const json = JSON.stringify(result)
    expect(json).not.toContain('rtsp')
    expect(json).not.toContain('Basic ')
    expect(json).not.toContain(API_KEY)
  })

  // The registry's refusals already carry a contract kind, so the handler must pass them through
  // rather than flatten them into `internal` — the UI branches on exactly these.
  const refusals: { kind: StreamRegistryErrorKind; retryable: boolean; why: string }[] = [
    { kind: 'not-found', retryable: true, why: 'the camera is not in the inventory' },
    { kind: 'bad-request', retryable: false, why: 'the camera has no package channel (CAM-4)' },
    { kind: 'gateway-down', retryable: true, why: 'go2rtc is not up' },
    { kind: 'invalid-response', retryable: false, why: 'the POST answered without the quality' },
    { kind: 'not-configured', retryable: false, why: 'no console address is set' },
  ]

  for (const { kind, retryable, why } of refusals) {
    it(`reports ${kind} when ${why}`, async () => {
      h.registry.ensureStream.mockRejectedValueOnce(
        new StreamRegistryError(`refused: ${why}`, { kind, retryable }),
      )
      const result = await h.call(IPC.ensureStream, { cameraId: 'cam-1', quality: 'package' })
      expect(failure(result)).toMatchObject({ kind, retryable, message: `refused: ${why}` })
    })
  }

  it('reports a Protect failure with the kind the client decided on', async () => {
    h.registry.ensureStream.mockRejectedValueOnce(
      new ProtectApiError('The API key was refused by the console.', {
        kind: 'auth',
        endpoint: '192.0.2.10:443',
      }),
    )
    const result = await h.call(IPC.ensureStream, { cameraId: 'cam-1', quality: 'low' })
    expect(failure(result)).toMatchObject({ kind: 'auth', endpoint: '192.0.2.10:443' })
  })

  it('never throws out of the handler either (contract rule 2)', async () => {
    h.registry.ensureStream.mockRejectedValueOnce(new Error('a bug in main'))
    const result = await h.call(IPC.ensureStream, { cameraId: 'cam-1', quality: 'low' })
    expect(failure(result)).toMatchObject({ kind: 'internal', message: 'a bug in main' })
  })

  it('answers not-ready while the services exist but the registry does not', async () => {
    // The sidecar and the registry are built after `startServices()`, so this state is real: every
    // other channel works and only this one has nothing to call yet.
    const router = createIpcRouter({
      getServices: () => h.services,
      getManager: () => h.manager,
      getRegistry: () => null,
      appVersion: () => '0.1.0',
    })
    const result = await handlerFor(
      router,
      IPC.ensureStream.channel,
    )({
      cameraId: 'cam-1',
      quality: 'low',
    })
    expect(failure(result)).toMatchObject({ kind: 'not-ready', retryable: true })
  })
})

describe('setViewVisible (P6.2, NFR-8)', () => {
  it('passes the flag to the power module and answers what it is now doing', async () => {
    const on = await h.call(IPC.setViewVisible, { visible: true })
    expect(on).toEqual({ ok: true, value: { preventingDisplaySleep: true } })
    const off = await h.call(IPC.setViewVisible, { visible: false })
    expect(off).toEqual({ ok: true, value: { preventingDisplaySleep: false } })
    expect(h.power.setViewVisible.mock.calls).toEqual([[true], [false]])
  })

  it('never reaches the power module with an invalid payload', async () => {
    const result = await h.call(IPC.setViewVisible, { visible: 1 })
    expect(failure(result).kind).toBe('invalid-request')
    expect(h.power.setViewVisible).not.toHaveBeenCalled()
  })

  it('answers not-ready while the services exist but the power module does not', async () => {
    const router = createIpcRouter({
      getServices: () => h.services,
      getManager: () => h.manager,
      getRegistry: () => null,
      appVersion: () => '0.1.0',
    })
    const result = await handlerFor(router, IPC.setViewVisible.channel)({ visible: true })
    expect(failure(result)).toMatchObject({ kind: 'not-ready', retryable: true })
  })
})

describe('saveRtspStream / deleteRtspStream (RTSP-1/2, F1.0.2-5)', () => {
  const HIGH = 'rtsp://admin:garden-pass-1@cam-a.invalid:554/high'
  const MEDIUM = 'rtsp://admin:garden-pass-2@cam-a.invalid:554/medium'
  const LOW = 'rtsps://admin:garden-pass-3@cam-a.invalid:7441/low'
  const OTHER = 'rtsp://admin:porch-pass@cam-b.invalid/live'
  const URLS = [HIGH, MEDIUM, LOW, OTHER]
  const UNKNOWN_ID = 'rtsp-99999999-9999-4999-8999-999999999999'

  /** Every reply of the test, for the CON-2 check at the end of each one. */
  let replies: unknown[]

  beforeEach(() => {
    replies = []
  })

  async function save(payload: unknown): Promise<IpcResult<AppState>> {
    const result = await h.call<AppState>(IPC.saveRtspStream, payload)
    replies.push(result)
    return result
  }

  async function remove(id: string): Promise<IpcResult<AppState>> {
    const result = await h.call<AppState>(IPC.deleteRtspStream, { id })
    replies.push(result)
    return result
  }

  /** Creates a stream and answers its id. */
  async function create(name: string, urls: Record<string, string>): Promise<string> {
    const result = await save({ name, urls })
    if (!result.ok) throw new Error(`create failed: ${result.error.message}`)
    const stream = h.disk.rtsp.streams.find((s) => s.name === name)
    if (stream === undefined) throw new Error('the stream was not stored')
    return stream.id
  }

  /** CON-2: no URL, or any part of one, in any reply — successes and refusals alike. */
  function expectNoUrlInReplies(): void {
    const text = JSON.stringify(replies)
    for (const url of URLS) expect(text).not.toContain(url)
    expect(text).not.toContain('pass-')
    expect(text).not.toContain('cam-a.invalid')
    expect(text).not.toContain('cam-b.invalid')
    // The scheme alone may appear: a refusal's fixed text names "rtsp:// or rtsps://".
    expect(text).not.toMatch(/rtsps?:\/\/\w/)
  }

  it('creates a stream with one URL: secrets, then config, then booleans in the reply', async () => {
    const result = await save({ name: '  Garden ', urls: { high: HIGH } })
    if (!result.ok) throw new Error(result.error.message)
    const [stream] = h.disk.rtsp.streams
    expect(stream?.name).toBe('Garden')
    expect(stream?.id).toMatch(/^rtsp-[0-9a-f-]{36}$/)
    const id = stream?.id ?? ''
    expect(h.secrets.setRtspUrls).toHaveBeenCalledWith(id, { high: HIGH })
    expect(h.secrets.setRtspUrls.mock.invocationCallOrder[0]).toBeLessThan(
      h.config.update.mock.invocationCallOrder[0] ?? 0,
    )
    expect(h.secretsDisk).toEqual({ [id]: { high: HIGH } })
    // In memory, on the very object the redactor and `appState` read.
    expect(h.services.credentials.rtspUrls).toEqual({ [id]: { high: HIGH } })
    expect(h.services.current.rtsp.streams).toEqual([{ id, name: 'Garden' }])
    expect(result.value.settings.rtsp.streams).toEqual([{ id, name: 'Garden' }])
    expect(result.value.secretsStored.rtspUrls).toEqual({
      [id]: { high: true, medium: false, low: false },
    })
    expectNoUrlInReplies()
  })

  it('refuses a create with no URL and writes nothing', async () => {
    const result = await save({ name: 'Garden', urls: { high: null } })
    expect(failure(result)).toMatchObject({
      kind: 'bad-request',
      message: 'Add at least one stream address.',
    })
    expect(h.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.disk.rtsp.streams).toEqual([])
    expect(h.services.credentials.rtspUrls).toBeUndefined()
  })

  it('refuses a name another stream has, in a different case, and writes nothing', async () => {
    await create('Garden', { high: HIGH })
    h.secrets.setRtspUrls.mockClear()
    h.config.update.mockClear()
    const result = await save({ name: 'GARDEN', urls: { high: OTHER } })
    expect(failure(result)).toMatchObject({
      kind: 'bad-request',
      message: 'Another stream already has this name.',
    })
    expect(h.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.disk.rtsp.streams).toHaveLength(1)
    expectNoUrlInReplies()
  })

  it('edits: keeps an untouched quality, sets another, clears a third, and renames', async () => {
    const id = await create('Garden', { high: HIGH, low: LOW })
    const result = await save({ id, name: 'Back garden', urls: { medium: MEDIUM, low: null } })
    if (!result.ok) throw new Error(result.error.message)
    expect(h.secretsDisk).toEqual({ [id]: { high: HIGH, medium: MEDIUM } })
    expect(h.services.credentials.rtspUrls).toEqual({ [id]: { high: HIGH, medium: MEDIUM } })
    expect(h.disk.rtsp.streams).toEqual([{ id, name: 'Back garden' }])
    expect(result.value.secretsStored.rtspUrls[id]).toEqual({
      high: true,
      medium: true,
      low: false,
    })
    expectNoUrlInReplies()
  })

  it('lets an edit keep its own name in another case, and does not rewrite unchanged URLs', async () => {
    const id = await create('Garden', { high: HIGH })
    h.secrets.setRtspUrls.mockClear()
    const result = await save({ id, name: 'garden', urls: {} })
    expect(result.ok).toBe(true)
    expect(h.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(h.disk.rtsp.streams).toEqual([{ id, name: 'garden' }])
  })

  it('refuses clearing the last URL and writes nothing', async () => {
    const id = await create('Garden', { high: HIGH })
    h.secrets.setRtspUrls.mockClear()
    h.config.update.mockClear()
    const result = await save({ id, name: 'Renamed', urls: { high: null } })
    expect(failure(result)).toMatchObject({
      kind: 'bad-request',
      message: 'A stream needs at least one address, so the last one cannot be cleared.',
    })
    expect(h.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(h.config.update).not.toHaveBeenCalled()
    expect(h.disk.rtsp.streams).toEqual([{ id, name: 'Garden' }])
    expect(h.services.credentials.rtspUrls).toEqual({ [id]: { high: HIGH } })
    expectNoUrlInReplies()
  })

  it('answers not-found for an edit or a delete of a stream that is not stored', async () => {
    const edited = await save({ id: UNKNOWN_ID, name: 'Garden', urls: { high: HIGH } })
    expect(failure(edited)).toMatchObject({
      kind: 'not-found',
      message: 'That stream no longer exists.',
    })
    const deleted = await remove(UNKNOWN_ID)
    expect(failure(deleted).kind).toBe('not-found')
    expect(h.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(h.secrets.clearRtspStream).not.toHaveBeenCalled()
    expect(h.config.update).not.toHaveBeenCalled()
    expectNoUrlInReplies()
  })

  it('deletes: removes the config entry and the URLs, and leaves the Views untouched', async () => {
    const id = await create('Garden', { high: HIGH })
    const keep = await create('Porch', { low: OTHER })
    expect((await h.call(IPC.setMode, { mode: 'rtsp' })).ok).toBe(true)
    const view = testView('r1', {
      cols: 1,
      rows: 1,
      cells: [{ col: 0, row: 0, cameraIds: [id] }],
    })
    expect((await h.call(IPC.setViews, { views: [view], lastViewId: 'r1', mode: 'rtsp' })).ok).toBe(
      true,
    )
    const viewsBefore = structuredClone(h.disk.rtsp.views)

    const result = await remove(id)
    if (!result.ok) throw new Error(result.error.message)
    expect(h.disk.rtsp.streams).toEqual([{ id: keep, name: 'Porch' }])
    expect(h.services.current.rtsp.streams).toEqual([{ id: keep, name: 'Porch' }])
    expect(h.secrets.clearRtspStream).toHaveBeenCalledWith(id)
    expect(h.secretsDisk).toEqual({ [keep]: { low: OTHER } })
    expect(h.services.credentials.rtspUrls).toEqual({ [keep]: { low: OTHER } })
    expect(result.value.secretsStored.rtspUrls).toEqual({
      [keep]: { high: false, medium: false, low: true },
    })
    // Views are never edited: the cell still names the deleted stream ("Camera not found").
    expect(h.disk.rtsp.views).toEqual(viewsBefore)
    expect(h.disk.rtsp.lastViewId).toBe('r1')
    expectNoUrlInReplies()
  })

  it('does not touch secrets.bin when deleting a stream with no stored URL', async () => {
    const id = await create('Garden', { high: HIGH })
    // As after a stored URL failed validation on read: the stream is in config, its URLs are not.
    delete h.services.credentials.rtspUrls
    expect((await remove(id)).ok).toBe(true)
    expect(h.disk.rtsp.streams).toEqual([])
    expect(h.secrets.clearRtspStream).not.toHaveBeenCalled()
  })

  it('drops rtspUrls from memory altogether when the last stream is deleted', async () => {
    const id = await create('Garden', { high: HIGH })
    expect((await remove(id)).ok).toBe(true)
    expect(h.services.credentials.rtspUrls).toBeUndefined()
    expect(h.secretsDisk).toEqual({})
  })

  it('refuses setting a URL while the keystore is unavailable, and writes nothing (CON-2)', async () => {
    const p = setup({ keystore: false })
    const result = await p.call<AppState>(IPC.saveRtspStream, {
      name: 'Garden',
      urls: { high: HIGH },
    })
    replies.push(result)
    expect(failure(result).kind).toBe('internal')
    expect(failure(result).message).toContain('Secure storage')
    expect(p.secrets.setRtspUrls).not.toHaveBeenCalled()
    expect(p.config.update).not.toHaveBeenCalled()
    expect(p.disk.rtsp.streams).toEqual([])
    expectNoUrlInReplies()
  })

  it('puts the URLs back when the config write fails, so a create leaves no orphan', async () => {
    h.config.update.mockImplementationOnce(() => Promise.reject(new Error('disk full')))
    const result = await save({ name: 'Garden', urls: { high: HIGH } })
    expect(failure(result).kind).toBe('internal')
    expect(h.secretsDisk).toEqual({})
    expect(h.services.credentials.rtspUrls).toBeUndefined()
    expect(h.disk.rtsp.streams).toEqual([])
    expectNoUrlInReplies()
  })

  it('runs overlapping saves one at a time, so the second sees the first`s name', async () => {
    const [first, second] = await Promise.all([
      save({ name: 'Garden', urls: { high: HIGH } }),
      save({ name: 'garden', urls: { high: OTHER } }),
    ])
    expect(first.ok).toBe(true)
    expect(failure(second).message).toBe('Another stream already has this name.')
    expect(h.disk.rtsp.streams).toHaveLength(1)
    expect(Object.values(h.secretsDisk)).toEqual([{ high: HIGH }])
    expectNoUrlInReplies()
  })

  it('refuses an invalid URL at the schema without quoting it', async () => {
    const bad = 'http://admin:garden-pass-1@cam-a.invalid/high'
    const result = await handlerFor(
      h.router,
      IPC.saveRtspStream.channel,
    )({
      name: 'Garden',
      urls: { high: bad },
    })
    replies.push(result)
    expect(failure(result).kind).toBe('invalid-request')
    expect(JSON.stringify(result)).not.toContain(bad)
    expectNoUrlInReplies()
  })

  it('maps RtspStreamError to its own kind, never retryable', () => {
    expect(toIpcError(new RtspStreamError('not-found', 'That stream no longer exists.'))).toEqual({
      kind: 'not-found',
      message: 'That stream no longer exists.',
      endpoint: null,
      retryable: false,
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
      name: 'a call the app mode does not make is a bad request, never retryable (MODE-4)',
      error: new AppModeError(RTSP_MODE_MESSAGES.protect),
      kind: 'bad-request',
      endpoint: null,
      retryable: false,
    },
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
