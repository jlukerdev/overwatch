// The tab list over the View editor's side panel (UX polish 2026-11-17): **View** | **Cell**, the
// WAI-ARIA tabs pattern. One tab is in the Tab order (roving `tabIndex`); Left / Right / Home / End
// move to another tab, select it and focus it (`tabForKey`, ./editorTabs). The panels themselves
// are drawn by the editor, both kept mounted (the inactive one `hidden`) so neither loses its local
// state — the settings' custom-aspect mode, the inspector's remembered rotate interval — to a
// change of tab. `editorTabId` / `editorPanelId` tie each tab to its panel.
import { useRef, type JSX } from 'react'
import { EDITOR_TAB_LABELS, EDITOR_TABS, tabForKey, type EditorTab } from './editorTabs'

/** The DOM id of a tab button, from the editor's `useId` prefix. */
export function editorTabId(idPrefix: string, tab: EditorTab): string {
  return `${idPrefix}-tab-${tab}`
}

/** The DOM id of a tab's panel. */
export function editorPanelId(idPrefix: string, tab: EditorTab): string {
  return `${idPrefix}-panel-${tab}`
}

export interface EditorTabListProps {
  readonly idPrefix: string
  readonly tab: EditorTab
  readonly onChange: (tab: EditorTab) => void
}

export function EditorTabList({ idPrefix, tab, onChange }: EditorTabListProps): JSX.Element {
  const buttons = useRef(new Map<EditorTab, HTMLButtonElement>())
  return (
    <div className="viewEditor__tabs" role="tablist" aria-label="View and cell settings">
      {EDITOR_TABS.map((id) => (
        <button
          key={id}
          ref={(element) => {
            if (element === null) buttons.current.delete(id)
            else buttons.current.set(id, element)
          }}
          type="button"
          role="tab"
          id={editorTabId(idPrefix, id)}
          className="viewEditor__tab"
          aria-selected={id === tab}
          aria-controls={editorPanelId(idPrefix, id)}
          tabIndex={id === tab ? 0 : -1}
          onClick={() => {
            onChange(id)
          }}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            const next = tabForKey(id, event.key)
            if (next === null) return
            event.preventDefault()
            onChange(next)
            buttons.current.get(next)?.focus()
          }}
        >
          {EDITOR_TAB_LABELS[id]}
        </button>
      ))}
    </div>
  )
}
