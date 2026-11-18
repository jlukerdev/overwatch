// P5.6 (DOOR-3, DOOR-4): the words and rules of the Doors screen's actions
// (src/renderer/src/features/doors/doorActions.ts).
//
// What these tests protect: every dialog names the door and the action on its confirm button; an
// unknown outcome is a warning that asks for a look before another try, never a success or a plain
// failure; an emergency dialog says it applies to every door; the pair sent for lockdown /
// evacuation is never both on, and is never computed while the status is not known.
import { DOOR_ACTIONS, IPC, MAX_DOOR_CUSTOM_MINUTES, type DoorActionResult } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import {
  ACTION_BLOCK_TITLES,
  actionBlock,
  activeEmergencies,
  doorActionConfirm,
  doorActionFailureToast,
  doorActionResultToast,
  EMERGENCY_MODES,
  emergencyBannerText,
  emergencyCommand,
  emergencyConfirm,
  emergencyFailureToast,
  emergencyInput,
  emergencyResultToast,
  emergencyStartBlock,
  minutesText,
  NO_HUB_TEXT,
  parseCustomMinutes,
  ruleActionFrom,
  ruleOptions,
} from '../../src/renderer/src/features/doors/doorActions'

const DOOR = 'Front Door'

const result = (overrides: Partial<DoorActionResult> = {}): DoorActionResult => ({
  doorId: 'd-front',
  doorName: DOOR,
  action: 'unlock',
  sent: 'unlock',
  minutes: null,
  outcome: 'done',
  reason: null,
  ...overrides,
})

describe("when a card's actions are available", () => {
  it('blocks a door with no hub, and any door while its state is not known', () => {
    expect(actionBlock({ stale: false, boundToHub: true })).toBeNull()
    expect(actionBlock({ stale: false, boundToHub: false })).toBe('no-hub')
    expect(actionBlock({ stale: true, boundToHub: true })).toBe('state-unknown')
    // The hub flag is as old as the rest while stale.
    expect(actionBlock({ stale: true, boundToHub: false })).toBe('state-unknown')
  })

  it('says why, in the tooltip and — for no hub — on the card', () => {
    expect(ACTION_BLOCK_TITLES['state-unknown']).toMatch(/not known right now/)
    expect(ACTION_BLOCK_TITLES['no-hub']).toMatch(/no door hub/)
    expect(NO_HUB_TEXT).toMatch(/^No door hub/)
  })
})

describe('the rule dropdown', () => {
  it('offers the three rules, and "Back to normal" only with a temporary rule to end', () => {
    expect(ruleOptions(false).map((o) => o.label)).toEqual([
      'Keep unlocked',
      'Keep locked',
      'Unlock for a set time',
    ])
    expect(ruleOptions(true).at(-1)).toEqual({ value: 'reset', label: 'Back to normal' })
  })

  it('reads a value as an action only when it is on offer', () => {
    expect(ruleActionFrom('keep_unlock', false)).toBe('keep_unlock')
    expect(ruleActionFrom('keep_lock', false)).toBe('keep_lock')
    expect(ruleActionFrom('custom', false)).toBe('custom')
    expect(ruleActionFrom('reset', true)).toBe('reset')
    // The rule ended while "Back to normal" was the pending choice.
    expect(ruleActionFrom('reset', false)).toBeNull()
    expect(ruleActionFrom('', true)).toBeNull()
    // Unlock and Lock are buttons, never something the dropdown can send.
    expect(ruleActionFrom('unlock', true)).toBeNull()
    expect(ruleActionFrom('lock', true)).toBeNull()
  })

  it('accepts whole minutes from 1 to the shared maximum, and nothing else', () => {
    expect(parseCustomMinutes('1')).toEqual({ ok: true, minutes: 1 })
    expect(parseCustomMinutes(' 15 ')).toEqual({ ok: true, minutes: 15 })
    expect(parseCustomMinutes(String(MAX_DOOR_CUSTOM_MINUTES))).toEqual({
      ok: true,
      minutes: MAX_DOOR_CUSTOM_MINUTES,
    })
    for (const text of ['', '0', '-1', '1.5', '1e2', 'ten', String(MAX_DOOR_CUSTOM_MINUTES + 1)]) {
      const parsed = parseCustomMinutes(text)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(String(MAX_DOOR_CUSTOM_MINUTES))
    }
  })

  it('builds only payloads main accepts', () => {
    const { request } = IPC.doorAction
    expect(request.safeParse({ doorId: 'd', action: 'custom', minutes: 15 }).success).toBe(true)
    expect(request.safeParse({ doorId: 'd', action: 'keep_unlock' }).success).toBe(true)
    // Why the screen leaves `minutes` out for everything but `custom`.
    expect(request.safeParse({ doorId: 'd', action: 'keep_unlock', minutes: 15 }).success).toBe(
      false,
    )
  })

  it('writes one minute in the singular', () => {
    expect(minutesText(1)).toBe('1 minute')
    expect(minutesText(15)).toBe('15 minutes')
  })
})

describe('the confirm dialog', () => {
  it('names the door and the action, on the title and on the confirm button', () => {
    const labels = {
      unlock: 'Unlock Front Door',
      lock: 'Lock Front Door',
      keep_unlock: 'Keep Front Door unlocked',
      keep_lock: 'Keep Front Door locked',
      custom: 'Unlock Front Door for 15 minutes',
      reset: 'Put Front Door back to normal',
    }
    for (const action of DOOR_ACTIONS) {
      const dialog = doorActionConfirm(action, DOOR, action === 'custom' ? 15 : null)
      expect(dialog.confirmLabel).toBe(labels[action])
      expect(dialog.title).toBe(`${labels[action]}?`)
      expect(dialog.message).not.toBe('')
      // Never a bare "OK" (CLAUDE.md).
      expect(dialog.confirmLabel).toContain(DOOR)
    }
  })
})

describe('the outcome toasts', () => {
  it('says what was done, by the door name main reports', () => {
    const done = (overrides: Partial<DoorActionResult>): string =>
      doorActionResultToast(result(overrides)).message
    expect(doorActionResultToast(result())).toEqual({
      tone: 'success',
      message: 'Front Door unlocked.',
    })
    expect(done({ action: 'lock', sent: 'lock_now' })).toBe('Front Door locked.')
    expect(done({ action: 'keep_unlock', sent: 'keep_unlock' })).toBe(
      'Front Door will stay unlocked.',
    )
    expect(done({ action: 'keep_lock', sent: 'keep_lock' })).toBe('Front Door will stay locked.')
    expect(done({ action: 'custom', sent: 'custom', minutes: 15 })).toBe(
      'Front Door unlocked for 15 minutes.',
    )
    expect(done({ action: 'reset', sent: 'reset' })).toBe('Front Door is back to normal.')
    expect(done({ doorName: 'Garage' })).toBe('Garage unlocked.')
  })

  it('warns, and asks for a look first, when the outcome is unknown', () => {
    const unknown = (overrides: Partial<DoorActionResult>): string => {
      const toast = doorActionResultToast(result({ outcome: 'unknown', ...overrides }))
      expect(toast.tone).toBe('warning')
      return toast.message
    }
    expect(unknown({})).toBe(
      'No answer from Access. Front Door may have unlocked — check before trying again.',
    )
    expect(unknown({ action: 'lock', sent: 'lock_now' })).toMatch(/may have locked — check/)
    expect(unknown({ action: 'keep_unlock', sent: 'keep_unlock' })).toMatch(
      /may now be kept unlocked — check/,
    )
    expect(unknown({ action: 'keep_lock', sent: 'keep_lock' })).toMatch(
      /may now be kept locked — check/,
    )
    expect(unknown({ action: 'custom', sent: 'custom', minutes: 1 })).toMatch(
      /may have unlocked for 1 minute — check/,
    )
    expect(unknown({ action: 'reset', sent: 'reset' })).toMatch(/may be back to normal — check/)
  })

  it('names the door and carries the reason on a failure', () => {
    expect(doorActionFailureToast('unlock', DOOR, null, ' The console refused it. ')).toEqual({
      tone: 'error',
      message: "Couldn't unlock Front Door. The console refused it.",
    })
    expect(doorActionFailureToast('lock', DOOR, null, '').message).toBe("Couldn't lock Front Door.")
    expect(doorActionFailureToast('keep_unlock', DOOR, null, '').message).toBe(
      "Couldn't keep Front Door unlocked.",
    )
    expect(doorActionFailureToast('keep_lock', DOOR, null, '').message).toBe(
      "Couldn't keep Front Door locked.",
    )
    expect(doorActionFailureToast('custom', DOOR, 15, '').message).toBe(
      "Couldn't unlock Front Door for 15 minutes.",
    )
    expect(doorActionFailureToast('reset', DOOR, null, '').message).toBe(
      "Couldn't put Front Door back to normal.",
    )
  })
})

describe('lockdown and evacuation', () => {
  const OFF = { lockdown: false, evacuation: false }
  const LOCKDOWN = { lockdown: true, evacuation: false }
  const EVACUATION = { lockdown: false, evacuation: true }
  const BOTH = { lockdown: true, evacuation: true }

  it('shows a banner per mode that is on, and none while the status is unknown', () => {
    expect(activeEmergencies(OFF)).toEqual([])
    expect(activeEmergencies(LOCKDOWN)).toEqual(['lockdown'])
    expect(activeEmergencies(EVACUATION)).toEqual(['evacuation'])
    expect(activeEmergencies(BOTH)).toEqual(['lockdown', 'evacuation'])
    expect(activeEmergencies(null)).toEqual([])
    expect(emergencyBannerText('lockdown')).toMatch(/Lockdown is on/)
    expect(emergencyBannerText('evacuation')).toMatch(/Evacuation is on/)
  })

  it('lets either start only while both are off and known, and says why otherwise', () => {
    for (const mode of EMERGENCY_MODES) {
      expect(emergencyStartBlock(mode, OFF)).toBeNull()
      expect(emergencyStartBlock(mode, null)).toMatch(/not known right now/)
    }
    expect(emergencyStartBlock('evacuation', LOCKDOWN)).toBe(
      'Lockdown is on. End it before starting evacuation.',
    )
    expect(emergencyStartBlock('lockdown', EVACUATION)).toBe(
      'Evacuation is on. End it before starting lockdown.',
    )
    expect(emergencyStartBlock('lockdown', LOCKDOWN)).toBe('Lockdown is already on.')
    expect(emergencyStartBlock('evacuation', EVACUATION)).toBe('Evacuation is already on.')
  })

  it('sends the whole pair: one on and the other off to start, both off to end', () => {
    expect(emergencyInput('lockdown', true, OFF)).toEqual(LOCKDOWN)
    expect(emergencyInput('evacuation', true, OFF)).toEqual(EVACUATION)
    expect(emergencyInput('lockdown', false, LOCKDOWN)).toEqual(OFF)
    expect(emergencyInput('evacuation', false, EVACUATION)).toEqual(OFF)
  })

  it('never sends both on, and ending one leaves the other as the console reported it', () => {
    const { request } = IPC.setDoorEmergency
    for (const mode of EMERGENCY_MODES) {
      for (const current of [OFF, LOCKDOWN, EVACUATION, BOTH]) {
        for (const on of [true, false]) {
          // Ending one of two that are both on leaves one on: still never both.
          expect(request.safeParse(emergencyInput(mode, on, current)).success).toBe(true)
        }
      }
    }
    expect(emergencyInput('lockdown', false, BOTH)).toEqual(EVACUATION)
    expect(emergencyInput('evacuation', false, BOTH)).toEqual(LOCKDOWN)
  })

  it('asks in a dialog that says it applies to every door, with the action on the button', () => {
    for (const mode of EMERGENCY_MODES) {
      for (const on of [true, false]) {
        const dialog = emergencyConfirm(mode, on)
        expect(dialog.message).toMatch(/every door/)
        expect(dialog.confirmLabel).toBe(emergencyCommand(mode, on))
        expect(dialog.title).toBe(`${emergencyCommand(mode, on)}?`)
        // Starting is the dangerous direction.
        expect(dialog.danger).toBe(on)
      }
    }
    expect(emergencyCommand('lockdown', true)).toBe('Start lockdown')
    expect(emergencyCommand('evacuation', false)).toBe('End evacuation')
    expect(emergencyConfirm('evacuation', true).message).toMatch(/unlocked/)
    expect(emergencyConfirm('lockdown', true).message).toMatch(/kept locked/)
  })

  it('reports the outcome, pointing at the banner when it is unknown', () => {
    expect(emergencyResultToast('lockdown', true, { outcome: 'done' })).toEqual({
      tone: 'success',
      message: 'Lockdown is on. Every door is kept locked.',
    })
    expect(emergencyResultToast('evacuation', true, { outcome: 'done' }).message).toBe(
      'Evacuation is on. Every door is unlocked.',
    )
    expect(emergencyResultToast('evacuation', false, { outcome: 'done' }).message).toBe(
      'Evacuation ended.',
    )
    expect(emergencyResultToast('lockdown', true, { outcome: 'unknown' })).toEqual({
      tone: 'warning',
      message:
        'No answer from Access. Lockdown may have started — check the banner before trying again.',
    })
    expect(emergencyResultToast('evacuation', false, { outcome: 'unknown' }).message).toMatch(
      /Evacuation may have ended — check the banner/,
    )
    expect(emergencyFailureToast('lockdown', true, 'Refused.')).toEqual({
      tone: 'error',
      message: "Couldn't start lockdown. Refused.",
    })
    expect(emergencyFailureToast('evacuation', false, '').message).toBe("Couldn't end evacuation.")
  })
})
