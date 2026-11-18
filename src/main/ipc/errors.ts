// Main's error taxonomies → the renderer's (P1.5). Every IPC handler ends here, because rule 2 of
// `src/shared/ipc.ts` makes failure a value: a thrown `Error` would cross `ipcMain.handle` as a
// string with main's stack glued on, which is useless to the UI and the easiest way to leak a path
// or a query (CON-2, NFR-9).
//
// There are five error families in main — `ProtectApiError` (P1.3), `AccessApiError` (P1.4),
// `PinRequiredError`/`PinMismatchError` (P1.2), `ConsoleEndpointError` (CON-1) and `SecretsError`
// (CON-2) — and one union in the contract. Mapping them in one place is what keeps the renderer
// branching on `kind` instead of re-reading HTTP statuses, and what keeps the three pin states
// apart: `pin-required` runs the CON-3 accept dialog, `pin-mismatch` blocks until an explicit
// re-pin, and everything else is a plain connection problem.
//
// **The message is reused, never rebuilt.** Each of those classes is already written to be safe to
// show and to log — no key, no token, no URL, no query string, `host:port` at most — so this file
// copies `err.message` rather than composing something new from an error it has not vetted. For an
// error from nowhere in particular only `message` is read: never the stack, never the `cause` chain.
import { type IpcError, type IpcErrorKind } from '@shared/ipc'
import { AccessApiError, type AccessErrorKind } from '../access/client'
import { ConsoleEndpointError } from '../console/endpoints'
import { pinFailure } from '../net/errorCause'
import { ProtectApiError, type ProtectErrorKind } from '../protect/errors'
import { SecretsError } from '../secrets/secrets'
import { PinMismatchError, PinRequiredError } from '../tls/pinning'

/**
 * `ProtectErrorKind` → `IpcErrorKind`. Written as an exhaustive record rather than a cast or a
 * `default` arm so that a kind added to the client is a typecheck error here instead of silently
 * becoming `internal` in the UI. `pin` is absent because it needs the cause to decide (see
 * {@link pinKind}).
 */
const PROTECT_KINDS: Readonly<Record<Exclude<ProtectErrorKind, 'pin'>, IpcErrorKind>> = {
  auth: 'auth',
  'rate-limit': 'rate-limit',
  'not-found': 'not-found',
  'bad-request': 'bad-request',
  unavailable: 'unavailable',
  server: 'server',
  timeout: 'timeout',
  network: 'network',
  'invalid-response': 'invalid-response',
  // A subscription the console closed with no better reason is a connection problem as far as the
  // user is concerned; the contract has no separate kind for it and does not need one.
  closed: 'network',
}

/**
 * `AccessErrorKind` → `IpcErrorKind`, same exhaustiveness rule. `forbidden` becomes `auth`: the
 * contract's `auth` covers 401 **and** 403, and for the door reads a refusal means the token lacks
 * the door scopes — which is Settings' business (DOOR-1). For an unlock (P5.4) a refusal can also
 * mean the door has no Door Hub; the kind stays `auth` (the contract has no `forbidden`, and the
 * community sources cannot tell the two apart, OS-1), but the message names both causes, and the
 * connection manager keeps the Access status `connected` for it, since the console did answer.
 */
const ACCESS_KINDS: Readonly<Record<Exclude<AccessErrorKind, 'pin'>, IpcErrorKind>> = {
  disabled: 'disabled',
  auth: 'auth',
  forbidden: 'auth',
  'not-found': 'not-found',
  'bad-request': 'bad-request',
  'rate-limit': 'rate-limit',
  server: 'server',
  timeout: 'timeout',
  network: 'network',
  'invalid-response': 'invalid-response',
}

/**
 * Which of the two pin states a `kind: 'pin'` failure is. The distinction matters to the UI and not
 * to the clients, which is why they collapse both into one kind: `pin-required` means "no
 * certificate has been accepted yet", so Settings opens the CON-3 dialog, while `pin-mismatch`
 * means "the presented certificate is not the pinned one", which may only ever be resolved by an
 * explicit re-pin. Read through `pinFailure`, because `fetch` wraps the real cause in a `TypeError`.
 */
function pinKind(cause: unknown): IpcErrorKind {
  return pinFailure(cause) instanceof PinRequiredError ? 'pin-required' : 'pin-mismatch'
}

/**
 * Any failure in main as the one shape the renderer may see.
 *
 * `fallback.endpoint` is used only when the error does not carry its own `host:port` — a caller
 * knows which endpoint it was talking to even when the failure does not.
 */
export function toIpcError(err: unknown, fallback: { endpoint?: string | null } = {}): IpcError {
  const where = fallback.endpoint ?? null

  if (err instanceof PinRequiredError) {
    return { kind: 'pin-required', message: err.message, endpoint: err.endpoint, retryable: false }
  }
  if (err instanceof PinMismatchError) {
    // Never retryable: repeating the call would present the same certificate (CON-3).
    return {
      kind: 'pin-mismatch',
      message: err.message,
      endpoint: err.endpoint ?? where,
      retryable: false,
    }
  }
  if (err instanceof ConsoleEndpointError) {
    // CON-1: there is nothing to retry until the address in Settings changes.
    return { kind: 'not-configured', message: err.message, endpoint: where, retryable: false }
  }
  if (err instanceof ProtectApiError) {
    return {
      kind: err.kind === 'pin' ? pinKind(err.cause) : PROTECT_KINDS[err.kind],
      message: err.message,
      endpoint: err.endpoint ?? where,
      retryable: err.retryable,
    }
  }
  if (err instanceof AccessApiError) {
    return {
      kind: err.kind === 'pin' ? pinKind(err.cause) : ACCESS_KINDS[err.kind],
      message: err.message,
      endpoint: err.endpoint ?? where,
      retryable: err.retryable,
    }
  }
  if (err instanceof SecretsError) {
    // The keystore's own failures are not something the UI can classify further, and the store's
    // messages are deliberately fixed text with no secret in them (CON-2).
    return { kind: 'internal', message: err.message, endpoint: where, retryable: false }
  }

  // Anything else is a bug in main. The message is still shown — it is ours, not a response body —
  // but the stack and the cause chain stay in main's log, where they cannot leak a path to the UI.
  return {
    kind: 'internal',
    message: err instanceof Error ? err.message : 'An unexpected error occurred in View Protect.',
    endpoint: where,
    retryable: false,
  }
}
