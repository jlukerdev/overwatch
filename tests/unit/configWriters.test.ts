// P3.1 (VIEW-6, CON-3): the three writers of config.json racing each other — the View handlers
// (`setViews`), the connection manager's console change (`applyConsoleChange`) and the pin store's
// writer (`createPinPersistence`). Each used to build a whole config from `services.current` before
// its await and write that, so whichever landed second carried the first one's fields back to their
// old values. They now all go through `ConfigStore.update` and change only their own fields.
//
// Real store over a temp directory, real router, real manager and real pin store. The one fake is a
// gate in front of the store, so a test can hold each writer's write and choose the order they land
// in; both writers have started before either is released, which is the race.
import { IPC, type AppState, type IpcResult } from '@shared/ipc'
import { ConsoleConfigSchema } from '@shared/models'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'
import { createConfigStore, type ConfigStore } from '../../src/main/config/store'
import { createConnectionManager, type ConnectionServices } from '../../src/main/connection'
import { protectEndpoint } from '../../src/main/console/endpoints'
import { createIpcRouter, type IpcHandlerServices } from '../../src/main/ipc/handlers'
import { createRateLimiter } from '../../src/main/net/rateLimiter'
import { createConfigPinStore, createPinPersistence } from '../../src/main/tls/configPinStore'

const FP =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'

const VIEW = {
  id: 'v1',
  name: 'Perimeter',
  cols: 1,
  rows: 1,
  cells: [{ col: 0, row: 0, cameraIds: ['cam-1'] }],
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'view-protect-writers-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Holds every `update` until the test releases it, then hands it to the real store. */
function gate(real: ConfigStore) {
  const parked: (() => void)[] = []
  const written: Promise<unknown>[] = []
  return {
    store: {
      update: (mutate: (latest: Config) => Config) =>
        new Promise<Config>((resolve, reject) => {
          parked.push(() => {
            const write = real.update(mutate)
            written.push(write)
            write.then(resolve, reject)
          })
        }),
    } satisfies Pick<ConfigStore, 'update'>,
    /** Resolves once `count` writes are being held. */
    async held(count: number) {
      await vi.waitFor(() => {
        expect(parked).toHaveLength(count)
      })
    },
    /** Releases the held writes in this order (indexes in the order they were parked). */
    release(...order: number[]) {
      for (const index of order) parked[index]?.()
    },
    /** Resolves once every released write has finished, including fire-and-forget ones. */
    async settled() {
      await Promise.allSettled(written)
    },
  }
}

async function setup() {
  const real = createConfigStore({ dir })
  await real.save(
    ConfigSchema.parse({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      console: ConsoleConfigSchema.parse({ host: '192.0.2.10' }),
    }),
  )
  let current = (await real.load()).config
  const gated = gate(real)

  const services: ConnectionServices & IpcHandlerServices = {
    config: gated.store,
    get current() {
      return current
    },
    set current(next: Config) {
      current = next
    },
    credentials: {},
    secrets: {
      isEncryptionAvailable: () => true,
      set: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    pins: {
      pinnedFingerprint: () => null,
      agentFor: () => ({}) as never,
      invalidate: vi.fn(),
      closeAll: () => Promise.resolve(),
      checkEndpoint: vi.fn(),
      acceptPin: vi.fn(),
      repin: vi.fn(),
    },
    limiter: createRateLimiter(),
    protect: () => ({
      metaInfo: vi.fn(),
      cameras: () => Promise.resolve([]),
      snapshot: vi.fn(),
      rtspsStreams: vi.fn(),
    }),
    access: () => ({
      doors: () => Promise.resolve([]),
      unlock: () => Promise.resolve(),
      lockRule: () => Promise.resolve({ type: '', endedTime: null }),
      setLockRule: () => Promise.resolve(),
      emergencyStatus: () => Promise.resolve({ lockdown: false, evacuation: false }),
      setEmergencyStatus: () => Promise.resolve(),
    }),
  }
  const manager = createConnectionManager({ services, emit: () => undefined })
  const router = createIpcRouter({
    getServices: () => services,
    getManager: () => manager,
    getRegistry: () => null,
    appVersion: () => '0.1.0',
  })
  const errors: unknown[] = []
  const pinStore = createConfigPinStore({
    getConsole: () => services.current.console,
    setConsole: createPinPersistence({
      live: services,
      store: gated.store,
      onError: (err) => errors.push(err),
    }),
  })

  return {
    services,
    gated,
    errors,
    setViews(): Promise<IpcResult<AppState>> {
      const handler = router.get(IPC.setViews.channel)
      if (handler === undefined) throw new Error('no setViews handler')
      return handler({ views: [VIEW], lastViewId: 'v1', mode: 'protect' }) as Promise<
        IpcResult<AppState>
      >
    },
    setHost(host: string): Promise<void> {
      return manager.applyConsoleChange({ ...services.current.console, host })
    },
    /** The user clicking "Trust this certificate" for the console's Protect endpoint. */
    acceptPin(): void {
      pinStore.set(protectEndpoint(services.current.console).hostPort, FP)
    },
    async disk(): Promise<Config> {
      return ConfigSchema.parse(JSON.parse(await readFile(real.path, 'utf8')))
    },
  }
}

describe('a views save racing a console save', () => {
  it.each([
    { lands: 'console first', order: [0, 1] },
    { lands: 'views first', order: [1, 0] },
  ])('keeps both, in memory and on disk ($lands)', async ({ order }) => {
    const h = await setup()
    const consoleChange = h.setHost('udm.local')
    await h.gated.held(1)
    const views = h.setViews()
    await h.gated.held(2)
    h.gated.release(...order)
    await consoleChange
    expect((await views).ok).toBe(true)

    for (const config of [h.services.current, await h.disk()]) {
      expect(config.console.host).toBe('udm.local')
      expect(config.views.map((v) => v.id)).toEqual(['v1'])
      expect(config.lastViewId).toBe('v1')
    }
  })

  it.each([
    { lands: 'console first', order: [1, 0] },
    { lands: 'views first', order: [0, 1] },
  ])('keeps both when the views save starts first ($lands)', async ({ order }) => {
    const h = await setup()
    const views = h.setViews()
    await h.gated.held(1)
    const consoleChange = h.setHost('udm.local')
    await h.gated.held(2)
    h.gated.release(...order)
    await consoleChange
    expect((await views).ok).toBe(true)

    for (const config of [h.services.current, await h.disk()]) {
      expect(config.console.host).toBe('udm.local')
      expect(config.views.map((v) => v.id)).toEqual(['v1'])
    }
  })
})

describe('a pin save racing a views save', () => {
  it.each([
    { starts: 'views', lands: 'pin first', order: [1, 0] },
    { starts: 'views', lands: 'views first', order: [0, 1] },
    { starts: 'pin', lands: 'pin first', order: [0, 1] },
    { starts: 'pin', lands: 'views first', order: [1, 0] },
  ])('keeps both, in memory and on disk ($starts starts, $lands)', async ({ starts, order }) => {
    const h = await setup()
    let views: Promise<IpcResult<AppState>>
    if (starts === 'views') {
      views = h.setViews()
      await h.gated.held(1)
      h.acceptPin()
    } else {
      h.acceptPin()
      await h.gated.held(1)
      views = h.setViews()
    }
    await h.gated.held(2)
    h.gated.release(...order)
    expect((await views).ok).toBe(true)
    // The pin's write is fire-and-forget, so wait for it to reach the file.
    await h.gated.settled()

    expect(h.errors).toEqual([])
    for (const config of [h.services.current, await h.disk()]) {
      expect(config.console.certFingerprint).toBe(FP)
      expect(config.views.map((v) => v.id)).toEqual(['v1'])
    }
  })
})

describe('a pin save racing a console change (CON-3)', () => {
  it('does not carry a pin accepted for the old host onto the new one', async () => {
    const h = await setup()
    const consoleChange = h.setHost('198.51.100.7')
    await h.gated.held(1)
    // Accepted for 192.0.2.10 while the move to 198.51.100.7 is being written.
    h.acceptPin()
    await h.gated.held(2)
    h.gated.release(0, 1)
    await consoleChange
    // Let the pin's write land: it must leave the stored (cleared) value alone.
    await h.gated.settled()

    expect(h.errors).toEqual([])
    for (const config of [h.services.current, await h.disk()]) {
      expect(config.console.host).toBe('198.51.100.7')
      expect(config.console.certFingerprint).toBeNull()
    }
  })
})
