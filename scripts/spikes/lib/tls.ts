// Trust-on-first-use certificate pinning for the spike (mirrors CON-3; P1.2 builds the real one).
// Verification is turned off only inside this one undici Agent, and every socket it opens is
// checked against the pinned leaf SHA-256 fingerprint before any request bytes are sent.
import { isIP } from 'node:net'
import { connect, type TLSSocket } from 'node:tls'
import { Agent, buildConnector } from 'undici'

export interface LeafCertInfo {
  /** Colon-separated uppercase SHA-256 of the DER leaf certificate (Node's `fingerprint256`). */
  fingerprint256: string
  validFrom: string
  validTo: string
  selfSigned: boolean
}

/** Normalises `aa:bb...`, `AABB...` or `aa bb ...` to Node's `AA:BB:...` form. */
export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (hex.length !== 64) throw new Error('A SHA-256 fingerprint must be 64 hex digits')
  return hex.match(/../g)?.join(':') ?? ''
}

function servername(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined
}

/** Connects once without verification, only to read the leaf certificate (the TOFU step). */
export function fetchLeafCert(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<LeafCertInfo> {
  return new Promise((resolve, reject) => {
    const name = servername(host)
    const socket = connect({
      host,
      port,
      rejectUnauthorized: false,
      ...(name === undefined ? {} : { servername: name }),
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`TLS connect timed out after ${String(timeoutMs)} ms`))
    })
    socket.once('error', reject)
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert.fingerprint256) {
        reject(new Error('The server did not present a certificate'))
        return
      }
      resolve({
        fingerprint256: cert.fingerprint256,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        selfSigned: JSON.stringify(cert.issuer) === JSON.stringify(cert.subject),
      })
    })
  })
}

/** An undici Agent that only completes TLS handshakes whose leaf matches `fingerprint256`. */
export function createPinnedAgent(fingerprint256: string): Agent {
  const expected = normalizeFingerprint(fingerprint256)
  // No TLS session cache: a resumed session may not expose the peer certificate, and every
  // connection must present (and be checked against) the pinned leaf.
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 })
  return new Agent({
    connect(opts, callback) {
      base(opts, (err, socket) => {
        if (err !== null) {
          callback(err, null)
          return
        }
        const actual = (socket as TLSSocket).getPeerCertificate().fingerprint256
        if (actual !== expected) {
          socket.destroy()
          callback(new Error(`Certificate pin mismatch: got ${actual}, expected ${expected}`), null)
          return
        }
        callback(null, socket)
      })
    },
  })
}
