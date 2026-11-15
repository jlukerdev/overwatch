import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blockUnload,
  confirmLeave,
  hasUnsaved,
  LEAVE_MESSAGE,
  setUnsaved,
} from '../../src/renderer/src/state/unsavedGuard'

afterEach(() => {
  setUnsaved(false)
})

describe('unsavedGuard', () => {
  it('starts clean and remembers the last report', () => {
    expect(hasUnsaved()).toBe(false)
    setUnsaved(true)
    expect(hasUnsaved()).toBe(true)
    setUnsaved(false)
    expect(hasUnsaved()).toBe(false)
  })

  it('lets the user leave without asking when nothing is unsaved', () => {
    const ask = vi.fn(() => false)
    expect(confirmLeave(ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks while something is unsaved, and follows the answer', () => {
    setUnsaved(true)
    const no = vi.fn(() => false)
    expect(confirmLeave(no)).toBe(false)
    expect(no).toHaveBeenCalledWith(LEAVE_MESSAGE)
    expect(confirmLeave(() => true)).toBe(true)
    // Asking does not clear the flag: the editor does that when it unmounts.
    expect(hasUnsaved()).toBe(true)
  })

  it('cancels an unload only while something is unsaved', () => {
    const clean = { preventDefault: vi.fn() }
    blockUnload(clean)
    expect(clean.preventDefault).not.toHaveBeenCalled()
    setUnsaved(true)
    const dirty = { preventDefault: vi.fn() }
    blockUnload(dirty)
    expect(dirty.preventDefault).toHaveBeenCalledOnce()
  })
})
