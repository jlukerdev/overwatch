// Focus mode (UX polish 2026-11-17): the Live screen's way of giving the wall the whole window, by
// hiding the app header and the View switcher. The pure rules are here, tested in the node
// environment; the state is App's (it owns the header), the listener and the floating exit control
// are LiveScreen's.
//
// The rules, and why:
//
//  - **`F` toggles it, with the View shortcuts' manners** (./viewShortcut): no modifier at all, not
//    on auto-repeat, not while typing in a text field, select or contentEditable, and not when
//    something else already handled the key. By character (`f` / `F`), like the mute-all `M`: a
//    mnemonic letter is wherever the layout puts it. `F` covers Caps Lock; Shift+F is refused with
//    the other modifiers.
//  - **`Esc` is not a way out.** `Esc` leaves fill (FILL-1) and nothing else; a key that left fill
//    the first time and focus mode the second would make the chrome reappear by accident.
//  - **Only on the wall.** Focus mode applies while the Live screen is showing and the View editor
//    is not (`focusModeApplies`). Going to another screen or opening the editor turns it off, so
//    the chrome is back and stays back.
//  - **Session only.** Nothing here is stored: a relaunch never opens without its chrome.
//  - **CON-5 still holds.** The header carries the connection indicator, so while it is hidden any
//    endpoint that is not `connected` is shown as an always-visible pill beside the exit control
//    (`focusModeAlerts`). Access counts only while it is switched on (DOOR-0), as in the header.
import type { ConnectionStatus, EndpointName } from '@shared/ipc'
import { isTextEntryTarget, type ViewShortcutKey, type ViewShortcutTarget } from './viewShortcut'

/** The parts of a `KeyboardEvent` the decision reads: the View shortcut's, minus the key code. */
export type FocusModeKey = Omit<ViewShortcutKey, 'code'>

/** Whether a keydown is the focus-mode toggle (header). The caller `preventDefault`s when it acts. */
export function isFocusModeKey(event: FocusModeKey, target: ViewShortcutTarget | null): boolean {
  if (event.defaultPrevented || event.repeat) return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  if (event.key !== 'f' && event.key !== 'F') return false
  return !isTextEntryTarget(target)
}

/**
 * Whether the chrome is actually hidden: the user asked for focus mode, the Live screen is the one
 * showing, and the View editor is not open on it.
 */
export function focusModeApplies(requested: boolean, onLive: boolean, editing: boolean): boolean {
  return requested && onLive && !editing
}

/**
 * The endpoints focus mode must keep on screen (CON-5): every one that is not `connected`, Protect
 * first. Access is left out while it is off. `null` (no status yet) shows nothing, as the header does.
 */
export function focusModeAlerts(connection: ConnectionStatus | null): EndpointName[] {
  if (connection === null) return []
  const alerts: EndpointName[] = []
  if (connection.protect.phase !== 'connected') alerts.push('protect')
  if (connection.access.phase !== 'connected' && connection.access.phase !== 'disabled') {
    alerts.push('access')
  }
  return alerts
}
