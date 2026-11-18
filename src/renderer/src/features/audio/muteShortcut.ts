// AUD-3's global mute-all shortcut, `M` (P5.1), as one pure decision over a key event and its
// target, so the rule is tested in the node environment and the listener (GridView.tsx) holds none
// of it.
//
// The rules, and why — fill's `Esc` (features/fill/fillMode.ts) and the View shortcuts'
// (features/viewSwitcher/viewShortcut.ts) manners:
//
//  - **By character (`key`), `m` or `M`.** A mnemonic letter, so it is wherever the layout puts
//    "M" (unlike the View digits, which are positional). `M` covers Caps Lock and Shift.
//  - **No Ctrl, Cmd or Alt.** Those combinations belong to the OS and the browser (Cmd+M minimises
//    the window on macOS). Shift is allowed: Shift+M still means "M".
//  - **Not while typing** in an input, a select, a textarea or a contentEditable (`isTextEntryTarget`).
//  - **Not on auto-repeat**, and **not if someone already handled it** (`defaultPrevented`).
//  - **Mutes; never unmutes.** Not a toggle (user decision, 2026-11-16): with nothing unmuted the
//    caller does nothing (state/audioStore.ts, `muteAllAudio`), so the listener is only attached
//    while a cell is unmuted, and the key is free otherwise. Only the Live screen listens.
import { isTextEntryTarget, type ViewShortcutTarget } from '../viewSwitcher/viewShortcut'

/** The parts of a `KeyboardEvent` the decision reads. */
export interface MuteAllKey {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly repeat: boolean
  readonly defaultPrevented: boolean
}

/** Whether a keydown is the mute-all shortcut (header). The caller `preventDefault`s when it acts. */
export function isMuteAllKey(event: MuteAllKey, target: ViewShortcutTarget | null): boolean {
  if (event.defaultPrevented || event.repeat) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (event.key !== 'm' && event.key !== 'M') return false
  return !isTextEntryTarget(target)
}
