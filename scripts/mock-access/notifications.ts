// The notifications WebSocket of the Access mock (P5.5): takes node:https `'upgrade'` requests,
// does the RFC 6455 handshake by hand (ws.ts) and pushes frames to every connected client.
// `GET /api/v1/developer/devices/notifications`, same Bearer token as REST (reference §11.1).
//
// A refused upgrade gets a plain HTTP response (401 `CODE_UNAUTHORIZED` for a missing or
// wrong token, 404 for another path) and the socket is closed. The mock sends no pings of its
// own (the reference does not say whether a console does) and ignores whatever clients send,
// apart from answering ping and close. `--fail-rate` does not apply to the upgrade.
// Node runs this file directly (type stripping): erasable syntax only.
import { STATUS_CODES } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { MOCK_HEADERS } from './app.ts'
import type { AccessMock, MockResponse } from './app.ts'
import {
  WS_OPCODE,
  acceptKey,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  encodeText,
} from './ws.ts'

export interface NotificationHub {
  /** Handler for the server's `'upgrade'` event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  /** Sends one JSON text frame to every client; returns how many got it. */
  broadcast(frame: unknown): number
  /** Cuts every client off without a close frame (a dropped connection); returns how many. */
  dropAll(): number
  /** Connected clients. */
  size(): number
}

export interface NotificationHubOptions {
  mock: AccessMock
  /** One line per upgrade result, connect and disconnect. Never receives headers or tokens. */
  log?: (line: string) => void
}

function headerLines(headers: Readonly<Record<string, string | number>>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${String(v)}\r\n`)
    .join('')
}

/** Flattens node's request headers to the lowercase single-value map the mock handler takes. */
export function flatHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v
  return headers
}

export function createNotificationHub(options: NotificationHubOptions): NotificationHub {
  const { mock } = options
  const log = options.log ?? ((): void => undefined)
  const clients = new Set<Duplex>()

  function refuse(socket: Duplex, out: MockResponse): void {
    const json = JSON.stringify(out.body)
    socket.end(
      `HTTP/1.1 ${String(out.status)} ${STATUS_CODES[out.status] ?? 'Error'}\r\n` +
        headerLines({
          ...out.headers,
          ...MOCK_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(json),
          Connection: 'close',
        }) +
        `\r\n${json}`,
    )
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    // A socket error with no listener would crash the process.
    socket.on('error', () => undefined)
    const headers = flatHeaders(req)
    const refusal = mock.authorizeUpgrade({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers,
      body: '',
    })
    if (refusal !== undefined) {
      refuse(socket, refusal)
      log(`WS upgrade ${path} -> ${String(refusal.status)} ${refusal.body.code}`)
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        headerLines({
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Accept': acceptKey(headers['sec-websocket-key'] ?? ''),
          ...MOCK_HEADERS,
        }) +
        '\r\n',
    )
    clients.add(socket)
    log(`WS upgrade ${path} -> 101, connected (${String(clients.size)} clients)`)

    const decoder = createFrameDecoder()
    let closing = false
    const gone = (): void => {
      if (!clients.delete(socket)) return
      log(`WS disconnected (${String(clients.size)} clients)`)
    }
    const receive = (chunk: Buffer): void => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch {
        socket.end(encodeClose(1009, 'frame too large'))
        gone()
        return
      }
      for (const f of frames) {
        if (f.opcode === WS_OPCODE.ping) socket.write(encodeFrame(WS_OPCODE.pong, f.payload))
        else if (f.opcode === WS_OPCODE.close && !closing) {
          // Echo the client's status code (if any) and finish.
          closing = true
          socket.end(encodeFrame(WS_OPCODE.close, f.payload.subarray(0, 2)))
          gone()
        }
        // Text, binary, continuation and pong frames from the client are discarded.
      }
    }
    socket.on('data', receive)
    socket.on('end', gone)
    socket.on('close', gone)
    socket.on('error', gone)
    if (head.length > 0) receive(head)
  }

  return {
    handleUpgrade,
    broadcast(frame) {
      const bytes = encodeText(JSON.stringify(frame))
      for (const s of clients) s.write(bytes)
      return clients.size
    },
    dropAll() {
      const n = clients.size
      for (const s of [...clients]) s.destroy()
      clients.clear()
      if (n > 0) log(`WS dropped ${String(n)} clients (mock control)`)
      return n
    },
    size: () => clients.size,
  }
}
