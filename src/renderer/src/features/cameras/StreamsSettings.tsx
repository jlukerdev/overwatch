// The Cameras screen's Settings bar (P5.7; QUAL-1): the app-wide default grid and fill quality.
// Moved here from the Settings screen's Streams card; the same `setStreams` call, and nothing about
// what is stored changed. The bar is the shared ../../ui/SettingsBar, as the Doors screen's polling.
//
// Unlike the polling form, each select saves on change and shows its own failure: a select has no
// half-typed state. One save runs at a time (both selects are disabled while it is in flight), and
// each payload is built from the store's defaults at the moment of the change (./streamsForm.ts),
// so a quick Grid-then-Fill change cannot have the second save write back the Grid value the first
// one replaced.
import { useState, type JSX } from 'react'
import type { IpcError, Settings } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { rejectedCall } from '../../state/rejectedCall'
import { SettingsBar } from '../../ui/SettingsBar'
import { StatusLine } from '../../ui/StatusLine'
import { QualityOptions } from '../quality/QualityOptions'
import { streamsInputFrom, type StreamsField } from './streamsForm'

export function StreamsSettings({ streams }: { streams: Settings['streams'] }): JSX.Element {
  const setStreams = useAppStore((s) => s.setStreams)
  // One save at a time for both selects (header): while one is in flight both are disabled, so a
  // second change cannot start from the defaults the first one is replacing.
  const [saving, setSaving] = useState(false)
  /** The last failed save, shown under the select that made it. */
  const [saveError, setSaveError] = useState<{ field: StreamsField; error: IpcError } | null>(null)

  const save = async (field: StreamsField, value: string): Promise<void> => {
    // The store's defaults as they are now, not the `streams` this render was given: an answer
    // that landed since is already in the store, and the other default must go out as stored.
    const stored = useAppStore.getState().settings?.streams ?? streams
    const input = streamsInputFrom(stored, field, value)
    if (input === null) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await setStreams(input)
      if (!result.ok) setSaveError({ field, error: result.error })
    } catch (err) {
      setSaveError({ field, error: rejectedCall(err) })
    } finally {
      // Never left disabled, whatever the call did.
      setSaving(false)
    }
  }

  const select = (field: StreamsField, label: string): JSX.Element => (
    <QualitySelect
      value={streams[field]}
      field={field}
      label={label}
      disabled={saving}
      error={saveError?.field === field ? saveError.error : null}
      onChange={(value) => {
        void save(field, value)
      }}
    />
  )

  return (
    <SettingsBar id="cameras-settings">
      <p className="card__hint">
        Streams: the default quality in the grid and when a camera fills the window. A View can set
        its own, and a cell its own grid quality.
      </p>
      <div className="cameras__streamsGrid">
        {select('defaultGridQuality', 'Grid quality')}
        {select('defaultFillQuality', 'Fill quality')}
      </div>
    </SettingsBar>
  )
}

/**
 * One QUAL-1 default. Controlled by the stored value, not by a draft: the select shows what main
 * holds, so a failed save snaps back to the stored quality and says why underneath. The saving
 * itself is `StreamsSettings`', which serialises the two selects.
 */
function QualitySelect({
  value,
  field,
  label,
  disabled,
  error,
  onChange,
}: {
  value: Settings['streams'][StreamsField]
  field: StreamsField
  label: string
  disabled: boolean
  error: IpcError | null
  onChange: (value: string) => void
}): JSX.Element {
  const id = `cameras-streams-${field}`
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input cameras__streamsSelect"
        value={value}
        disabled={disabled}
        title={disabled ? 'Saving the last change…' : undefined}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      >
        <QualityOptions />
      </select>
      {error === null ? null : (
        <StatusLine kind="error" role="alert">
          {error.message}
        </StatusLine>
      )}
    </div>
  )
}
