// VIEW-4's keyboard shortcut — `1`…`9` select View N — as one pure decision over a key event and
// its target, so the rules are tested in the node environment and the hook that listens for keys
// (ViewSwitcher.tsx) holds none of them.
//
// The rules, and why:
//
//  - **By physical key (`code`), not by character (`key`).** `Digit1` is the key under "1" whatever
//    the layout: on AZERTY it types "&" unshifted, and a shortcut that only worked on layouts where
//    the top row types digits would be a shortcut half the world could not press.
//  - **The numpad counts only with Num Lock on.** With it off, `Numpad1` is End and `Numpad7` Home;
//    the user pressed a navigation key, not a digit. `key` tells the two apart.
//  - **No modifier at all.** Ctrl/Cmd/Alt + digit belong to the OS and the browser (Cmd+1 switches
//    tabs in many apps), and a shortcut that fires on top of one is a surprise. Shift is refused too:
//    Shift+digit types a symbol, and Shift+numpad digit is a navigation key on Windows.
//  - **Not while typing.** A digit typed into a text field, a select or a contentEditable is text.
//  - **Not on auto-repeat**, so holding a key down switches once rather than hammering IPC.
//  - **Not if someone already handled it** (`defaultPrevented`): a focused control that used the
//    key for itself wins.

/** The parts of a `KeyboardEvent` the decision reads. */
export interface ViewShortcutKey {
  readonly code: string
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly defaultPrevented: boolean
}

/** The parts of the event's target the decision reads. `null` for a target that is not an element. */
export interface ViewShortcutTarget {
  readonly tagName: string
  readonly isContentEditable: boolean
}

/** Elements whose keystrokes are text. `tagName` is upper-case for HTML elements. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

const DIGIT_CODE = /^Digit([1-9])$/
const NUMPAD_CODE = /^Numpad([1-9])$/

/**
 * The 0-based index of the View a key selects (`1` → 0 … `9` → 8), or `null` when the key is not a
 * View shortcut in this context. Whether that View exists is the caller's question.
 */
export function viewShortcutIndex(
  event: ViewShortcutKey,
  target: ViewShortcutTarget | null,
): number | null {
  if (event.defaultPrevented || event.repeat) return null
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  if (target !== null && (target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName))) {
    return null
  }
  const digit = DIGIT_CODE.exec(event.code)?.[1] ?? numpadDigit(event)
  return digit === undefined ? null : Number(digit) - 1
}

/** The numpad digit, only when Num Lock makes the key type it (see the header). */
function numpadDigit(event: ViewShortcutKey): string | undefined {
  const digit = NUMPAD_CODE.exec(event.code)?.[1]
  return digit !== undefined && event.key === digit ? digit : undefined
}
