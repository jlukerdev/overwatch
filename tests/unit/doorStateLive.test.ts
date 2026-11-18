// DOOR-6 end to end (P5.5): the real Access client, the real notifications subscription and the real
// door-state monitor against the mock (`scripts/mock-access/`) over real pinned TLS on an ephemeral
// loopback port. Nothing is faked but the console itself, so this is the closest thing to gate G5's
// "against the mock" evidence that runs without a window: a door unlocked by the app's own PUT, a
// door unlocked from elsewhere with **no** push (a card tap), and a dropped socket.
//
// Real timers on purpose. The mock relocks after 400 ms and the monitor's burst poll is 1 s, so each
// case waits a few seconds at most.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetch } from 'undici'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAccessMock, type AccessMock } from '../../scripts/mock-access/app.ts'
import { SEED_DOORS } from '../../scripts/mock-access/doors.ts'
import { createMockServer } from '../../scripts/mock-access/http.ts'
import { createAccessClient, type AccessClient } from '../../src/main/access/client'
import {
  createDoorStateMonitor,
  type DoorStateMonitor,
} from '../../src/main/access/doorStateMonitor'
import {
  accessNotificationsUrl,
  createAccessNotifications,
  type AccessNotificationsState,
} from '../../src/main/access/notifications'
import { ACCESS_API_PATH, ACCESS_EVENT_REMOTE_UNLOCK } from '../../src/main/access/types'
import type { ConsoleEndpoint } from '../../src/main/console/endpoints'
import { createPinnedAgent } from '../../src/main/tls/pinning'
import type { DoorStates } from '../../src/shared/models'

const HOST = '127.0.0.1'
const TOKEN = 'door-state-live-test-token'
const UNLOCK_MS = 400

const FRONT = SEED_DOORS[0]?.id ?? ''
const GARAGE = SEED_DOORS[1]?.id ?? ''
const OFFICE = SEED_DOORS[2]?.id ?? ''

describe('DOOR-6 against the mock over pinned TLS', () => {
  let certDir: string
  let mock: AccessMock
  let running: ReturnType<typeof createMockServer>
  let endpoint: ConsoleEndpoint
  let agent: ReturnType<typeof createPinnedAgent>
  let client: AccessClient

  let monitor: DoorStateMonitor | null = null
  let emitted: DoorStates[] = []
  let events: string[] = []
  let socketStates: AccessNotificationsState[] = []
  let reads = 0
  /** Upgrade attempts the mock has seen since last reset (its own log lines). */
  let upgrades = 0

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'vp-door-live-'))
    const keyPath = join(certDir, 'key.pem')
    const certPath = join(certDir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=view-protect-access-mock',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const cert = readFileSync(certPath, 'utf8')
    mock = createAccessMock({ token: TOKEN, unlockMs: UNLOCK_MS })
    running = createMockServer({
      mock,
      cert,
      key: readFileSync(keyPath, 'utf8'),
      log: (line) => {
        if (line.startsWith('WS upgrade')) upgrades += 1
      },
    })
    await new Promise<void>((resolve) => {
      running.server.listen(0, HOST, () => {
        resolve()
      })
    })
    const port = (running.server.address() as AddressInfo).port
    const hostPort = `${HOST}:${String(port)}`
    const origin = `https://${hostPort}`
    endpoint = { host: HOST, port, hostPort, origin, baseUrl: `${origin}${ACCESS_API_PATH}` }
    agent = createPinnedAgent(new X509Certificate(cert).fingerprint256, { endpoint: hostPort })
    client = createAccessClient({
      endpoint,
      enabled: () => true,
      token: () => TOKEN,
      dispatcher: () => agent,
    })
  })

  afterEach(() => {
    monitor?.stop()
    monitor = null
  })

  afterAll(async () => {
    await agent.close()
    await running.close()
    rmSync(certDir, { recursive: true, force: true })
  })

  /** The monitor exactly as `src/main/index.ts` and the connection manager assemble it. */
  function startMonitor(linked: readonly string[]): DoorStateMonitor {
    emitted = []
    events = []
    socketStates = []
    reads = 0
    const created = createDoorStateMonitor({
      readDoors: async () => {
        reads += 1
        return client.doors()
      },
      openNotifications: (handlers) => {
        const socket = createAccessNotifications({
          url: accessNotificationsUrl(endpoint),
          token: () => TOKEN,
          dispatcher: () => agent,
          onNotification: (notification) => {
            events.push(notification.event)
            handlers.onNotification(notification)
          },
          onStateChange: (state) => {
            socketStates.push(state)
            handlers.onStateChange(state)
          },
        })
        socket.start()
        return socket
      },
      linkedDoorIds: () => new Set(linked),
      onStates: (states) => emitted.push(states),
    })
    monitor = created
    created.start()
    return created
  }

  async function until(what: string, check: () => boolean, timeoutMs = 6000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** A mock-only control route: something other than the app acting on a door. */
  async function mockControl(path: string): Promise<void> {
    const res = await fetch(`${endpoint.origin}/__mock${path}`, {
      method: 'POST',
      dispatcher: agent,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    await res.text()
  }

  const relayOf = (id: string): string | undefined => monitor?.states[id]?.relay

  it('reads the linked doors on start, and only those', async () => {
    startMonitor([FRONT, GARAGE])
    await until('the first states', () => emitted.length > 0)
    expect(Object.keys(emitted[0] ?? {}).sort()).toEqual([FRONT, GARAGE].sort())
    expect(relayOf(FRONT)).toBe('lock')
    expect(monitor?.states[GARAGE]).toEqual({ relay: 'lock', position: 'open' })
    await until('the notifications socket', () => socketStates.includes('open'))
  })

  it("follows the app's own unlock to unlocked and back to locked, with one PUT", async () => {
    const created = startMonitor([FRONT])
    await until('the socket and the first read', () => {
      return socketStates.includes('open') && relayOf(FRONT) === 'lock'
    })

    await client.unlock(FRONT)
    created.poke('unlock answered')
    await until('the button to go green', () => relayOf(FRONT) === 'unlock', 1500)
    // The mock pushes the documented frame for a remote unlock...
    await until('the remote_unlock frame', () => events.includes(ACCESS_EVENT_REMOTE_UNLOCK))
    // ...and nothing on relock, so the return to locked is found by the burst poll.
    await until('the relock', () => relayOf(FRONT) === 'lock', 4000)
    expect(events.filter((event) => event !== ACCESS_EVENT_REMOTE_UNLOCK)).toEqual([])
    expect(emitted.map((states) => states[FRONT]?.relay)).toEqual(['lock', 'unlock', 'lock'])
  })

  it('shows a door unlocked from elsewhere with no push at all (a card tap), then its relock', async () => {
    startMonitor([OFFICE])
    await until('the socket and the first read', () => {
      return socketStates.includes('open') && relayOf(OFFICE) === 'lock'
    })
    mock.store.setLockRule(OFFICE, { type: 'keep_unlock' })
    // No frame is sent for this, so only the baseline poll (5 s with the socket open) can see it.
    await until('the baseline poll to see it', () => relayOf(OFFICE) === 'unlock', 7000)
    expect(events).toEqual([])
    await mockControl(`/doors/${OFFICE}/lock`)
    // A door is unlocked, so reads are now 1 s apart.
    await until('the relock', () => relayOf(OFFICE) === 'lock', 2500)
  }, 15_000)

  it('keeps reading while the socket is down, and the socket comes back by itself', async () => {
    startMonitor([FRONT])
    await until('the socket', () => socketStates.includes('open'))
    const readsBefore = reads
    await mockControl('/notifications/drop')
    await until('the drop to be noticed', () => socketStates.includes('reconnecting'))
    // 2 s polling while it is down; the door is still reported.
    await until('a read without the socket', () => reads > readsBefore, 3000)
    expect(relayOf(FRONT)).toBe('lock')
    await until(
      'the reconnect',
      () => socketStates.lastIndexOf('open') > socketStates.indexOf('reconnecting'),
      4000,
    )
  })

  it('a rejected token stops polling for good and never reaches the socket (the REST read detects it)', async () => {
    // undici reports a refused upgrade with no status, so the socket alone would keep retrying.
    // The monitor's first GET /doors answers 401 and halts it, and the socket is only opened after
    // a read that worked: no upgrade is ever attempted with the rejected token.
    const badClient = createAccessClient({
      endpoint,
      enabled: () => true,
      token: () => 'not-the-token',
      dispatcher: () => agent,
    })
    const socketStates: AccessNotificationsState[] = []
    const results: string[] = []
    let badReads = 0
    const halted = createDoorStateMonitor({
      readDoors: async () => {
        badReads += 1
        return badClient.doors()
      },
      openNotifications: (handlers) => {
        const socket = createAccessNotifications({
          url: accessNotificationsUrl(endpoint),
          token: () => 'not-the-token',
          dispatcher: () => agent,
          onNotification: (notification) => {
            handlers.onNotification(notification)
          },
          onStateChange: (state) => {
            socketStates.push(state)
            handlers.onStateChange(state)
          },
        })
        socket.start()
        return socket
      },
      linkedDoorIds: () => new Set([FRONT]),
      onStates: () => undefined,
      onReadResult: (result) => {
        results.push(result.ok ? 'ok' : ((result.error as { kind?: string }).kind ?? 'unknown'))
      },
    })
    upgrades = 0
    halted.start()
    await until('the halt', () => !halted.running)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(results).toEqual(['auth'])
    expect(badReads).toBe(1)
    expect(socketStates).toEqual([])
    expect(upgrades).toBe(0)
    halted.stop()
  })

  it('stops for good: no read and no state after stop()', async () => {
    const created = startMonitor([FRONT])
    await until('the first states', () => relayOf(FRONT) === 'lock')
    created.stop()
    expect(emitted.at(-1)).toEqual({})
    const readsAtStop = reads
    await new Promise((resolve) => setTimeout(resolve, 2300))
    expect(reads).toBe(readsAtStop)
    expect(created.states).toEqual({})
  })
})
