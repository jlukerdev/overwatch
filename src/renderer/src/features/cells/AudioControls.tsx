// A camera cell's audio controls (P5.1; AUD-1, AUD-2, AUD-3, CELL-3), for the overlay's strip
// (CellOverlay), drawn as its chips (`cellOverlay__back cellOverlay__iconButton`, cells.css):
//
//  - **`MuteToggle`**, in the grid and in fill, only on a cell whose camera can be heard
//    (a mic, on, and the camera connected, AUD-1; `GridSlot.audio`, features/audio/cameraAudio.ts). A speaker crossed out while muted — every
//    cell starts so — and with sound waves while heard; `aria-pressed` says which. A press unmutes
//    this cell, which mutes every other (AUD-2), or mutes it. What that means is
//    state/audioStore.ts's; this only reports the press.
//  - **`VolumeSlider`**, only while filled and only on a cell with audio (AUD-3): a compact range,
//    0–100%, for the app-wide session level (user decision, 2026-11-16). It applies to whatever
//    plays, so it is there whether this cell is heard or not, and moving it never unmutes.
//
// Both sit in the slot whose presses and clicks CellOverlay stops, so neither fills the cell; and
// the zoom skips a press, a wheel or a drag that starts in it (ZoomPan), so a slider drag never pans.
//
// **Focus after the pointer**, like the quality pickers (QualityPicker.tsx): a range is an `INPUT`,
// so while it has the focus the keyboard rules treat keys as typing — fill's `Esc`, the `1`–`9`
// View shortcuts and `M` all stand aside (`isTextEntryTarget`). A slider used with the pointer
// therefore gives the focus back when the pointer is released, so those keys work again at once. The
// press captures the pointer on the slider (`setPointerCapture`), so the release comes back to it
// even when a drag ends off it, and nothing is left listening on the window if the slider unmounts
// mid-drag; one focused from the keyboard keeps it, because a
// keyboard user is still on the control and the arrows move it. A mouse-focused range does not hold
// the strip open (only a select's focus does, overlayVisibility.ts); the drag's own movement does.
import { useRef, type JSX, type PointerEvent } from 'react'
import { SpeakerIcon, SpeakerMutedIcon } from '../../ui/icons'

export interface MuteToggleProps {
  /** This cell is the one heard (AUD-2). */
  readonly audible: boolean
  /** `true` asks to unmute this cell, `false` to mute it. */
  readonly onToggle: (unmute: boolean) => void
}

export function MuteToggle({ audible, onToggle }: MuteToggleProps): JSX.Element {
  return (
    <button
      type="button"
      className="cellOverlay__back cellOverlay__iconButton"
      aria-label={audible ? 'Mute' : 'Unmute'}
      aria-pressed={audible}
      title={audible ? 'Mute (M mutes all)' : 'Unmute (mutes the other cells)'}
      data-audible={audible ? 'true' : undefined}
      onClick={() => {
        onToggle(!audible)
      }}
    >
      {audible ? (
        <SpeakerIcon className="cellOverlay__icon" />
      ) : (
        <SpeakerMutedIcon className="cellOverlay__icon" />
      )}
    </button>
  )
}

export interface VolumeSliderProps {
  /** The app-wide level, 0…1. */
  readonly volume: number
  readonly onChange: (volume: number) => void
}

export function VolumeSlider({ volume, onChange }: VolumeSliderProps): JSX.Element {
  const percent = Math.round(volume * 100)
  // Whether the current press is the pointer's, to let go of the focus on release (header).
  const pressedRef = useRef(false)

  const onPointerDown = (event: PointerEvent<HTMLInputElement>): void => {
    pressedRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerRelease = (event: PointerEvent<HTMLInputElement>): void => {
    if (!pressedRef.current) return
    pressedRef.current = false
    const input = event.currentTarget
    if (document.activeElement === input) input.blur()
  }

  return (
    <input
      type="range"
      className="cellOverlay__volume"
      min={0}
      max={100}
      step={1}
      value={percent}
      aria-label="Volume"
      aria-valuetext={`${String(percent)}%`}
      title={`Volume ${String(percent)}%`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerRelease}
      onPointerCancel={onPointerRelease}
      onChange={(event) => {
        onChange(Number(event.target.value) / 100)
      }}
    />
  )
}
