// The Doors screen's Polling card (P5.6; DOOR-6): how often main reads the Access door API. Four
// whole-second fields in a column, grouped (./pollingForm.ts `POLLING_GROUPS`), each with its range
// and one line of help to its right, a Save button and "Reset to defaults".
//
// **Collapsible** (user decision 2026-11-19): the shared ../../ui/SettingsBar, closed by default and
// at the top of the Doors screen, above its title row; opening it expands downwards over the cards.
// The draft is this component's state, outside the bar's body, so what was typed is kept while it
// is closed, for as long as the screen stays open.
//
// This one *is* a form, unlike the rest of the screen: nothing is saved as you type (a half-typed
// `1` of `15` would be an interval main starts using at once), field validation takes the
// place of the field's help as `.field__error`, and Save's outcome is a `StatusLine`, not a toast. "Reset to defaults"
// only fills the fields; it still needs Save. The rules are ./pollingForm.ts's, and main validates
// the payload again and applies it without a restart.
import { useState, type JSX } from 'react'
import type { IpcError } from '@shared/ipc'
import { ACCESS_POLLING_FIELDS, type AccessPolling } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { rejectedCall } from '../../state/rejectedCall'
import { SaveIcon, UndoIcon } from '../../ui/icons'
import { SettingsBar } from '../../ui/SettingsBar'
import { StatusLine } from '../../ui/StatusLine'
import {
  defaultPollingDraft,
  POLLING_GROUPS,
  POLLING_HELP,
  POLLING_LABELS,
  pollingCanSave,
  pollingDraftFrom,
  pollingFieldError,
  pollingInputFrom,
  pollingRangeText,
  type PollingDraft,
} from './pollingForm'

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: IpcError }

export function PollingCard({ polling }: { polling: AccessPolling }): JSX.Element {
  const setAccessPolling = useAppStore((s) => s.setAccessPolling)
  const [draft, setDraft] = useState<PollingDraft>(() => pollingDraftFrom(polling))
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const canSave = pollingCanSave(draft, polling) && !saving
  const defaults = defaultPollingDraft()
  const atDefaults = ACCESS_POLLING_FIELDS.every((field) => draft[field] === defaults[field])

  const save = async (): Promise<void> => {
    const input = pollingInputFrom(draft)
    if (input === null || !canSave) return
    setSaving(true)
    setOutcome(null)
    try {
      const result = await setAccessPolling(input)
      setOutcome(result.ok ? { ok: true } : { ok: false, error: result.error })
      // What was saved, as main normalised it ("05" becomes "5").
      if (result.ok) setDraft(pollingDraftFrom(result.value.settings.accessPolling))
    } catch (err) {
      setOutcome({ ok: false, error: rejectedCall(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsBar id="doors-polling">
      <p className="card__hint">Polling: seconds between the app's checks of the console.</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {POLLING_GROUPS.map((group) => (
          <fieldset key={group.title} className="settingsBar__group">
            <legend className="settingsBar__legend">{group.title}</legend>
            {group.fields.map((field) => {
              const id = `doors-polling-${field}`
              const error = pollingFieldError(field, draft[field])
              return (
                <div key={field} className="settingsBar__row">
                  <label className="field__label" htmlFor={id}>
                    {POLLING_LABELS[field]}
                  </label>
                  <input
                    id={id}
                    className="field__input doors__pollingInput"
                    type="number"
                    inputMode="numeric"
                    step={1}
                    value={draft[field]}
                    aria-invalid={error === null ? undefined : true}
                    aria-describedby={`${id}-hint`}
                    onChange={(event) => {
                      setDraft({ ...draft, [field]: event.target.value })
                      // The line is about the last save, not about what is being typed now.
                      setOutcome(null)
                    }}
                  />
                  <span
                    id={`${id}-hint`}
                    className={error === null ? 'field__hint' : 'field__error'}
                  >
                    {error ?? `${pollingRangeText(field)} ${POLLING_HELP[field]}`}
                  </span>
                </div>
              )
            })}
          </fieldset>
        ))}
        <div className="row doors__pollingActions">
          <button type="submit" className="button button--primary" disabled={!canSave}>
            <SaveIcon />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="button"
            disabled={atDefaults || saving}
            title={atDefaults ? 'The fields already hold the defaults.' : undefined}
            onClick={() => {
              setDraft(defaults)
              setOutcome(null)
            }}
          >
            <UndoIcon />
            Reset to defaults
          </button>
          {outcome === null ? null : outcome.ok ? (
            <StatusLine kind="ok" role="status">
              Saved. The new intervals are in use.
            </StatusLine>
          ) : (
            <StatusLine kind="error" role="alert">
              {outcome.error.message}
            </StatusLine>
          )}
        </div>
      </form>
    </SettingsBar>
  )
}
