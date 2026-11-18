// The Access mock as a node:https server (P0.4, P5.5): app.ts's pure handler behind TLS, plus the
// notifications WebSocket on the `'upgrade'` event. server.ts is the command line around this;
// tests/unit/accessMock.test.ts starts it on an ephemeral loopback port.
//
// Each request is logged as method, path and result code. Headers (and so the token) are never
// logged, and neither are query strings or bodies.
// Node runs this file directly (type stripping): erasable syntax only.
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { MOCK_HEADERS } from './app.ts'
import type { AccessMock, MockResponse } from './app.ts'
import { createNotificationHub, flatHeaders } from './notifications.ts'
import type { NotificationHub } from './notifications.ts'

const MAX_BODY_BYTES = 64 * 1024

export interface MockServerOptions {
  mock: AccessMock
  cert: string
  key: string
  /** Delay before every REST response. */
  latencyMs?: number
  /** Receives each log line, without a timestamp. */
  log?: (line: string) => void
}

export interface MockServer {
  /** Not listening yet: call `server.listen(port, host)`. */
  readonly server: Server
  readonly hub: NotificationHub
  /** Drops the WebSocket clients, cancels the door timers and closes the server. */
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) tooBig = true
      else chunks.push(c)
    })
    req.on('end', () => {
      resolve(tooBig ? undefined : Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export function createMockServer(options: MockServerOptions): MockServer {
  const { mock } = options
  const latencyMs = options.latencyMs ?? 0
  const log = options.log ?? ((): void => undefined)
  const hub = createNotificationHub({ mock, log })

  const offNotification = mock.onNotification((frame) => {
    const n = hub.broadcast(frame)
    log(`WS push ${frame.event} -> ${String(n)} clients`)
  })
  const offDrop = mock.onDropClients(() => hub.dropAll())
  // For whoever watches the mock's console. None of this is sent to clients: the reference
  // documents no relay or relock push.
  const offChange = mock.store.onChange((change) => {
    const name = 'doorId' in change ? `"${mock.store.get(change.doorId)?.name ?? '?'}"` : ''
    if (change.kind === 'relay') log(`door ${name} relay -> ${change.relay} (not pushed)`)
    else if (change.kind === 'position') log(`door ${name} position -> ${change.position}`)
    else if (change.kind === 'unlock' && change.source === 'local')
      log(`door ${name} unlocked at the door (mock control)`)
  })

  const server = createServer({ cert: options.cert, key: options.key }, (req, res) => {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    void (async () => {
      const body = await readBody(req)
      let out: MockResponse
      if (body === undefined) {
        out = {
          status: 413,
          headers: MOCK_HEADERS,
          body: { code: 'CODE_PARAMS_INVALID', msg: 'request body too large' },
        }
      } else {
        out = mock.handle({ method, url: req.url ?? '/', headers: flatHeaders(req), body })
      }
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs))
      const json = JSON.stringify(out.body)
      res.writeHead(out.status, {
        ...out.headers,
        // Set again here so no response path can drop the mock marker.
        ...MOCK_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
      })
      res.end(json)
      // Method, path, result only. Never headers: they carry the token.
      log(`${method} ${path} -> ${String(out.status)} ${out.body.code}`)
    })().catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.writeHead(500, MOCK_HEADERS)
      res.end()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    hub.handleUpgrade(req, socket, head)
  })

  return {
    server,
    hub,
    close() {
      offNotification()
      offDrop()
      offChange()
      hub.dropAll()
      mock.store.dispose()
      return new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
}
