// Settings' door-link card (P5.3; DOOR-1, DOOR-2), as pure functions over plain data.
//
// The card is three inputs — the camera inventory, the stored camera → door map and wherever the
// door list read has got to — and one output: the rows it draws. Everything that can be *wrong*
// about that mapping lives here rather than in the component, for the same reason as
// ./settingsForm.ts: the project has no jsdom, so a rule inside an onChange is a rule no test can
// reach.
//
// Three rules this module keeps:
//
//  1. **A stored link is never pruned.** A door list that failed, is still loading, came back empty
//     or simply does not have a door any more must not cost the user a link: the row stays, shows
//     what is known about the door ("Unknown door", or just its id while the list is not in), and
//     only an explicit unlink removes it. The same for a link whose camera is not in the inventory
//     (not connected yet, or the camera was removed): it gets its own row with an Unlink button.
//  2. **One row per camera id.** The link is per camera (SPEC §6 `doorLinks`), so a doorbell's
//     package channel (CAM-4) is not a row of its own — it shares the doorbell's link, which is
//     what P5.4's unlock control reads for a package cell.
//  3. **A door that cannot be unlocked remotely stays selectable**, labelled as such. Whether the
//     door is bound to a hub (`is_bind_hub`, unverified, OS-1) can change on the console, and the
//     link is the user's statement of which door the camera watches; DOOR-3's control is where
//     "this door cannot be unlocked from here" is enforced.
import type { Camera, Door, DoorLinks, IpcError, SecretsStored, Settings } from '@shared/ipc'
import { cameraDisplayName, sortByLabel, sortCameras } from '@shared/cameraOrder'

/** The `<select>` value that means "no link". Door ids are non-empty (DoorLinksSchema), so it cannot collide. */
export const NOT_LINKED = ''

/**
 * What the door list depends on, as one string: the saved console host and Access API root (which
 * together decide the Access endpoint, SPEC §6), the accepted Access pin, and whether an Access
 * token is stored. SettingsPage keys the card on it, so a change to any of them throws the old list
 * away and reads the new endpoint's — door ids from one console must never be offered as links on
 * another, and an error the user has just fixed (a pin accepted, a token saved) must not linger.
 *
 * A token **replaced** by another keeps `accessToken: true` and so keeps the key: the renderer
 * cannot see that it changed (CON-2), and Refresh doors is there for that case.
 */
export function doorListKey(settings: Settings, secretsStored: SecretsStored): string {
  return JSON.stringify([
    settings.console.host,
    settings.console.accessBaseUrl,
    settings.console.accessCertFingerprint,
    secretsStored.accessToken,
  ])
}

/** Where the card's `GET /doors` has got to. */
export type DoorListState =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: IpcError }
  | { readonly state: 'loaded'; readonly doors: readonly Door[] }

export interface DoorOption {
  readonly value: string
  readonly label: string
}

/**
 * How a row's link reads:
 * - `unlinked` — no link stored;
 * - `linked` — the door is in the loaded list;
 * - `unknown-door` — the list loaded and that door is not in it (deleted, or renumbered on the
 *   console). Still selected, still stored, until the user unlinks it;
 * - `pending` — a link is stored but the list is loading or failed, so nothing is known about the
 *   door beyond its id.
 */
export type LinkStatus = 'unlinked' | 'linked' | 'unknown-door' | 'pending'

/**
 * Where a row's camera stands:
 * - `inventory` — in `AppState.cameras`, named by CAM-1's fallback chain;
 * - `unknown` — the inventory has loaded (it is not empty) and does not have this camera: removed
 *   from the console, or a link made against a different one;
 * - `not-loaded` — the inventory is empty, i.e. the console has not been connected yet this session,
 *   so nothing can be said about the camera beyond its id. Not called "unknown": it most likely
 *   exists and simply has not been read.
 */
export type RowCamera = 'inventory' | 'unknown' | 'not-loaded'

export interface DoorLinkRow {
  readonly cameraId: string
  /** The camera's display name (CAM-1's fallback chain), or the unknown / not-loaded label. */
  readonly cameraLabel: string
  readonly camera: RowCamera
  /** The stored door id, or `null` when the camera is not linked. */
  readonly doorId: string | null
  readonly status: LinkStatus
  /** What the row says the linked door is, or `null` when not linked. */
  readonly doorLabel: string | null
  /**
   * The select's options, "Not linked" first, or `null` when the row has no select (an unknown
   * camera: there is nothing to link it to, only a link to remove). The stored door is always among
   * them, so the select can show it whatever the list's state.
   */
  readonly options: readonly DoorOption[] | null
  /** The select may pick a door: only once a list with doors in it has loaded. */
  readonly selectable: boolean
  /** The row shows an Unlink button, for the cases its select cannot unlink (rule 1). */
  readonly unlinkButton: boolean
}

export const UNKNOWN_CAMERA_LABEL = 'Unknown camera (not in the inventory)'

/** The label for a stored link's camera while the inventory has not been read yet. */
export function notLoadedCameraLabel(cameraId: string): string {
  return `Camera ${cameraId} — not loaded yet`
}
export const NO_HUB_SUFFIX = ' — no hub, remote unlock unavailable'

/** A door as the select shows it: `full_name`, then `name`, then the id; flagged when not hub-bound. */
export function doorLabel(door: Door): string {
  const full = door.fullName.trim()
  const short = door.name.trim()
  const base = full !== '' ? full : short !== '' ? short : door.id
  return door.boundToHub ? base : `${base}${NO_HUB_SUFFIX}`
}

/** The label for a stored door id the loaded list does not have. */
export function unknownDoorLabel(doorId: string): string {
  return `Unknown door (${doorId})`
}

/** The label for a stored door id while the list is loading or failed: all that is known is the id. */
export function pendingDoorLabel(doorId: string): string {
  return `Door ${doorId}`
}

/** The doors in the order the select lists them: by label, numbers as numbers, ties in console order. */
export function sortedDoors(doors: readonly Door[]): Door[] {
  return sortByLabel(doors, doorLabel)
}

/** True when the list has loaded with at least one door, i.e. there is something to pick. */
export function doorsSelectable(list: DoorListState): boolean {
  return list.state === 'loaded' && list.doors.length > 0
}

/**
 * Every row the card draws: one per inventory camera, in the camera list's order (`sortCameras`),
 * then one per stored link whose camera the inventory does not have, by camera id — labelled
 * "Unknown camera" only when there is an inventory to be missing from (see {@link RowCamera}).
 */
export function buildDoorLinkRows(
  cameras: readonly Camera[],
  links: DoorLinks,
  list: DoorListState,
): DoorLinkRow[] {
  const loaded = list.state === 'loaded' ? list.doors : null
  const byId = new Map((loaded ?? []).map((door) => [door.id, door]))
  const doorOptions: DoorOption[] = sortedDoors(loaded ?? []).map((door) => ({
    value: door.id,
    label: doorLabel(door),
  }))
  const selectable = doorsSelectable(list)

  /** The stored link as the row describes it. */
  const describe = (doorId: string | null): { status: LinkStatus; label: string | null } => {
    if (doorId === null) return { status: 'unlinked', label: null }
    if (loaded === null) return { status: 'pending', label: pendingDoorLabel(doorId) }
    const door = byId.get(doorId)
    return door === undefined
      ? { status: 'unknown-door', label: unknownDoorLabel(doorId) }
      : { status: 'linked', label: doorLabel(door) }
  }

  const known = new Set(cameras.map((camera) => camera.id))
  const rows: DoorLinkRow[] = sortCameras(cameras).map((camera) => {
    const doorId = linkOf(links, camera.id)
    const { status, label } = describe(doorId)
    // The stored door stays an option whatever the list says, so the select keeps showing it.
    const extra: DoorOption[] =
      doorId !== null && status !== 'linked' && label !== null ? [{ value: doorId, label }] : []
    return {
      cameraId: camera.id,
      cameraLabel: cameraDisplayName(camera),
      camera: 'inventory',
      doorId,
      status,
      doorLabel: label,
      options: [{ value: NOT_LINKED, label: 'Not linked' }, ...extra, ...doorOptions],
      selectable,
      // Once the list is selectable, "Not linked" in the select is the unlink.
      unlinkButton: doorId !== null && !selectable,
    }
  })

  const inventoryLoaded = cameras.length > 0
  const orphans = sortByLabel(
    Object.keys(links).filter((cameraId) => !known.has(cameraId)),
    (cameraId) => cameraId,
  )
  for (const cameraId of orphans) {
    const doorId = linkOf(links, cameraId)
    const { status, label } = describe(doorId)
    rows.push({
      cameraId,
      cameraLabel: inventoryLoaded ? UNKNOWN_CAMERA_LABEL : notLoadedCameraLabel(cameraId),
      camera: inventoryLoaded ? 'unknown' : 'not-loaded',
      doorId,
      status,
      doorLabel: label,
      options: null,
      selectable: false,
      unlinkButton: true,
    })
  }
  return rows
}

/**
 * A DOM id for a row's select and label, from its camera id rather than its position, so a row
 * keeps its id (and its label association) when the rows above it change. Letters and digits pass
 * through; anything else, `_` included, becomes `_<hex code>_`, which keeps the mapping one-to-one —
 * two camera ids can never share a DOM id.
 */
export function doorLinkFieldId(cameraId: string): string {
  const safe = Array.from(cameraId, (char) =>
    /^[A-Za-z0-9]$/.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}_`,
  ).join('')
  return `door-link-${safe}`
}

/**
 * The line about the cameras themselves, or `null` once the inventory is in. With no inventory
 * there are no rows to pick a door for, and any stored links are listed by camera id only.
 */
export function cameraListNotice(cameras: readonly Camera[], links: DoorLinks): string | null {
  if (cameras.length > 0) return null
  return Object.keys(links).length === 0
    ? 'Connect to the console to list cameras.'
    : 'Connect to the console to list cameras. The links below are kept and are shown by camera ' +
        'id until the cameras load.'
}

/** The stored door for a camera, or `null`. `Object.hasOwn`, so `constructor` is not a camera. */
function linkOf(links: DoorLinks, cameraId: string): string | null {
  return Object.hasOwn(links, cameraId) ? (links[cameraId] ?? null) : null
}

/**
 * The map after one select change: `doorId` links the camera (replacing any link it had), and
 * `NOT_LINKED` or `null` removes its key. A new object either way; every other link is kept as is.
 */
export function withLink(links: DoorLinks, cameraId: string, doorId: string | null): DoorLinks {
  if (doorId === null || doorId === NOT_LINKED) {
    return Object.fromEntries(Object.entries(links).filter(([key]) => key !== cameraId))
  }
  return { ...links, [cameraId]: doorId }
}

/** True when `withLink` would change nothing, so the card can skip a pointless save. */
export function sameLink(links: DoorLinks, cameraId: string, doorId: string | null): boolean {
  const target = doorId === NOT_LINKED ? null : doorId
  return linkOf(links, cameraId) === target
}

/**
 * The extra sentence under a failed door list that says where the fix is, or `null` when the
 * error's own message is all there is to say. Specific to Settings: every fix it names is a card
 * above this one.
 */
export function doorListHint(error: IpcError): string | null {
  switch (error.kind) {
    case 'pin-required':
      return 'Accept the Access certificate in the Access certificate card above, then retry.'
    case 'pin-mismatch':
      return (
        'The Access endpoint is presenting a different certificate. Check it in the Access ' +
        'certificate card above and re-pin only if you trust it, then retry.'
      )
    case 'auth':
      return 'Save a valid Access API token above, then retry.'
    case 'not-configured':
      return 'Save a console address (or a valid Access API root) in the Console card above, then retry.'
    case 'disabled':
      return 'Turn on "Enable UniFi Access" above and save it first.'
    default:
      return null
  }
}

/** The line the card shows about the list itself, or `null` when it loaded with doors in it. */
export function doorListNotice(list: DoorListState): string | null {
  switch (list.state) {
    case 'loading':
      return 'Reading the door list…'
    case 'failed':
      return null
    case 'loaded':
      return list.doors.length === 0
        ? 'The Access console reports no doors, so there is nothing to link yet.'
        : null
  }
}
