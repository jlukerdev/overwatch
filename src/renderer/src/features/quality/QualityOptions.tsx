// The `<option>`s every quality select shows (P3.7; QUAL-1/2/3/4/5): an optional "inherit" option
// first, then the qualities best first, named by `qualityName`. One component so Settings' two
// defaults, the View editor's View and cell selects and the overlay's pickers cannot drift apart in
// order or wording; the values and names themselves are ./qualityChoice, pure and tested.
//
// It renders options only, not the `<select>`: each caller keeps its own value, handler, class and
// any extra option of its own. An RTSP stream's picker passes its `availability`, which disables a
// quality with no URL and marks it "(not set)" (RTSP-3); the inherit option is never disabled.
import type { JSX } from 'react'
import { INHERIT_OPTION, qualityOptionItems, type QualityAvailability } from './qualityChoice'

export interface QualityOptionsProps {
  /**
   * The text of the "inherit" option (`null`, {@link INHERIT_OPTION}), usually from
   * `inheritOptionLabel`. Left out, there is no such option: the level has no inherit (QUAL-1).
   */
  readonly inheritLabel?: string
  /**
   * Which qualities the stream has a URL for (RTSP-3); `null` or left out, every quality is
   * enabled (Protect mode, a View-wide select).
   */
  readonly availability?: QualityAvailability
}

export function QualityOptions({ inheritLabel, availability }: QualityOptionsProps): JSX.Element {
  return (
    <>
      {inheritLabel === undefined ? null : <option value={INHERIT_OPTION}>{inheritLabel}</option>}
      {qualityOptionItems(availability).map((item) => (
        <option key={item.value} value={item.value} disabled={item.disabled}>
          {item.label}
        </option>
      ))}
    </>
  )
}
