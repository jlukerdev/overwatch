// Minimal server-side WebSocket codec for the Access mock's notifications socket (P5.5).
// RFC 6455, by hand: the project has no `ws` package and the mock must not add a dependency.
// Pure (Buffers in, Buffers out), unit-tested in tests/unit/accessMock.test.ts; notifications.ts
// puts it on a socket. No extensions, no fragmentation on the way out.
// Node runs this file directly (type stripping): erasable syntax only.
import { createHash } from 'node:crypto'

/** The GUID every WebSocket handshake appends to the client key (RFC 6455 §1.3). */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

/** Largest payload the decoder buffers. The mock's clients only ever send control frames. */
export const WS_MAX_PAYLOAD = 1024 * 1024

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`: base64(sha1(key + GUID)). */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key.trim() + WS_GUID)
    .digest('base64')
}

/** A valid `Sec-WebSocket-Key` is 16 random bytes in base64. */
export function isValidKey(key: string | undefined): key is string {
  return key !== undefined && /^[A-Za-z0-9+/]{22}==$/.test(key.trim())
}

/**
 * One final (FIN) frame. Unmasked, as a server sends it, unless `mask` (4 bytes) is given, which
 * is how a client sends it: used by the tests to feed the decoder.
 */
export function encodeFrame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  if (mask !== undefined && mask.length !== 4) throw new Error('A WebSocket mask is 4 bytes')
  const len = payload.length
  const maskBit = mask === undefined ? 0 : 0x80
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = maskBit | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  if (mask === undefined) return Buffer.concat([header, payload])
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
  return Buffer.concat([header, mask, masked])
}

export function encodeText(text: string): Buffer {
  return encodeFrame(WS_OPCODE.text, Buffer.from(text, 'utf8'))
}

/** A close frame; with no `code` its payload is empty. */
export function encodeClose(code?: number, reason = ''): Buffer {
  if (code === undefined) return encodeFrame(WS_OPCODE.close, Buffer.alloc(0))
  const body = Buffer.alloc(2 + Buffer.byteLength(reason))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2, 'utf8')
  return encodeFrame(WS_OPCODE.close, body)
}

export interface WsFrame {
  fin: boolean
  opcode: number
  /** Whether the sender masked it (a client must). */
  masked: boolean
  /** The payload, already unmasked. */
  payload: Buffer
}

export interface WsFrameDecoder {
  /** Feeds received bytes; returns the frames completed by them. Throws on an oversized frame. */
  push(chunk: Buffer): WsFrame[]
}

/** Incremental frame parser: frames may arrive split across chunks or several to a chunk. */
export function createFrameDecoder(maxPayload = WS_MAX_PAYLOAD): WsFrameDecoder {
  let buf: Buffer = Buffer.alloc(0)
  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      const frames: WsFrame[] = []
      for (;;) {
        if (buf.length < 2) break
        const b0 = buf[0] ?? 0
        const b1 = buf[1] ?? 0
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let offset = 2
        if (len === 126) {
          if (buf.length < 4) break
          len = buf.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buf.length < 10) break
          const big = buf.readBigUInt64BE(2)
          if (big > BigInt(maxPayload)) throw new Error('WebSocket frame too large')
          len = Number(big)
          offset = 10
        }
        if (len > maxPayload) throw new Error('WebSocket frame too large')
        const total = offset + (masked ? 4 : 0) + len
        if (buf.length < total) break
        let payload: Buffer = Buffer.from(buf.subarray(total - len, total))
        if (masked) {
          const mask = buf.subarray(offset, offset + 4)
          payload = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)))
        }
        frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, masked, payload })
        buf = buf.subarray(total)
      }
      return frames
    },
  }
}
