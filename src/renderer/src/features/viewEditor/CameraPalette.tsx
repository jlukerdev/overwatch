// The View editor's camera palette (P3.3; VIEW-3): every camera on the console, plus each
// doorbell's package channel (CAM-4), in the camera list's order (`cameraChoices`, ./editorModel).
// Each entry is a native HTML5 drag source carrying its camera ref as `CAMERA_DRAG_TYPE`; dropping
// it on a canvas cell makes that cell show that camera alone (`dropCameraOnCell`). The keyboard way
// to do the same is the cell inspector's "Add camera" picker.
//
// An entry whose exact ref heads at least one cell of the draft is marked with a green check (P5.2, VIEW-3;
// `inUseRefs`), with its label a little quieter. It stays draggable: one camera may head several
// cells.
//
// Each entry starts with a small 16:9 thumbnail (UX polish 2026-11-17, VIEW-3): the camera's cached
// snapshot when the shared cache has one (`paletteSnapshots`, ./editorThumbnails — the palette
// itself fetches nothing), else a camera icon on a tile — always the icon in RTSP mode, which has no
// snapshots (RTSP-4). It never takes the pointer, so a drag
// started on the picture drags the entry.
//
// The panel sits under the side panel's tabs, whichever is open, and its list scrolls on its own.
// While the draft has no camera in any cell the hint says so, in the foreground colour, so a new
// View's first step is spelled out.
import type { JSX } from 'react'
import { SnapshotImage } from '../../ui/SnapshotImage'
import { CameraIcon, CheckIcon, InfoIcon } from '../../ui/icons'
import type { CameraChoice } from './editorModel'
import type { ReadySnapshot } from './editorThumbnails'
import { CAMERA_DRAG_TYPE } from './viewEditorHelpers'

export interface CameraPaletteProps {
  /** `cameraChoices(cameras)`, computed once by the editor and shared with the inspector. */
  readonly choices: readonly CameraChoice[]
  /** `inUseRefs(draft.cells)`: ref → how many cells it heads. Absent means not in use. */
  readonly inUse: ReadonlyMap<string, number>
  /** `paletteSnapshots(...)`: ref → its cached image. Absent means the icon tile. */
  readonly snapshots: ReadonlyMap<string, ReadySnapshot>
  /** RTSP mode (MODE-3): the empty hint points to the Streams screen rather than the console. */
  readonly rtsp: boolean
}

/** "In use in 1 cell", "In use in 3 cells". */
function inUseText(count: number): string {
  return `In use in ${String(count)} ${count === 1 ? 'cell' : 'cells'}`
}

export function CameraPalette({
  choices,
  inUse,
  snapshots,
  rtsp,
}: CameraPaletteProps): JSX.Element {
  return (
    <section className="viewEditor__panel viewEditor__palettePanel" aria-label="Cameras">
      <h3 className="viewEditor__panelTitle">Cameras</h3>
      {choices.length === 0 ? (
        <p className="viewEditor__hint">
          {rtsp
            ? 'No streams yet. Add one on the Streams screen.'
            : 'No cameras yet. Connect to the console from the Cameras screen.'}
        </p>
      ) : (
        <>
          {inUse.size === 0 ? (
            <p className="status viewEditor__paletteStart">
              <InfoIcon />
              <span>This View has no cameras yet. Drag one onto a cell to place it.</span>
            </p>
          ) : (
            <p className="viewEditor__hint">Drag a camera onto a cell.</p>
          )}
          <ul className="viewEditor__palette">
            {choices.map((choice) => {
              const count = inUse.get(choice.ref) ?? 0
              const image = snapshots.get(choice.ref)
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
                  <span className="viewEditor__paletteThumb" aria-hidden="true">
                    {image === undefined ? (
                      <CameraIcon />
                    ) : (
                      <SnapshotImage
                        className="viewEditor__paletteImage"
                        bytes={image.bytes}
                        mimeType={image.mimeType}
                      />
                    )}
                  </span>
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
