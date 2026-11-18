// AUD-1's audio predicates (P5.1): which cameras are audio sources, and which can be heard now.
// Pure and store-free, so the camera list (state/camerasStore.ts), the grid's slot builder
// (features/grid/gridLayout.ts) and the audio controller (state/audioStore.ts) share one rule
// without the slot builder importing a module that creates a store.
//
//  - **{@link cameraHasAudio}: the camera is an audio source** — it has a microphone
//    (`featureFlags.hasMic`) *and* it is switched on (`isMicEnabled`). This is what the camera list's
//    Audio badge means (CAM-1): mic-capable, online or not.
//  - **{@link cameraCanBeHeard}: …and it is connected now** (CAM-3's `state === 'CONNECTED'`). This is
//    what shows a cell's mute toggle (user decision, 2026-11-16): an offline or connecting camera
//    plays nothing, so it has no toggle, and a heard camera that drops is muted (the controller
//    drops a source whose slot can no longer be heard, state/audioStore.ts).
import { isCameraOnline } from '@shared/models'

/** The parts of a camera the predicates read (`Camera`, @shared/ipc, fits it). */
export interface CameraAudioFlags {
  readonly hasMic: boolean
  readonly micEnabled: boolean
  readonly state: string
}

/** AUD-1 / CAM-1: a mic, switched on. A camera the inventory does not have is not a source. */
export function cameraHasAudio(
  camera: Pick<CameraAudioFlags, 'hasMic' | 'micEnabled'> | undefined,
): boolean {
  return camera !== undefined && camera.hasMic && camera.micEnabled
}

/** AUD-1: an audio source that is connected now, i.e. one a cell offers to unmute (header). */
export function cameraCanBeHeard(camera: CameraAudioFlags | undefined): boolean {
  return camera !== undefined && cameraHasAudio(camera) && isCameraOnline(camera.state)
}
