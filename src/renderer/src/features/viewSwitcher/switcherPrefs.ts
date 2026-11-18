// The View switcher's per-machine preference (UX polish 2026-11-17; VIEW-4): whether the sidebar is
// collapsed to its rail. Kept in the renderer's `localStorage`, not in the app config: it is a
// convenience of this window on this machine, nothing main or another screen reads, and losing it
// costs one click.
//
// Storage can be missing or throw (a blocked or full profile), so every access is wrapped and the
// switcher simply opens expanded. The storage is passed in, so the rules are tested without a DOM.

/** The `localStorage` key. The value is `'1'` when collapsed; anything else reads as expanded. */
export const SWITCHER_COLLAPSED_KEY = 'vp:viewSwitcher/collapsed'

/** Views 1–9 have a key; a tenth and later are reachable by click only (VIEW-4). */
export const SHORTCUT_COUNT = 9

/** Whether the switcher was left collapsed. `false` when nothing was stored or storage fails. */
export function readSwitcherCollapsed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(SWITCHER_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** Remembers the choice; a storage failure is ignored (the choice still holds for this mount). */
export function writeSwitcherCollapsed(
  storage: Pick<Storage, 'setItem'> | null,
  collapsed: boolean,
): void {
  try {
    storage?.setItem(SWITCHER_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Nothing to do: see the header.
  }
}

/**
 * The window's `localStorage`, or `null` where reading the property itself throws (storage blocked)
 * or there is no window (the node test environment).
 */
export function switcherStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The `1`–`9` key of the View at `index` (0-based), or `null` from the tenth on. */
export function viewShortcutKey(index: number): string | null {
  return index >= 0 && index < SHORTCUT_COUNT ? String(index + 1) : null
}

/** A View button's tooltip: its name, plus its key when it has one. */
export function viewItemTitle(name: string, index: number): string {
  const key = viewShortcutKey(index)
  return key === null ? name : `${name} (${key})`
}
