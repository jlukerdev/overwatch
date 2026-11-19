// An "Add …" control (P5.3, moved with the door links in P5.6): a select that only holds a
// **pending** choice, and a button that acts on it. Nothing happens on `change` — on Windows and
// Linux an arrow key on a closed select fires one, so a select that acted on change would save
// whatever the arrow landed on (user decision 2026-11-17).
//
// The button is usable only with something chosen and no save running; it is `aria-disabled`
// rather than `disabled` for the second, so the focus stays on it through the save. After a press
// the select goes back to its placeholder. A choice the options no longer contain (the camera was
// linked elsewhere meanwhile) reads as no choice.
import { useState, type JSX } from 'react'
import { PLACEHOLDER, type DropdownOption } from './doorLinks'

export function AddPicker({
  id,
  selectLabel,
  buttonLabel,
  buttonText,
  placeholder,
  options,
  unavailable,
  busy,
  onAdd,
}: {
  id: string
  /** The select's accessible name. */
  selectLabel: string
  /** The button's accessible name, e.g. "Add camera to <door>". */
  buttonLabel: string
  /** The button's visible text. */
  buttonText: string
  placeholder: string
  options: readonly DropdownOption[]
  /** Nothing can be added at all (no options): the select itself is disabled. */
  unavailable: boolean
  busy: boolean
  onAdd: (value: string) => void
}): JSX.Element {
  const [pending, setPending] = useState<string>(PLACEHOLDER)
  const choice = options.some((option) => option.value === pending) ? pending : PLACEHOLDER
  const ready = !unavailable && !busy && choice !== PLACEHOLDER

  return (
    <div className="row doorCard__add">
      <select
        id={id}
        className="field__input doorCard__select"
        aria-label={selectLabel}
        value={choice}
        disabled={unavailable}
        onChange={(event) => {
          setPending(event.target.value)
        }}
      >
        <option value={PLACEHOLDER} disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button button--primary button--sm"
        aria-disabled={!ready}
        aria-label={buttonLabel}
        onClick={() => {
          if (!ready) return
          setPending(PLACEHOLDER)
          onAdd(choice)
        }}
      >
        {buttonText}
      </button>
    </div>
  )
}
