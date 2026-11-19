// The words and the small rules of the Doors screen's actions (P5.6; DOOR-3, DOOR-4), pure:
// what each confirm dialog asks, what each toast says, when a card's actions are unavailable and
// whether the minutes of a timed unlock are valid. The components only wire these to buttons.
//
// **Every action on this screen is confirmed in a dialog** (user decision 2026-11-18): unlock
// included, and there is no press-and-hold here. The dialog names the door and the action, and its
// confirm button names the action. One confirmed dialog is one IPC call, which is never repeated.
//
// The toasts follow the cell's unlock (features/door/unlockHold.ts): a success goes by itself, a
// failure carries main's safe reason, and an **unknown** outcome — the request may have reached
// the console but no answer came back — is a warning that asks for a look before another try,
// because the door may have changed and a second try is a second action.
import {
  MAX_DOOR_CUSTOM_MINUTES,
  type DoorAction,
  type DoorActionResult,
  type DoorEmergency,
  type DoorEmergencyInput,
  type DoorEmergencyResult,
} from '@shared/ipc'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'
import type { ToastInput } from '../../state/toastStore'
import type { DropdownOption } from './doorLinks'

// -------------------------------------------------------------------------------------------------
// One door

/** Why a card's actions cannot be used right now, or `null` when they can. */
export type ActionBlock = 'no-hub' | 'state-unknown'

/**
 * `state-unknown` wins: while the state is old the hub flag is old too. A door with no hub is
 * refused by main as well (`bad-request`, no Access call); this only saves the user the dialog.
 */
export function actionBlock(input: {
  readonly stale: boolean
  readonly boundToHub: boolean
}): ActionBlock | null {
  if (input.stale) return 'state-unknown'
  return input.boundToHub ? null : 'no-hub'
}

/** The disabled controls' tooltip. */
export const ACTION_BLOCK_TITLES: Readonly<Record<ActionBlock, string>> = {
  'no-hub': "This door has no door hub, so it can't be unlocked or locked from here.",
  'state-unknown': "This door's state is not known right now.",
}

/** Shown as text on the card of a door with no hub, not only as a tooltip. */
export const NO_HUB_TEXT = "No door hub, so it can't be unlocked or locked from here."

/** The actions the "Set a rule" dropdown holds; Unlock and Lock have their own buttons. */
export type RuleAction = Exclude<DoorAction, 'unlock' | 'lock'>

/** The dropdown's options. "Back to normal" only while there is a temporary rule to end. */
export function ruleOptions(allowReset: boolean): DropdownOption[] {
  return [
    { value: 'keep_unlock', label: 'Keep unlocked' },
    { value: 'keep_lock', label: 'Keep locked' },
    { value: 'custom', label: 'Unlock for a set time' },
    ...(allowReset ? [{ value: 'reset', label: 'Back to normal' }] : []),
  ]
}

/** The dropdown's value as an action, or `null` for the placeholder or anything not offered. */
export function ruleActionFrom(value: string, allowReset: boolean): RuleAction | null {
  if (value === 'keep_unlock' || value === 'keep_lock' || value === 'custom') return value
  return value === 'reset' && allowReset ? 'reset' : null
}

/** What the minutes field starts with. */
export const DEFAULT_CUSTOM_MINUTES = '15'

export type MinutesParse =
  { readonly ok: true; readonly minutes: number } | { readonly ok: false; readonly error: string }

/** The minutes of "Unlock for a set time": a whole number, 1 to {@link MAX_DOOR_CUSTOM_MINUTES}. */
export function parseCustomMinutes(text: string): MinutesParse {
  const trimmed = text.trim()
  const error = `Enter a whole number of minutes, 1 to ${String(MAX_DOOR_CUSTOM_MINUTES)}.`
  // Digits only: `Number('1e2')`, `' 0x10'` and `'1.0'` are numbers, but not what was typed.
  if (!/^\d+$/.test(trimmed)) return { ok: false, error }
  const minutes = Number(trimmed)
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_DOOR_CUSTOM_MINUTES) {
    return { ok: false, error }
  }
  return { ok: true, minutes }
}

/** "1 minute", "15 minutes". */
export function minutesText(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`
}

/** What a door action is, for the sentences below. `minutes` only matters for `custom`. */
interface ActionWords {
  /** The dialog's title: "Unlock Front Door". */
  readonly command: string
  /** The confirm button: the action without the door, which the title already names. */
  readonly confirm: string
  /** After "Couldn't ": "unlock Front Door". */
  readonly attempt: string
  /** The success toast. */
  readonly done: string
  /** After "<door> may ": "have unlocked". */
  readonly maybe: string
  /** The dialog's sentence under the title. */
  readonly explain: string
}

function actionWords(action: DoorAction, door: string, minutes: number | null): ActionWords {
  const span = minutesText(minutes ?? 0)
  switch (action) {
    case 'unlock':
      return {
        command: `Unlock ${door}`,
        confirm: 'Unlock',
        attempt: `unlock ${door}`,
        done: `${door} unlocked.`,
        maybe: 'have unlocked',
        explain: 'The door unlocks now and locks again by itself after a few seconds.',
      }
    case 'lock':
      return {
        command: `Lock ${door}`,
        confirm: 'Lock',
        attempt: `lock ${door}`,
        done: `${door} locked.`,
        maybe: 'have locked',
        explain: 'The door locks now. If it is being kept unlocked, that ends.',
      }
    case 'keep_unlock':
      return {
        command: `Keep ${door} unlocked`,
        confirm: 'Keep unlocked',
        attempt: `keep ${door} unlocked`,
        done: `${door} will stay unlocked.`,
        maybe: 'now be kept unlocked',
        explain: 'The door stays unlocked until you lock it or put it back to normal.',
      }
    case 'keep_lock':
      return {
        command: `Keep ${door} locked`,
        confirm: 'Keep locked',
        attempt: `keep ${door} locked`,
        done: `${door} will stay locked.`,
        maybe: 'now be kept locked',
        explain:
          'The door stays locked, through any unlock schedule, until you put it back to normal.',
      }
    case 'custom':
      return {
        command: `Unlock ${door} for ${span}`,
        confirm: `Unlock for ${span}`,
        attempt: `unlock ${door} for ${span}`,
        done: `${door} unlocked for ${span}.`,
        maybe: `have unlocked for ${span}`,
        explain: `The door stays unlocked for ${span}, then locks again.`,
      }
    case 'reset':
      return {
        command: `Put ${door} back to normal`,
        confirm: 'Back to normal',
        attempt: `put ${door} back to normal`,
        done: `${door} is back to normal.`,
        maybe: 'be back to normal',
        explain: 'This ends the rule on the door. It goes back to its usual schedule.',
      }
  }
}

/** The confirm dialog for one action on one door (DOOR-3: the title names both). */
export function doorActionConfirm(
  action: DoorAction,
  doorName: string,
  minutes: number | null = null,
): ConfirmOptions {
  const words = actionWords(action, doorName, minutes)
  return { title: `${words.command}?`, message: words.explain, confirmLabel: words.confirm }
}

/** The toast for an action main answered: done, or sent with no answer (`unknown`). */
export function doorActionResultToast(result: DoorActionResult): ToastInput {
  const words = actionWords(result.action, result.doorName, result.minutes)
  if (result.outcome === 'unknown') {
    return {
      tone: 'warning',
      message: `No answer from Access. ${result.doorName} may ${words.maybe} — check before trying again.`,
    }
  }
  return { tone: 'success', message: words.done }
}

/** `head`, then the reason when there is one. */
function withReason(head: string, reason: string): string {
  const trimmed = reason.trim()
  return trimmed === '' ? head : `${head} ${trimmed}`
}

/**
 * The toast for an action that failed or was refused. There is no result to read the door's name
 * from, so it is the name on the card the user pressed.
 */
export function doorActionFailureToast(
  action: DoorAction,
  doorName: string,
  minutes: number | null,
  reason: string,
): ToastInput {
  const words = actionWords(action, doorName, minutes)
  return { tone: 'error', message: withReason(`Couldn't ${words.attempt}.`, reason) }
}

/** The reason when the bridge itself failed (not an `IpcResult`), as the cell's unlock words it. */
export const SEND_FAILED_REASON = 'The app could not send the request.'

// -------------------------------------------------------------------------------------------------
// Every door: lockdown and evacuation

export type EmergencyMode = 'lockdown' | 'evacuation'
export const EMERGENCY_MODES: readonly EmergencyMode[] = ['lockdown', 'evacuation']

const OTHER_MODE: Readonly<Record<EmergencyMode, EmergencyMode>> = {
  lockdown: 'evacuation',
  evacuation: 'lockdown',
}

const MODE_NAMES: Readonly<Record<EmergencyMode, string>> = {
  lockdown: 'Lockdown',
  evacuation: 'Evacuation',
}

/** The header button's text. */
export function emergencyModeName(mode: EmergencyMode): string {
  return MODE_NAMES[mode]
}

/** The modes that are on, for the banners. None while the status is not known. */
export function activeEmergencies(emergency: DoorEmergency | null): EmergencyMode[] {
  if (emergency === null) return []
  return EMERGENCY_MODES.filter((mode) => emergency[mode])
}

/**
 * Why a header Start button is disabled, or `null` when it can be pressed. Unknown status first:
 * a pair computed from a guess must never be sent. The two cannot be on together (main refuses
 * it), so one being on disables the other's button — and its own, which the banner's End replaces.
 */
export function emergencyStartBlock(
  mode: EmergencyMode,
  emergency: DoorEmergency | null,
): string | null {
  if (emergency === null) return 'The emergency status is not known right now.'
  if (emergency[mode]) return `${MODE_NAMES[mode]} is already on.`
  const other = OTHER_MODE[mode]
  if (emergency[other]) {
    return `${MODE_NAMES[other]} is on. End it before starting ${MODE_NAMES[mode].toLowerCase()}.`
  }
  return null
}

/**
 * The whole pair to send (`setDoorEmergency` takes both flags). Starting a mode turns the other
 * off — it is off anyway, or Start is disabled. Ending one leaves the other as the console last
 * reported it, so ending lockdown on a console that somehow has both on does not also end the
 * evacuation behind the user's back.
 */
export function emergencyInput(
  mode: EmergencyMode,
  on: boolean,
  current: DoorEmergency,
): DoorEmergencyInput {
  const other = OTHER_MODE[mode]
  return {
    lockdown: false,
    evacuation: false,
    [mode]: on,
    [other]: on ? false : current[other],
  }
}

/** The banner's sentence while a mode is on. */
export function emergencyBannerText(mode: EmergencyMode): string {
  return mode === 'lockdown'
    ? 'Lockdown is on. Every door is kept locked.'
    : 'Evacuation is on. Every door is kept unlocked.'
}

/** "Start lockdown" / "End evacuation": the confirm button, and the banner's End button. */
export function emergencyCommand(mode: EmergencyMode, on: boolean): string {
  return `${on ? 'Start' : 'End'} ${MODE_NAMES[mode].toLowerCase()}`
}

/** The confirm dialog. It says the change applies to every door (user decision 2026-11-18). */
export function emergencyConfirm(mode: EmergencyMode, on: boolean): ConfirmOptions {
  const command = emergencyCommand(mode, on)
  const message = on
    ? mode === 'lockdown'
      ? 'This applies to every door. All doors are kept locked until you end the lockdown.'
      : 'This applies to every door. All doors are unlocked and stay unlocked until you end the evacuation.'
    : 'This applies to every door. They go back to their usual rules and schedules.'
  return { title: `${command}?`, message, confirmLabel: command, danger: on }
}

/** The toast for an emergency change main answered. `mode` and `on` are what was asked. */
export function emergencyResultToast(
  mode: EmergencyMode,
  on: boolean,
  result: Pick<DoorEmergencyResult, 'outcome'>,
): ToastInput {
  const name = MODE_NAMES[mode]
  if (result.outcome === 'unknown') {
    return {
      tone: 'warning',
      message: `No answer from Access. ${name} may have ${on ? 'started' : 'ended'} — check the banner before trying again.`,
    }
  }
  if (!on) return { tone: 'success', message: `${name} ended.` }
  return {
    tone: 'success',
    message:
      mode === 'lockdown'
        ? 'Lockdown is on. Every door is kept locked.'
        : 'Evacuation is on. Every door is unlocked.',
  }
}

/** The toast for an emergency change that failed or was refused. */
export function emergencyFailureToast(
  mode: EmergencyMode,
  on: boolean,
  reason: string,
): ToastInput {
  return {
    tone: 'error',
    message: withReason(`Couldn't ${emergencyCommand(mode, on).toLowerCase()}.`, reason),
  }
}
