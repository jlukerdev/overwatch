// The overlay's quality pickers (P3.7; QUAL-4, QUAL-5), two compact native selects for the strip's
// controls slot (CellOverlay), styled as its chips (`cellOverlay__select`, cells.css):
//
//  - **`CellQualityPicker`, in the grid** (QUAL-4): "View default (X)" — X being what the cell plays
//    with its override cleared — then the qualities. The value is the cell's own override, so a cell
//    that inherits shows the default option even when the View default happens to equal a quality.
//    A change is saved at once by the grid (`setCellQuality`); the cell's `quality` prop then
//    changes and the player swaps seamlessly (QUAL-6).
//  - **`FillQualityPicker`, while filled** (QUAL-5): the qualities, selected on what is playing, and
//    to the left of the select (not in it — an action is not a quality) a "Save for this View"
//    button, shown only once a pick has changed what plays (`canSaveFillQuality`). A pick lasts until fill ends (fillMode.ts,
//    "session pick").
//
// Thin on purpose: the option values, names and the edit are features/quality/qualityChoice.ts, the
// fill rules features/fill/fillMode.ts, all pure and tested. Native selects, because the dropdown,
// its keyboard handling and its accessibility come for free; the slot around them already keeps
// their presses and clicks from filling the cell or panning the zoom (CellOverlay, ZoomPan), and the
// View shortcuts and fill's `Esc` ignore keys typed into a select (`isTextEntryTarget`).
//
// **Focus after the pointer.** Any focus on a select holds the strip open (overlayVisibility.ts),
// which is what keeps it up while the dropdown is open. A pick made with the pointer then gives the
// focus back (`blur`), so the strip auto-hides again and fill's `Esc` works again; one made from the
// keyboard keeps it, because a keyboard user is still on the control. A dropdown opened with the
// pointer and closed with no pick is let go too: by an `Esc` on the closed select (`blursOnKey`,
// here), so the next `Esc` leaves fill, and by the pointer leaving the cell (CellOverlay). Which input
// focused the select is this picker's own record (the last of a pointer press or a key on it,
// cleared on blur), because `:focus-visible` turns on for the very key being handled.
import { useRef, type ChangeEvent, type JSX, type KeyboardEvent } from 'react'
import type { Quality, StreamQuality } from '@shared/quality'
import {
  inheritOptionLabel,
  parseQualityOption,
  qualityOptionValue,
} from '../quality/qualityChoice'
import { QualityOptions } from '../quality/QualityOptions'
import { SaveIcon } from '../../ui/icons'
import { blursOnKey } from './overlayVisibility'

/**
 * Tracks whether the select was last used by the pointer, and gives the focus back after a pick
 * from it or an `Esc` on it (header). Returns the handlers to spread on the select.
 */
function usePointerPickBlur(): {
  readonly onPointerDown: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLSelectElement>) => void
  readonly onBlur: () => void
  readonly afterPick: (event: ChangeEvent<HTMLSelectElement>) => void
} {
  const pointerRef = useRef(false)
  return {
    onPointerDown: () => {
      pointerRef.current = true
    },
    onKeyDown: (event) => {
      const select = event.currentTarget
      if (blursOnKey(event.key, { tagName: select.tagName, focusVisible: !pointerRef.current })) {
        // Not `preventDefault`: this `Esc` only lets go, and fill still sees a select target.
        select.blur()
        return
      }
      pointerRef.current = false
    },
    onBlur: () => {
      // The next focus decides afresh, e.g. a Tab back to the select is keyboard focus.
      pointerRef.current = false
    },
    afterPick: (event) => {
      if (pointerRef.current) event.currentTarget.blur()
    },
  }
}

export interface CellQualityPickerProps {
  /** The cell's own override; `null` inherits. */
  readonly override: Quality | null
  /** What the cell plays with the override cleared, named by the default option. */
  readonly inherited: Quality
  readonly onChange: (quality: Quality | null) => void
}

export function CellQualityPicker({
  override,
  inherited,
  onChange,
}: CellQualityPickerProps): JSX.Element {
  const blur = usePointerPickBlur()
  return (
    <select
      className="cellOverlay__select"
      aria-label="Cell quality"
      title="Quality for this cell (saved)"
      value={qualityOptionValue(override)}
      onPointerDown={blur.onPointerDown}
      onKeyDown={blur.onKeyDown}
      onBlur={blur.onBlur}
      onChange={(event) => {
        onChange(parseQualityOption(event.target.value))
        blur.afterPick(event)
      }}
    >
      <QualityOptions inheritLabel={inheritOptionLabel('View default', inherited)} />
    </select>
  )
}

export interface FillQualityPickerProps {
  /** What the filled cell plays now (the pick, or QUAL-5's chain). */
  readonly shown: StreamQuality
  /** Show "Save for this View": a pick changed what plays (`canSaveFillQuality`). */
  readonly canSave: boolean
  readonly onPick: (quality: Quality) => void
  readonly onSave: () => void
}

export function FillQualityPicker({
  shown,
  canSave,
  onPick,
  onSave,
}: FillQualityPickerProps): JSX.Element {
  const blur = usePointerPickBlur()
  return (
    <>
      {canSave ? (
        <button
          type="button"
          className="cellOverlay__back cellOverlay__iconButton cellOverlay__iconButton--labelled"
          title="Use this quality whenever a cell of this View fills"
          onClick={onSave}
        >
          <SaveIcon className="cellOverlay__icon" />
          Save for this View
        </button>
      ) : null}
      <select
        className="cellOverlay__select"
        aria-label="Fill quality"
        title="Quality while filled (until you return to the grid)"
        value={shown}
        onPointerDown={blur.onPointerDown}
        onKeyDown={blur.onKeyDown}
        onBlur={blur.onBlur}
        onChange={(event) => {
          const quality = parseQualityOption(event.target.value)
          if (quality !== null) onPick(quality)
          blur.afterPick(event)
        }}
      >
        <QualityOptions />
      </select>
    </>
  )
}
