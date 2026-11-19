// The View editor's side panel tabs (UX polish 2026-11-17; VIEW-3): **View** (the View's Display
// and Quality settings) and **Cell** (the inspector of the selected cell). Which tab a key moves
// to and when a selection brings the Cell tab forward are decided here, pure and unit-tested
// (tests/renderer/editorPanel.test.ts); ./EditorTabList draws the tabs and ./ViewEditor owns
// the state.

/** The tabs, in the order they are drawn. */
export const EDITOR_TABS = ['view', 'cell'] as const

export type EditorTab = (typeof EDITOR_TABS)[number]

export const EDITOR_TAB_LABELS: Readonly<Record<EditorTab, string>> = {
  view: 'View',
  cell: 'Cell',
}

/**
 * The tab a key pressed on the tab list moves to (the WAI-ARIA tabs pattern, horizontal, with
 * automatic activation): Left / Right step and wrap around, Home / End jump to the first / last.
 * `null` for every other key, which the tab list then leaves alone.
 */
export function tabForKey(current: EditorTab, key: string): EditorTab | null {
  const index = EDITOR_TABS.indexOf(current)
  const count = EDITOR_TABS.length
  const at = (i: number): EditorTab => EDITOR_TABS[(i + count) % count] ?? current
  switch (key) {
    case 'ArrowRight':
      return at(index + 1)
    case 'ArrowLeft':
      return at(index - 1)
    case 'Home':
      return at(0)
    case 'End':
      return at(count - 1)
    default:
      return null
  }
}

/**
 * The tab to show once a cell has been picked on the canvas. Only the first pick — from no
 * selection to one — brings the Cell tab forward; with a selection already there the tab is the
 * user's choice, so changing or growing the selection while on the View tab does not yank them
 * off it.
 */
export function tabAfterSelect(current: EditorTab, hadSelection: boolean): EditorTab {
  return hadSelection ? current : 'cell'
}

/**
 * The View tab's two groups (P7.1, user request 2026-11-19): each folds away on its own, so the
 * camera palette under the tab gets the room. Not remembered: the editor starts with both open
 * (`ALL_GROUPS_OPEN`) every time it opens, and keeps the choice while it stays open (across the
 * View | Cell tabs, a Discard and a switch of View).
 */
export const VIEW_SETTINGS_GROUPS = ['display', 'quality'] as const

export type ViewSettingsGroup = (typeof VIEW_SETTINGS_GROUPS)[number]

/** Which of the View tab's groups are open. */
export type OpenGroups = Readonly<Record<ViewSettingsGroup, boolean>>

export const ALL_GROUPS_OPEN: OpenGroups = { display: true, quality: true }

/** `open` with `group` folded if it was open, or opened if it was folded; the other untouched. */
export function toggleGroup(open: OpenGroups, group: ViewSettingsGroup): OpenGroups {
  return { ...open, [group]: !open[group] }
}
