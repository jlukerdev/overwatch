// The mode choice at the top of Settings (MODE-2): two large selectable cards, **UniFi Protect**
// and **RTSP streams**, the most prominent thing on the screen in either mode.
//
// A native radio group (`.choiceCards` / `.choiceCard`, styles.css): each card is a `<label>`
// around a visually hidden radio, so the browser gives arrow keys, Tab-into-the-checked-one and the
// accessible "radio, 1 of 2, checked" for free; the card draws the input's focus ring and checked
// state. The radios are **controlled** by the stored mode, not by the click: choosing the other card
// asks first (`confirmDialog`), and a Cancel leaves the stored mode checked because nothing changed.
// Arrow keys select as well as move, as in any radio group, so they ask too. While the Console form
// holds unsaved input, switching to RTSP asks to discard it instead (`DISCARD_AND_SWITCH`).
//
// A confirmed switch is saved at once through `setMode` (no Save button); main tears down or brings
// back the Protect side and answers with the new mode's state (MODE-4). While that is in flight the
// radios are `aria-disabled` (not `disabled`, which would drop keyboard focus), and a failure is reported under the cards and stays there.
import { useState, type JSX } from 'react'
import type { AppMode } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { confirmDialog, type ConfirmOptions } from '../../ui/ConfirmDialog'
import { CameraIcon, CheckIcon, ShieldIcon } from '../../ui/icons'
import { StatusLine } from '../../ui/StatusLine'

interface ModeChoice {
  readonly mode: AppMode
  readonly title: string
  readonly hint: string
  readonly icon: JSX.Element
  /** What switching **to** this mode asks first. */
  readonly confirm: ConfirmOptions
}

const CHOICES: readonly ModeChoice[] = [
  {
    mode: 'protect',
    title: 'UniFi Protect',
    hint: 'Cameras, motion events and doors from your UniFi console',
    icon: <ShieldIcon />,
    confirm: {
      title: 'Switch to UniFi Protect?',
      message:
        'Streams stop playing. Your streams and their Views are kept for when you switch back.',
      confirmLabel: 'Switch to UniFi Protect',
    },
  },
  {
    mode: 'rtsp',
    title: 'RTSP streams',
    hint: 'Any camera with an RTSP address. No UniFi console needed.',
    icon: <CameraIcon />,
    confirm: {
      title: 'Switch to RTSP streams?',
      message:
        'Live video stops and the UniFi connection closes. Your UniFi settings, Views and door links are kept for when you switch back.',
      confirmLabel: 'Switch to RTSP streams',
    },
  },
]

/**
 * Asked in place of the RTSP card's own confirm while the Console form holds unsaved input, which
 * the switch would discard (ConsoleCard unmounts in RTSP mode). Only saved settings are kept.
 */
const DISCARD_AND_SWITCH: ConfirmOptions = {
  title: 'Discard unsaved console changes?',
  message:
    'Your console changes are not saved. Switching to RTSP streams discards them; your saved UniFi settings, Views and door links are kept.',
  confirmLabel: 'Discard and switch',
  danger: true,
}

export function ModePicker({
  mode,
  unsavedConsole,
}: {
  readonly mode: AppMode
  /** The Console form holds unsaved input (Protect mode only); switching would discard it. */
  readonly unsavedConsole: boolean
}): JSX.Element {
  const setMode = useAppStore((s) => s.setMode)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async (choice: ModeChoice): Promise<void> => {
    if (choice.mode === mode || switching) return
    const ask = choice.mode === 'rtsp' && unsavedConsole ? DISCARD_AND_SWITCH : choice.confirm
    if (!(await confirmDialog(ask))) return
    setSwitching(true)
    setError(null)
    const result = await setMode(choice.mode)
    setSwitching(false)
    if (!result.ok) setError(result.error.message)
  }

  return (
    <div className="choiceCards">
      <h2 className="card__title settings__groupTitle" id="settings-mode-title">
        Mode
      </h2>
      <div className="choiceCards__list" role="radiogroup" aria-labelledby="settings-mode-title">
        {CHOICES.map((choice) => (
          <label key={choice.mode} className="choiceCard">
            <input
              type="radio"
              className="visuallyHidden"
              name="app-mode"
              value={choice.mode}
              checked={mode === choice.mode}
              // Not `disabled`: disabling the focused radio would drop keyboard focus to the
              // body mid-switch. `choose` ignores input while `switching`, and the card is dimmed.
              aria-disabled={switching}
              onChange={() => {
                void choose(choice)
              }}
            />
            <span className="choiceCard__icon">{choice.icon}</span>
            <span className="choiceCard__text">
              <span className="choiceCard__title">{choice.title}</span>
              <span className="choiceCard__hint">{choice.hint}</span>
            </span>
            <span className="choiceCard__check" aria-hidden="true">
              <CheckIcon />
            </span>
          </label>
        ))}
      </div>
      {switching ? (
        <StatusLine kind="muted" busy role="status">
          Switching…
        </StatusLine>
      ) : null}
      {error === null ? null : (
        <StatusLine kind="error" role="alert">
          {error}
        </StatusLine>
      )}
    </div>
  )
}
