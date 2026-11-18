// A cell's camera ref (CAM-4): `<cameraId>` for a camera, `<cameraId>:package` for a doorbell's
// package channel. One grammar for both processes: the renderer splits refs to find streams and
// door links, and main splits the ref the unlock control sends to find the door (P5.4, DOOR-2/4).
// Pure, no Node or Electron imports.
import { PACKAGE_CHANNEL } from './quality'

/** What a `cameraIds` entry points at: a camera, or a doorbell's package channel. */
export interface CameraRef {
  /** The Protect camera id — the one the inventory and `ensureStream` know. */
  readonly cameraId: string
  /** `true` for `<cameraId>:package` (CAM-4): play the camera's {@link PACKAGE_CHANNEL} stream. */
  readonly packageChannel: boolean
}

export const PACKAGE_SUFFIX = `:${PACKAGE_CHANNEL}`

/** The ref of a camera's package channel (CAM-4): `<cameraId>:package`, as `parseCameraRef` reads it. */
export function packageRef(cameraId: string): string {
  return `${cameraId}${PACKAGE_SUFFIX}`
}

/**
 * Splits a cell's camera ref. Only the exact suffix `:package` with a non-empty id before it is the
 * package channel; anything else is a plain camera id, passed through as is (Protect ids are hex and
 * never contain a colon, so nothing real is misread). `':package'` alone is a plain id.
 */
export function parseCameraRef(ref: string): CameraRef {
  if (ref.length > PACKAGE_SUFFIX.length && ref.endsWith(PACKAGE_SUFFIX)) {
    return { cameraId: ref.slice(0, -PACKAGE_SUFFIX.length), packageChannel: true }
  }
  return { cameraId: ref, packageChannel: false }
}
