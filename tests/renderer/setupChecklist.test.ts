// UX polish 2026-11-17: the Live screen's setup checklist
// (src/renderer/src/state/setupChecklist.ts; CON-1, CON-3, CON-4).
//
// What these tests protect: the four steps come in the order the user does them, each is ticked
// exactly when `setupGaps` no longer reports it, and connecting is done only while connected.
import { describe, expect, it } from 'vitest'
import type { EndpointStatus } from '../../src/shared/ipc'
import { openSetupSteps, setupChecklist } from '../../src/renderer/src/state/setupChecklist'

function protect(overrides: Partial<EndpointStatus> = {}): EndpointStatus {
  return {
    endpoint: 'protect',
    phase: 'unconfigured',
    hostPort: null,
    pinned: false,
    credentialStored: false,
    version: null,
    error: null,
    updatedAt: 0,
    ...overrides,
  }
}

function done(status: EndpointStatus): Record<string, boolean> {
  return Object.fromEntries(setupChecklist(status).map((step) => [step.id, step.done]))
}

describe('setupChecklist', () => {
  it('lists address, key, certificate, connect, all open on a fresh install', () => {
    const steps = setupChecklist(protect())
    expect(steps.map((step) => step.id)).toEqual(['host', 'credential', 'certificate', 'connect'])
    expect(steps.every((step) => !step.done)).toBe(true)
    expect(steps.every((step) => step.label !== '')).toBe(true)
    expect(openSetupSteps(steps)).toBe(4)
  })

  it('ticks each stored step on its own', () => {
    expect(done(protect({ hostPort: '192.0.2.1:443' }))).toEqual({
      host: true,
      credential: false,
      certificate: false,
      connect: false,
    })
    expect(done(protect({ credentialStored: true }))).toMatchObject({
      host: false,
      credential: true,
    })
    expect(done(protect({ hostPort: '192.0.2.1:443', pinned: true }))).toMatchObject({
      certificate: true,
      credential: false,
    })
  })

  it('ticks connect only while connected', () => {
    const ready = { hostPort: '192.0.2.1:443', pinned: true, credentialStored: true }
    expect(done(protect({ ...ready, phase: 'idle' })).connect).toBe(false)
    expect(done(protect({ ...ready, phase: 'reconnecting' })).connect).toBe(false)
    const connected = setupChecklist(protect({ ...ready, phase: 'connected' }))
    expect(connected.every((step) => step.done)).toBe(true)
    expect(openSetupSteps(connected)).toBe(0)
  })
})
