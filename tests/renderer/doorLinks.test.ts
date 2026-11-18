// P5.3 (DOOR-1, DOOR-2): the Door links card's door cards, tested where they live.
//
// Like settingsForm.ts, the card's component cannot be tested here (no jsdom, vitest.config.mts), so
// every rule about which door cards exist, what is in them and what a change sends is in
// doorLinks.ts. The one that matters most is rule 1: a stored link is never pruned — not by a
// failed list, not by an empty one, not by a door or a camera the app cannot see right now.
import { CameraSchema, DoorSchema, SettingsSchema, type Camera, type Door } from '@shared/models'
import type { IpcError, SecretsStored } from '@shared/ipc'
import { sortByLabel } from '@shared/cameraOrder'
import { describe, expect, it } from 'vitest'
import {
  addCameraOptions,
  addDoorOptions,
  buildDoorCards,
  cameraListNotice,
  domId,
  doorLabel,
  doorListHint,
  doorListKey,
  doorListNotice,
  doorsSelectable,
  doorTitle,
  addCameraPlaceholder,
  linkCamera,
  NO_HUB_SUFFIX,
  pruneAddedDoors,
  removeDoorAction,
  withAddedDoor,
  withoutAddedDoor,
  notLoadedCameraLabel,
  removeDoor,
  sortedDoors,
  unknownCameraLabel,
  unlinkCamera,
  type DoorListState,
} from '../../src/renderer/src/features/settings/doorLinks'

const camera = (id: string, name: string | null, extra: Record<string, unknown> = {}): Camera =>
  CameraSchema.parse({ id, name, ...extra })

const door = (id: string, overrides: Partial<Door> = {}): Door =>
  DoorSchema.parse({
    id,
    name: `Door ${id}`,
    fullName: `Ground Floor - Door ${id}`,
    floorId: 'floor-1',
    type: 'door',
    boundToHub: true,
    relay: 'lock',
    position: null,
    ...overrides,
  })

const error = (kind: IpcError['kind'], message = 'it failed'): IpcError => ({
  kind,
  message,
  endpoint: null,
  retryable: false,
})

const FRONT = door('d-front', { name: 'Front', fullName: 'Ground Floor - Front Door' })
const GARAGE = door('d-garage', { name: 'Garage', fullName: 'Ground Floor - Garage' })
const SIDE = door('d-side', { fullName: 'Side Gate', boundToHub: false })
const loaded = (...doors: Door[]): DoorListState => ({ state: 'loaded', doors })
const LOADING: DoorListState = { state: 'loading' }
const FAILED: DoorListState = { state: 'failed', error: error('network') }

const DRIVEWAY = camera('cam-drive', 'Driveway')
const PORCH = camera('cam-porch', 'Porch', { hasPackageCamera: true })
const CAM10 = camera('cam-10', 'Cam 10')
const CAM2 = camera('cam-2', 'Cam 2')
const ALL = [PORCH, CAM10, DRIVEWAY, CAM2]

describe('door names', () => {
  it('uses full_name, then name, then the id', () => {
    expect(doorTitle(FRONT)).toBe('Ground Floor - Front Door')
    expect(doorTitle(door('x', { fullName: '  ', name: 'Back' }))).toBe('Back')
    expect(doorTitle(door('x', { fullName: '', name: '' }))).toBe('x')
  })

  it('flags a door with no hub in the dropdown label, not in its title', () => {
    expect(doorTitle(SIDE)).toBe('Side Gate')
    expect(doorLabel(SIDE)).toBe(`Side Gate${NO_HUB_SUFFIX}`)
    expect(doorLabel(FRONT)).toBe('Ground Floor - Front Door')
  })

  it('sorts doors by name with numbers as numbers, ties in console order', () => {
    const d10 = door('a', { fullName: 'Door 10' })
    const d2 = door('b', { fullName: 'Door 2' })
    const twinA = door('c', { fullName: 'Twin' })
    const twinB = door('d', { fullName: 'twin' })
    expect(sortedDoors([d10, twinA, d2, twinB]).map((d) => d.id)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('buildDoorCards', () => {
  it('has no cards with no links and nothing added', () => {
    expect(buildDoorCards(ALL, {}, loaded(FRONT, GARAGE))).toEqual([])
  })

  it('groups linked cameras under their door, in camera-list order', () => {
    const links = { 'cam-drive': 'd-front', 'cam-10': 'd-front', 'cam-2': 'd-front' }
    const [card] = buildDoorCards(ALL, links, loaded(FRONT))
    expect(card).toMatchObject({
      doorId: 'd-front',
      kind: 'known',
      title: 'Ground Floor - Front Door',
      noHub: false,
    })
    expect(card?.cameras.map((c) => c.label)).toEqual(['Cam 2', 'Cam 10', 'Driveway'])
    expect(card?.cameras.every((c) => c.kind === 'inventory')).toBe(true)
  })

  it('orders known doors by name, then unknown doors by id', () => {
    const links = {
      'cam-drive': 'd-garage',
      'cam-porch': 'zz-gone',
      'cam-10': 'aa-gone',
      'cam-2': 'd-front',
    }
    const cards = buildDoorCards(ALL, links, loaded(GARAGE, FRONT))
    expect(cards.map((card) => [card.doorId, card.kind])).toEqual([
      ['d-front', 'known'],
      ['d-garage', 'known'],
      ['aa-gone', 'unknown'],
      ['zz-gone', 'unknown'],
    ])
  })

  it('gives a doorbell one entry: its package channel shares the door (CAM-4)', () => {
    const [card] = buildDoorCards([PORCH], { 'cam-porch': 'd-front' }, loaded(FRONT))
    expect(card?.cameras).toEqual([{ cameraId: 'cam-porch', label: 'Porch', kind: 'inventory' }])
  })

  it('marks a door with no hub, and still lets cameras be added to it', () => {
    const [card] = buildDoorCards(ALL, { 'cam-drive': 'd-side' }, loaded(SIDE))
    // `known`, so Add camera applies.
    expect(card).toMatchObject({ title: 'Side Gate', noHub: true, kind: 'known' })
  })

  it('keeps a door the loaded list lacks as "Unknown door", with no Add camera', () => {
    const [card] = buildDoorCards(ALL, { 'cam-drive': 'd-gone' }, loaded(FRONT))
    expect(card).toMatchObject({
      doorId: 'd-gone',
      kind: 'unknown',
      title: 'Unknown door (d-gone)',
    })
    expect(card?.cameras.map((c) => c.cameraId)).toEqual(['cam-drive'])
  })

  it('keeps every link through a failed, loading or empty list, as "Door <id>" cards', () => {
    const links = { 'cam-drive': 'd-front', 'cam-porch': 'd-garage' }
    for (const list of [FAILED, LOADING]) {
      const cards = buildDoorCards(ALL, links, list)
      expect(cards.map((card) => [card.title, card.kind])).toEqual([
        ['Door d-front', 'pending'],
        ['Door d-garage', 'pending'],
      ])
    }
    // An empty list has loaded, so these doors are known to be missing from it.
    const empty = buildDoorCards(ALL, links, loaded())
    expect(empty.map((card) => [card.title, card.kind])).toEqual([
      ['Unknown door (d-front)', 'unknown'],
      ['Unknown door (d-garage)', 'unknown'],
    ])
  })

  it('lists a camera the inventory lacks by id, after the known ones', () => {
    const links = { 'cam-z': 'd-front', 'cam-a': 'd-front', 'cam-drive': 'd-front' }
    const [card] = buildDoorCards([DRIVEWAY], links, loaded(FRONT))
    expect(card?.cameras).toEqual([
      { cameraId: 'cam-drive', label: 'Driveway', kind: 'inventory' },
      { cameraId: 'cam-a', label: 'Unknown camera (cam-a)', kind: 'unknown' },
      { cameraId: 'cam-z', label: 'Unknown camera (cam-z)', kind: 'unknown' },
    ])
  })

  it('says "not loaded yet", not unknown, while the inventory is empty', () => {
    const [card] = buildDoorCards([], { 'cam-a': 'd-front' }, loaded(FRONT))
    expect(card?.cameras).toEqual([
      { cameraId: 'cam-a', label: notLoadedCameraLabel('cam-a'), kind: 'not-loaded' },
    ])
    expect(notLoadedCameraLabel('cam-a')).toBe('Camera cam-a — not loaded yet')
    expect(unknownCameraLabel('cam-a')).toBe('Unknown camera (cam-a)')
  })

  it('shows an added door as an empty card until a camera is linked to it', () => {
    const [card] = buildDoorCards(ALL, {}, loaded(FRONT, GARAGE), ['d-garage'])
    expect(card).toMatchObject({ doorId: 'd-garage', kind: 'known', cameras: [] })
    // Linked as well as added: one card, not two.
    const both = buildDoorCards(ALL, { 'cam-2': 'd-garage' }, loaded(GARAGE), ['d-garage'])
    expect(both).toHaveLength(1)
  })

  it('drops an added empty door the reloaded list lacks (it was never data), keeps it while loading', () => {
    expect(buildDoorCards(ALL, {}, loaded(FRONT), ['d-garage'])).toEqual([])
    expect(buildDoorCards(ALL, {}, LOADING, ['d-garage'])).toEqual([
      expect.objectContaining({ doorId: 'd-garage', kind: 'pending', cameras: [] }),
    ])
  })

  it('keeps a stored door as an empty card after its last camera is unlinked (added on unlink)', () => {
    // What the card does on unlink: the door joins addedDoorIds, then the link goes.
    const added = withAddedDoor([], 'd-front')
    const [card] = buildDoorCards(
      ALL,
      unlinkCamera({ 'cam-2': 'd-front' }, 'cam-2'),
      loaded(FRONT),
      added,
    )
    expect(card).toMatchObject({ doorId: 'd-front', kind: 'known', cameras: [] })
  })

  it('does not read an inherited property as a link', () => {
    expect(buildDoorCards([camera('constructor', 'Odd id')], {}, loaded(FRONT))).toEqual([])
  })
})

describe('the Add dropdowns', () => {
  it('offers the loaded doors without a card, by name, no-hub label kept', () => {
    const list = loaded(SIDE, GARAGE, FRONT)
    const cards = buildDoorCards(ALL, { 'cam-2': 'd-garage' }, list)
    expect(addDoorOptions(list, cards)).toEqual([
      { value: 'd-front', label: 'Ground Floor - Front Door' },
      { value: 'd-side', label: `Side Gate${NO_HUB_SUFFIX}` },
    ])
    // An empty added card is a card too, so it is not offered again.
    const added = buildDoorCards(ALL, {}, list, ['d-front'])
    expect(addDoorOptions(list, added).map((o) => o.value)).toEqual(['d-garage', 'd-side'])
  })

  it('offers no doors until a list has loaded', () => {
    expect(addDoorOptions(LOADING, [])).toEqual([])
    expect(addDoorOptions(FAILED, [])).toEqual([])
    expect(addDoorOptions(loaded(), [])).toEqual([])
  })

  it('says why Add camera is empty: cameras not loaded, or none unlinked', () => {
    expect(addCameraPlaceholder([], [])).toBe('Cameras not loaded yet')
    expect(addCameraPlaceholder([DRIVEWAY], [])).toBe('No unlinked cameras')
    expect(addCameraPlaceholder([DRIVEWAY], addCameraOptions([DRIVEWAY], {}))).toMatch(/Choose/)
  })

  it('offers only the cameras linked to no door, in camera-list order', () => {
    expect(addCameraOptions(ALL, { 'cam-10': 'd-front', 'cam-x': 'd-front' })).toEqual([
      { value: 'cam-2', label: 'Cam 2' },
      { value: 'cam-drive', label: 'Driveway' },
      { value: 'cam-porch', label: 'Porch' },
    ])
    expect(addCameraOptions([], {})).toEqual([])
  })
})

describe('added doors (session-only empty cards)', () => {
  it('prunes the ids a loaded list does not have, so they cannot come back', () => {
    const added = ['d-front', 'd-gone']
    const pruned = pruneAddedDoors(added, loaded(FRONT))
    expect(pruned).toEqual(['d-front'])
    // Gone for good: a later loading state or reload does not revive it.
    expect(buildDoorCards(ALL, {}, LOADING, pruned).map((card) => card.doorId)).toEqual(['d-front'])
  })

  it('keeps them all while the list is loading or failed, and returns the same array', () => {
    const added = ['d-front', 'd-gone']
    expect(pruneAddedDoors(added, LOADING)).toBe(added)
    expect(pruneAddedDoors(added, FAILED)).toBe(added)
    expect(pruneAddedDoors(added, loaded(FRONT, door('d-gone')))).toBe(added)
  })

  it('adds and forgets a door without duplicates or needless copies', () => {
    const added = ['d-front']
    expect(withAddedDoor(added, 'd-front')).toBe(added)
    expect(withAddedDoor(added, 'd-garage')).toEqual(['d-front', 'd-garage'])
    expect(withoutAddedDoor(added, 'd-front')).toEqual([])
    expect(withoutAddedDoor(added, 'd-garage')).toBe(added)
  })

  it('decides Remove door from the links as stored: save while a camera links to it', () => {
    expect(removeDoorAction({ 'cam-1': 'd-front' }, 'd-front')).toBe('save')
    expect(removeDoorAction({ 'cam-1': 'd-garage' }, 'd-front')).toBe('forget')
    expect(removeDoorAction({}, 'd-front')).toBe('forget')
  })
})

describe('link changes', () => {
  const links = { 'cam-1': 'd-front', 'cam-2': 'd-front', 'cam-3': 'd-garage' }

  it('links a camera, keeping every other link', () => {
    expect(linkCamera(links, 'cam-4', 'd-garage')).toEqual({ ...links, 'cam-4': 'd-garage' })
  })

  it('unlinks one camera by removing its key', () => {
    const next = unlinkCamera(links, 'cam-1')
    expect(next).toEqual({ 'cam-2': 'd-front', 'cam-3': 'd-garage' })
    expect(Object.keys(next)).not.toContain('cam-1')
  })

  it('removes a door by unlinking all its cameras in one map', () => {
    expect(removeDoor(links, 'd-front')).toEqual({ 'cam-3': 'd-garage' })
    expect(removeDoor(links, 'd-none')).toEqual(links)
  })

  it('never mutates the map it was given', () => {
    const before = structuredClone(links)
    linkCamera(links, 'cam-9', 'd-front')
    unlinkCamera(links, 'cam-1')
    removeDoor(links, 'd-front')
    expect(links).toEqual(before)
  })
})

describe('the list state', () => {
  it('is selectable only once a list with doors in it has loaded', () => {
    expect(doorsSelectable(loaded(FRONT))).toBe(true)
    expect(doorsSelectable(loaded())).toBe(false)
    expect(doorsSelectable(LOADING)).toBe(false)
    expect(doorsSelectable(FAILED)).toBe(false)
  })

  it('says when it is loading or empty, and leaves a failure to the error itself', () => {
    expect(doorListNotice(LOADING)).toMatch(/Reading/)
    expect(doorListNotice(loaded())).toMatch(/no doors/)
    expect(doorListNotice(loaded(FRONT))).toBeNull()
    expect(doorListNotice(FAILED)).toBeNull()
  })

  it('points each Settings-fixable failure at the card that fixes it', () => {
    expect(doorListHint(error('pin-required'))).toMatch(/Accept the Access certificate/)
    expect(doorListHint(error('pin-mismatch'))).toMatch(/re-pin/)
    expect(doorListHint(error('auth'))).toMatch(/valid Access API token/)
    expect(doorListHint(error('not-configured'))).toMatch(/console address/)
    expect(doorListHint(error('disabled'))).toMatch(/Enable UniFi Access/)
    // Nothing in Settings fixes a console that is down; its own message says what happened.
    expect(doorListHint(error('network'))).toBeNull()
    expect(doorListHint(error('timeout'))).toBeNull()
  })
})

describe('sortByLabel (shared with sortCameras)', () => {
  it('sorts case-insensitively with numbers as numbers, ties kept in input order', () => {
    const items = ['b', 'Item 10', 'item 2', 'A', 'a']
    expect(sortByLabel(items, (item) => item)).toEqual(['A', 'a', 'b', 'item 2', 'Item 10'])
    // A new array; the input is left alone.
    expect(items[0]).toBe('b')
  })
})

describe('domId', () => {
  it('builds a DOM id from the entity id, not a position', () => {
    expect(domId('door-card', '65a1f0c2')).toBe('door-card-65a1f0c2')
  })

  it('escapes everything else, one-to-one, so two ids never collide', () => {
    const ids = ['a b', 'a_b', 'a_20_b', 'a.b', 'a:b', 'ä']
    const dom = ids.map((id) => domId('x', id))
    expect(new Set(dom).size).toBe(ids.length)
    for (const id of dom) expect(id).toMatch(/^x-[A-Za-z0-9_]+$/)
  })
})

describe('cameraListNotice', () => {
  it('asks to connect while there is no inventory, and says the links are kept', () => {
    expect(cameraListNotice([], {})).toBe('Connect to the console to list cameras.')
    expect(cameraListNotice([], { 'cam-1': 'd-front' })).toMatch(/linked ones show by id/)
    expect(cameraListNotice([DRIVEWAY], { 'cam-1': 'd-front' })).toBeNull()
  })
})

describe('doorListKey', () => {
  const settings = (console: Record<string, unknown> = {}) =>
    SettingsSchema.parse({ console: { host: '192.0.2.10', accessEnabled: true, ...console } })
  const STORED: SecretsStored = { protectApiKey: true, accessToken: true }
  const base = doorListKey(settings(), STORED)

  it('changes with the Access endpoint, its pin and whether a token is stored', () => {
    expect(doorListKey(settings({ host: 'udm.local' }), STORED)).not.toBe(base)
    expect(
      doorListKey(
        settings({ accessBaseUrl: 'https://192.0.2.10/proxy/access/api/v1/developer' }),
        STORED,
      ),
    ).not.toBe(base)
    expect(doorListKey(settings({ accessCertFingerprint: 'AA:BB' }), STORED)).not.toBe(base)
    expect(doorListKey(settings(), { ...STORED, accessToken: false })).not.toBe(base)
  })

  it('does not change for anything the door list does not depend on', () => {
    expect(doorListKey(settings({ certFingerprint: 'CC:DD' }), STORED)).toBe(base)
    expect(doorListKey(settings(), { ...STORED, protectApiKey: false })).toBe(base)
    const withLinks = SettingsSchema.parse({ ...settings(), doorLinks: { 'cam-1': 'd-front' } })
    expect(doorListKey(withLinks, STORED)).toBe(base)
  })
})
