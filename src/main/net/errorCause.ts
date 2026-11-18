// Reading a thrown value's `cause` chain, which is where the real reason lives.
//
// `fetch` reports a connection failure as a bare `TypeError` ("fetch failed") and puts the actual
// error — the refused connection, the DNS failure, the `PinMismatchError` from the pinned Agent's
// connector — in `cause`, sometimes a level or two down. Every client therefore has to unwrap
// before it can classify a failure, and all of them were doing it with their own copy of the same
// loop. One copy also means one place where a new way of saying "timed out" gets added.
//
// Nothing here is Protect- or Access-specific, so it is `net/` rather than either client's folder:
// the Access client must not import a Protect module to read an error.
import { PinMismatchError, PinRequiredError } from '../tls/pinning'

/**
 * How far to follow `cause`. A chain this long is already pathological, and a bound means a
 * self-referential `cause` cannot hang the process.
 */
export const MAX_CAUSE_DEPTH = 8

/** The value and its `cause` chain, outermost first, bounded by {@link MAX_CAUSE_DEPTH}. */
export function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [err]
  let current = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error) || current.cause === undefined) break
    current = current.cause
    chain.push(current)
  }
  return chain
}

/** The innermost `cause`, or the value itself when it has none. */
export function rootCause(err: unknown): unknown {
  const chain = causeChain(err)
  return chain[chain.length - 1]
}

/**
 * True for every way a request can run out of time: our own `AbortSignal.timeout` (`TimeoutError`,
 * or `AbortError` on an older runtime) and undici's own header and body deadlines, which the pinned
 * Agent sets (`src/main/tls/pinning.ts`). Missing the undici codes would classify a stalled console
 * as a network failure, which reads to the user as "unreachable" rather than "too slow".
 */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  const code = errorCodeOf(err)
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
}

/**
 * A TLS pin failure anywhere in the chain (CON-3). It is the one failure a client must never retry
 * around, so it has to survive being wrapped in a `TypeError` by `fetch`.
 */
export function pinFailure(err: unknown): PinMismatchError | PinRequiredError | null {
  for (const link of causeChain(err)) {
    if (link instanceof PinMismatchError || link instanceof PinRequiredError) return link
  }
  return null
}

/**
 * The socket-level codes that mean the connection was **never made**: refused, no such host, DNS
 * temporarily failing, no route. A request that failed with one of these never left this machine
 * for the console, so it cannot have done anything there. Every other connection failure (a reset,
 * a socket closed mid-answer, a TLS error after the connect) may have come after the request was
 * written.
 */
export const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/**
 * True when the `cause` chain shows the connection was never made ({@link NEVER_CONNECTED_CODES}).
 * Node's address-family racing reports a failed connect as an `AggregateError` whose `errors` are
 * the per-address attempts; it counts only when every attempt says "never connected".
 */
export function isNeverConnectedError(err: unknown): boolean {
  for (const link of causeChain(err)) {
    if (!(link instanceof Error)) continue
    if (link instanceof AggregateError && link.errors.length > 0) {
      return link.errors.every((inner) => isNeverConnectedError(inner))
    }
    const code = errorCodeOf(link)
    if (code !== undefined && NEVER_CONNECTED_CODES.has(code)) return true
  }
  return false
}

/** An error as one line: its message plus its `code` when it has one. Never a stack. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = errorCodeOf(err)
  return code === undefined ? err.message : `${err.message} (${code})`
}

function errorCodeOf(err: Error): string | undefined {
  return 'code' in err && typeof err.code === 'string' ? err.code : undefined
}
