// UX polish 2026-11-17: the View switcher's collapsed preference and its labels
// (src/renderer/src/features/viewSwitcher/switcherPrefs.ts; VIEW-4).
//
// What these tests protect: the choice round-trips through storage, a missing or throwing storage
// reads as expanded and never throws, and the first nine Views — only those — carry their key.
import { describe, expect, it } from 'vitest'
import {
  readSwitcherCollapsed,
  SWITCHER_COLLAPSED_KEY,
  switcherStorage,
  viewItemTitle,
  viewShortcutKey,
  writeSwitcherCollapsed,
} from '../../src/renderer/src/features/viewSwitcher/switcherPrefs'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

const BROKEN: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('storage is blocked')
  },
  setItem: () => {
    throw new Error('quota exceeded')
  },
}

describe('the collapsed preference', () => {
  it('is expanded until something is stored', () => {
    expect(readSwitcherCollapsed(memoryStorage())).toBe(false)
  })

  it('round-trips both ways', () => {
    const storage = memoryStorage()
    writeSwitcherCollapsed(storage, true)
    expect(readSwitcherCollapsed(storage)).toBe(true)
    writeSwitcherCollapsed(storage, false)
    expect(readSwitcherCollapsed(storage)).toBe(false)
  })

  it('reads anything unexpected as expanded', () => {
    const storage = memoryStorage()
    storage.setItem(SWITCHER_COLLAPSED_KEY, 'true')
    expect(readSwitcherCollapsed(storage)).toBe(false)
  })

  it('survives a storage that is missing or throws', () => {
    expect(readSwitcherCollapsed(null)).toBe(false)
    expect(readSwitcherCollapsed(BROKEN)).toBe(false)
    expect(() => {
      writeSwitcherCollapsed(null, true)
      writeSwitcherCollapsed(BROKEN, true)
    }).not.toThrow()
  })

  it('has no storage outside a window (the node environment)', () => {
    expect(switcherStorage()).toBeNull()
  })
})

describe('View labels', () => {
  it('gives the first nine Views their key and the rest none', () => {
    expect(viewShortcutKey(0)).toBe('1')
    expect(viewShortcutKey(8)).toBe('9')
    expect(viewShortcutKey(9)).toBeNull()
    expect(viewShortcutKey(-1)).toBeNull()
  })

  it('puts the key in the tooltip when there is one', () => {
    expect(viewItemTitle('Front', 0)).toBe('Front (1)')
    expect(viewItemTitle('Tenth', 9)).toBe('Tenth')
  })
})
