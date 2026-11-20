// The View editor's side panel tabs (UX polish 2026-11-17; VIEW-3): **View** (the View's Display
// and Quality settings) and **Cell** (the selection's Merge / Split / Clear cameras, then the
// inspector of the selected cell; F1.0.2-2). Which tab a key moves to and when a selection brings
// the Cell tab forward are decided here, pure and unit-tested (tests/renderer/editorPanel.test.ts);
// ./EditorTabList draws the tabs and ./ViewEditor owns the state.
import type { CellPlacement } from '@shared/viewLayout'

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
 * The tab to show once the canvas selection has gone from `before` to `after` (F1.0.2-2; VIEW-3).
 * Every change to a non-empty selection — a click, a drag, a Shift-click — brings the Cell tab
 * forward, even from the View tab, since the Cell tab holds what acts on the selection. A pick
 * that leaves the selection as it was (clicking the selected cell again) leaves the tab alone, so
 * the user can go back to the View tab and stay there until the selection changes. Clearing the
 * selection (`after` null: `Esc`, a layout change) never moves the tab.
 */
export function tabAfterSelect(
  current: EditorTab,
  before: CellPlacement | null,
  after: CellPlacement | null,
): EditorTab {
  if (after === null) return current
  if (before !== null && samePlacement(before, after)) return current
  return 'cell'
}

function samePlacement(a: CellPlacement, b: CellPlacement): boolean {
  return a.col === b.col && a.row === b.row && a.colSpan === b.colSpan && a.rowSpan === b.rowSpan
}

/**
 * The View tab's two groups (P7.1): each folds away on its own, so the camera palette under the
 * tab gets the room. Not remembered: the editor starts with both folded (`INITIAL_GROUPS`,
 * F1.0.2-2) every time it opens, and keeps the choice while it stays open (across the View | Cell
 * tabs, a Discard and a switch of View).
 */
export const VIEW_SETTINGS_GROUPS = ['display', 'quality'] as const

export type ViewSettingsGroup = (typeof VIEW_SETTINGS_GROUPS)[number]

/** Which of the View tab's groups are open. */
export type OpenGroups = Readonly<Record<ViewSettingsGroup, boolean>>

/** Both groups folded: how the editor starts each time it opens. */
export const INITIAL_GROUPS: OpenGroups = { display: false, quality: false }

/** `open` with `group` folded if it was open, or opened if it was folded; the other untouched. */
export function toggleGroup(open: OpenGroups, group: ViewSettingsGroup): OpenGroups {
  return { ...open, [group]: !open[group] }
}
