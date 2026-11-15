// "Leaving with unsaved changes asks first" (P3.3; VIEW-3) for the places outside the View editor
// that can take the user away from it: the app's screen navigation and closing / reloading the
// window. The editor's draft lives in its own React state, so the editor reports whether it is
// dirty here (`setUnsaved`, cleared when it unmounts) and the app shell asks `confirmLeave` before
// switching screens, and `blockUnload` from a `beforeunload` listener.
//
// One flag, module-level: there is one editor at a time, and the shell must read it synchronously
// from an event handler. The prompt is injectable so the rule is unit-tested without a DOM.

/** What the navigation prompt asks. */
export const LEAVE_MESSAGE = 'You have unsaved changes to a View. Leave and discard them?'

let unsaved = false

/** The editor's report: `true` while its draft differs from the stored View. */
export function setUnsaved(value: boolean): void {
  unsaved = value
}

export function hasUnsaved(): boolean {
  return unsaved
}

/**
 * Whether the user may leave: always with nothing unsaved; otherwise only if `ask` (by default
 * `window.confirm`) agrees. Not asked at all when clean.
 */
export function confirmLeave(
  ask: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  return !unsaved || ask(LEAVE_MESSAGE)
}

/**
 * A `beforeunload` listener: cancels the unload while something is unsaved. Electron shows no
 * prompt of its own for that, so main asks the user on `will-prevent-unload` (src/main/index.ts).
 */
export function blockUnload(event: Pick<Event, 'preventDefault'>): void {
  if (unsaved) event.preventDefault()
}
