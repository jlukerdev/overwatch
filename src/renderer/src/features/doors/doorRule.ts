// What a door card says about its door (P5.6; DOOR-6): the lock state, the door position and the
// line about the rule or schedule controlling it. Pure, with the clock and the locale handed in,
// so the tests are the same in every time zone (tests/renderer/doorRule.test.ts).
//
// Two things here are about **not claiming more than is known**:
//  - a door whose state is old (`DoorsScreenState.stale`) or that the list does not have is
//    "Unknown", never locked or unlocked;
//  - a door missing from the rules map has an *unknown* rule, which is not a state worth a line:
//    nothing is shown, exactly as for a door the console says has no rule (`type: ''`).
import type { Door, DoorRule } from '@shared/ipc'

/** The lock state a card shows. `unknown` is drawn neutral and never worded as locked. */
export type DoorLockLook = 'locked' | 'unlocked' | 'unknown'

/** `door`: the listed door, or `null` for a card the list does not have. */
export function doorLockLook(door: Door | null, stale: boolean): DoorLockLook {
  if (door === null || stale) return 'unknown'
  return door.relay === 'unlock' ? 'unlocked' : 'locked'
}

export const LOCK_LOOK_LABELS: Readonly<Record<DoorLockLook, string>> = {
  locked: 'Locked',
  unlocked: 'Unlocked',
  unknown: 'Unknown',
}

/** "Door open" / "Door closed", or `null` with no sensor or while the state is not known. */
export function doorPositionLine(door: Door | null, stale: boolean): string | null {
  if (door === null || stale || door.position === null) return null
  return door.position === 'open' ? 'Door open' : 'Door closed'
}

/** The moment and the conventions a time is written in. The tests pin all three. */
export interface RuleClock {
  readonly nowMs: number
  /** Default: the system's locale. */
  readonly locale?: string
  /** Default: the system's time zone. */
  readonly timeZone?: string
}

/** A calendar day in the clock's time zone, as one comparable string. */
function dayKey(ms: number, clock: RuleClock): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: clock.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)
}

/**
 * When a rule ends, for the end of a sentence: the locale's short time ("6:00 PM"), with the date
 * in front when that is not today ("Nov 19, 6:00 PM") and the year too when it is not this year (a
 * "keep unlocked" can run for months). `null` when there is no end worth saying:
 * none sent, `0` (the mock's "no rule") or a moment that has already passed — a rule the console
 * has not cleared yet is not "until" a time in the past.
 */
export function ruleEndText(endedTime: number | null, clock: RuleClock): string | null {
  if (endedTime === null || !Number.isFinite(endedTime) || endedTime <= 0) return null
  // `endedTime` is Unix **seconds** (reference §7.11).
  const endMs = endedTime * 1000
  if (endMs <= clock.nowMs) return null
  const endDay = dayKey(endMs, clock)
  const today = dayKey(clock.nowMs, clock)
  // `YYYY-MM-DD`: the first four characters are the year.
  const sameYear = endDay.slice(0, 4) === today.slice(0, 4)
  return new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    ...(endDay === today ? {} : { month: 'short', day: 'numeric' }),
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(endMs)
}

/**
 * The card's rule line, or `null` for no line: no rule (`type: ''`, whatever `endedTime` says) or
 * a rule that is not known (`undefined`: the door is missing from `DoorsScreenState.rules`).
 *
 * The official document gives a rule's type and end time and nothing else — no schedule name, no
 * hours (src/shared/models.ts `DoorRuleSchema`) — so that is all a line can say. A type the
 * document does not list is shown as it is rather than hidden.
 */
export function doorRuleLine(rule: DoorRule | undefined, clock: RuleClock): string | null {
  if (rule === undefined) return null
  const type = rule.type.trim()
  if (type === '') return null
  const end = ruleEndText(rule.endedTime, clock)
  const until = end === null ? '' : ` until ${end}`
  switch (type) {
    case 'schedule':
      return `On an unlock schedule${until}`
    case 'keep_unlock':
      return `Kept unlocked${until}`
    case 'keep_lock':
      return `Kept locked${until}`
    case 'custom':
      return end === null ? 'Unlocked for a set time' : `Unlocked${until}`
    case 'lock_early':
      // What the end time of a `lock_early` means is not documented (most likely the end of the
      // schedule it cut short), so the line does not promise that anything resumes then.
      return `Locked early, ahead of its unlock schedule${until}`
    default:
      return `Rule: ${type}${until}`
  }
}

/**
 * Whether "Back to normal" (`reset`) is offered: only for the three temporary rules it ends. An
 * unlock schedule is not ended by `reset` (Lock does that: main always sends `lock_now`).
 */
export function ruleAllowsReset(rule: DoorRule | undefined): boolean {
  const type = rule?.type.trim()
  return type === 'keep_lock' || type === 'keep_unlock' || type === 'custom'
}
