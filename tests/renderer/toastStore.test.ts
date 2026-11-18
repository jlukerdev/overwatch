// P5.4: the shared toasts (src/renderer/src/state/toastStore.ts).
//
// What these tests protect: a success goes by itself after ~4 s, an error or a warning stays ~10 s
// unless dismissed, dismissing clears the toast (and its timer), and at most three are kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissToast,
  ERROR_TOAST_MS,
  MAX_TOASTS,
  resetToasts,
  showToast,
  SUCCESS_TOAST_MS,
  toastDurationMs,
  useToastStore,
} from '../../src/renderer/src/state/toastStore'

const messages = (): string[] => useToastStore.getState().toasts.map((toast) => toast.message)

beforeEach(() => {
  vi.useFakeTimers()
  resetToasts()
})

afterEach(() => {
  resetToasts()
  vi.useRealTimers()
})

describe('toastStore', () => {
  it('shows a toast with its tone and message', () => {
    const id = showToast({ tone: 'success', message: 'Door unlocked for Front.' })
    expect(useToastStore.getState().toasts).toEqual([
      { id, tone: 'success', message: 'Door unlocked for Front.' },
    ])
  })

  it('dismisses a success after its time', () => {
    showToast({ tone: 'success', message: 'ok' })
    vi.advanceTimersByTime(SUCCESS_TOAST_MS - 1)
    expect(messages()).toEqual(['ok'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual([])
  })

  it('keeps an error longer, until dismissed or its time is up', () => {
    expect(ERROR_TOAST_MS).toBeGreaterThan(SUCCESS_TOAST_MS)
    showToast({ tone: 'error', message: 'failed' })
    vi.advanceTimersByTime(SUCCESS_TOAST_MS)
    expect(messages()).toEqual(['failed'])
    vi.advanceTimersByTime(ERROR_TOAST_MS - SUCCESS_TOAST_MS)
    expect(messages()).toEqual([])
  })

  it('keeps a warning as long as an error', () => {
    expect(toastDurationMs('warning')).toBe(ERROR_TOAST_MS)
    showToast({ tone: 'warning', message: 'maybe' })
    vi.advanceTimersByTime(ERROR_TOAST_MS - 1)
    expect(messages()).toEqual(['maybe'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual([])
  })

  it('dismisses a toast on request, and ignores an unknown id', () => {
    const id = showToast({ tone: 'error', message: 'failed' })
    dismissToast(id + 100)
    expect(messages()).toEqual(['failed'])
    dismissToast(id)
    expect(messages()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps at most the newest few', () => {
    for (let i = 0; i < MAX_TOASTS + 2; i++) showToast({ tone: 'error', message: `m${String(i)}` })
    expect(messages()).toEqual(['m2', 'm3', 'm4'].slice(-MAX_TOASTS))
    expect(vi.getTimerCount()).toBe(MAX_TOASTS)
  })
})
