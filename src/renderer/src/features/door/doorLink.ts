// Which door a cell's unlock control would open, and when the control shows (P5.4; DOOR-0/2/3).
// Pure, so the rule is tested in the node environment; `<UnlockButton>` only reads the store and
// asks these.
//
//  - **Access saved as on** (`settings.console.accessEnabled`, DOOR-0). The unsaved Settings checkbox
//    reveals nothing.
//  - **A link for the cell's camera** (`settings.doorLinks`, DOOR-2). A doorbell's package channel
//    (`<id>:package`, CAM-4) has no entry of its own: it shares the doorbell's link. This is only
//    what the renderer *shows*; main resolves the door again from the same ref when the unlock is
//    sent, and the renderer never sends a door id (DOOR-4).
//  - **The camera connected and its picture playing.** An unlock you cannot watch is not offered: no
//    button over "Connecting…", "Offline" or an error placeholder (the same "connected" signal as the
//    mute toggle, AUD-1, plus the player actually showing video).
import type { DoorLinks } from '@shared/models'
import { parseCameraRef } from '@shared/cameraRef'

/** The door linked to the camera behind `cameraRef`, or `null` when there is none or Access is off. */
export function doorForCell(
  cameraRef: string,
  doorLinks: Readonly<DoorLinks> | null | undefined,
  accessEnabled: boolean,
): string | null {
  if (!accessEnabled || doorLinks === null || doorLinks === undefined) return null
  const { cameraId } = parseCameraRef(cameraRef)
  // `Object.hasOwn`: a camera id such as `constructor` must not find a prototype member.
  if (!Object.hasOwn(doorLinks, cameraId)) return null
  const doorId = doorLinks[cameraId]
  return typeof doorId === 'string' && doorId !== '' ? doorId : null
}

export interface UnlockAvailability {
  /** {@link doorForCell}'s answer. */
  readonly doorId: string | null
  /** The camera's inventory state is connected (CAM-3, `isCameraOnline`). */
  readonly connected: boolean
  /** The cell's visible player is showing live video (no placeholder). */
  readonly streaming: boolean
}

/** Whether the cell offers its unlock control now (header). */
export function unlockAvailable({ doorId, connected, streaming }: UnlockAvailability): boolean {
  return doorId !== null && connected && streaming
}
