// P5.6 (DOOR-1, DOOR-2): the Doors screen's door cards and their camera links, tested where they
// live (src/renderer/src/features/doors/doorLinks.ts; moved from Settings' Door links card, P5.3).
//
// The components cannot be tested here (no jsdom, vitest.config.mts), so every rule about which
// door cards exist, what is in them and what a change sends is in doorLinks.ts. Two matter most:
// every listed door has a card, linked or not; and a stored link is never pruned — not by a failed
// list, not by an empty one, not by a door or a camera the app cannot see right now.
import { CameraSchema, DoorSchema, type Camera, type Door } from '@shared/models'
import type { IpcError } from '@shared/ipc'
import { sortByLabel } from '@shared/cameraOrder'
import { describe, expect, it } from 'vitest'
import {
  addCameraOptions,
  addCameraPlaceholder,
  buildDoorCards,
  cameraListNotice,
  domId,
  doorsBody,
  doorsErrorHint,
  doorsReadWarning,
  linkCamera,
  notLoadedCameraLabel,
  unknownCameraLabel,
  unlinkCamera,
} from '../../src/renderer/src/features/doors/doorLinks'

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

const DRIVEWAY = camera('cam-drive', 'Driveway')
const PORCH = camera('cam-porch', 'Porch', { hasPackageCamera: true })
const CAM10 = camera('cam-10', 'Cam 10')
const CAM2 = camera('cam-2', 'Cam 2')
const ALL = [PORCH, CAM10, DRIVEWAY, CAM2]

describe('buildDoorCards', () => {
  it('gives every listed door a card, linked or not, with the door on it', () => {
    const cards = buildDoorCards(ALL, {}, [GARAGE, FRONT])
    expect(cards.map((card) => [card.doorId, card.kind, card.cameras.length])).toEqual([
      ['d-front', 'listed', 0],
      ['d-garage', 'listed', 0],
    ])
    expect(cards[0]?.door).toBe(FRONT)
    expect(cards[0]?.title).toBe('Ground Floor - Front Door')
  })

  it('sorts listed doors by name with numbers as numbers, ties in console order', () => {
    const d10 = door('a', { fullName: 'Door 10' })
    const d2 = door('b', { fullName: 'Door 2' })
    const twinA = door('c', { fullName: 'Twin' })
    const twinB = door('d', { fullName: 'twin' })
    expect(buildDoorCards([], {}, [d10, twinA, d2, twinB]).map((card) => card.doorId)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ])
  })

  it('draws a door the console lists twice once', () => {
    expect(buildDoorCards([], {}, [FRONT, FRONT])).toHaveLength(1)
  })

  it('has no cards with no list and no links', () => {
    expect(buildDoorCards(ALL, {}, null)).toEqual([])
    expect(buildDoorCards(ALL, {}, [])).toEqual([])
  })

  it('groups linked cameras under their door, in camera-list order', () => {
    const links = { 'cam-drive': 'd-front', 'cam-10': 'd-front', 'cam-2': 'd-front' }
    const [card] = buildDoorCards(ALL, links, [FRONT])
    expect(card?.cameras.map((c) => c.label)).toEqual(['Cam 2', 'Cam 10', 'Driveway'])
    expect(card?.cameras.every((c) => c.kind === 'inventory')).toBe(true)
  })

  it('orders listed doors by name, then linked doors the list lacks by id', () => {
    const links = { 'cam-porch': 'zz-gone', 'cam-10': 'aa-gone', 'cam-2': 'd-front' }
    const cards = buildDoorCards(ALL, links, [GARAGE, FRONT])
    expect(cards.map((card) => [card.doorId, card.kind])).toEqual([
      ['d-front', 'listed'],
      ['d-garage', 'listed'],
      ['aa-gone', 'unknown'],
      ['zz-gone', 'unknown'],
    ])
  })

  it('gives a doorbell one entry: its package channel shares the door (CAM-4)', () => {
    const [card] = buildDoorCards([PORCH], { 'cam-porch': 'd-front' }, [FRONT])
    expect(card?.cameras).toEqual([{ cameraId: 'cam-porch', label: 'Porch', kind: 'inventory' }])
  })

  it('lists a door with no hub like any other; the card carries the door for the reason', () => {
    const [card] = buildDoorCards(ALL, { 'cam-drive': 'd-side' }, [SIDE])
    expect(card).toMatchObject({ title: 'Side Gate', kind: 'listed' })
    expect(card?.door?.boundToHub).toBe(false)
    expect(card?.cameras.map((c) => c.cameraId)).toEqual(['cam-drive'])
  })

  it('keeps a linked door the list lacks as "Unknown door", with no door on the card', () => {
    const [, card] = buildDoorCards(ALL, { 'cam-drive': 'd-gone' }, [FRONT])
    expect(card).toMatchObject({
      doorId: 'd-gone',
      kind: 'unknown',
      title: 'Unknown door (d-gone)',
      door: null,
    })
    expect(card?.cameras.map((c) => c.cameraId)).toEqual(['cam-drive'])
  })

  it('keeps every link while there is no list, as "Door <id>" cards, and through an empty one', () => {
    const links = { 'cam-drive': 'd-front', 'cam-porch': 'd-garage' }
    expect(buildDoorCards(ALL, links, null).map((card) => [card.title, card.kind])).toEqual([
      ['Door d-front', 'pending'],
      ['Door d-garage', 'pending'],
    ])
    // An empty list has been read, so these doors are known to be missing from it.
    expect(buildDoorCards(ALL, links, []).map((card) => [card.title, card.kind])).toEqual([
      ['Unknown door (d-front)', 'unknown'],
      ['Unknown door (d-garage)', 'unknown'],
    ])
  })

  it('lists a camera the inventory lacks by id, after the known ones', () => {
    const links = { 'cam-z': 'd-front', 'cam-a': 'd-front', 'cam-drive': 'd-front' }
    const [card] = buildDoorCards([DRIVEWAY], links, [FRONT])
    expect(card?.cameras).toEqual([
      { cameraId: 'cam-drive', label: 'Driveway', kind: 'inventory' },
      { cameraId: 'cam-a', label: 'Unknown camera (cam-a)', kind: 'unknown' },
      { cameraId: 'cam-z', label: 'Unknown camera (cam-z)', kind: 'unknown' },
    ])
  })

  it('says "not loaded yet", not unknown, while the inventory is empty', () => {
    const [card] = buildDoorCards([], { 'cam-a': 'd-front' }, [FRONT])
    expect(card?.cameras).toEqual([
      { cameraId: 'cam-a', label: notLoadedCameraLabel('cam-a'), kind: 'not-loaded' },
    ])
    expect(notLoadedCameraLabel('cam-a')).toBe('Camera cam-a — not loaded yet')
    expect(unknownCameraLabel('cam-a')).toBe('Unknown camera (cam-a)')
  })

  it('keeps a listed door as a card with no cameras after its last camera is unlinked', () => {
    const [card] = buildDoorCards(ALL, unlinkCamera({ 'cam-2': 'd-front' }, 'cam-2'), [FRONT])
    expect(card).toMatchObject({ doorId: 'd-front', kind: 'listed', cameras: [] })
    // …while a door the list lacks goes with its last link: there is nothing else to show of it.
    expect(buildDoorCards(ALL, unlinkCamera({ 'cam-2': 'd-gone' }, 'cam-2'), [FRONT])).toHaveLength(
      1,
    )
  })

  it('does not read an inherited property as a link', () => {
    const [card] = buildDoorCards([camera('constructor', 'Odd id')], {}, [FRONT])
    expect(card?.cameras).toEqual([])
  })
})

describe('the Add camera dropdown', () => {
  it('says why it is empty: cameras not loaded, or none unlinked', () => {
    expect(addCameraPlaceholder([], [])).toBe('Cameras not loaded yet')
    expect(addCameraPlaceholder([DRIVEWAY], [])).toBe('No unlinked cameras')
    expect(addCameraPlaceholder([DRIVEWAY], addCameraOptions([DRIVEWAY], {}))).toBe('Add camera…')
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

  it('never mutates the map it was given', () => {
    const before = structuredClone(links)
    linkCamera(links, 'cam-9', 'd-front')
    unlinkCamera(links, 'cam-1')
    expect(links).toEqual(before)
  })
})

describe('the screen body', () => {
  it('is loading with no list and no reason, an error with a reason', () => {
    expect(doorsBody({ doors: null, error: null })).toBe('loading')
    expect(doorsBody({ doors: null, error: error('auth') })).toBe('error')
  })

  it('is empty for a list with no doors, cards otherwise — whatever the error says', () => {
    expect(doorsBody({ doors: [], error: null })).toBe('empty')
    expect(doorsBody({ doors: [FRONT], error: null })).toBe('cards')
    expect(doorsBody({ doors: [FRONT], error: error('network') })).toBe('cards')
  })

  it('warns above the cards once the list is stale, and says the states are unknown', () => {
    const failing = error('network', 'The console did not answer.')
    expect(doorsReadWarning({ doors: [FRONT], stale: false, error: null })).toBeNull()
    // Main reports a failing read only together with `stale`; one that is not stale says nothing.
    expect(doorsReadWarning({ doors: [FRONT], stale: false, error: failing })).toBeNull()
    expect(doorsReadWarning({ doors: [FRONT], stale: true, error: failing })).toBe(
      'The doors cannot be read right now, so their states are not known. The console did not answer.',
    )
    // Stale with no reason still says so; no list is the error state's job, not this line's.
    expect(doorsReadWarning({ doors: [FRONT], stale: true, error: null })).toMatch(/not known\.$/)
    expect(doorsReadWarning({ doors: null, stale: false, error: failing })).toBeNull()
  })

  it('points each Settings-fixable failure at Settings', () => {
    expect(doorsErrorHint(error('pin-required'))).toBe('Accept the Access certificate in Settings.')
    expect(doorsErrorHint(error('pin-mismatch'))).toMatch(/different certificate.*Settings/)
    expect(doorsErrorHint(error('auth'))).toMatch(/valid Access API token in Settings/)
    expect(doorsErrorHint(error('not-configured'))).toMatch(/console address.*Settings/)
    expect(doorsErrorHint(error('disabled'))).toMatch(/Enable UniFi Access/)
    // Nothing in Settings fixes a console that is down; its own message says what happened.
    expect(doorsErrorHint(error('network'))).toBeNull()
    expect(doorsErrorHint(error('timeout'))).toBeNull()
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
    expect(cameraListNotice([], {})).toBe('Connect to the console to link cameras to doors.')
    expect(cameraListNotice([], { 'cam-1': 'd-front' })).toMatch(/linked ones show by id/)
    expect(cameraListNotice([DRIVEWAY], { 'cam-1': 'd-front' })).toBeNull()
  })
})
