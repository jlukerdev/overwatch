// "Leaving with unsaved changes asks first" (P3.3; VIEW-3) for the places outside the View editor
// that can take the user away from it: the app's screen navigation and closing / reloading the
// window. The editor's draft lives in its own React state, so the editor reports whether it is
// dirty here (`setUnsaved`, cleared when it unmounts) and the app shell asks `confirmLeave` before
// switching screens, and `blockUnload` from a `beforeunload` listener.
//
// One flag, module-level: there is one editor at a time, and the shell must read it synchronously
// from an event handler. The prompt is injected so the rule is unit-tested without a DOM.

/** What the navigation prompt asks (the app's own dialog, ui/ConfirmDialog.tsx). */
export const LEAVE_PROMPT = {
  title: 'Discard unsaved changes?',
  message: 'You have unsaved changes to a View. Leaving the editor discards them.',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
  danger: true,
} as const

let unsaved = false

/** The editor's report: `true` while its draft differs from the stored View. */
export function setUnsaved(value: boolean): void {
  unsaved = value
}

export function hasUnsaved(): boolean {
  return unsaved
}

/**
 * Whether the user may leave: always with nothing unsaved; otherwise only if `ask` (the app shell
 * passes `confirmDialog`) agrees. Not asked at all when clean. Asynchronous, because the app's own
 * dialog is; the caller navigates when this resolves `true`.
 */
export async function confirmLeave(
  ask: (prompt: typeof LEAVE_PROMPT) => boolean | Promise<boolean>,
): Promise<boolean> {
  return !unsaved || (await ask(LEAVE_PROMPT))
}

/**
 * A `beforeunload` listener: cancels the unload while something is unsaved. Electron shows no
 * prompt of its own for that, so main asks the user on `will-prevent-unload` (src/main/index.ts).
 */
export function blockUnload(event: Pick<Event, 'preventDefault'>): void {
  if (unsaved) event.preventDefault()
}
