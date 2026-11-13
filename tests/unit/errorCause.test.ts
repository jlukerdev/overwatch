// P1.3/P1.4: reading a thrown value's `cause` chain. Both API clients classify every failure
// through this module, so a gap here shows up as a misleading message in Settings — or, worse, as a
// TLS pin failure (CON-3) classified as a retryable network blip.
import { describe, expect, it } from 'vitest'
import {
  MAX_CAUSE_DEPTH,
  causeChain,
  describeError,
  isTimeoutError,
  pinFailure,
  rootCause,
} from '../../src/main/net/errorCause'
import { PinMismatchError, PinRequiredError } from '../../src/main/tls/pinning'

const FP_A =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'

/** An `Error` with a `code`, the way Node and undici report a failed connection. */
function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('causeChain', () => {
  it('returns the value itself when there is no cause', () => {
    const err = new Error('alone')
    expect(causeChain(err)).toEqual([err])
    expect(causeChain('not an error')).toEqual(['not an error'])
    expect(causeChain(undefined)).toEqual([undefined])
  })

  it('follows cause outermost first', () => {
    const inner = coded('connect ECONNREFUSED', 'ECONNREFUSED')
    const middle = new Error('socket', { cause: inner })
    const outer = new TypeError('fetch failed', { cause: middle })
    expect(causeChain(outer)).toEqual([outer, middle, inner])
  })

  it('stops at the depth bound, so a self-referential cause cannot hang', () => {
    const loop = new Error('round and round')
    // A cause pointing back at its own error: without the bound this would never terminate.
    Object.defineProperty(loop, 'cause', { value: loop })
    expect(causeChain(loop)).toHaveLength(MAX_CAUSE_DEPTH + 1)
  })
})

describe('rootCause', () => {
  it('is the innermost cause, which is where undici puts the real reason', () => {
    const inner = coded('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED')
    expect(rootCause(new TypeError('fetch failed', { cause: inner }))).toBe(inner)
  })

  it('is the value itself when nothing wraps it', () => {
    const err = new Error('alone')
    expect(rootCause(err)).toBe(err)
    expect(rootCause(null)).toBeNull()
  })
})

describe('isTimeoutError', () => {
  it('recognises our own AbortSignal.timeout', () => {
    // Node names it TimeoutError; an older runtime used AbortError.
    expect(isTimeoutError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(
      true,
    )
    expect(isTimeoutError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
  })

  it("recognises undici's header and body deadlines", () => {
    // These come from the pinned Agent's own timeouts (src/main/tls/pinning.ts). Missing them
    // would report a slow console as unreachable.
    expect(isTimeoutError(coded('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'))).toBe(true)
    expect(isTimeoutError(coded('Body Timeout Error', 'UND_ERR_BODY_TIMEOUT'))).toBe(true)
  })

  it('is false for a connection failure and for a non-error', () => {
    expect(isTimeoutError(coded('connect ECONNREFUSED', 'ECONNREFUSED'))).toBe(false)
    expect(isTimeoutError(new Error('plain'))).toBe(false)
    expect(isTimeoutError('TimeoutError')).toBe(false)
  })
})

describe('pinFailure (CON-3)', () => {
  it('finds a mismatch wrapped by fetch', () => {
    // This is the real shape: fetch turns a connector failure into a TypeError with the cause.
    const pin = new PinMismatchError({ endpoint: '192.0.2.10:443', expected: FP_A, actual: null })
    const found = pinFailure(new TypeError('fetch failed', { cause: pin }))
    expect(found).toBe(pin)
    expect(found?.message).toContain('Refusing to connect')
  })

  it('finds an unpinned endpoint thrown by the registry', () => {
    const required = new PinRequiredError('192.0.2.10:12445')
    expect(pinFailure(required)).toBe(required)
  })

  it('finds one several levels down', () => {
    const pin = new PinRequiredError('udm.local:443')
    const wrapped = new TypeError('fetch failed', {
      cause: new Error('socket', { cause: pin }),
    })
    expect(pinFailure(wrapped)).toBe(pin)
  })

  it('is null for every other failure', () => {
    expect(pinFailure(coded('connect ECONNREFUSED', 'ECONNREFUSED'))).toBeNull()
    expect(pinFailure('nothing')).toBeNull()
  })
})

describe('describeError', () => {
  it('appends the code when there is one', () => {
    expect(describeError(coded('connect ECONNREFUSED 192.0.2.10:443', 'ECONNREFUSED'))).toBe(
      'connect ECONNREFUSED 192.0.2.10:443 (ECONNREFUSED)',
    )
  })

  it('is the bare message otherwise, and never a stack', () => {
    const err = new Error('something went wrong')
    expect(describeError(err)).toBe('something went wrong')
    expect(describeError(err)).not.toContain('at ')
  })

  it('stringifies a non-error', () => {
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError(42)).toBe('42')
  })
})
