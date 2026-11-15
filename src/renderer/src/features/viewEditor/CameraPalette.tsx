// The View editor's camera palette (P3.3; VIEW-3): every camera on the console, plus each
// doorbell's package channel (CAM-4), in the camera list's order (`cameraChoices`, ./editorModel).
// Each entry is a native HTML5 drag source carrying its camera ref as `CAMERA_DRAG_TYPE`; dropping
// it on a canvas cell makes that cell show that camera alone (`dropCameraOnCell`). The keyboard way
// to do the same is the cell inspector's "Add camera" picker.
import type { JSX } from 'react'
import type { CameraChoice } from './editorModel'
import { CAMERA_DRAG_TYPE } from './viewEditorHelpers'

export interface CameraPaletteProps {
  /** `cameraChoices(cameras)`, computed once by the editor and shared with the inspector. */
  readonly choices: readonly CameraChoice[]
}

export function CameraPalette({ choices }: CameraPaletteProps): JSX.Element {
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
            {choices.map((choice) => (
              <li
                key={choice.ref}
                className="viewEditor__paletteItem"
                draggable
                title={choice.label}
                onDragStart={(event) => {
                  event.dataTransfer.setData(CAMERA_DRAG_TYPE, choice.ref)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                {choice.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
