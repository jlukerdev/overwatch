// A whole-number input for the View editor's settings row (P3.3): the aspect's custom w:h and the
// gap. The rule — round, clamp to [min, max], ignore what is not a number — is `parseBoundedInt`
// (./editorModel); this component only keeps the text being typed.
//
// The text is local state rather than `String(value)` so that a half-typed or empty field is not
// snapped back on every keystroke. It is reset to the value when the value changes from outside
// (Discard, the range slider beside it) and on blur, so the field never keeps showing a number the
// View does not have.
import { useState, type JSX } from 'react'
import { parseBoundedInt } from './editorModel'

export interface BoundedNumberInputProps {
  readonly value: number
  readonly min: number
  readonly max: number
  /** Called with the parsed, clamped number, only when it differs from `value`. */
  readonly onChange: (value: number) => void
  /** The accessible name, e.g. "Aspect width". */
  readonly label: string
  readonly className?: string
}

export function BoundedNumberInput({
  value,
  min,
  max,
  onChange,
  label,
  className,
}: BoundedNumberInputProps): JSX.Element {
  const [text, setText] = useState(String(value))
  // The value `text` was last synced to; a different `value` means it changed from outside.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(String(value))
  }
  return (
    <input
      type="number"
      className={`field__input ${className ?? ''}`}
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const parsed = parseBoundedInt(event.target.value, min, max)
        if (parsed !== null && parsed !== value) onChange(parsed)
      }}
      onBlur={() => {
        setText(String(value))
      }}
    />
  )
}
