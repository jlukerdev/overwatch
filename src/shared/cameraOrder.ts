// How a camera is named and the order the camera list shows them in (P1.7, CAM-1). Pure functions
// over plain data, shared by the renderer (`state/camerasStore.ts` re-exports them) and main, where
// the P3.2 perf harness fills its View with "the first N cameras in list order" — which has to be
// the order the user sees, or a run on a console with more cameras than slots would measure a
// different set of cameras than the list suggests. One definition, so the two cannot drift.
//
// Imports only a type from ./models, so it pulls nothing into either bundle.
import type { Camera } from './models'

/**
 * CAM-1's fallback chain: Protect's `name`, then the model (`type`), then the id. The id is never
 * pretty, but a row the user cannot identify at all is worse than an ugly one — and a camera that
 * is missing from the list is worse still.
 */
export function cameraDisplayName(camera: Camera): string {
  const name = camera.name?.trim() ?? ''
  if (name !== '') return name
  const model = camera.model.trim()
  if (model !== '') return model
  return camera.id
}

/**
 * Display order: by display name, case-insensitively, numbers compared as numbers (`Cam 10` after
 * `Cam 2`), and **ties keep their inventory order** — `Array.prototype.sort` is stable, so two
 * cameras with the same name never swap places between renders.
 *
 * Offline cameras are deliberately *not* grouped or pushed to the end. Being offline is a state,
 * not a position: a camera that drops off for a minute would otherwise jump to the bottom and back,
 * and the row the user is watching during the G1 unplug test has to stay where it is.
 */
export function sortCameras(cameras: readonly Camera[]): Camera[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...cameras].sort((a, b) => collator.compare(cameraDisplayName(a), cameraDisplayName(b)))
}
