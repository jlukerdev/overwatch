// The View editor's cell inspector (P3.3; VIEW-2, VIEW-3): the cameras of the one selected cell, in
// order, with ▲/▼ to reorder, a remove button each, and an "Add camera" picker — the keyboard way to
// assign cameras, beside the palette's drag-and-drop. It is the side panel's **Cell** tab, under
// the selection's actions (./CellActions, F1.0.2-2); the tab names it, so the hint shown when the
// selection is not exactly one cell has no heading of its own.
//
// Every edit is a call into ./editorModel (`addCellCamera`, `removeCellCamera`, `moveCellCamera`)
// made by the editor; this component only says which one. A cell holds several cameras already
// (VIEW-2); with two or more, what the Live grid does with them depends on the cell's CELL-2
// settings (P4.2) — it rotates only with a `rotateIntervalSec`, and switches on events only with
// `motionSwitch` on, otherwise it stays on the first camera — so the note under the list
// (`multiCameraHint`, ./editorModel) says which of those this cell will do.
//
// Below the cameras, the cell's quality override (P3.7; QUAL-3): "View default (X)" — X being what
// the View and the app defaults give the cell now — then the qualities. It edits the draft's
// `quality` (`setCellQuality`), saved with the rest; the overlay's picker on the Live screen
// (QUAL-4) edits the same field directly.
//
// With two or more cameras, a "Multi-camera" group between the two edits the cell's CELL-2 settings
// (P4.2): Rotate (off, or every N s from 5), Switch on events, and — while that is on — which
// triggers count, the smart-detection type filter and the hold. The filter offers the types the
// cell's cameras report, plus any the cell already stores (`smartDetectFilterChoices`; none checked
// = any type; a type it has no label for, from a newer console, is listed under its own name and
// kept). Unticking Rotate removes the interval, as the schema has it; the inspector remembers it for
// the selected cell, so ticking Rotate again restores it (10 s when there is none). The group is
// hidden for fewer cameras, where none of it does anything; the settings stay in the cell. Each
// control is one `setCell…` edit (./editorModel), saved with the draft like the quality.
//
// **RTSP streams mode has no events** (RTSP-4): no motion, smart detection or ring. There
// (`events` false) the group shows Rotate alone — Switch on events, its triggers, the type filter
// and the hold are not drawn — and the note under the list speaks of rotation only. The cell's
// stored event settings are left exactly as they are, unused, for nothing here edits them.
import { useId, useState, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import {
  MIN_ROTATE_INTERVAL_SEC,
  MOTION_TRIGGERS,
  type Cell,
  type MotionTrigger,
} from '@shared/models'
import type { Quality } from '@shared/quality'
import {
  inheritOptionLabel,
  parseQualityOption,
  qualityOptionValue,
} from '../quality/qualityChoice'
import { QualityOptions } from '../quality/QualityOptions'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '../../ui/icons'
import { BoundedNumberInput } from './BoundedNumberInput'
import {
  cameraRefLabel,
  cellCameraSmartDetectTypes,
  multiCameraHint,
  DEFAULT_ROTATE_INTERVAL_SEC,
  MAX_MOTION_HOLD_SEC,
  MAX_ROTATE_INTERVAL_SEC,
  MOTION_TRIGGER_LABELS,
  smartDetectFilterChoices,
  smartDetectTypeLabel,
  toggleMotionTrigger,
  toggleSmartDetectType,
  type CameraChoice,
} from './editorModel'

export interface CellInspectorProps {
  /** The selected cell, or `null` when the selection is not exactly one cell. */
  readonly cell: Cell | null
  /** How many cells the selection holds (for the hint when it is not one). */
  readonly selectedCount: number
  readonly cameras: readonly Camera[]
  /** `cameraChoices(cameras)`, computed once by the editor and shared with the palette. */
  readonly choices: readonly CameraChoice[]
  readonly onAdd: (ref: string) => void
  readonly onRemove: (position: number) => void
  readonly onMove: (position: number, delta: -1 | 1) => void
  /**
   * What the cell plays with its override cleared (the draft's `gridQuality`, else the app default),
   * for the "View default (X)" option; `null` before settings load.
   */
  readonly viewDefaultQuality: Quality | null
  /** A new quality override for the cell; `null` clears it. */
  readonly onQualityChange: (quality: Quality | null) => void
  /** CELL-2: a new rotate interval in seconds; `undefined` turns rotation off. */
  readonly onRotateChange: (sec: number | undefined) => void
  readonly onMotionSwitchChange: (on: boolean) => void
  readonly onMotionTriggersChange: (triggers: readonly MotionTrigger[]) => void
  /** The whole filter; empty means no filter. */
  readonly onSmartDetectTypesChange: (types: readonly string[]) => void
  readonly onMotionHoldChange: (sec: number) => void
  /**
   * Whether the app has camera events: Protect mode. `false` in RTSP streams mode hides Switch on
   * events and everything under it (header).
   */
  readonly events: boolean
}

export function CellInspector({
  cell,
  selectedCount,
  cameras,
  choices,
  onAdd,
  onRemove,
  onMove,
  viewDefaultQuality,
  onQualityChange,
  onRotateChange,
  onMotionSwitchChange,
  onMotionTriggersChange,
  onSmartDetectTypesChange,
  onMotionHoldChange,
  events,
}: CellInspectorProps): JSX.Element {
  const qualityId = useId()
  const fieldId = useId()
  // The interval Rotate had when it was last unticked, for the cell it belongs to (header).
  const [lastRotate, setLastRotate] = useState<{ cell: string; sec: number } | null>(null)
  if (cell === null) {
    return (
      <section className="viewEditor__panel" aria-label="Cell">
        <p className="viewEditor__hint">
          {selectedCount === 0
            ? 'Select a cell on the canvas to edit it.'
            : 'Select one cell to edit its cameras and settings.'}
        </p>
      </section>
    )
  }

  const present = new Set(cell.cameraIds)
  const addable = choices.filter((choice) => !present.has(choice.ref))
  const last = cell.cameraIds.length - 1
  const cellKey = `${String(cell.col)},${String(cell.row)},${String(cell.colSpan)}x${String(cell.rowSpan)}`

  return (
    <section className="viewEditor__panel" aria-label="Cell">
      <h3 className="viewEditor__panelTitle">
        Cell {String(cell.col + 1)},{String(cell.row + 1)}
        {cell.colSpan > 1 || cell.rowSpan > 1
          ? ` (${String(cell.colSpan)}×${String(cell.rowSpan)})`
          : ''}
      </h3>
      {cell.cameraIds.length === 0 ? (
        <p className="viewEditor__hint">
          This cell has no cameras yet. Drag one onto it, or add one below.
        </p>
      ) : (
        <ol className="viewEditor__cameraList">
          {cell.cameraIds.map((ref, position) => {
            const label = cameraRefLabel(ref, cameras)
            return (
              // Keyed by position too: a stored View's list may hold the same ref twice.
              <li key={`${ref}-${String(position)}`} className="viewEditor__cameraRow">
                <span className="viewEditor__cameraName" title={label}>
                  {label}
                </span>
                <button
                  type="button"
                  className="button button--icon button--ghost button--sm"
                  aria-label={`Move ${label} up`}
                  title={`Move ${label} up`}
                  disabled={position === 0}
                  onClick={() => {
                    onMove(position, -1)
                  }}
                >
                  <ChevronUpIcon />
                </button>
                <button
                  type="button"
                  className="button button--icon button--ghost button--sm"
                  aria-label={`Move ${label} down`}
                  title={`Move ${label} down`}
                  disabled={position === last}
                  onClick={() => {
                    onMove(position, 1)
                  }}
                >
                  <ChevronDownIcon />
                </button>
                <button
                  type="button"
                  className="button button--icon button--ghost button--danger button--sm"
                  aria-label={`Remove ${label}`}
                  title={`Remove ${label}`}
                  onClick={() => {
                    onRemove(position)
                  }}
                >
                  <XIcon />
                </button>
              </li>
            )
          })}
        </ol>
      )}
      <select
        className="field__input viewEditor__addCamera"
        aria-label="Add camera"
        value=""
        disabled={addable.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onAdd(event.target.value)
        }}
      >
        <option value="">{addable.length === 0 ? 'No more cameras' : 'Add camera…'}</option>
        {addable.map((choice) => (
          <option key={choice.ref} value={choice.ref}>
            {choice.label}
          </option>
        ))}
      </select>
      <p className="viewEditor__hint">{multiCameraHint(cell, events)}</p>
      {cell.cameraIds.length >= 2 ? (
        <MultiCameraSettings
          cell={cell}
          idPrefix={fieldId}
          smartDetectChoices={smartDetectFilterChoices(
            cellCameraSmartDetectTypes(cell.cameraIds, cameras),
            cell.smartDetectTypes,
          )}
          rotateRestoreSec={
            lastRotate?.cell === cellKey ? lastRotate.sec : DEFAULT_ROTATE_INTERVAL_SEC
          }
          onRotateOff={(sec) => {
            setLastRotate({ cell: cellKey, sec })
            onRotateChange(undefined)
          }}
          onRotateChange={onRotateChange}
          onMotionSwitchChange={onMotionSwitchChange}
          onMotionTriggersChange={onMotionTriggersChange}
          onSmartDetectTypesChange={onSmartDetectTypesChange}
          onMotionHoldChange={onMotionHoldChange}
          events={events}
        />
      ) : null}
      <label className="field__label" htmlFor={qualityId}>
        Quality
      </label>
      <select
        id={qualityId}
        className="field__input"
        value={qualityOptionValue(cell.quality)}
        onChange={(event) => {
          onQualityChange(parseQualityOption(event.target.value))
        }}
      >
        <QualityOptions inheritLabel={inheritOptionLabel('View default', viewDefaultQuality)} />
      </select>
    </section>
  )
}

type MultiCameraSettingsProps = Pick<
  CellInspectorProps,
  | 'onRotateChange'
  | 'onMotionSwitchChange'
  | 'onMotionTriggersChange'
  | 'onSmartDetectTypesChange'
  | 'onMotionHoldChange'
  | 'events'
> & {
  readonly cell: Cell
  /** A `useId` value; each control's id is this plus a suffix. */
  readonly idPrefix: string
  /** The filter's checkboxes, `smartDetectFilterChoices` order. */
  readonly smartDetectChoices: readonly string[]
  /** What ticking Rotate sets the interval to: the cell's last one, else the default. */
  readonly rotateRestoreSec: number
  /** Unticking Rotate, with the interval it had, for the inspector to remember. */
  readonly onRotateOff: (sec: number) => void
}

/** The CELL-2 group, for a cell with two or more cameras (header). */
function MultiCameraSettings({
  cell,
  idPrefix,
  smartDetectChoices,
  rotateRestoreSec,
  onRotateOff,
  onRotateChange,
  onMotionSwitchChange,
  onMotionTriggersChange,
  onSmartDetectTypesChange,
  onMotionHoldChange,
  events,
}: MultiCameraSettingsProps): JSX.Element {
  const rotateSec = cell.rotateIntervalSec

  return (
    <fieldset className="viewEditor__group">
      <legend className="viewEditor__groupTitle">Multi-camera</legend>

      <div className="viewEditor__checkRow">
        <input
          id={`${idPrefix}-rotate`}
          type="checkbox"
          checked={rotateSec !== undefined}
          onChange={(event) => {
            if (event.target.checked) onRotateChange(rotateRestoreSec)
            else if (rotateSec !== undefined) onRotateOff(rotateSec)
          }}
        />
        <label htmlFor={`${idPrefix}-rotate`}>Rotate every</label>
        {rotateSec !== undefined ? (
          <>
            <BoundedNumberInput
              className="viewEditor__number"
              label="Rotate interval, in seconds"
              value={rotateSec}
              min={MIN_ROTATE_INTERVAL_SEC}
              max={MAX_ROTATE_INTERVAL_SEC}
              onChange={onRotateChange}
            />
            <span aria-hidden="true">s</span>
          </>
        ) : null}
      </div>

      {events ? (
        <EventSwitchSettings
          cell={cell}
          idPrefix={idPrefix}
          smartDetectChoices={smartDetectChoices}
          onMotionSwitchChange={onMotionSwitchChange}
          onMotionTriggersChange={onMotionTriggersChange}
          onSmartDetectTypesChange={onSmartDetectTypesChange}
          onMotionHoldChange={onMotionHoldChange}
        />
      ) : null}
    </fieldset>
  )
}

/** Switch on events and what hangs off it (CELL-2); Protect mode only (header). */
function EventSwitchSettings({
  cell,
  idPrefix,
  smartDetectChoices,
  onMotionSwitchChange,
  onMotionTriggersChange,
  onSmartDetectTypesChange,
  onMotionHoldChange,
}: Pick<
  MultiCameraSettingsProps,
  | 'cell'
  | 'idPrefix'
  | 'smartDetectChoices'
  | 'onMotionSwitchChange'
  | 'onMotionTriggersChange'
  | 'onSmartDetectTypesChange'
  | 'onMotionHoldChange'
>): JSX.Element {
  const types = cell.smartDetectTypes ?? []
  const smartOn = cell.motionTriggers.includes('smartDetect')
  return (
    <>
      <div className="viewEditor__checkRow">
        <input
          id={`${idPrefix}-switch`}
          type="checkbox"
          checked={cell.motionSwitch}
          onChange={(event) => {
            onMotionSwitchChange(event.target.checked)
          }}
        />
        <label htmlFor={`${idPrefix}-switch`}>Switch on events</label>
      </div>

      {cell.motionSwitch ? (
        <>
          <fieldset className="viewEditor__subgroup">
            <legend className="field__label">Triggers</legend>
            {MOTION_TRIGGERS.map((trigger) => (
              <div key={trigger} className="viewEditor__checkRow">
                <input
                  id={`${idPrefix}-trigger-${trigger}`}
                  type="checkbox"
                  checked={cell.motionTriggers.includes(trigger)}
                  onChange={(event) => {
                    onMotionTriggersChange(
                      toggleMotionTrigger(cell.motionTriggers, trigger, event.target.checked),
                    )
                  }}
                />
                <label htmlFor={`${idPrefix}-trigger-${trigger}`}>
                  {MOTION_TRIGGER_LABELS[trigger]}
                </label>
              </div>
            ))}
            {cell.motionTriggers.length === 0 ? (
              <p className="viewEditor__hint">
                No trigger is checked, so no event switches the cell.
              </p>
            ) : null}
          </fieldset>

          {smartOn ? (
            <fieldset className="viewEditor__subgroup">
              <legend className="field__label">Smart detection types</legend>
              <p className="viewEditor__hint">Leave them all unchecked to switch on any type.</p>
              {smartDetectChoices.map((type, i) => (
                <div key={type} className="viewEditor__checkRow">
                  <input
                    id={`${idPrefix}-type-${String(i)}`}
                    type="checkbox"
                    checked={types.includes(type)}
                    onChange={(event) => {
                      onSmartDetectTypesChange(
                        toggleSmartDetectType(cell.smartDetectTypes, type, event.target.checked),
                      )
                    }}
                  />
                  <label htmlFor={`${idPrefix}-type-${String(i)}`}>
                    {smartDetectTypeLabel(type)}
                  </label>
                </div>
              ))}
            </fieldset>
          ) : null}

          <div className="viewEditor__inlineRow">
            <label htmlFor={`${idPrefix}-hold`}>Hold after the event ends</label>
            <BoundedNumberInput
              id={`${idPrefix}-hold`}
              className="viewEditor__number"
              value={cell.motionHoldSec}
              min={0}
              max={MAX_MOTION_HOLD_SEC}
              onChange={onMotionHoldChange}
            />
            <span aria-hidden="true">s</span>
          </div>
        </>
      ) : null}
    </>
  )
}
