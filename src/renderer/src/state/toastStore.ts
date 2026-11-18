// Toasts (P5.4): short notices about the outcome of an action taken away from any form — first of
// all an unlock from a cell (DOOR-3). A form's outcome stays a `StatusLine` (CLAUDE.md).
//
// `showToast({ tone, message })` adds one; `<ToastHost>` (ui/Toast.tsx), mounted once by the app
// shell, draws the list. A success goes by itself after {@link SUCCESS_TOAST_MS}; an error or a
// warning stays longer ({@link ERROR_TOAST_MS}) and has a Dismiss button, since it says something
// went wrong — or may have (a warning: an unlock with no answer, the door may be open) — and may
// need reading twice. At most {@link MAX_TOASTS} are kept: a new one pushes out the oldest.
//
// The timers live here, not in the component, so a toast shown by a cell that has since unmounted
// still goes away, and the rules are testable with fake timers.
import { create } from 'zustand'

export type ToastTone = 'success' | 'warning' | 'error'

export interface Toast {
  readonly id: number
  readonly tone: ToastTone
  readonly message: string
}

export interface ToastInput {
  readonly tone: ToastTone
  readonly message: string
}

export const SUCCESS_TOAST_MS = 4000
export const ERROR_TOAST_MS = 10_000
export const MAX_TOASTS = 3

interface ToastStoreState {
  readonly toasts: readonly Toast[]
}

export const useToastStore = create<ToastStoreState>(() => ({ toasts: [] }))

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

/** How long a toast of this tone stays before it goes by itself: a warning as long as an error. */
export function toastDurationMs(tone: ToastTone): number {
  return tone === 'success' ? SUCCESS_TOAST_MS : ERROR_TOAST_MS
}

/** Removes a toast (its Dismiss button, or its timer). Unknown ids are ignored. */
export function dismissToast(id: number): void {
  clearTimer(id)
  const { toasts } = useToastStore.getState()
  if (!toasts.some((toast) => toast.id === id)) return
  useToastStore.setState({ toasts: toasts.filter((toast) => toast.id !== id) })
}

/** Shows a toast and returns its id. */
export function showToast(input: ToastInput): number {
  const id = nextId++
  const toast: Toast = { id, tone: input.tone, message: input.message }
  const kept = [...useToastStore.getState().toasts, toast]
  const dropped = kept.slice(0, Math.max(0, kept.length - MAX_TOASTS))
  for (const old of dropped) clearTimer(old.id)
  useToastStore.setState({ toasts: kept.slice(dropped.length) })
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      dismissToast(id)
    }, toastDurationMs(input.tone)),
  )
  return id
}

/** Tests: drop every toast and timer. */
export function resetToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
  useToastStore.setState({ toasts: [] })
}
