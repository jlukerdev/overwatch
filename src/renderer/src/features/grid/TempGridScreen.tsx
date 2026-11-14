// TEMPORARY (P2.4): a live grid of the first 9 or 12 cameras, with a 3×3 / 4×3 toggle. It exists so
// Phase 2 can run many `<LivePlayer>`s at once (P2.5 perf harness, gate G2). Phase 3 replaces it
// with real Views (VIEW-1/2, the View switcher); `GridView` and `Cell` stay, this file goes.
//
// Quality is never a literal: it is QUAL-3's chain with no overrides, i.e. the settings default
// (`tempGridQuality`). The empty states reuse the camera list's setup-gap rules, so this screen and
// that one never disagree about why there is nothing to show.
import { useMemo, useState, type JSX } from 'react'
import { navClass } from '../../navClass'
import { useAppStore } from '../../state/appStore'
import { cameraListBody, setupGaps, SETUP_GAP_LABELS } from '../../state/camerasStore'
import { GridView } from './GridView'
import { assignTempGridSlots, TEMP_GRID_PRESETS, tempGridQuality } from './gridLayout'

export interface TempGridScreenProps {
  readonly onOpenSettings: () => void
  /** The Cameras screen is where the console is connected and its list is refreshed. */
  readonly onOpenCameras: () => void
}

export function TempGridScreen({
  onOpenSettings,
  onOpenCameras,
}: TempGridScreenProps): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const connection = useAppStore((s) => s.connection)
  const streams = useAppStore((s) => s.settings?.streams ?? null)

  const [presetId, setPresetId] = useState(TEMP_GRID_PRESETS[0]?.id)
  const preset = TEMP_GRID_PRESETS.find((p) => p.id === presetId) ?? TEMP_GRID_PRESETS[0]

  const slots = useMemo(
    () =>
      preset === undefined || streams === null
        ? []
        : assignTempGridSlots(cameras, preset, tempGridQuality(streams)),
    [cameras, preset, streams],
  )

  if (connection === null || streams === null || preset === undefined) {
    return <Notice title="Reading the console status…" />
  }

  const gaps = setupGaps(connection.protect)
  const body = cameraListBody(cameras.length, gaps)
  if (body === 'setup') {
    return (
      <Notice
        title="Not set up yet"
        hint={`Nothing to stream until setup is done: ${gaps.map((g) => SETUP_GAP_LABELS[g]).join('; ')}.`}
        action={{ label: 'Open settings', onClick: onOpenSettings }}
      />
    )
  }
  if (body === 'empty') {
    return (
      <Notice
        title="No cameras"
        hint="Connect to the console from the Cameras screen; the grid fills from its list."
        action={{ label: 'Open cameras', onClick: onOpenCameras }}
      />
    )
  }

  return (
    <section className="tempGrid">
      <div className="tempGrid__toolbar" role="toolbar" aria-label="Grid size">
        {TEMP_GRID_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={navClass(p.id === preset.id)}
            aria-pressed={p.id === preset.id}
            onClick={() => {
              setPresetId(p.id)
            }}
          >
            {p.label}
          </button>
        ))}
        <span className="app__muted">temporary grid (P2.4)</span>
      </div>
      <div className="tempGrid__body">
        <GridView cols={preset.cols} rows={preset.rows} slots={slots} />
      </div>
    </section>
  )
}

/** A notice card. `action` is the one button, labelled for the screen it actually opens. */
function Notice({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: { readonly label: string; readonly onClick: () => void }
}): JSX.Element {
  return (
    <div className="card tempGrid__notice">
      <h3 className="card__title">{title}</h3>
      {hint === undefined ? null : <p className="card__hint">{hint}</p>}
      {action === undefined ? null : (
        <button type="button" className="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
