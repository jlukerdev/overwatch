// The Doors screen's door cards and their camera links (P5.6; DOOR-1, DOOR-2), as pure functions
// over plain data. Moved here from Settings' Door links card (P5.3), whose rules still hold.
//
// The screen shows **one card per door, with everything about that door on it**, the cameras linked
// to it included (user decision 2026-11-18). Its inputs are the camera inventory, the stored
// camera → door map and the door list main last read (`DoorsScreenState.doors`, `null` while it has
// none); its output is the cards and the options of each card's "Add camera" dropdown. Everything
// that can be *wrong* about that mapping lives here rather than in the component: the project has
// no jsdom, so a rule inside an onChange is a rule no test can reach.
//
// Four rules this module keeps:
//
//  1. **A stored link is never pruned.** A door list that failed, is still loading, came back empty
//     or simply does not have a door any more must not cost the user a link: a linked door the list
//     lacks still gets a card, labelled with what is known about it ("Unknown door (<id>)", or
//     "Door <id>" while there is no list), and only an explicit unlink removes a camera from it.
//     The same for a camera the inventory does not have: it stays in its door's card, by id.
//  2. **Every listed door has a card**, linked or not. So P5.3's "Add door" picker, its
//     session-only empty cards and "Remove door" are gone: a door with no camera is just a card
//     whose camera list is empty, and nothing is stored for it.
//  3. **One entry per camera id.** The persisted model is camera → door (`doorLinks`), one door per
//     camera, so a doorbell's package channel (CAM-4) is not an entry of its own — it shares the
//     doorbell's link, which is what the cell's unlock control reads for a package cell.
//  4. **A door that cannot be unlocked remotely can still be linked.** Whether the door is bound to
//     a hub can change on the console, and the link is the user's statement of which door the
//     camera watches; the card's actions are where "no hub" is enforced (./doorActions.ts).
import type { Camera, Door, DoorLinks, IpcError } from '@shared/ipc'
import { cameraDisplayName, sortByLabel, sortCameras } from '@shared/cameraOrder'
import { doorDisplayName } from '@shared/doorName'

/** The `<select>` value of a dropdown's placeholder. Ids are non-empty, so it cannot collide. */
export const PLACEHOLDER = ''

export interface DropdownOption {
  readonly value: string
  readonly label: string
}

/**
 * What a card knows about its door:
 * - `listed` — the door is in the list main read, so it has a state and can be acted on;
 * - `unknown` — there is a list and it does not have this (linked) door: deleted, or renumbered on
 *   the console. Its cameras can be unlinked, and that is all;
 * - `pending` — there is no list (not read yet, or the read is failing), so nothing is known about
 *   this (linked) door beyond its id. Unlink only, like `unknown`.
 */
export type DoorCardKind = 'listed' | 'unknown' | 'pending'

/**
 * Where a linked camera stands:
 * - `inventory` — in `AppState.cameras`, named by CAM-1's fallback chain;
 * - `unknown` — the inventory has loaded (it is not empty) and does not have this camera;
 * - `not-loaded` — the inventory is empty, i.e. the console has not been connected yet this session,
 *   so nothing can be said about the camera beyond its id. Not called "unknown": it most likely
 *   exists and simply has not been read.
 */
export type CardCameraKind = 'inventory' | 'unknown' | 'not-loaded'

export interface DoorCardCamera {
  readonly cameraId: string
  readonly label: string
  readonly kind: CardCameraKind
}

export interface DoorCard {
  readonly doorId: string
  readonly kind: DoorCardKind
  /** The card's heading: the door's name, or what stands in for it (`unknown` / `pending`). */
  readonly title: string
  /** The door as main read it; `null` unless `kind` is `listed`. */
  readonly door: Door | null
  /** Inventory cameras in camera-list order, then unknown / not-loaded ones by id. */
  readonly cameras: readonly DoorCardCamera[]
}

export function unknownDoorTitle(doorId: string): string {
  return `Unknown door (${doorId})`
}

export function pendingDoorTitle(doorId: string): string {
  return `Door ${doorId}`
}

export function unknownCameraLabel(cameraId: string): string {
  return `Unknown camera (${cameraId})`
}

export function notLoadedCameraLabel(cameraId: string): string {
  return `Camera ${cameraId} — not loaded yet`
}

/**
 * Every door card, in order: the listed doors by name (`sortByLabel`: numbers as numbers, ties in
 * console order), then the linked doors the list lacks, by id (rule 1). `doors` is
 * `DoorsScreenState.doors`: `null` means there is no list, so only linked doors have cards.
 */
export function buildDoorCards(
  cameras: readonly Camera[],
  links: DoorLinks,
  doors: readonly Door[] | null,
): DoorCard[] {
  const inventory = new Map(cameras.map((camera) => [camera.id, camera]))
  const inventoryLoaded = cameras.length > 0

  // Door id → its cameras, from the links (own keys only: `constructor` is not a camera).
  const members = new Map<string, string[]>()
  for (const [cameraId, doorId] of Object.entries(links)) {
    const ids = members.get(doorId) ?? []
    ids.push(cameraId)
    members.set(doorId, ids)
  }

  const cardCameras = (ids: readonly string[]): DoorCardCamera[] => {
    const known = sortCameras(ids.flatMap((id) => inventory.get(id) ?? []))
    const others = sortByLabel(
      ids.filter((id) => !inventory.has(id)),
      (id) => id,
    )
    return [
      ...known.map((camera) => ({
        cameraId: camera.id,
        label: cameraDisplayName(camera),
        kind: 'inventory' as const,
      })),
      ...others.map((cameraId) => ({
        cameraId,
        label: inventoryLoaded ? unknownCameraLabel(cameraId) : notLoadedCameraLabel(cameraId),
        kind: inventoryLoaded ? ('unknown' as const) : ('not-loaded' as const),
      })),
    ]
  }

  const listedIds = new Set<string>()
  const listed: DoorCard[] = []
  for (const door of sortByLabel(doors ?? [], doorDisplayName)) {
    // A console that lists one id twice still gets one card (and one React key).
    if (listedIds.has(door.id)) continue
    listedIds.add(door.id)
    listed.push({
      doorId: door.id,
      kind: 'listed',
      title: doorDisplayName(door),
      door,
      cameras: cardCameras(members.get(door.id) ?? []),
    })
  }

  const others: DoorCard[] = []
  for (const [doorId, ids] of members) {
    if (listedIds.has(doorId)) continue
    others.push({
      doorId,
      kind: doors === null ? 'pending' : 'unknown',
      title: doors === null ? pendingDoorTitle(doorId) : unknownDoorTitle(doorId),
      door: null,
      cameras: cardCameras(ids),
    })
  }
  return [...listed, ...sortByLabel(others, (card) => card.doorId)]
}

/**
 * The Add camera dropdown, the same for every card: the inventory cameras linked to **no** door
 * (one door per camera; a move between doors is unlink, then add — user decision 2026-11-17), in
 * camera-list order.
 */
export function addCameraOptions(cameras: readonly Camera[], links: DoorLinks): DropdownOption[] {
  return sortCameras(cameras)
    .filter((camera) => !Object.hasOwn(links, camera.id))
    .map((camera) => ({ value: camera.id, label: cameraDisplayName(camera) }))
}

/** The Add camera placeholder: why it is empty when it is, otherwise the prompt. */
export function addCameraPlaceholder(
  cameras: readonly Camera[],
  options: readonly DropdownOption[],
): string {
  if (cameras.length === 0) return 'Cameras not loaded yet'
  return options.length === 0 ? 'No unlinked cameras' : 'Add camera…'
}

/** Links a camera to a door, replacing any link it had. A new map; every other link is kept. */
export function linkCamera(links: DoorLinks, cameraId: string, doorId: string): DoorLinks {
  return { ...links, [cameraId]: doorId }
}

/** Removes one camera's link. A new map; every other link is kept. */
export function unlinkCamera(links: DoorLinks, cameraId: string): DoorLinks {
  return Object.fromEntries(Object.entries(links).filter(([key]) => key !== cameraId))
}

/**
 * A DOM id built from an entity id rather than a position, so a control keeps its id (and its
 * label association) when the cards around it change. Letters and digits pass through; anything
 * else, `_` included, becomes `_<hex code>_`, which keeps the mapping one-to-one.
 */
export function domId(prefix: string, id: string): string {
  const safe = Array.from(id, (char) =>
    /^[A-Za-z0-9]$/.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}_`,
  ).join('')
  return `${prefix}-${safe}`
}

/**
 * The line about the cameras themselves, or `null` once the inventory is in. With no inventory
 * there is nothing to add to a door, and any linked cameras are shown by id only.
 */
export function cameraListNotice(cameras: readonly Camera[], links: DoorLinks): string | null {
  if (cameras.length > 0) return null
  return Object.keys(links).length === 0
    ? 'Connect to the console to link cameras to doors.'
    : 'Connect to the console to link cameras to doors; linked ones show by id until then.'
}

/**
 * The extra sentence under a door list that cannot be read, saying where the fix is — or `null`
 * when Settings cannot fix it and the error's own message is all there is to say (a console that
 * is down). Every fix it names is in Settings, which the screen offers a button to.
 */
export function doorsErrorHint(error: IpcError): string | null {
  switch (error.kind) {
    case 'pin-required':
      return 'Accept the Access certificate in Settings.'
    case 'pin-mismatch':
      return (
        'Access is presenting a different certificate. Check it in Settings and accept it only ' +
        'if you trust it.'
      )
    case 'auth':
      return 'Save a valid Access API token in Settings.'
    case 'not-configured':
      return 'Save a console address (or a valid Access API root) in Settings.'
    case 'disabled':
      return 'Turn on "Enable UniFi Access" in Settings and save it.'
    default:
      return null
  }
}

/**
 * What the screen's body is, from main's state alone:
 * - `loading` — no list and no reason yet: the first read is on its way;
 * - `error` — no list, and why (`DoorsScreenState.error`). Linked doors still get their cards
 *   (rule 1), under the message;
 * - `empty` — the console answered with no doors;
 * - `cards` — a list with doors in it.
 */
export type DoorsBody = 'loading' | 'error' | 'empty' | 'cards'

export function doorsBody(state: {
  readonly doors: readonly Door[] | null
  readonly error: IpcError | null
}): DoorsBody {
  if (state.doors === null) return state.error === null ? 'loading' : 'error'
  return state.doors.length === 0 ? 'empty' : 'cards'
}

/**
 * The warning above the cards while there is a list but the reads are failing, or `null`. Once
 * two reads in a row have failed (`stale`) every state on the cards is drawn as unknown, and the
 * line says so. Before that there is nothing to say: main reports a failing read only together
 * with `stale` (one lost poll is not news), and the cards still show what was last read.
 */
export function doorsReadWarning(state: {
  readonly doors: readonly Door[] | null
  readonly stale: boolean
  readonly error: IpcError | null
}): string | null {
  if (state.doors === null || !state.stale) return null
  const reason = state.error?.message.trim() ?? ''
  const head = 'The doors cannot be read right now, so their states are not known.'
  return reason === '' ? head : `${head} ${reason}`
}
