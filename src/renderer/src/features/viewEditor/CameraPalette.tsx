// The View editor's camera palette (P3.3; VIEW-3): every camera on the console, plus each
// doorbell's package channel (CAM-4), in the camera list's order (`cameraChoices`, ./editorModel).
// Each entry is a native HTML5 drag source carrying its camera ref as `CAMERA_DRAG_TYPE`; dropping
// it on a canvas cell makes that cell show that camera alone (`dropCameraOnCell`). The keyboard way
// to do the same is the cell inspector's "Add camera" picker.
//
// An entry whose exact ref heads at least one cell of the draft is marked with a green check (P5.2, VIEW-3;
// `inUseRefs`), with its label a little quieter. It stays draggable: one camera may head several
// cells.
import type { JSX } from 'react'
import type { CameraChoice } from './editorModel'
import { CheckIcon } from '../../ui/icons'
import { CAMERA_DRAG_TYPE } from './viewEditorHelpers'

export interface CameraPaletteProps {
  /** `cameraChoices(cameras)`, computed once by the editor and shared with the inspector. */
  readonly choices: readonly CameraChoice[]
  /** `inUseRefs(draft.cells)`: ref → how many cells it heads. Absent means not in use. */
  readonly inUse: ReadonlyMap<string, number>
}

/** "In use in 1 cell", "In use in 3 cells". */
function inUseText(count: number): string {
  return `In use in ${String(count)} ${count === 1 ? 'cell' : 'cells'}`
}

export function CameraPalette({ choices, inUse }: CameraPaletteProps): JSX.Element {
  return (
    <section className="viewEditor__panel" aria-label="Cameras">
      <h3 className="viewEditor__panelTitle">Cameras</h3>
      {choices.length === 0 ? (
        <p className="viewEditor__hint">
          No cameras yet. Connect to the console from the Cameras screen.
        </p>
      ) : (
        <>
          <p className="viewEditor__hint">Drag a camera onto a cell.</p>
          <ul className="viewEditor__palette">
            {choices.map((choice) => {
              const count = inUse.get(choice.ref) ?? 0
              return (
                <li
                  key={choice.ref}
                  className={
                    count > 0
                      ? 'viewEditor__paletteItem viewEditor__paletteItem--inUse'
                      : 'viewEditor__paletteItem'
                  }
                  draggable
                  title={count > 0 ? `${choice.label} — ${inUseText(count)}` : choice.label}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(CAMERA_DRAG_TYPE, choice.ref)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="viewEditor__paletteLabel">{choice.label}</span>
                  {count > 0 ? (
                    <span className="viewEditor__inUse" role="img" aria-label={inUseText(count)}>
                      <CheckIcon />
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
