// P5.6 (DOOR-6): what a door card says about its door — lock state, position and the rule line
// (src/renderer/src/features/doors/doorRule.ts).
//
// What these tests protect: a door whose state is old or that the list lacks is "Unknown", never
// locked or unlocked; an unknown rule and "no rule" both draw no line; and a rule's end time is
// written only while it is still ahead. The clock, the locale and the time zone are pinned, so the
// assertions are the same on every machine.
import { DoorSchema, type Door, type DoorRule } from '@shared/models'
import { describe, expect, it } from 'vitest'
import {
  doorLockLook,
  doorPositionLine,
  doorRuleLine,
  LOCK_LOOK_LABELS,
  ruleAllowsReset,
  ruleEndText,
  type RuleClock,
} from '../../src/renderer/src/features/doors/doorRule'

const door = (overrides: Partial<Door> = {}): Door =>
  DoorSchema.parse({
    id: 'd-1',
    name: 'Front',
    fullName: 'Front Door',
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay: 'lock',
    position: null,
    ...overrides,
  })

/** 2026-11-18 12:00:00 UTC, read as a clock on the wall in UTC, in US English. */
const NOW_MS = Date.UTC(2026, 10, 18, 12, 0, 0)
const CLOCK: RuleClock = { nowMs: NOW_MS, locale: 'en-US', timeZone: 'UTC' }
const sec = (ms: number): number => Math.floor(ms / 1000)
const SIX_PM = sec(Date.UTC(2026, 10, 18, 18, 0, 0))
const TOMORROW_8AM = sec(Date.UTC(2026, 10, 19, 8, 0, 0))

/** ICU puts a narrow no-break space before AM/PM in some versions and a plain space in others. */
const plain = (text: string | null): string | null =>
  text === null ? null : text.replace(/[\u202f\u00a0]/g, ' ')

const rule = (type: string, endedTime: number | null = null): DoorRule => ({ type, endedTime })
const line = (r: DoorRule | undefined, clock: RuleClock = CLOCK): string | null =>
  plain(doorRuleLine(r, clock))

describe('lock state and position', () => {
  it('reads the relay: unlocked or locked', () => {
    expect(doorLockLook(door({ relay: 'unlock' }), false)).toBe('unlocked')
    expect(doorLockLook(door({ relay: 'lock' }), false)).toBe('locked')
  })

  it('is unknown — never locked or unlocked — while stale or without a listed door', () => {
    expect(doorLockLook(door({ relay: 'unlock' }), true)).toBe('unknown')
    expect(doorLockLook(door({ relay: 'lock' }), true)).toBe('unknown')
    expect(doorLockLook(null, false)).toBe('unknown')
    expect(LOCK_LOOK_LABELS.unknown).toBe('Unknown')
  })

  it('says where the door is only with a sensor and a fresh state', () => {
    expect(doorPositionLine(door({ position: 'open' }), false)).toBe('Door open')
    expect(doorPositionLine(door({ position: 'close' }), false)).toBe('Door closed')
    expect(doorPositionLine(door({ position: null }), false)).toBeNull()
    expect(doorPositionLine(door({ position: 'open' }), true)).toBeNull()
    expect(doorPositionLine(null, false)).toBeNull()
  })
})

describe('ruleEndText', () => {
  it('writes the short time for an end later today', () => {
    expect(plain(ruleEndText(SIX_PM, CLOCK))).toBe('6:00 PM')
  })

  it('adds the date when the end is not today', () => {
    expect(plain(ruleEndText(TOMORROW_8AM, CLOCK))).toBe('Nov 19, 8:00 AM')
  })

  it('adds the year when the end is not this year', () => {
    const nextFebruary = sec(Date.UTC(2027, 1, 23, 1, 16, 0))
    expect(plain(ruleEndText(nextFebruary, CLOCK))).toBe('Feb 23, 2027, 1:16 AM')
  })

  it('decides "today" in the clock\'s time zone, not in UTC', () => {
    // 18 Nov 23:30 UTC is already the 19th in Tokyo, and so is 19 Nov 00:30 UTC: same day there.
    const tokyo: RuleClock = {
      nowMs: Date.UTC(2026, 10, 18, 23, 30, 0),
      locale: 'en-US',
      timeZone: 'Asia/Tokyo',
    }
    expect(plain(ruleEndText(sec(Date.UTC(2026, 10, 19, 0, 30, 0)), tokyo))).toBe('9:30 AM')
  })

  it('has no end for none, zero, a past moment or nonsense', () => {
    expect(ruleEndText(null, CLOCK)).toBeNull()
    expect(ruleEndText(0, CLOCK)).toBeNull()
    expect(ruleEndText(sec(NOW_MS) - 60, CLOCK)).toBeNull()
    expect(ruleEndText(sec(NOW_MS), CLOCK)).toBeNull()
    expect(ruleEndText(Number.NaN, CLOCK)).toBeNull()
    expect(ruleEndText(-5, CLOCK)).toBeNull()
  })

  it('reads the end as seconds, not milliseconds', () => {
    // As milliseconds this would be January 1970, long past, and so no text at all.
    expect(ruleEndText(SIX_PM, CLOCK)).not.toBeNull()
  })
})

describe('doorRuleLine', () => {
  it('words each documented rule, with its end when one is ahead', () => {
    expect(line(rule('schedule', SIX_PM))).toBe('On an unlock schedule until 6:00 PM')
    expect(line(rule('keep_unlock', SIX_PM))).toBe('Kept unlocked until 6:00 PM')
    expect(line(rule('keep_lock', TOMORROW_8AM))).toBe('Kept locked until Nov 19, 8:00 AM')
    expect(line(rule('custom', SIX_PM))).toBe('Unlocked until 6:00 PM')
    expect(line(rule('lock_early', SIX_PM))).toBe(
      'Locked early, ahead of its unlock schedule until 6:00 PM',
    )
  })

  it('drops "until" with no end, a zero end or one that has passed', () => {
    expect(line(rule('schedule'))).toBe('On an unlock schedule')
    expect(line(rule('keep_unlock', 0))).toBe('Kept unlocked')
    expect(line(rule('keep_lock', sec(NOW_MS) - 1))).toBe('Kept locked')
    expect(line(rule('custom'))).toBe('Unlocked for a set time')
    expect(line(rule('lock_early'))).toBe('Locked early, ahead of its unlock schedule')
  })

  it('draws no line for no rule, whatever its end time says', () => {
    expect(line(rule(''))).toBeNull()
    expect(line(rule('', 0))).toBeNull()
    expect(line(rule('', SIX_PM))).toBeNull()
    expect(line(rule('  ', SIX_PM))).toBeNull()
  })

  it('draws no line for a rule that is not known: unknown is not a state', () => {
    expect(line(undefined)).toBeNull()
  })

  it('shows a type the document does not list as it is', () => {
    expect(line(rule('holiday_mode'))).toBe('Rule: holiday_mode')
    expect(line(rule('holiday_mode', SIX_PM))).toBe('Rule: holiday_mode until 6:00 PM')
  })
})

describe('ruleAllowsReset', () => {
  it('offers "Back to normal" only for the three temporary rules', () => {
    expect(ruleAllowsReset(rule('keep_lock'))).toBe(true)
    expect(ruleAllowsReset(rule('keep_unlock'))).toBe(true)
    expect(ruleAllowsReset(rule('custom'))).toBe(true)
    expect(ruleAllowsReset(rule('schedule'))).toBe(false)
    expect(ruleAllowsReset(rule('lock_early'))).toBe(false)
    expect(ruleAllowsReset(rule(''))).toBe(false)
    expect(ruleAllowsReset(rule('something_new'))).toBe(false)
    expect(ruleAllowsReset(undefined)).toBe(false)
  })
})
