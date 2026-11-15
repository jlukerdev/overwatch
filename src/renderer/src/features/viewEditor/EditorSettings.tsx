// The View editor's settings (P3.3; VIEW-1, VIEW-5, VIEW-7; P3.7, QUAL-2/5): layout preset, grid
// size, the 1×1 cell's aspect, the gap between cells, how a camera fits its cell, and the View's
// grid and fill qualities. Each control turns into one edit of the draft:
//
//  - Layout → `applyPreset` (cameras carried over in reading order). "Custom" is shown, and
//    selected, only while the layout matches no preset (`matchingPresetId`); it is not choosable.
//  - Columns / Rows → `resizeGrid`.
//  - Aspect → one of `ASPECT_CHOICES`, or "Custom…" with a w:h pair of number inputs. Choosing
//    "Custom…" keeps the current ratio and only reveals the inputs. Custom mode is sticky: it
//    starts on when the ratio is not a listed one, and once on (picked, or the inputs typed in) it
//    is left only through the select, so the inputs do not vanish mid-typing when a ratio reduces
//    to a listed one (16:10 → 16:9). The editor remounts this row (`key`) when the draft goes back
//    to the stored View, which resets the mode.
//  - Gap → a 0–MAX_GRID_GAP range plus a number input for an exact value.
//  - Fit → contain / cover.
//  - Grid quality / Fill quality (P3.7; QUAL-2, QUAL-5) → `gridQuality` / `fillQuality`. The first
//    option inherits (`null`) and names what that gives now, from `settings.streams` (QUAL-1):
//    "App default (LOW)". Saved with the rest of the draft, like every setting here.
//
// The controls sit in three titled groups (P3.8): Grid (layout preset, columns, rows), Display (aspect,
// gap, fit) and Quality (grid, fill). Each group is a `fieldset`, so its caption is read with the
// controls inside it.
//
// Layout changes report how many camera cells they dropped, so the editor can say so.
import { useId, useState, type JSX } from 'react'
import { FitSchema, MAX_GRID_DIMENSION, MAX_GRID_GAP, type View } from '@shared/models'
import { LAYOUT_PRESETS, resizeGrid } from '@shared/viewLayout'
import { useAppStore } from '../../state/appStore'
import {
  inheritOptionLabel,
  parseQualityOption,
  qualityOptionValue,
} from '../quality/qualityChoice'
import { QualityOptions } from '../quality/QualityOptions'
import { BoundedNumberInput } from './BoundedNumberInput'
import {
  applyPreset,
  ASPECT_CHOICES,
  aspectChoiceLabel,
  matchingPresetId,
  MAX_ASPECT_TERM,
} from './editorModel'
import { resizeDropsCameras } from './viewEditorHelpers'

const CUSTOM = 'custom'

const GRID_SIZES = Array.from({ length: MAX_GRID_DIMENSION }, (_, i) => i + 1)

export interface EditorSettingsProps {
  readonly draft: View
  /** A setting that leaves the cells alone (aspect, gap, fit, the two qualities). */
  readonly onEdit: (next: View) => void
  /** A change of layout: the selection no longer means anything, and `lost` camera cells went. */
  readonly onLayout: (next: View, lost: number) => void
  /** A refused operation's reason, shown by the editor. */
  readonly onError: (reason: string) => void
}

export function EditorSettings({
  draft,
  onEdit,
  onLayout,
  onError,
}: EditorSettingsProps): JSX.Element {
  const aspectId = useId()
  const gapId = useId()
  const [customAspect, setCustomAspect] = useState(() => aspectChoiceLabel(draft.aspect) === null)
  const presetId = matchingPresetId(draft)
  const aspectLabel = aspectChoiceLabel(draft.aspect)
  const showCustomAspect = customAspect || aspectLabel === null
  // QUAL-1's defaults, for the inherit options' labels. `undefined` before settings load.
  const streams = useAppStore((s) => s.settings?.streams)

  const resize = (cols: number, rows: number): void => {
    const result = resizeGrid(draft, cols, rows)
    if (result.ok) onLayout(result.view, resizeDropsCameras(draft, cols, rows))
    else onError(result.reason)
  }

  return (
    <div className="viewEditor__settings">
      <fieldset className="viewEditor__group">
        <legend className="viewEditor__groupTitle">Grid</legend>
        <label className="viewEditor__setting">
          <span className="field__label">Layout</span>
          <select
            className="field__input"
            value={presetId ?? CUSTOM}
            onChange={(event) => {
              const preset = LAYOUT_PRESETS.find((p) => p.id === event.target.value)
              if (preset === undefined) return
              const result = applyPreset(draft, preset)
              onLayout(result.view, result.dropped)
            }}
          >
            {presetId === null ? (
              <option value={CUSTOM} disabled>
                Custom
              </option>
            ) : null}
            {LAYOUT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="viewEditor__setting">
          <span className="field__label">Columns</span>
          <select
            className="field__input"
            value={draft.cols}
            onChange={(event) => {
              resize(Number(event.target.value), draft.rows)
            }}
          >
            {GRID_SIZES.map((n) => (
              <option key={n} value={n}>
                {String(n)}
              </option>
            ))}
          </select>
        </label>

        <label className="viewEditor__setting">
          <span className="field__label">Rows</span>
          <select
            className="field__input"
            value={draft.rows}
            onChange={(event) => {
              resize(draft.cols, Number(event.target.value))
            }}
          >
            {GRID_SIZES.map((n) => (
              <option key={n} value={n}>
                {String(n)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="viewEditor__group">
        <legend className="viewEditor__groupTitle">Display</legend>
        <div className="viewEditor__setting">
          <label className="field__label" htmlFor={aspectId}>
            Aspect
          </label>
          <div className="row">
            <select
              id={aspectId}
              className="field__input"
              value={showCustomAspect ? CUSTOM : aspectLabel}
              onChange={(event) => {
                const choice = ASPECT_CHOICES.find((c) => c.label === event.target.value)
                if (choice === undefined) {
                  setCustomAspect(true)
                  return
                }
                setCustomAspect(false)
                onEdit({ ...draft, aspect: { ...choice.aspect } })
              }}
            >
              {ASPECT_CHOICES.map((choice) => (
                <option key={choice.label} value={choice.label}>
                  {choice.label}
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
            {showCustomAspect ? (
              <>
                <BoundedNumberInput
                  className="viewEditor__number"
                  label="Aspect width"
                  value={draft.aspect.w}
                  min={1}
                  max={MAX_ASPECT_TERM}
                  onChange={(w) => {
                    setCustomAspect(true)
                    onEdit({ ...draft, aspect: { ...draft.aspect, w } })
                  }}
                />
                <span aria-hidden="true">:</span>
                <BoundedNumberInput
                  className="viewEditor__number"
                  label="Aspect height"
                  value={draft.aspect.h}
                  min={1}
                  max={MAX_ASPECT_TERM}
                  onChange={(h) => {
                    setCustomAspect(true)
                    onEdit({ ...draft, aspect: { ...draft.aspect, h } })
                  }}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="viewEditor__setting">
          <label className="field__label" htmlFor={gapId}>
            Gap (px)
          </label>
          <div className="row">
            <input
              id={gapId}
              type="range"
              min={0}
              max={MAX_GRID_GAP}
              step={1}
              value={draft.gap}
              onChange={(event) => {
                onEdit({ ...draft, gap: Number(event.target.value) })
              }}
            />
            <BoundedNumberInput
              className="viewEditor__number"
              label="Gap in pixels"
              value={draft.gap}
              min={0}
              max={MAX_GRID_GAP}
              onChange={(gap) => {
                onEdit({ ...draft, gap })
              }}
            />
          </div>
        </div>

        <label className="viewEditor__setting">
          <span className="field__label">Fit</span>
          <select
            className="field__input"
            value={draft.fit}
            onChange={(event) => {
              const fit = FitSchema.safeParse(event.target.value)
              if (fit.success) onEdit({ ...draft, fit: fit.data })
            }}
          >
            <option value="contain">Contain (whole picture)</option>
            <option value="cover">Cover (fill the cell)</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="viewEditor__group">
        <legend className="viewEditor__groupTitle">Quality</legend>
        <label className="viewEditor__setting">
          <span className="field__label">Grid quality</span>
          <select
            className="field__input"
            value={qualityOptionValue(draft.gridQuality)}
            onChange={(event) => {
              onEdit({ ...draft, gridQuality: parseQualityOption(event.target.value) })
            }}
          >
            <QualityOptions
              inheritLabel={inheritOptionLabel('App default', streams?.defaultGridQuality)}
            />
          </select>
        </label>

        <label className="viewEditor__setting">
          <span className="field__label">Fill quality</span>
          <select
            className="field__input"
            value={qualityOptionValue(draft.fillQuality)}
            onChange={(event) => {
              onEdit({ ...draft, fillQuality: parseQualityOption(event.target.value) })
            }}
          >
            <QualityOptions
              inheritLabel={inheritOptionLabel('App default', streams?.defaultFillQuality)}
            />
          </select>
        </label>
      </fieldset>
    </div>
  )
}
