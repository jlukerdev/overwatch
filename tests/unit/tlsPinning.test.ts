// P1.2 (CON-3, R4, NFR-9): trust-on-first-use certificate pinning in src/main/tls/pinning.ts.
//
// These tests run against real TLS servers. The certificates are self-signed and generated here
// with the system `openssl` into a temp dir (the same approach as scripts/mock-access/server.ts),
// so nothing is committed and the pinning path is exercised exactly as against a console.
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, fetch } from 'undici'
import {
  PinMismatchError,
  PinRequiredError,
  createPinRegistry,
  createPinnedAgent,
  fetchLeafCert,
  fingerprintsMatch,
  hostPortKey,
  normalizeFingerprint,
} from '../../src/main/tls/pinning'
import type { PinStore } from '../../src/main/tls/pinning'

const HOST = '127.0.0.1'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const SAMPLE = `${FP_A}:${FP_A}` // 32 bytes, i.e. a well-formed SHA-256 fingerprint

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const OPENSSL = hasOpenssl()

interface TestCert {
  cert: string
  key: string
  fingerprint256: string
  commonName: string
}

let certDir = ''

/** One self-signed P-256 certificate, generated for this run only. */
function makeCert(commonName: string): TestCert {
  const certPath = join(certDir, `${commonName}.cert.pem`)
  const keyPath = join(certDir, `${commonName}.key.pem`)
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
      `/CN=${commonName}`,
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const cert = readFileSync(certPath, 'utf8')
  return {
    cert,
    key: readFileSync(keyPath, 'utf8'),
    fingerprint256: new X509Certificate(cert).fingerprint256,
    commonName,
  }
}

interface TestServer {
  port: number
  url: string
  /** Request paths that reached the application — must stay empty when a pin check fails. */
  requests: string[]
  /** Paths of accepted WebSocket upgrades. */
  upgrades: string[]
  /** One entry per completed TLS handshake; `resumed` is the server's `isSessionReused()`. */
  handshakes: { resumed: boolean }[]
  /** TCP connections accepted, and how many of those have closed again. */
  connections: number
  closedConnections: number
  stop(): Promise<void>
}

/** An HTTPS server that answers `ok`, plus a minimal RFC 6455 upgrade so a WebSocket can connect. */
async function startServer(
  c: TestCert,
  options: { connectionClose?: boolean } = {},
): Promise<TestServer> {
  const requests: string[] = []
  const upgrades: string[] = []
  const handshakes: { resumed: boolean }[] = []
  const state = { connections: 0, closed: 0 }
  const live = new Set<Duplex>()

  const server = createServer({ cert: c.cert, key: c.key }, (req, res) => {
    requests.push(req.url ?? '/')
    res.writeHead(200, {
      'content-type': 'text/plain',
      ...(options.connectionClose === true ? { connection: 'close' } : {}),
    })
    res.end('ok')
  })
  // The TCP level, not 'secureConnection': when the client rejects the pin it destroys the socket
  // as soon as it has the certificate, which can beat the server's own handshake completion.
  server.on('connection', (socket) => {
    state.connections++
    live.add(socket)
    // A pin failure destroys the socket from the client side; without this the reset would be an
    // unhandled 'error' on the server socket.
    socket.on('error', () => undefined)
    socket.once('close', () => {
      state.closed++
      live.delete(socket)
    })
  })
  server.on('secureConnection', (socket: TLSSocket) => {
    handshakes.push({ resumed: socket.isSessionReused() })
  })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] ?? ''
    const accept = createHash('sha1')
      .update(`${Array.isArray(key) ? key.join('') : key}${WS_GUID}`)
      .digest('base64')
    upgrades.push(req.url ?? '/')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })
  await new Promise<void>((resolve) => {
    server.listen(0, HOST, () => {
      resolve()
    })
  })
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  const { port } = address

  return {
    port,
    url: `https://${HOST}:${String(port)}/meta/info`,
    requests,
    upgrades,
    handshakes,
    get connections() {
      return state.connections
    },
    get closedConnections() {
      return state.closed
    },
    async stop() {
      // An upgraded WebSocket socket is no longer the server's, so closeAllConnections() misses
      // it and close() would wait forever.
      for (const socket of live) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

/** The injected pin store port, in memory. The real one is backed by the config store. */
function memoryStore(
  initial: Record<string, string> = {},
): PinStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: (hostPort) => map.get(hostPort) ?? null,
    set: (hostPort, fingerprint256) => {
      map.set(hostPort, fingerprint256)
    },
  }
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the request to fail')
    },
    (err: unknown) => err,
  )
}

/** The pinned Agent's error surfaces as the `cause` of fetch's own TypeError. */
function pinMismatchCause(err: unknown): PinMismatchError {
  const cause = err instanceof Error ? err.cause : undefined
  if (!(cause instanceof PinMismatchError))
    throw new Error(`expected a PinMismatchError cause, got ${String(cause ?? err)}`)
  return cause
}

describe('normalizeFingerprint', () => {
  const canonical = SAMPLE

  it('accepts every input form the accept dialog and Settings can produce', () => {
    expect(normalizeFingerprint(canonical)).toBe(canonical)
    expect(normalizeFingerprint(canonical.toLowerCase())).toBe(canonical)
    expect(normalizeFingerprint(canonical.replace(/:/g, ''))).toBe(canonical)
    expect(normalizeFingerprint(canonical.replace(/:/g, '').toLowerCase())).toBe(canonical)
    expect(normalizeFingerprint(canonical.replace(/:/g, ' '))).toBe(canonical)
    expect(normalizeFingerprint(canonical.replace(/:/g, '-'))).toBe(canonical)
    expect(normalizeFingerprint(`  ${canonical}\n`)).toBe(canonical)
  })

  it('is idempotent on its own output', () => {
    expect(normalizeFingerprint(normalizeFingerprint(canonical))).toBe(canonical)
  })

  it('rejects anything that is not 64 hex digits', () => {
    const bad = [
      '',
      'not a fingerprint',
      canonical.slice(0, -1), // 63 digits
      `${canonical}:FF`, // 66 digits
      canonical.replace('AA', 'ZZ'), // non-hex
      canonical.replace(/:/g, ', '), // not a recognised separator
      `${canonical} (SHA-256)`, // trailing junk must not be stripped silently
    ]
    for (const value of bad) expect(() => normalizeFingerprint(value)).toThrow(/64 hex digits/)
  })
})

describe('fingerprintsMatch', () => {
  it('ignores formatting on both sides', () => {
    expect(fingerprintsMatch(SAMPLE, SAMPLE.toLowerCase().replace(/:/g, ''))).toBe(true)
    expect(fingerprintsMatch(SAMPLE.replace(/:/g, ' '), SAMPLE)).toBe(true)
  })

  it('is false for a different certificate and for unusable input', () => {
    expect(fingerprintsMatch(SAMPLE, SAMPLE.replace(/^AA/, 'AB'))).toBe(false)
    expect(fingerprintsMatch(SAMPLE, 'nonsense')).toBe(false)
    expect(fingerprintsMatch('', SAMPLE)).toBe(false)
  })
})

describe('hostPortKey', () => {
  it('keys per host and port, so 443 and 12445 are separate pins (P0.4 §4)', () => {
    expect(hostPortKey('192.168.1.1', 443)).toBe('192.168.1.1:443')
    expect(hostPortKey('192.168.1.1', 12445)).toBe('192.168.1.1:12445')
    expect(hostPortKey('192.168.1.1', 443)).not.toBe(hostPortKey('192.168.1.1', 12445))
  })

  it('normalises the host and brackets IPv6', () => {
    expect(hostPortKey(' Console.Local ', 443)).toBe('console.local:443')
    expect(hostPortKey('::1', 12445)).toBe('[::1]:12445')
    expect(hostPortKey('[::1]', 12445)).toBe('[::1]:12445')
  })
})

describe.skipIf(!OPENSSL)('against a real TLS server', () => {
  let certA: TestCert
  let certB: TestCert
  let serverA: TestServer
  let serverB: TestServer

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'vp-tls-pinning-'))
    certA = makeCert('view-protect-test-a')
    certB = makeCert('view-protect-test-b')
    serverA = await startServer(certA)
    serverB = await startServer(certB)
  })

  afterAll(async () => {
    await serverA.stop()
    await serverB.stop()
    rmSync(certDir, { recursive: true, force: true })
  })

  describe('fetchLeafCert', () => {
    it("returns the server's real fingerprint and the fields the accept dialog shows (CON-3)", async () => {
      const info = await fetchLeafCert(HOST, serverA.port)
      expect(info.fingerprint256).toBe(certA.fingerprint256)
      expect(info.fingerprint256).toBe(normalizeFingerprint(info.fingerprint256))
      expect(info.hostPort).toBe(`${HOST}:${String(serverA.port)}`)
      expect(info.host).toBe(HOST)
      expect(info.port).toBe(serverA.port)
      expect(info.subjectCommonName).toBe(certA.commonName)
      expect(info.issuerCommonName).toBe(certA.commonName)
      expect(info.selfSigned).toBe(true)
      expect(Number.isNaN(Date.parse(info.validFrom))).toBe(false)
      expect(Number.isNaN(Date.parse(info.validTo))).toBe(false)
      // The probe only reads the certificate: nothing reached the application.
      expect(serverA.requests).toHaveLength(0)
    })

    it('tells the two endpoints apart (the Access port may serve another certificate)', async () => {
      const a = await fetchLeafCert(HOST, serverA.port)
      const b = await fetchLeafCert(HOST, serverB.port)
      expect(a.fingerprint256).toBe(certA.fingerprint256)
      expect(b.fingerprint256).toBe(certB.fingerprint256)
      expect(a.fingerprint256).not.toBe(b.fingerprint256)
    })

    it('times out and destroys the socket when the peer never completes a handshake', async () => {
      const accepted: Socket[] = []
      let closed = 0
      const stalled = createTcpServer((socket) => {
        accepted.push(socket)
        // Read and answer nothing: the ClientHello arrives, the handshake never finishes. The
        // socket has to be resumed, or a paused Node socket never reports the peer's FIN.
        socket.resume()
        socket.on('error', () => undefined)
        socket.once('close', () => {
          closed++
        })
      })
      await new Promise<void>((resolve) => {
        stalled.listen(0, HOST, () => {
          resolve()
        })
      })
      const address: AddressInfo | string | null = stalled.address()
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address')

      try {
        await expect(fetchLeafCert(HOST, address.port, 150)).rejects.toThrow(/timed out after 150/)
        // A failed probe leaks nothing: the socket is gone, which the server sees as a close.
        await vi.waitFor(() => {
          expect(accepted).toHaveLength(1)
          expect(closed).toBe(1)
        })
      } finally {
        for (const socket of accepted) socket.destroy()
        await new Promise<void>((resolve) => {
          stalled.close(() => {
            resolve()
          })
        })
      }
    })

    it('rejects when nothing is listening', async () => {
      // Port 1 on loopback: nothing binds it, so the connect is refused.
      await expect(fetchLeafCert(HOST, 1, 2_000)).rejects.toThrow()
    })
  })

  describe('createPinnedAgent', () => {
    it('completes the request when the leaf matches the pin', async () => {
      const agent = createPinnedAgent(certA.fingerprint256)
      try {
        const res = await fetch(serverA.url, { dispatcher: agent })
        expect(res.status).toBe(200)
        await expect(res.text()).resolves.toBe('ok')
        expect(serverA.requests).toContain('/meta/info')
      } finally {
        await agent.close()
      }
    })

    it('accepts a pin in any formatting (a fingerprint typed by hand still matches)', async () => {
      const agent = createPinnedAgent(certA.fingerprint256.replace(/:/g, '').toLowerCase())
      try {
        const res = await fetch(serverA.url, { dispatcher: agent })
        expect(res.status).toBe(200)
        await res.text()
      } finally {
        await agent.close()
      }
    })

    it('fails the connection, destroys the socket and sends no request on a mismatch', async () => {
      const endpoint = hostPortKey(HOST, serverA.port)
      const before = serverA.requests.length
      const connectionsBefore = serverA.connections
      const closedBefore = serverA.closedConnections
      const agent = createPinnedAgent(certB.fingerprint256, { endpoint })
      try {
        const err = await failureOf(fetch(serverA.url, { dispatcher: agent }))
        const mismatch = pinMismatchCause(err)
        expect(mismatch.name).toBe('PinMismatchError')
        expect(mismatch.endpoint).toBe(endpoint)
        expect(mismatch.expected).toBe(certB.fingerprint256)
        expect(mismatch.actual).toBe(certA.fingerprint256)
        expect(mismatch.message).toContain(certB.fingerprint256)
        expect(mismatch.message).toContain(certA.fingerprint256)
        expect(mismatch.message).toMatch(/Refusing to connect/)
        // No request bytes were written, and the socket the handshake used is gone.
        expect(serverA.requests).toHaveLength(before)
        await vi.waitFor(() => {
          expect(serverA.connections).toBe(connectionsBefore + 1)
          expect(serverA.closedConnections).toBe(closedBefore + 1)
        })
      } finally {
        await agent.close()
      }
    })

    it('serves undici WebSocket from the same dispatcher as fetch (P0.3 §8)', async () => {
      const agent = createPinnedAgent(certA.fingerprint256)
      try {
        const res = await fetch(serverA.url, { dispatcher: agent })
        await res.text()
        const ws = new WebSocket(`wss://${HOST}:${String(serverA.port)}/subscribe/events`, {
          dispatcher: agent,
        })
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => {
            resolve()
          })
          ws.addEventListener('error', () => {
            reject(new Error('the WebSocket handshake failed'))
          })
        })
        expect(serverA.upgrades).toContain('/subscribe/events')
        ws.close()
      } finally {
        await agent.close()
      }
    })

    it('does not resume TLS sessions: a second connection still sees the peer certificate', async () => {
      // The P0.3 §8 regression: with a session cache, the second connection resumes, the peer
      // certificate comes back empty and the pin check fails. `Connection: close` forces the
      // second request onto a fresh connection, which is where resumption would happen.
      const server = await startServer(certA, { connectionClose: true })
      const agent = createPinnedAgent(certA.fingerprint256)
      try {
        for (const path of ['/meta/info', '/cameras']) {
          const res = await fetch(`https://${HOST}:${String(server.port)}${path}`, {
            dispatcher: agent,
          })
          expect(res.status).toBe(200)
          await expect(res.text()).resolves.toBe('ok')
        }
        expect(server.requests).toStrictEqual(['/meta/info', '/cameras'])
        expect(server.handshakes).toHaveLength(2)
        expect(server.handshakes.map((h) => h.resumed)).toStrictEqual([false, false])
      } finally {
        await agent.close()
        await server.stop()
      }
    })
  })

  describe('createPinRegistry', () => {
    it('reports no-pin and refuses to hand out an Agent until the user accepts (CON-3)', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      const result = await registry.checkEndpoint(HOST, serverA.port)
      expect(result.state).toBe('no-pin')
      if (result.state !== 'no-pin') throw new Error('unreachable')
      expect(result.cert.fingerprint256).toBe(certA.fingerprint256)
      expect(result.endpoint.hostPort).toBe(hostPortKey(HOST, serverA.port))
      expect(registry.pinnedFingerprint(HOST, serverA.port)).toBeNull()
      expect(() => registry.agentFor(HOST, serverA.port)).toThrow(PinRequiredError)
      expect(store.map.size).toBe(0)
      await registry.closeAll()
    })

    it('reports match after acceptPin and reuses one Agent per endpoint', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      expect(store.map.get(hostPortKey(HOST, serverA.port))).toBe(certA.fingerprint256)

      const result = await registry.checkEndpoint(HOST, serverA.port)
      expect(result.state).toBe('match')
      if (result.state !== 'match') throw new Error('unreachable')
      expect(result.fingerprint256).toBe(certA.fingerprint256)

      const agent = registry.agentFor(HOST, serverA.port)
      expect(registry.agentFor(HOST, serverA.port)).toBe(agent)
      const res = await fetch(serverA.url, { dispatcher: agent })
      expect(res.status).toBe(200)
      await res.text()
      await registry.closeAll()
    })

    it('reports mismatch with both fingerprints and never re-pins by itself', async () => {
      const store = memoryStore({ [hostPortKey(HOST, serverA.port)]: certB.fingerprint256 })
      const registry = createPinRegistry(store)
      const result = await registry.checkEndpoint(HOST, serverA.port)
      expect(result.state).toBe('mismatch')
      if (result.state !== 'mismatch') throw new Error('unreachable')
      expect(result.expected).toBe(certB.fingerprint256)
      expect(result.actual).toBe(certA.fingerprint256)
      expect(result.message).toContain(hostPortKey(HOST, serverA.port))
      expect(result.message).toContain(certA.fingerprint256)
      // The stored pin is untouched, and connecting still fails.
      expect(store.map.get(hostPortKey(HOST, serverA.port))).toBe(certB.fingerprint256)
      const err = await failureOf(
        fetch(serverA.url, { dispatcher: registry.agentFor(HOST, serverA.port) }),
      )
      expect(pinMismatchCause(err).expected).toBe(certB.fingerprint256)
      await registry.closeAll()

      expect(() => {
        registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      }).toThrow(/already pinned/)
      expect(store.map.get(hostPortKey(HOST, serverA.port))).toBe(certB.fingerprint256)
    })

    it('accepts the same pin again in another format without complaining', () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256.replace(/:/g, '').toLowerCase())
      expect(store.map.get(hostPortKey(HOST, serverA.port))).toBe(certA.fingerprint256)
    })

    it('replaces the Agent on an explicit repin, and the stale Agent stops working', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      const stale = registry.agentFor(HOST, serverA.port)
      expect((await fetch(serverA.url, { dispatcher: stale })).status).toBe(200)

      // The console was reinstalled and now serves certB: the user re-pins deliberately.
      registry.repin(HOST, serverA.port, certB.fingerprint256)
      expect(store.map.get(hostPortKey(HOST, serverA.port))).toBe(certB.fingerprint256)
      const fresh = registry.agentFor(HOST, serverA.port)
      expect(fresh).not.toBe(stale)
      // The Agent built for the old pin cannot outlive it.
      await expect(fetch(serverA.url, { dispatcher: stale })).rejects.toThrow()
      // And the new one enforces the new pin against the server that still serves certA.
      expect(
        pinMismatchCause(await failureOf(fetch(serverA.url, { dispatcher: fresh }))).expected,
      ).toBe(certB.fingerprint256)
      await registry.closeAll()
    })

    it('rebuilds the Agent when the stored pin changes behind its back', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      const first = registry.agentFor(HOST, serverA.port)
      store.set(hostPortKey(HOST, serverA.port), certB.fingerprint256)
      expect(registry.agentFor(HOST, serverA.port)).not.toBe(first)
      await registry.closeAll()
    })

    it('keeps independent pins and Agents for two endpoints on different ports (P0.4 §4)', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      registry.acceptPin(HOST, serverB.port, certB.fingerprint256)
      expect(store.map.size).toBe(2)
      expect(registry.pinnedFingerprint(HOST, serverA.port)).toBe(certA.fingerprint256)
      expect(registry.pinnedFingerprint(HOST, serverB.port)).toBe(certB.fingerprint256)

      const agentA = registry.agentFor(HOST, serverA.port)
      const agentB = registry.agentFor(HOST, serverB.port)
      expect(agentA).not.toBe(agentB)
      expect((await fetch(serverA.url, { dispatcher: agentA })).status).toBe(200)
      expect((await fetch(serverB.url, { dispatcher: agentB })).status).toBe(200)
      // Each pin is enforced only on its own endpoint.
      expect(
        pinMismatchCause(await failureOf(fetch(serverB.url, { dispatcher: agentA }))).actual,
      ).toBe(certB.fingerprint256)
      await registry.closeAll()
    })

    it('treats an unreadable stored pin as an error, not as "no pin yet"', async () => {
      const store = memoryStore({ [hostPortKey(HOST, serverA.port)]: 'definitely-not-a-pin' })
      const registry = createPinRegistry(store)
      expect(() => registry.pinnedFingerprint(HOST, serverA.port)).toThrow(/not a SHA-256/)
      await expect(registry.checkEndpoint(HOST, serverA.port)).rejects.toThrow(/not a SHA-256/)
      expect(() => registry.agentFor(HOST, serverA.port)).toThrow(/not a SHA-256/)
      await registry.closeAll()
    })

    it('repin replaces an unparsable stored pin, which is the documented recovery', async () => {
      const key = hostPortKey(HOST, serverA.port)
      const store = memoryStore({ [key]: 'definitely-not-a-pin' })
      const registry = createPinRegistry(store)
      // acceptPin has to read the current pin to know it is not silently overwriting one, so it
      // still fails here...
      expect(() => {
        registry.acceptPin(HOST, serverA.port, SAMPLE)
      }).toThrow(/not a SHA-256/)
      // ...but repin is an explicit user action, and it is what the error message tells the user to
      // do, so it must not depend on parsing the broken value (PinStore has no clear()).
      registry.repin(HOST, serverA.port, SAMPLE)
      expect(store.map.get(key)).toBe(SAMPLE)
      expect(registry.pinnedFingerprint(HOST, serverA.port)).toBe(SAMPLE)
      expect(registry.agentFor(HOST, serverA.port)).toBeDefined()
      await registry.closeAll()
    })

    it('invalidate and closeAll drop the cached Agents', async () => {
      const store = memoryStore()
      const registry = createPinRegistry(store)
      registry.acceptPin(HOST, serverA.port, certA.fingerprint256)
      const first = registry.agentFor(HOST, serverA.port)
      registry.invalidate(HOST, serverA.port)
      const second = registry.agentFor(HOST, serverA.port)
      expect(second).not.toBe(first)
      await registry.closeAll()
      expect(registry.agentFor(HOST, serverA.port)).not.toBe(second)
      await registry.closeAll()
    })
  })
})
