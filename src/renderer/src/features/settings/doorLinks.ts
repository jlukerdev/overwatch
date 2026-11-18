// Settings' Door links card (P5.3; DOOR-1, DOOR-2), as pure functions over plain data.
//
// The card shows **one small card per door, with the cameras linked to it inside** (user request
// 2026-11-17: a per-camera list grows too long on a wall with many cameras). Its inputs are the
// camera inventory, the stored camera → door map, wherever the door list read has got to, and the
// doors the user has added this session without linking a camera yet; its output is the door cards
// and the options of the two "Add" dropdowns. Everything that can be *wrong* about that mapping
// lives here rather than in the component, for the same reason as ./settingsForm.ts: the project
// has no jsdom, so a rule inside an onChange is a rule no test can reach.
//
// Four rules this module keeps:
//
//  1. **A stored link is never pruned.** A door list that failed, is still loading, came back empty
//     or simply does not have a door any more must not cost the user a link: the door keeps its
//     card, labelled with what is known about it ("Unknown door (<id>)", or "Door <id>" while the
//     list is not in), and only an explicit unlink removes a camera from it. The same for a camera
//     the inventory does not have: it stays in its door's card, by id.
//  2. **The persisted model is unchanged**: `doorLinks` is still camera → door, one door per
//     camera. A door card with no camera in it exists only as session UI state (`addedDoorIds`):
//     the step between "Add door" and "Add camera", or what is left after its last camera was
//     unlinked, until the user removes it or leaves Settings. Nothing is saved for it. So an
//     empty door the reloaded list no longer has is pruned from that state (`pruneAddedDoors`):
//     it was never data.
//  3. **One entry per camera id.** The link is per camera (SPEC §6), so a doorbell's package
//     channel (CAM-4) is not an entry of its own — it shares the doorbell's link, which is what
//     P5.4's unlock control reads for a package cell.
//  4. **A door that cannot be unlocked remotely can still be added**, labelled as such. Whether the
//     door is bound to a hub (`is_bind_hub`, unverified, OS-1) can change on the console, and the
//     link is the user's statement of which door the camera watches; DOOR-3's control is where
//     "this door cannot be unlocked from here" is enforced.
import type { Camera, Door, DoorLinks, IpcError, SecretsStored, Settings } from '@shared/ipc'
import { cameraDisplayName, sortByLabel, sortCameras } from '@shared/cameraOrder'

/** The `<select>` value of an "Add …" dropdown's placeholder. Ids are non-empty, so it cannot collide. */
export const PLACEHOLDER = ''

/** Where the card's `GET /doors` has got to. */
export type DoorListState =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: IpcError }
  | { readonly state: 'loaded'; readonly doors: readonly Door[] }

export interface DropdownOption {
  readonly value: string
  readonly label: string
}

/**
 * What a door card knows about its door:
 * - `known` — the door is in the loaded list;
 * - `unknown` — the list loaded and does not have it (deleted, or renumbered on the console). Its
 *   cameras can be unlinked, but none can be added;
 * - `pending` — the list is loading, failed or not read yet, so nothing is known beyond the id.
 */
export type DoorCardKind = 'known' | 'unknown' | 'pending'

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
  /** True for a known door with no Door Hub: the heading carries the "remote unlock unavailable" note. */
  readonly noHub: boolean
  /**
   * Inventory cameras in camera-list order, then unknown / not-loaded ones by id. Cameras can be
   * added only to a `known` door — which implies a loaded list that has it.
   */
  readonly cameras: readonly DoorCardCamera[]
}

export const NO_HUB_NOTE = 'No hub, remote unlock unavailable'
export const NO_HUB_SUFFIX = ' — no hub, remote unlock unavailable'

/** A door's name: `full_name`, then `name`, then the id. */
export function doorTitle(door: Door): string {
  const full = door.fullName.trim()
  const short = door.name.trim()
  return full !== '' ? full : short !== '' ? short : door.id
}

/** A door as the Add door dropdown lists it: its name, flagged when it has no hub. */
export function doorLabel(door: Door): string {
  return door.boundToHub ? doorTitle(door) : `${doorTitle(door)}${NO_HUB_SUFFIX}`
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

/** The doors in the order the card lists them: by name, numbers as numbers, ties in console order. */
export function sortedDoors(doors: readonly Door[]): Door[] {
  return sortByLabel(doors, doorTitle)
}

/** True when the list has loaded with at least one door, i.e. there is something to add. */
export function doorsSelectable(list: DoorListState): boolean {
  return list.state === 'loaded' && list.doors.length > 0
}

/**
 * Every door card, in order: the known doors by name (`sortByLabel`), then the unknown and pending
 * ones by id. A door gets a card when at least one camera links to it (rule 1, whatever the list
 * says) or when it is in `addedDoorIds` and the list can vouch for it — loaded and containing it,
 * or not loaded at all, in which case it waits as a pending card (rule 2).
 */
export function buildDoorCards(
  cameras: readonly Camera[],
  links: DoorLinks,
  list: DoorListState,
  addedDoorIds: readonly string[] = [],
): DoorCard[] {
  const loaded = list.state === 'loaded' ? list.doors : null
  const byId = new Map((loaded ?? []).map((door) => [door.id, door]))
  const inventory = new Map(cameras.map((camera) => [camera.id, camera]))
  const inventoryLoaded = cameras.length > 0

  // Door id → its cameras, from the links (own keys only: `constructor` is not a camera).
  const members = new Map<string, string[]>()
  for (const [cameraId, doorId] of Object.entries(links)) {
    const ids = members.get(doorId) ?? []
    ids.push(cameraId)
    members.set(doorId, ids)
  }
  for (const doorId of addedDoorIds) {
    if (members.has(doorId)) continue
    if (loaded !== null && !byId.has(doorId)) continue
    members.set(doorId, [])
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

  const knownCards: DoorCard[] = []
  const otherCards: DoorCard[] = []
  for (const [doorId, ids] of members) {
    const door = byId.get(doorId)
    if (door !== undefined) {
      knownCards.push({
        doorId,
        kind: 'known',
        title: doorTitle(door),
        noHub: !door.boundToHub,
        cameras: cardCameras(ids),
      })
      continue
    }
    otherCards.push({
      doorId,
      kind: loaded === null ? 'pending' : 'unknown',
      title: loaded === null ? pendingDoorTitle(doorId) : unknownDoorTitle(doorId),
      noHub: false,
      cameras: cardCameras(ids),
    })
  }
  return [
    ...sortByLabel(knownCards, (card) => card.title),
    ...sortByLabel(otherCards, (card) => card.doorId),
  ]
}

/** The Add door dropdown: every loaded door without a card yet, by name, no-hub doors flagged. */
export function addDoorOptions(list: DoorListState, cards: readonly DoorCard[]): DropdownOption[] {
  if (list.state !== 'loaded') return []
  const shown = new Set(cards.map((card) => card.doorId))
  return sortedDoors(list.doors)
    .filter((door) => !shown.has(door.id))
    .map((door) => ({ value: door.id, label: doorLabel(door) }))
}

/**
 * The Add camera dropdown, the same for every card: the inventory cameras linked to **no** door
 * (one door per camera), in camera-list order.
 */
export function addCameraOptions(cameras: readonly Camera[], links: DoorLinks): DropdownOption[] {
  return sortCameras(cameras)
    .filter((camera) => !Object.hasOwn(links, camera.id))
    .map((camera) => ({ value: camera.id, label: cameraDisplayName(camera) }))
}

/**
 * `addedDoorIds` after a door list landed: the doors a **loaded** list does not have are dropped,
 * so an empty card for a door that has gone cannot come back on a later reload or while one is
 * loading. A list that is loading or failed says nothing about which doors exist, so it keeps them
 * all. The same array back when nothing changes, so React can skip the re-render.
 */
export function pruneAddedDoors(
  addedDoorIds: readonly string[],
  list: DoorListState,
): readonly string[] {
  if (list.state !== 'loaded') return addedDoorIds
  const present = new Set(list.doors.map((door) => door.id))
  const kept = addedDoorIds.filter((id) => present.has(id))
  return kept.length === addedDoorIds.length ? addedDoorIds : kept
}

/** `addedDoorIds` with one more door (Add door, or a card whose cameras are being unlinked). */
export function withAddedDoor(addedDoorIds: readonly string[], doorId: string): readonly string[] {
  return addedDoorIds.includes(doorId) ? addedDoorIds : [...addedDoorIds, doorId]
}

/** `addedDoorIds` without a door (its card was removed). */
export function withoutAddedDoor(
  addedDoorIds: readonly string[],
  doorId: string,
): readonly string[] {
  return addedDoorIds.includes(doorId) ? addedDoorIds.filter((id) => id !== doorId) : addedDoorIds
}

/**
 * What Remove door does, decided from the links **as stored when the click happens**: `save` when
 * any camera still links to the door (one save unlinks them all), `forget` when none does — the
 * card is session state only, and there is nothing to write.
 */
export function removeDoorAction(links: DoorLinks, doorId: string): 'save' | 'forget' {
  return Object.values(links).includes(doorId) ? 'save' : 'forget'
}

/** The Add camera placeholder: why it is empty when it is, otherwise the prompt. */
export function addCameraPlaceholder(
  cameras: readonly Camera[],
  options: readonly DropdownOption[],
): string {
  if (cameras.length === 0) return 'Cameras not loaded yet'
  return options.length === 0 ? 'No unlinked cameras' : 'Choose a camera…'
}

/** Links a camera to a door, replacing any link it had. A new map; every other link is kept. */
export function linkCamera(links: DoorLinks, cameraId: string, doorId: string): DoorLinks {
  return { ...links, [cameraId]: doorId }
}

/** Removes one camera's link. A new map; every other link is kept. */
export function unlinkCamera(links: DoorLinks, cameraId: string): DoorLinks {
  return Object.fromEntries(Object.entries(links).filter(([key]) => key !== cameraId))
}

/** Removes every camera's link to one door, in one map (so one save). Other doors are kept. */
export function removeDoor(links: DoorLinks, doorId: string): DoorLinks {
  return Object.fromEntries(Object.entries(links).filter(([, value]) => value !== doorId))
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
 * What the door list depends on, as one string: the saved console host and Access API root (which
 * together decide the Access endpoint, SPEC §6), the accepted Access pin, and whether an Access
 * token is stored. SettingsPage keys the card on it, so a change to any of them throws the old list
 * away and reads the new endpoint's — door ids from one console must never be offered on another,
 * and an error the user has just fixed (a pin accepted, a token saved) must not linger.
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

/**
 * The line about the cameras themselves, or `null` once the inventory is in. With no inventory
 * there is nothing to add to a door, and any linked cameras are shown by id only.
 */
export function cameraListNotice(cameras: readonly Camera[], links: DoorLinks): string | null {
  if (cameras.length > 0) return null
  return Object.keys(links).length === 0
    ? 'Connect to the console to list cameras.'
    : 'Connect to the console to list cameras. The links below are kept and show camera ids ' +
        'until the cameras load.'
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
        ? 'The Access console reports no doors, so there is nothing to add yet.'
        : null
  }
}
