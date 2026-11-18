// P5.1: AUD-3's mute-all shortcut rule (src/renderer/src/features/audio/muteShortcut.ts).
//
// What these tests protect: `m` / `M` is the shortcut (Shift and Caps Lock included), and it stays
// out of the way of Ctrl / Cmd / Alt, auto-repeat, text entry and keys someone else already handled.
import { describe, expect, it } from 'vitest'
import { isMuteAllKey, type MuteAllKey } from '../../src/renderer/src/features/audio/muteShortcut'
import type { ViewShortcutTarget } from '../../src/renderer/src/features/viewSwitcher/viewShortcut'

function key(value: string, overrides: Partial<MuteAllKey> = {}): MuteAllKey {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  }
}

const BODY: ViewShortcutTarget = { tagName: 'BODY', isContentEditable: false }

describe('isMuteAllKey (AUD-3)', () => {
  it('accepts m and M', () => {
    expect(isMuteAllKey(key('m'), BODY)).toBe(true)
    expect(isMuteAllKey(key('M'), BODY)).toBe(true)
    expect(isMuteAllKey(key('m'), null)).toBe(true)
  })

  it('accepts a button target (a control in the strip)', () => {
    expect(isMuteAllKey(key('m'), { tagName: 'BUTTON', isContentEditable: false })).toBe(true)
  })

  it('ignores other keys', () => {
    for (const other of ['n', 'Escape', '1', 'KeyM', 'µ']) {
      expect(isMuteAllKey(key(other), BODY)).toBe(false)
    }
  })

  it('ignores Ctrl, Cmd and Alt', () => {
    expect(isMuteAllKey(key('m', { ctrlKey: true }), BODY)).toBe(false)
    expect(isMuteAllKey(key('m', { metaKey: true }), BODY)).toBe(false)
    expect(isMuteAllKey(key('m', { altKey: true }), BODY)).toBe(false)
  })

  it('ignores auto-repeat and a key already handled', () => {
    expect(isMuteAllKey(key('m', { repeat: true }), BODY)).toBe(false)
    expect(isMuteAllKey(key('m', { defaultPrevented: true }), BODY)).toBe(false)
  })

  it('ignores typing in an input, a select, a textarea or a contentEditable', () => {
    for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) {
      expect(isMuteAllKey(key('m'), { tagName, isContentEditable: false })).toBe(false)
    }
    expect(isMuteAllKey(key('m'), { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})
