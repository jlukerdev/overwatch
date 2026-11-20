// UX polish 2026-11-17: the Live screen's focus mode
// (src/renderer/src/features/viewSwitcher/focusMode.ts).
//
// What these tests protect: `F` toggles with the View shortcuts' manners (no modifiers, no
// auto-repeat, not while typing, not when already handled) and `Esc` is never the key; focus mode
// applies only on the Live screen with the editor closed; and the endpoints it must keep on screen
// (CON-5) are exactly the ones that are not connected, Access only while it is on, and none at all
// in RTSP mode (MODE-3).
import { describe, expect, it } from 'vitest'
import type { ConnectionPhase, ConnectionStatus, EndpointStatus } from '../../src/shared/ipc'
import {
  focusModeAlerts,
  focusModeApplies,
  isFocusModeKey,
  type FocusModeKey,
} from '../../src/renderer/src/features/viewSwitcher/focusMode'
import type { ViewShortcutTarget } from '../../src/renderer/src/features/viewSwitcher/viewShortcut'

function key(value: string, overrides: Partial<FocusModeKey> = {}): FocusModeKey {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  }
}

const BODY: ViewShortcutTarget = { tagName: 'BODY', isContentEditable: false }

describe('isFocusModeKey', () => {
  it('is F, in either case (Caps Lock)', () => {
    expect(isFocusModeKey(key('f'), BODY)).toBe(true)
    expect(isFocusModeKey(key('F'), BODY)).toBe(true)
    expect(isFocusModeKey(key('f'), null)).toBe(true)
  })

  it('is no other key, and never Esc (which only leaves fill, FILL-1)', () => {
    for (const other of ['Escape', 'g', 'm', '1', 'F1', 'Enter', ' ']) {
      expect(isFocusModeKey(key(other), BODY)).toBe(false)
    }
  })

  it('is refused with any modifier held', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(isFocusModeKey(key('f', { [modifier]: true }), BODY)).toBe(false)
    }
    expect(isFocusModeKey(key('F', { shiftKey: true }), BODY)).toBe(false)
  })

  it('is refused on auto-repeat and when something already handled the key', () => {
    expect(isFocusModeKey(key('f', { repeat: true }), BODY)).toBe(false)
    expect(isFocusModeKey(key('f', { defaultPrevented: true }), BODY)).toBe(false)
  })

  it('is refused while typing, and allowed on a button', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isFocusModeKey(key('f'), { tagName, isContentEditable: false })).toBe(false)
    }
    expect(isFocusModeKey(key('f'), { tagName: 'DIV', isContentEditable: true })).toBe(false)
    expect(isFocusModeKey(key('f'), { tagName: 'BUTTON', isContentEditable: false })).toBe(true)
  })
})

describe('focusModeApplies', () => {
  it('needs the request, the Live screen and a closed editor', () => {
    expect(focusModeApplies(true, true, false)).toBe(true)
    expect(focusModeApplies(false, true, false)).toBe(false)
    expect(focusModeApplies(true, false, false)).toBe(false)
    expect(focusModeApplies(true, true, true)).toBe(false)
  })
})

function endpoint(name: 'protect' | 'access', phase: ConnectionPhase): EndpointStatus {
  return {
    endpoint: name,
    phase,
    hostPort: '192.0.2.1:443',
    pinned: true,
    credentialStored: true,
    version: null,
    error: null,
    updatedAt: 0,
  }
}

function status(protect: ConnectionPhase, access: ConnectionPhase): ConnectionStatus {
  return { protect: endpoint('protect', protect), access: endpoint('access', access) }
}

describe('focusModeAlerts (CON-5)', () => {
  it('shows nothing while everything in use is connected, or before the first status', () => {
    expect(focusModeAlerts(null, 'protect')).toEqual([])
    expect(focusModeAlerts(status('connected', 'connected'), 'protect')).toEqual([])
    expect(focusModeAlerts(status('connected', 'disabled'), 'protect')).toEqual([])
  })

  it('shows Protect in every phase but connected', () => {
    const phases: ConnectionPhase[] = [
      'unconfigured',
      'idle',
      'connecting',
      'reconnecting',
      'error',
    ]
    for (const phase of phases) {
      expect(focusModeAlerts(status(phase, 'disabled'), 'protect')).toEqual(['protect'])
    }
  })

  it('shows Access only while it is on and not connected, after Protect', () => {
    expect(focusModeAlerts(status('connected', 'error'), 'protect')).toEqual(['access'])
    expect(focusModeAlerts(status('reconnecting', 'idle'), 'protect')).toEqual([
      'protect',
      'access',
    ])
    expect(focusModeAlerts(status('error', 'disabled'), 'protect')).toEqual(['protect'])
  })

  it('shows nothing in RTSP mode, which uses neither endpoint (MODE-3)', () => {
    expect(focusModeAlerts(status('error', 'error'), 'rtsp')).toEqual([])
    expect(focusModeAlerts(status('unconfigured', 'disabled'), 'rtsp')).toEqual([])
  })
})
