// Which door a cell's unlock control would open, when the control shows (P5.4; DOOR-0/2/3), and
// when the Live screen asks main to watch the doors' lock state (P5.5; DOOR-6). Pure, so the rules
// are tested in the node environment; `<UnlockButton>` and `useDoorWatch` only read the store and
// ask these.
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
//
// **Watching (DOOR-6).** {@link shouldWatchDoors} is wider than "a control is on screen right now"
// on purpose: it counts every camera in the active View's cells, not only the ones rotated in and
// streaming, so a rotation step or a reconnecting player does not stop and restart main's monitor.
// What the button then draws from the watched state is ./doorState.
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

export interface DoorWatchInput {
  /** Access is saved as on (`settings.console.accessEnabled`, DOOR-0). */
  readonly accessEnabled: boolean
  /** The saved camera → door links (`settings.doorLinks`). */
  readonly doorLinks: Readonly<DoorLinks> | null | undefined
  /** Every camera ref of the active View's cells, each cell's whole list (see {@link viewCameraRefs}). */
  readonly viewCameraRefs: readonly string[]
}

/**
 * DOOR-6: whether the Live screen asks main to watch the linked doors. True when Access is saved as
 * on and at least one camera of the active View has a door link by {@link doorForCell}'s rule (so a
 * package ref counts through its doorbell).
 */
export function shouldWatchDoors({
  accessEnabled,
  doorLinks,
  viewCameraRefs,
}: DoorWatchInput): boolean {
  if (!accessEnabled) return false
  return viewCameraRefs.some((ref) => doorForCell(ref, doorLinks, accessEnabled) !== null)
}

/** Every camera ref a View can show: each cell's whole list, not just the camera rotated in. */
export function viewCameraRefs(
  view: { readonly cells: readonly { readonly cameraIds: readonly string[] }[] } | null,
): string[] {
  return view === null ? [] : view.cells.flatMap((cell) => cell.cameraIds)
}
