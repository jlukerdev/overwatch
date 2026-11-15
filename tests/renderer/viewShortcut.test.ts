// P3.2: VIEW-4's `1`–`9` shortcut rule (src/renderer/src/features/viewSwitcher/viewShortcut.ts).
//
// What these tests protect: the digit keys map to View indexes 0–8 by physical key, the numpad only
// with Num Lock on, and the shortcut stays out of the way of modifiers, auto-repeat, text entry and
// keys someone else already handled.
import { describe, expect, it } from 'vitest'
import {
  viewShortcutIndex,
  type ViewShortcutKey,
  type ViewShortcutTarget,
} from '../../src/renderer/src/features/viewSwitcher/viewShortcut'

function key(code: string, overrides: Partial<ViewShortcutKey> = {}): ViewShortcutKey {
  return {
    code,
    key: code.replace(/^(Digit|Numpad)/, ''),
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

describe('viewShortcutIndex (VIEW-4)', () => {
  it('maps Digit1…Digit9 to indexes 0…8', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(viewShortcutIndex(key(`Digit${String(n)}`), BODY)).toBe(n - 1)
    }
  })

  it('maps Numpad1…Numpad9 to indexes 0…8 with Num Lock on', () => {
    expect(viewShortcutIndex(key('Numpad1'), BODY)).toBe(0)
    expect(viewShortcutIndex(key('Numpad9'), BODY)).toBe(8)
  })

  it('ignores the numpad with Num Lock off (the key is End, Home, …)', () => {
    expect(viewShortcutIndex(key('Numpad1', { key: 'End' }), BODY)).toBeNull()
  })

  it('goes by physical key, so a layout whose top row types symbols still works', () => {
    expect(viewShortcutIndex(key('Digit1', { key: '&' }), BODY)).toBe(0)
  })

  it('ignores 0 and every other key', () => {
    for (const code of ['Digit0', 'Numpad0', 'KeyA', 'Escape', 'F1', 'NumpadAdd']) {
      expect(viewShortcutIndex(key(code), BODY)).toBeNull()
    }
  })

  it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)('ignores %s + digit', (mod) => {
    expect(viewShortcutIndex(key('Digit2', { [mod]: true }), BODY)).toBeNull()
  })

  it('ignores auto-repeat and keys already handled', () => {
    expect(viewShortcutIndex(key('Digit2', { repeat: true }), BODY)).toBeNull()
    expect(viewShortcutIndex(key('Digit2', { defaultPrevented: true }), BODY)).toBeNull()
  })

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores a digit typed into %s', (tagName) => {
    expect(viewShortcutIndex(key('Digit3'), { tagName, isContentEditable: false })).toBeNull()
  })

  it('ignores a digit typed into contentEditable', () => {
    expect(viewShortcutIndex(key('Digit3'), { tagName: 'DIV', isContentEditable: true })).toBeNull()
  })

  it('works with a button focused, or with no element target', () => {
    expect(viewShortcutIndex(key('Digit3'), { tagName: 'BUTTON', isContentEditable: false })).toBe(
      2,
    )
    expect(viewShortcutIndex(key('Digit3'), null)).toBe(2)
  })
})
