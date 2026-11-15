// A whole-number input for the View editor (P3.3): the aspect's custom w:h and the gap in the
// settings row, and the cell inspector's rotate interval and hold (P4.2). The rules are pure, in
// ./editorModel: while typing, `boundedInputCommit` commits only a whole number already within
// [min, max], so a half-typed number is never snapped to a bound; on blur, `boundedInputBlurCommit`
// commits the rounded, clamped number. This component only keeps the text being typed.
//
// The text is local state rather than `String(value)` so that a half-typed, empty or out-of-range
// field is not snapped back on every keystroke. It is reset to the value when the value changes
// from outside (Discard, the range slider beside it) and on blur, so the field never keeps showing a
// number the View does not have.
import { useState, type JSX } from 'react'
import { boundedInputBlurCommit, boundedInputCommit } from './editorModel'

/**
 * How the input is named: by `label` (its `aria-label`), or by a visible `<label htmlFor={id}>`
 * beside it. Never both — an `aria-label` would override the visible label.
 */
type BoundedNumberInputNaming =
  | {
      /** The accessible name, e.g. "Aspect width". */
      readonly label: string
      readonly id?: undefined
    }
  | {
      /** For a visible `<label htmlFor>` beside it, which is then the accessible name. */
      readonly id: string
      readonly label?: undefined
    }

export type BoundedNumberInputProps = BoundedNumberInputNaming & {
  readonly value: number
  readonly min: number
  readonly max: number
  /** Called with the committed number, only when it differs from `value`. */
  readonly onChange: (value: number) => void
  readonly className?: string
}

export function BoundedNumberInput({
  value,
  min,
  max,
  onChange,
  label,
  className,
  id,
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
      id={id}
      type="number"
      className={`field__input ${className ?? ''}`}
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const committed = boundedInputCommit(event.target.value, min, max, value)
        if (committed !== null) onChange(committed)
      }}
      onBlur={() => {
        const committed = boundedInputBlurCommit(text, min, max, value)
        if (committed !== null) onChange(committed)
        setText(String(committed ?? value))
      }}
    />
  )
}
