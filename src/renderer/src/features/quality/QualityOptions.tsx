// The `<option>`s every quality select shows (P3.7; QUAL-1/2/3/4/5): an optional "inherit" option
// first, then the qualities best first, named by `qualityName`. One component so Settings' two
// defaults, the View editor's View and cell selects and the overlay's pickers cannot drift apart in
// order or wording; the values and names themselves are ./qualityChoice, pure and tested.
//
// It renders options only, not the `<select>`: each caller keeps its own value, handler, class and
// any extra option of its own (the fill picker's "Save for this View").
import type { JSX } from 'react'
import { INHERIT_OPTION, QUALITY_OPTIONS, qualityName } from './qualityChoice'

export interface QualityOptionsProps {
  /**
   * The text of the "inherit" option (`null`, {@link INHERIT_OPTION}), usually from
   * `inheritOptionLabel`. Left out, there is no such option: the level has no inherit (QUAL-1).
   */
  readonly inheritLabel?: string
}

export function QualityOptions({ inheritLabel }: QualityOptionsProps): JSX.Element {
  return (
    <>
      {inheritLabel === undefined ? null : <option value={INHERIT_OPTION}>{inheritLabel}</option>}
      {QUALITY_OPTIONS.map((quality) => (
        <option key={quality} value={quality}>
          {qualityName(quality)}
        </option>
      ))}
    </>
  )
}
