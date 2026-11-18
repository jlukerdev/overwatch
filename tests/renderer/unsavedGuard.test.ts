import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blockUnload,
  confirmLeave,
  hasUnsaved,
  LEAVE_PROMPT,
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

  it('lets the user leave without asking when nothing is unsaved', async () => {
    const ask = vi.fn(() => false)
    expect(await confirmLeave(ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks while something is unsaved, and follows the answer', async () => {
    setUnsaved(true)
    const no = vi.fn(() => false)
    expect(await confirmLeave(no)).toBe(false)
    expect(no).toHaveBeenCalledWith(LEAVE_PROMPT)
    expect(await confirmLeave(() => true)).toBe(true)
    // The app's dialog answers asynchronously.
    expect(await confirmLeave(() => Promise.resolve(false))).toBe(false)
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
