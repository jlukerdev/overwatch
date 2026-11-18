// P5.5 (DOOR-6): what the unlock control shows of its door's lock state
// (src/renderer/src/features/door/doorState.ts).
//
// What these tests protect: green only for a door main reports as unlocked; a locked door and a
// door main has no state for (unknown) drawn the same neutral way, never green; the door position
// sensor changing nothing; and the label / tooltip strings.
import { describe, expect, it } from 'vitest'
import type { DoorStates } from '@shared/models'
import {
  doorLook,
  unlockLabel,
  unlockRestTitle,
} from '../../src/renderer/src/features/door/doorState'

const STATES: DoorStates = {
  'door-a': { relay: 'unlock', position: 'close' },
  'door-b': { relay: 'lock', position: 'close' },
}

describe('doorLook', () => {
  it('is unlocked while the lock relay is released', () => {
    expect(doorLook('door-a', STATES)).toBe('unlocked')
  })

  it('is neutral for a locked door', () => {
    expect(doorLook('door-b', STATES)).toBe('neutral')
  })

  it('is neutral for a door missing from the map (unknown), never green', () => {
    expect(doorLook('door-c', STATES)).toBe('neutral')
    expect(doorLook('door-a', {})).toBe('neutral')
  })

  it('is neutral with no door', () => {
    expect(doorLook(null, STATES)).toBe('neutral')
  })

  it('follows the relay, not the position sensor', () => {
    expect(doorLook('d', { d: { relay: 'lock', position: 'open' } })).toBe('neutral')
    expect(doorLook('d', { d: { relay: 'unlock', position: null } })).toBe('unlocked')
    expect(doorLook('d', { d: { relay: 'unlock', position: 'open' } })).toBe('unlocked')
  })

  it('never reads a prototype member as a state', () => {
    expect(doorLook('constructor', {})).toBe('neutral')
    expect(doorLook('toString', STATES)).toBe('neutral')
  })
})

describe('label and tooltip', () => {
  it('names the action, and the state only when the door is known unlocked', () => {
    expect(unlockLabel('neutral')).toBe('Unlock door')
    expect(unlockLabel('unlocked')).toBe('Unlock door (currently unlocked)')
  })

  it('says what a hold does, without claiming a neutral door is locked', () => {
    expect(unlockRestTitle('neutral')).toBe('Hold to unlock the door')
    expect(unlockRestTitle('unlocked')).toBe('Door is unlocked. Hold to unlock it again')
  })
})
