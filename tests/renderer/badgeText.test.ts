// UX polish 2026-11-17: the connection badge's wording
// (src/renderer/src/features/status/badgeText.ts; CON-5).
//
// What these tests protect: the reason is shown only in `error`, on one line; the tooltip keeps the
// full sentence; and the accessible name says the endpoint, the phase and what pressing does.
import { describe, expect, it } from 'vitest'
import type { EndpointStatus } from '../../src/shared/ipc'
import {
  badgeAriaLabel,
  badgeReason,
  badgeTitle,
  PHASE_LABELS,
} from '../../src/renderer/src/features/status/badgeText'

function status(overrides: Partial<EndpointStatus> = {}): EndpointStatus {
  return {
    endpoint: 'protect',
    phase: 'connected',
    hostPort: '192.0.2.1:443',
    pinned: true,
    credentialStored: true,
    version: '7.3.74',
    error: null,
    updatedAt: 0,
    ...overrides,
  }
}

const REFUSED = {
  kind: 'network',
  message: 'The console refused the connection.',
  endpoint: null,
  retryable: true,
} as const satisfies EndpointStatus['error']

describe('badgeReason', () => {
  it('is the error message without its full stop, in error', () => {
    expect(badgeReason(status({ phase: 'error', error: REFUSED }))).toBe(
      'The console refused the connection',
    )
  })

  it('is put on one line', () => {
    const error = { ...REFUSED, message: '  Bad key.\n Check   Settings. ' }
    expect(badgeReason(status({ phase: 'error', error }))).toBe('Bad key. Check Settings')
  })

  it('is nothing outside error, even with a last failure kept (reconnecting)', () => {
    expect(badgeReason(status())).toBeNull()
    expect(badgeReason(status({ phase: 'reconnecting', error: REFUSED }))).toBeNull()
  })

  it('is nothing when the error has no message or there is no error', () => {
    expect(badgeReason(status({ phase: 'error' }))).toBeNull()
    expect(badgeReason(status({ phase: 'error', error: { ...REFUSED, message: ' ' } }))).toBeNull()
  })
})

describe('badgeTitle', () => {
  it('lists the address, the full error and the version', () => {
    expect(badgeTitle(status({ phase: 'reconnecting', error: REFUSED }))).toBe(
      '192.0.2.1:443 — The console refused the connection. — Version 7.3.74 — Click to open Settings',
    )
  })

  it('says so when there is no address', () => {
    expect(badgeTitle(status({ phase: 'unconfigured', hostPort: null, version: null }))).toBe(
      'No address yet — Click to open Settings',
    )
  })
})

describe('badgeAriaLabel', () => {
  it('names the endpoint, the phase and the action', () => {
    expect(badgeAriaLabel('Protect', status())).toBe('Protect: connected. Open settings')
    expect(badgeAriaLabel('Access', status({ phase: 'reconnecting' }))).toBe(
      'Access: reconnecting. Open settings',
    )
  })

  it('includes the reason in error', () => {
    expect(badgeAriaLabel('Protect', status({ phase: 'error', error: REFUSED }))).toBe(
      'Protect: error (The console refused the connection). Open settings',
    )
  })

  it('has a label for every phase', () => {
    for (const label of Object.values(PHASE_LABELS)) expect(label).toMatch(/^[A-Z]/)
  })
})
