// One door on the Doors screen (P5.6; DOOR-2, DOOR-3, DOOR-6): its name and lock state, the door
// position, the rule controlling it, its actions, and the cameras linked to it. Thin on purpose:
// what a card is comes from ./doorLinks.ts, what it says from ./doorRule.ts and ./doorActions.ts.
//
// **Actions.** Unlock, Lock, and a "Set a rule" dropdown with its Apply button. The dropdown only
// holds a pending choice: nothing acts on `change` (user decision 2026-11-17 — on Windows and Linux
// an arrow key on a closed select fires one). Every button here only *asks*: `onAction` opens the
// confirm dialog, and the one request is sent from there (DoorsScreen). So activating a button
// from the keyboard never changes a door without the dialog being confirmed too (DOOR-4).
//
// Two kinds of "cannot be pressed":
//  - **blocked** (`block`): the door has no hub, or its state is not known right now. The controls
//    are `disabled` and say why in `title`; "no hub" is also text on the card.
//  - **busy**: this door's action, or a link save, is in flight. The controls are `aria-disabled`
//    and ignore the press instead, because disabling the button that has the focus throws the
//    focus to `document.body`.
//
// A card for a door the list does not have (`unknown` / `pending`) has no actions and no Add
// camera: its state is "Unknown" and its cameras can be unlinked, which is all that is safe to
// offer for a door main has not read (main would refuse an action on it anyway).
import { useState, type JSX } from 'react'
import { MAX_DOOR_CUSTOM_MINUTES, type DoorAction, type IpcError } from '@shared/ipc'
import { DoorIcon, DoorOpenIcon, XIcon } from '../../ui/icons'
import { StatusLine } from '../../ui/StatusLine'
import { AddPicker } from './AddPicker'
import {
  ACTION_BLOCK_TITLES,
  DEFAULT_CUSTOM_MINUTES,
  NO_HUB_TEXT,
  parseCustomMinutes,
  ruleActionFrom,
  ruleOptions,
  type ActionBlock,
} from './doorActions'
import { domId, PLACEHOLDER, type DoorCard, type DropdownOption } from './doorLinks'
import { LOCK_LOOK_LABELS, type DoorLockLook } from './doorRule'

export interface DoorCardViewProps {
  readonly card: DoorCard
  readonly look: DoorLockLook
  readonly positionLine: string | null
  readonly ruleLine: string | null
  /** "Back to normal" is offered (the door has a temporary rule). */
  readonly allowReset: boolean
  /** Why the actions cannot be used, or `null`. Not read for a card without a listed door. */
  readonly block: ActionBlock | null
  /** This door's action is in flight. */
  readonly acting: boolean
  /** A link save is in flight, for any card: one save at a time for the whole screen. */
  readonly saving: boolean
  readonly cameraOptions: readonly DropdownOption[]
  readonly cameraPlaceholder: string
  /** The last failed link save, when this card made it. */
  readonly saveError: IpcError | null
  /** Asks (confirm dialog) and then sends. Answers whether the user confirmed. */
  readonly onAction: (action: DoorAction, minutes: number | null) => Promise<boolean>
  readonly onAddCamera: (cameraId: string) => void
  readonly onUnlink: (cameraId: string) => void
}

export function DoorCardView({
  card,
  look,
  positionLine,
  ruleLine,
  allowReset,
  block,
  acting,
  saving,
  cameraOptions,
  cameraPlaceholder,
  saveError,
  onAction,
  onAddCamera,
  onUnlink,
}: DoorCardViewProps): JSX.Element {
  const headingId = domId('door-card', card.doorId)
  const listed = card.kind === 'listed'
  return (
    <li className="card doorCard" aria-labelledby={headingId}>
      <div className="row doorCard__head">
        <h3 className="doorCard__title" id={headingId}>
          {card.title}
        </h3>
        {/* The connection badge's pill, not a button here: the dot is green only while unlocked. */}
        <span className="badge doorCard__lock" data-lock={look}>
          <span className="badge__dot" aria-hidden="true" />
          {LOCK_LOOK_LABELS[look]}
        </span>
      </div>

      {positionLine === null && ruleLine === null ? null : (
        <div className="doorCard__lines">
          {positionLine === null ? null : <p className="doorCard__line">{positionLine}</p>}
          {ruleLine === null ? null : <p className="doorCard__line">{ruleLine}</p>}
        </div>
      )}
      {listed && card.door?.boundToHub === false ? (
        <p className="field__hint">{NO_HUB_TEXT}</p>
      ) : null}

      {listed ? (
        <DoorActions
          card={card}
          allowReset={allowReset}
          block={block}
          acting={acting}
          onAction={onAction}
        />
      ) : null}

      <div className="doorCard__cameras">
        <h4 className="doorCard__section">Cameras</h4>
        {card.cameras.length === 0 ? (
          <p className="field__hint">No cameras linked</p>
        ) : (
          <ul className="doorCard__cameraList">
            {card.cameras.map((camera) => (
              <li key={camera.cameraId} className="row doorCard__camera">
                <span className="doorCard__grow">{camera.label}</span>
                <button
                  type="button"
                  className="button button--ghost button--icon button--sm"
                  aria-disabled={saving}
                  aria-label={`Unlink ${camera.label} from ${card.title}`}
                  title={`Unlink ${camera.label} from ${card.title}`}
                  onClick={() => {
                    if (!saving) onUnlink(camera.cameraId)
                  }}
                >
                  <XIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Not for a door the list lacks: there is nothing to link a new camera to. */}
        {listed ? (
          <AddPicker
            id={domId('door-card-add', card.doorId)}
            selectLabel={`Camera to add to ${card.title}`}
            buttonLabel={`Add camera to ${card.title}`}
            buttonText="Add"
            placeholder={cameraPlaceholder}
            options={cameraOptions}
            unavailable={cameraOptions.length === 0}
            busy={saving}
            onAdd={onAddCamera}
          />
        ) : null}
        {saveError === null ? null : (
          <StatusLine kind="error" role="alert">
            {saveError.message}
          </StatusLine>
        )}
      </div>
    </li>
  )
}

/** Unlock, Lock and the rule control of a listed door (header). */
function DoorActions({
  card,
  allowReset,
  block,
  acting,
  onAction,
}: Pick<DoorCardViewProps, 'card' | 'allowReset' | 'block' | 'acting' | 'onAction'>): JSX.Element {
  // The pending rule choice and the minutes being typed. Neither is sent anywhere until Apply.
  const [pending, setPending] = useState<string>(PLACEHOLDER)
  const [minutesText, setMinutesText] = useState<string>(DEFAULT_CUSTOM_MINUTES)

  const blocked = block !== null
  const blockTitle = block === null ? undefined : ACTION_BLOCK_TITLES[block]
  // A choice that is no longer offered ("Back to normal" after the rule ended) reads as none.
  const rule = blocked ? null : ruleActionFrom(pending, allowReset)
  const minutes = parseCustomMinutes(minutesText)
  const ruleReady = rule !== null && (rule !== 'custom' || minutes.ok)
  const minutesId = domId('door-card-minutes', card.doorId)
  const minutesErrorId = `${minutesId}-error`

  const press = (action: DoorAction, value: number | null = null): void => {
    if (blocked || acting) return
    void onAction(action, value)
  }

  return (
    <div className="doorCard__actions" aria-busy={acting ? true : undefined}>
      <div className="row doorCard__buttons">
        <button
          type="button"
          className="button button--sm"
          disabled={blocked}
          aria-disabled={acting}
          title={blockTitle}
          aria-label={`Unlock ${card.title}`}
          onClick={() => {
            press('unlock')
          }}
        >
          <DoorOpenIcon />
          Unlock
        </button>
        <button
          type="button"
          className="button button--sm"
          disabled={blocked}
          aria-disabled={acting}
          title={blockTitle}
          aria-label={`Lock ${card.title}`}
          onClick={() => {
            press('lock')
          }}
        >
          <DoorIcon />
          Lock
        </button>
        {acting ? (
          <span className="row doorCard__working" role="status">
            <span className="spinner" aria-hidden="true" />
            <span className="visuallyHidden">Sending to {card.title}…</span>
          </span>
        ) : null}
      </div>

      <div className="row doorCard__add">
        <select
          className="field__input doorCard__select"
          aria-label={`Rule to set on ${card.title}`}
          title={blockTitle}
          value={rule ?? PLACEHOLDER}
          disabled={blocked}
          onChange={(event) => {
            // Only the pending choice (header): Apply is what asks.
            setPending(event.target.value)
          }}
        >
          <option value={PLACEHOLDER} disabled>
            Set a rule…
          </option>
          {ruleOptions(allowReset).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--sm"
          disabled={blocked}
          aria-disabled={acting || !ruleReady}
          title={blockTitle}
          aria-label={`Apply the rule to ${card.title}`}
          onClick={() => {
            if (blocked || acting || rule === null) return
            if (rule === 'custom' && !minutes.ok) return
            void onAction(rule, rule === 'custom' && minutes.ok ? minutes.minutes : null).then(
              (confirmed) => {
                // Sent: back to the placeholder. Cancelled: the choice stays for another look.
                if (confirmed) setPending(PLACEHOLDER)
              },
            )
          }}
        >
          Apply
        </button>
      </div>

      {rule === 'custom' ? (
        <div className="field doorCard__minutes">
          <label className="field__label" htmlFor={minutesId}>
            Minutes to stay unlocked
          </label>
          <input
            id={minutesId}
            className="field__input doorCard__minutesInput"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_DOOR_CUSTOM_MINUTES}
            step={1}
            value={minutesText}
            aria-invalid={minutes.ok ? undefined : true}
            aria-describedby={minutes.ok ? undefined : minutesErrorId}
            onChange={(event) => {
              setMinutesText(event.target.value)
            }}
          />
          {minutes.ok ? null : (
            <span className="field__error" id={minutesErrorId}>
              {minutes.error}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}
