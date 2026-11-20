// The top of the View editor's Cell tab (F1.0.2-2; VIEW-3): how many cells are selected, then the
// three actions on the selection — Merge, Split, Clear cameras — as one row of equal-width buttons,
// icon over label. A button that cannot act is disabled and says why in its tooltip
// (`toolbarTitles`, ./viewEditorHelpers). With nothing selected the caption is left out and every
// action is disabled; the inspector's hint under the row says what to do. The edits themselves are
// the editor's (./ViewEditor); this component only says which one.
//
// An action often disables its own button (a merged cell cannot be merged again, a cleared one has
// nothing to clear), which would drop keyboard focus to the page. So after an action whose button
// is now disabled, focus moves to the next action that can still act (`focusAfterAction`), or to
// the row itself when none can.
import { useLayoutEffect, useRef, type JSX } from 'react'
import { EraserIcon, MergeIcon, SplitIcon } from '../../ui/icons'

export interface CellActionsProps {
  /** How many cells the selection holds. */
  readonly selectedCount: number
  readonly canMerge: boolean
  readonly canSplit: boolean
  /** Whether any selected cell has a camera. */
  readonly canClear: boolean
  /** The buttons' tooltips: what each does, or why it cannot. */
  readonly titles: { readonly merge: string; readonly split: string; readonly clear: string }
  readonly onMerge: () => void
  readonly onSplit: () => void
  readonly onClear: () => void
}

/** The caption over the actions: "1 cell selected" / "N cells selected"; `null` for none. */
export function selectionCaption(count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? '1 cell selected' : `${String(count)} cells selected`
}

/**
 * Where focus goes after the action at `clicked` ran, given which actions are enabled now: `clicked`
 * itself if it still is, else the next enabled one after it (wrapping), else `null` (none can act).
 */
export function focusAfterAction(enabled: readonly boolean[], clicked: number): number | null {
  for (let step = 0; step < enabled.length; step += 1) {
    const index = (clicked + step) % enabled.length
    if (enabled[index] === true) return index
  }
  return null
}

export function CellActions({
  selectedCount,
  canMerge,
  canSplit,
  canClear,
  titles,
  onMerge,
  onSplit,
  onClear,
}: CellActionsProps): JSX.Element {
  const caption = selectionCaption(selectedCount)
  const rowRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  // The action just clicked, until the render after it has placed focus.
  const clickedRef = useRef<number | null>(null)
  const enabled = [canMerge, canSplit, canClear]
  useLayoutEffect(() => {
    const clicked = clickedRef.current
    if (clicked === null) return
    clickedRef.current = null
    const button = buttonRefs.current[clicked]
    // Only when the click left focus nowhere: the clicked button went disabled.
    if (button?.disabled !== true) return
    const target = focusAfterAction(enabled, clicked)
    const next = target === null ? null : buttonRefs.current[target]
    ;(next ?? rowRef.current)?.focus()
  })
  return (
    <div className="viewEditor__cellActions">
      {caption === null ? null : (
        <p className="viewEditor__selectionCaption" title="Press Esc to clear the selection">
          {caption}
        </p>
      )}
      <div
        ref={rowRef}
        className="viewEditor__cellActionRow"
        role="group"
        aria-label="Selected cells"
        tabIndex={-1}
      >
        <button
          type="button"
          className="button viewEditor__cellAction"
          disabled={!canMerge}
          title={titles.merge}
          ref={(el) => {
            buttonRefs.current[0] = el
          }}
          onClick={() => {
            clickedRef.current = 0
            onMerge()
          }}
        >
          <MergeIcon />
          Merge
        </button>
        <button
          type="button"
          className="button viewEditor__cellAction"
          disabled={!canSplit}
          title={titles.split}
          ref={(el) => {
            buttonRefs.current[1] = el
          }}
          onClick={() => {
            clickedRef.current = 1
            onSplit()
          }}
        >
          <SplitIcon />
          Split
        </button>
        <button
          type="button"
          className="button button--danger viewEditor__cellAction"
          disabled={!canClear}
          title={titles.clear}
          ref={(el) => {
            buttonRefs.current[2] = el
          }}
          onClick={() => {
            clickedRef.current = 2
            onClear()
          }}
        >
          <EraserIcon />
          Clear cameras
        </button>
      </div>
    </div>
  )
}
