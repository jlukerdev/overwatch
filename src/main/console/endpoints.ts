// Turns the saved console settings (SPEC §6 `console`) into the two endpoints the app talks to:
// Protect behind 443 and the Access developer API on 12445. One place owns these rules because
// three things have to agree on them — the REST clients, the WebSocket subscriptions and TLS
// pinning, which is **per host:port** (P0.4 §4) and so needs the port, not just the host.
//
// Nothing here does I/O, imports Electron or touches a secret: it is string arithmetic over the
// config, and the unit tests cover it directly.
import { ACCESS_API_PATH, ACCESS_DEFAULT_PORT } from '../access/types'
import { hostPortKey } from '../tls/pinning'
import type { ConsoleConfig } from '@shared/models'

/** Where the Integration API sits behind the console's own proxy (SPEC §5.1). */
export const PROTECT_API_PREFIX = '/proxy/protect/integration'

/** The console's HTTPS port. `console.host` may override it as `host:port`. */
export const DEFAULT_HTTPS_PORT = 443

/** A reachable HTTPS endpoint, with everything pinning and the clients need. */
export interface ConsoleEndpoint {
  /** Connect host: a name or an IP literal, **without** brackets, ready for `tls.connect`. */
  readonly host: string
  readonly port: number
  /** Pin and Agent key (`host:port`, IPv6 bracketed) — {@link hostPortKey}. */
  readonly hostPort: string
  /** `https://host[:port]`, no trailing slash. */
  readonly origin: string
  /** Origin plus the API path, no trailing slash. Request paths are appended to it. */
  readonly baseUrl: string
}

/** The console settings are not usable yet, with a message meant for Settings (CON-1). */
export class ConsoleEndpointError extends Error {
  override readonly name = 'ConsoleEndpointError'
}

/**
 * Splits `console.host` into a host and a port. Accepts what a user plausibly types: `192.0.2.10`,
 * `udm.local`, `192.0.2.10:8443`, `https://udm.local`, a trailing slash or path (ignored), and a
 * bracketed IPv6 literal (`[2001:db8::1]`, brackets required to tell the address from a port).
 *
 * Anything but https is refused rather than silently upgraded: an `http://` console would send the
 * API key in clear (CON-2, R5).
 */
export function parseConsoleHost(raw: string): { host: string; port: number } {
  const text = raw.trim()
  if (text === '') {
    throw new ConsoleEndpointError(
      'No console address is set yet. Enter the console IP or host name in Settings (CON-1).',
    )
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== 'https') {
    throw new ConsoleEndpointError(
      `The console address must be https (got ${scheme}://). The Integration API key may only ` +
        'travel over TLS (CON-2).',
    )
  }
  let url: URL
  try {
    url = new URL(scheme === undefined ? `https://${text}` : text)
  } catch {
    throw new ConsoleEndpointError(
      `"${text}" is not a usable console address. Use the IP or host name, optionally with a ` +
        'port (for example 192.0.2.10 or udm.local:8443).',
    )
  }
  const host = bareHost(url.hostname)
  if (host === '') {
    throw new ConsoleEndpointError(
      `"${text}" has no host part. Use the IP or host name, for example 192.0.2.10.`,
    )
  }
  const port = url.port === '' ? DEFAULT_HTTPS_PORT : Number(url.port)
  return { host, port }
}

/** The Protect Integration API endpoint (SPEC §5.1). Request paths keep the contract's `/v1/…`. */
export function protectEndpoint(config: ConsoleConfig): ConsoleEndpoint {
  const { host, port } = parseConsoleHost(config.host)
  return makeEndpoint(host, port, PROTECT_API_PREFIX)
}

/**
 * The Access developer API endpoint (SPEC §5.2, DOOR-1). `console.accessBaseUrl` is the **API
 * root** — origin plus path, as `VP_ACCESS_BASE_URL` is for the spike — so the newer-firmware
 * alternative (`https://<console>/proxy/access/api/v1/developer`) and the local mock are both just
 * a different value here. When it is `null` the root is derived as
 * `https://<console.host>:12445/api/v1/developer`, **ignoring any port in `console.host`**: the
 * developer API has its own port.
 *
 * This resolves whether or not Access is enabled. DOOR-0 is enforced by the client, which makes no
 * call at all while the feature is off; the endpoint is still needed to pin and show its
 * certificate.
 */
export function accessEndpoint(config: ConsoleConfig): ConsoleEndpoint {
  if (config.accessBaseUrl === null) {
    const { host } = parseConsoleHost(config.host)
    return makeEndpoint(host, ACCESS_DEFAULT_PORT, ACCESS_API_PATH)
  }
  let url: URL
  try {
    url = new URL(config.accessBaseUrl)
  } catch {
    throw new ConsoleEndpointError(
      `The Access API URL "${config.accessBaseUrl}" is not a valid URL. Clear it to use the ` +
        `default (https://<console>:${String(ACCESS_DEFAULT_PORT)}${ACCESS_API_PATH}).`,
    )
  }
  if (url.protocol !== 'https:') {
    throw new ConsoleEndpointError(
      `The Access API URL must be https (got ${url.protocol}//). The API token may only travel ` +
        'over TLS (CON-2).',
    )
  }
  const host = bareHost(url.hostname)
  if (host === '') {
    throw new ConsoleEndpointError(`The Access API URL "${config.accessBaseUrl}" has no host.`)
  }
  const port = url.port === '' ? DEFAULT_HTTPS_PORT : Number(url.port)
  return makeEndpoint(host, port, url.pathname)
}

/**
 * `wss://…/v1/subscribe/<channel>` for one of the two Protect subscriptions (SPEC §5.1). The same
 * `X-API-KEY` header authenticates it, and the upgrade spends a rate-limit permit (R9).
 */
export function protectSubscribeUrl(
  protect: ConsoleEndpoint,
  channel: 'devices' | 'events',
): string {
  return `${protect.baseUrl.replace(/^https:/, 'wss:')}/v1/subscribe/${channel}`
}

/** Strips the brackets Node's `URL` keeps around an IPv6 literal; `tls.connect` wants them gone. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function makeEndpoint(host: string, port: number, path: string): ConsoleEndpoint {
  const authority = host.includes(':') ? `[${host}]` : host
  // 443 is left out of the URL so requests look exactly like the ones P0.3 verified, and so the
  // `Host` header does too. `port` and `hostPort` always carry it.
  const origin = `https://${authority}${port === DEFAULT_HTTPS_PORT ? '' : `:${String(port)}`}`
  return {
    host,
    port,
    hostPort: hostPortKey(host, port),
    origin,
    baseUrl: `${origin}${path.replace(/\/+$/, '')}`,
  }
}
