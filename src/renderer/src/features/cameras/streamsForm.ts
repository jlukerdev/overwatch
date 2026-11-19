// QUAL-1's app-wide stream defaults, as a pure function (P3.7; moved here from
// features/settings/settingsForm.ts when the selects moved to the Cameras screen's Settings bar,
// P5.7). No jsdom in this project (vitest.config.mts: node environment only), so the rule lives
// here, where tests/renderer/streamsForm.test.ts can reach it, not in ./StreamsSettings.tsx.
import type { SetStreamsInput } from '@shared/ipc'
import { isQuality } from '@shared/quality'

/** Which of the two QUAL-1 defaults a select edits. */
export type StreamsField = keyof SetStreamsInput

/**
 * The `setStreams` payload after one select changed: the other default exactly as it is stored, so
 * the call can never reset it. `streams` must be what is stored *now*, read at the moment of the
 * change rather than the value a select last rendered with: ./StreamsSettings.tsx passes the
 * store's latest `settings.streams`, and lets only one save run at a time, so two quick changes
 * cannot have the second one write back the first one's old value. `null` for a value that is not a
 * `Quality` (a select only offers the qualities, features/quality/QualityOptions, so that is a bug,
 * not user input) or for no change at all — a select fires `change` only on a different value, but
 * there is no reason to write the same one.
 */
export function streamsInputFrom(
  streams: SetStreamsInput,
  field: StreamsField,
  value: string,
): SetStreamsInput | null {
  if (!isQuality(value) || streams[field] === value) return null
  return {
    defaultGridQuality: streams.defaultGridQuality,
    defaultFillQuality: streams.defaultFillQuality,
    [field]: value,
  }
}
