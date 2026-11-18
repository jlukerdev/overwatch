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
 * The one collator every list in the app sorts by: case-insensitive, numbers compared as numbers
 * (`Cam 10` after `Cam 2`). Module-level, because building an `Intl.Collator` is not free and a
 * list re-sorts on every render that changes it.
 */
const LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * `items` sorted by `label(item)` with {@link LABEL_COLLATOR}. A new array; **ties keep their input
 * order** (`Array.prototype.sort` is stable), so two items with the same label never swap places
 * between renders. Shared by the camera list and the door-link card's doors (P5.3), so the two
 * lists in Settings order the same way.
 */
export function sortByLabel<T>(items: readonly T[], label: (item: T) => string): T[] {
  return [...items].sort((a, b) => LABEL_COLLATOR.compare(label(a), label(b)))
}

/**
 * Display order: by display name, through {@link sortByLabel} — case-insensitively, numbers as
 * numbers, and **ties keep their inventory order**.
 *
 * Offline cameras are deliberately *not* grouped or pushed to the end. Being offline is a state,
 * not a position: a camera that drops off for a minute would otherwise jump to the bottom and back,
 * and the row the user is watching during the G1 unplug test has to stay where it is.
 */
export function sortCameras(cameras: readonly Camera[]): Camera[] {
  return sortByLabel(cameras, cameraDisplayName)
}
