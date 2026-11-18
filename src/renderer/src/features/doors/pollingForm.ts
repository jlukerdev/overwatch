// The Doors screen's Polling card (P5.6; DOOR-6), as pure functions: the four Access read
// intervals as the text being typed, their validation and the payload Save sends.
//
// The fields are text, not numbers, so a half-typed or empty field stays what the user typed and
// gets its message under it instead of snapping to a bound. Main validates again
// (`SetAccessPollingInputSchema`); this only keeps Save from sending what main would refuse.
import type { SetAccessPollingInput } from '@shared/ipc'
import {
  ACCESS_POLLING_BOUNDS,
  ACCESS_POLLING_FIELDS,
  type AccessPolling,
  type AccessPollingField,
} from '@shared/models'

export type PollingDraft = Readonly<Record<AccessPollingField, string>>

/** The field labels: what is read, and when that interval applies. All are in seconds. */
export const POLLING_LABELS: Readonly<Record<AccessPollingField, string>> = {
  withSocketSec: 'Door states, while live updates are connected',
  withoutSocketSec: 'Door states, while live updates are not connected',
  unlockedSec: 'Door states, while a door is unlocked',
  detailsSec: 'Rules and emergency status',
}

/** "Every 2 to 60 seconds": the field's hint, which is also where the unit is said. */
export function pollingRangeText(field: AccessPollingField): string {
  const { min, max } = ACCESS_POLLING_BOUNDS[field]
  return `Every ${String(min)} to ${String(max)} seconds`
}

function draftOf(read: (field: AccessPollingField) => number): PollingDraft {
  return {
    withSocketSec: String(read('withSocketSec')),
    withoutSocketSec: String(read('withoutSocketSec')),
    unlockedSec: String(read('unlockedSec')),
    detailsSec: String(read('detailsSec')),
  }
}

/** The saved intervals as the fields show them. */
export function pollingDraftFrom(polling: AccessPolling): PollingDraft {
  return draftOf((field) => polling[field])
}

/** What "Reset to defaults" fills in. Nothing is saved until Save. */
export function defaultPollingDraft(): PollingDraft {
  return draftOf((field) => ACCESS_POLLING_BOUNDS[field].default)
}

/** One field's number, or `null` when it is not a whole number inside the field's range. */
export function parsePollingField(field: AccessPollingField, text: string): number | null {
  const trimmed = text.trim()
  // Digits only: `Number('1e1')` and `Number('5.0')` are numbers, but not what the field asks for.
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  const { min, max } = ACCESS_POLLING_BOUNDS[field]
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

/** The message under an invalid field, or `null`. */
export function pollingFieldError(field: AccessPollingField, text: string): string | null {
  if (parsePollingField(field, text) !== null) return null
  const { min, max } = ACCESS_POLLING_BOUNDS[field]
  return `Enter a whole number from ${String(min)} to ${String(max)}.`
}

/** The payload for Save, or `null` while any field is invalid. */
export function pollingInputFrom(draft: PollingDraft): SetAccessPollingInput | null {
  const values = ACCESS_POLLING_FIELDS.map((field) => parsePollingField(field, draft[field]))
  const [withSocketSec, withoutSocketSec, unlockedSec, detailsSec] = values
  if (
    withSocketSec == null ||
    withoutSocketSec == null ||
    unlockedSec == null ||
    detailsSec == null
  ) {
    return null
  }
  return { withSocketSec, withoutSocketSec, unlockedSec, detailsSec }
}

/**
 * Whether Save has something to send: every field valid and at least one different from what is
 * saved. Compared as numbers, so `05` against a saved `5` is not a change.
 */
export function pollingCanSave(draft: PollingDraft, saved: AccessPolling): boolean {
  const input = pollingInputFrom(draft)
  if (input === null) return false
  return ACCESS_POLLING_FIELDS.some((field) => input[field] !== saved[field])
}
