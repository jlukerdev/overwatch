// One door on the Doors screen (P5.6; DOOR-2, DOOR-3, DOOR-6): its name, its actions with the lock
// state beside them, the rule controlling it, and the cameras linked to it. Thin on purpose:
// what a card is comes from ./doorLinks.ts, what it says from ./doorRule.ts and ./doorActions.ts.
//
// **Actions.** Unlock, Lock, and a "Set a rule" dropdown with its Apply button. The dropdown only
// holds a pending choice: nothing acts on `change` (user decision 2026-11-17 — on Windows and Linux
// an arrow key on a closed select fires one). Every button here only *asks*: `onAction` opens the
// confirm dialog, and the one request is sent from there (DoorsScreen). So activating a button
// from the keyboard never changes a door without the dialog being confirmed too (DOOR-4).
//
// **A door with no hub** has no lock the console drives, so its card is the name and one line
// saying so: no lock state (what the console reports for it means nothing), no actions and no Add
// camera (user decision 2026-11-19). Cameras linked to it earlier are still listed, so they can be
// unlinked.
//
// Two kinds of "cannot be pressed":
//  - **blocked** (`block`): the door's state is not known right now. The controls are `disabled`
//    and say why in `title`.
//  - **busy**: this door's action, or a link save, is in flight. The controls are `aria-disabled`
//    and ignore the press instead, because disabling the button that has the focus throws the
//    focus to `document.body`.
//
// A card for a door the list does not have (`unknown` / `pending`) has no actions and no Add
// camera: its state is "Unknown" and its cameras can be unlinked, which is all that is safe to
// offer for a door main has not read (main would refuse an action on it anyway).
import { useState, type JSX } from 'react'
import { MAX_DOOR_CUSTOM_MINUTES, type DoorAction, type IpcError } from '@shared/ipc'
import { CameraIcon, DoorIcon, DoorOpenIcon, XIcon } from '../../ui/icons'
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
  const noHub = listed && card.door?.boundToHub === false
  // The pill of the connection badge, not a button here. Never for a door with no hub (header).
  const lockChip = (
    <span className="badge doorCard__state" data-lock={look}>
      <span className="badge__dot" aria-hidden="true" />
      {LOCK_LOOK_LABELS[look]}
    </span>
  )
  // Nothing to add for a door with no hub or one the list lacks; what is linked can be unlinked.
  const canAdd = listed && !noHub
  return (
    <li className="card doorCard" aria-labelledby={headingId}>
      {/* Two lines are always reserved, so the controls line up across the cards of a row. */}
      <h3 className="doorCard__title" id={headingId} title={card.title}>
        {card.title}
      </h3>

      {noHub ? (
        <p className="field__hint">{NO_HUB_TEXT}</p>
      ) : listed ? (
        <DoorActions
          card={card}
          lockChip={lockChip}
          ruleLine={ruleLine}
          allowReset={allowReset}
          block={block}
          acting={acting}
          onAction={onAction}
        />
      ) : (
        <div className="row doorCard__buttons">{lockChip}</div>
      )}

      {canAdd || card.cameras.length > 0 ? (
        <div className="doorCard__cameras">
          <h4 className="doorCard__section">Cameras</h4>
          {card.cameras.length === 0 ? null : (
            <ul className="doorCard__cameraList">
              {card.cameras.map((camera) => (
                <li key={camera.cameraId} className="doorCard__camera">
                  <CameraIcon />
                  <span className="doorCard__cameraName">{camera.label}</span>
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
          {canAdd ? (
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
      ) : null}
    </li>
  )
}

/** Unlock, Lock and the rule control of a listed door (header). */
function DoorActions({
  card,
  lockChip,
  ruleLine,
  allowReset,
  block,
  acting,
  onAction,
}: Pick<DoorCardViewProps, 'card' | 'ruleLine' | 'allowReset' | 'block' | 'acting' | 'onAction'> & {
  readonly lockChip: JSX.Element
}): JSX.Element {
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
          className="button button--sm doorCard__unlock"
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
          className="button button--sm doorCard__lock"
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
        {lockChip}
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
          className="button button--primary button--sm"
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

      {/* What is controlling the door now, under the control that changes it. */}
      {ruleLine === null ? null : <p className="doorCard__line">{ruleLine}</p>}
    </div>
  )
}
