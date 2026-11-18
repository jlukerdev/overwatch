// P5.6 (DOOR-6): the Polling card's fields, validation and payload
// (src/renderer/src/features/doors/pollingForm.ts).
//
// What these tests protect: Save never sends what main would refuse (a value outside its range, a
// fraction, an empty field), is off while nothing changed, and "Reset to defaults" fills P5.5's
// values. The bounds are read from the shared table, so a changed range cannot leave a test stale.
import { ACCESS_POLLING_BOUNDS, ACCESS_POLLING_FIELDS, defaultAccessPolling } from '@shared/models'
import { IPC } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import {
  defaultPollingDraft,
  parsePollingField,
  POLLING_LABELS,
  pollingCanSave,
  pollingDraftFrom,
  pollingFieldError,
  pollingInputFrom,
  pollingRangeText,
} from '../../src/renderer/src/features/doors/pollingForm'

const SAVED = { withSocketSec: 10, withoutSocketSec: 3, unlockedSec: 2, detailsSec: 60 }

describe('the draft', () => {
  it('shows the saved intervals as text', () => {
    expect(pollingDraftFrom(SAVED)).toEqual({
      withSocketSec: '10',
      withoutSocketSec: '3',
      unlockedSec: '2',
      detailsSec: '60',
    })
  })

  it('resets to the defaults of the shared table', () => {
    expect(defaultPollingDraft()).toEqual(pollingDraftFrom(defaultAccessPolling()))
  })

  it('has a label and a range for every field', () => {
    for (const field of ACCESS_POLLING_FIELDS) {
      expect(POLLING_LABELS[field]).not.toBe('')
      const { min, max } = ACCESS_POLLING_BOUNDS[field]
      expect(pollingRangeText(field)).toBe(`Every ${String(min)} to ${String(max)} seconds`)
    }
  })
})

describe('field validation', () => {
  it('accepts whole numbers at and inside the bounds', () => {
    for (const field of ACCESS_POLLING_FIELDS) {
      const { min, max } = ACCESS_POLLING_BOUNDS[field]
      expect(parsePollingField(field, String(min))).toBe(min)
      expect(parsePollingField(field, String(max))).toBe(max)
      expect(parsePollingField(field, ` ${String(min)} `)).toBe(min)
      expect(pollingFieldError(field, String(min))).toBeNull()
    }
  })

  it('refuses a value just outside either bound, with the range in the message', () => {
    for (const field of ACCESS_POLLING_FIELDS) {
      const { min, max } = ACCESS_POLLING_BOUNDS[field]
      expect(parsePollingField(field, String(min - 1))).toBeNull()
      expect(parsePollingField(field, String(max + 1))).toBeNull()
      expect(pollingFieldError(field, String(max + 1))).toBe(
        `Enter a whole number from ${String(min)} to ${String(max)}.`,
      )
    }
  })

  it('refuses anything that is not plain digits', () => {
    for (const text of ['', ' ', '5.5', '5.0', '1e1', '-5', '+5', '0x5', 'five', '5s']) {
      expect(parsePollingField('withSocketSec', text)).toBeNull()
    }
  })
})

describe('the payload', () => {
  it("is all four numbers, and passes main's schema", () => {
    const input = pollingInputFrom(pollingDraftFrom(SAVED))
    expect(input).toEqual(SAVED)
    expect(IPC.setAccessPolling.request.safeParse(input).success).toBe(true)
  })

  it('is null while any one field is invalid', () => {
    for (const field of ACCESS_POLLING_FIELDS) {
      expect(pollingInputFrom({ ...pollingDraftFrom(SAVED), [field]: '' })).toBeNull()
    }
  })

  it('can be saved only when valid and different from what is saved', () => {
    const draft = pollingDraftFrom(SAVED)
    expect(pollingCanSave(draft, SAVED)).toBe(false)
    expect(pollingCanSave({ ...draft, detailsSec: '61' }, SAVED)).toBe(true)
    expect(pollingCanSave({ ...draft, detailsSec: '6000' }, SAVED)).toBe(false)
    // One valid change does not excuse another field's error.
    expect(pollingCanSave({ ...draft, detailsSec: '61', unlockedSec: '0' }, SAVED)).toBe(false)
    // Compared as numbers: a leading zero is not a change.
    expect(pollingCanSave({ ...draft, withSocketSec: '010' }, SAVED)).toBe(false)
    expect(pollingCanSave(defaultPollingDraft(), SAVED)).toBe(true)
    expect(pollingCanSave(defaultPollingDraft(), defaultAccessPolling())).toBe(false)
  })
})
