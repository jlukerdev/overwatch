// P5.3 (DOOR-1, DOOR-2): the door-link card's rows, tested where they live.
//
// Like settingsForm.ts, the card's component cannot be tested here (no jsdom, vitest.config.mts), so
// every rule about which rows exist, what they say and what a change sends is in doorLinks.ts. The
// one that matters most is rule 1: a stored link is never pruned — not by a failed list, not by an
// empty one, not by a door or a camera the app cannot see right now.
import { CameraSchema, DoorSchema, type Camera, type Door } from '@shared/models'
import { SettingsSchema } from '@shared/models'
import type { IpcError, SecretsStored } from '@shared/ipc'
import { sortByLabel } from '@shared/cameraOrder'
import { describe, expect, it } from 'vitest'
import {
  buildDoorLinkRows,
  doorLabel,
  doorListHint,
  doorListNotice,
  doorsSelectable,
  NO_HUB_SUFFIX,
  NOT_LINKED,
  sameLink,
  sortedDoors,
  UNKNOWN_CAMERA_LABEL,
  cameraListNotice,
  doorLinkFieldId,
  doorListKey,
  notLoadedCameraLabel,
  withLink,
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
const loaded = (...doors: Door[]): DoorListState => ({ state: 'loaded', doors })
const LOADING: DoorListState = { state: 'loading' }
const FAILED: DoorListState = { state: 'failed', error: error('network') }

const DRIVEWAY = camera('cam-drive', 'Driveway')
const PORCH = camera('cam-porch', 'Porch', { hasPackageCamera: true })
const CAM10 = camera('cam-10', 'Cam 10')
const CAM2 = camera('cam-2', 'Cam 2')

describe('doorLabel', () => {
  it('uses full_name, then name, then the id', () => {
    expect(doorLabel(FRONT)).toBe('Ground Floor - Front Door')
    expect(doorLabel(door('x', { fullName: '  ', name: 'Back' }))).toBe('Back')
    expect(doorLabel(door('x', { fullName: '', name: '' }))).toBe('x')
  })

  it('labels a door with no hub as unable to unlock remotely, but keeps it', () => {
    const noHub = door('x', { fullName: 'Side Gate', boundToHub: false })
    expect(doorLabel(noHub)).toBe(`Side Gate${NO_HUB_SUFFIX}`)
    expect(NO_HUB_SUFFIX).toMatch(/remote unlock unavailable/)
  })
})

describe('sortedDoors', () => {
  it('sorts by label with numbers as numbers, keeping ties in console order', () => {
    const d10 = door('a', { fullName: 'Door 10' })
    const d2 = door('b', { fullName: 'Door 2' })
    const twinA = door('c', { fullName: 'Twin' })
    const twinB = door('d', { fullName: 'twin' })
    expect(sortedDoors([d10, twinA, d2, twinB]).map((d) => d.id)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('buildDoorLinkRows', () => {
  it('has one row per inventory camera, in camera-list order', () => {
    const rows = buildDoorLinkRows([PORCH, CAM10, DRIVEWAY, CAM2], {}, loaded(FRONT))
    expect(rows.map((row) => row.cameraLabel)).toEqual(['Cam 2', 'Cam 10', 'Driveway', 'Porch'])
    expect(rows.every((row) => row.camera === 'inventory' && row.status === 'unlinked')).toBe(true)
  })

  it('gives a doorbell one row: its package channel shares the link (CAM-4)', () => {
    const rows = buildDoorLinkRows([PORCH], { 'cam-porch': 'd-front' }, loaded(FRONT))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ cameraId: 'cam-porch', doorId: 'd-front', status: 'linked' })
  })

  it('falls back to the model, then the id, for a camera with no name (CAM-1)', () => {
    const rows = buildDoorLinkRows(
      [camera('cam-x', null, { model: 'G4 Doorbell' }), camera('cam-y', null)],
      {},
      LOADING,
    )
    expect(rows.map((row) => row.cameraLabel)).toEqual(['cam-y', 'G4 Doorbell'])
  })

  it('offers "Not linked" first and every door by label, no-hub doors included', () => {
    const side = door('d-side', { fullName: 'Side Gate', boundToHub: false })
    const [row] = buildDoorLinkRows([DRIVEWAY], {}, loaded(side, GARAGE, FRONT))
    expect(row?.options).toEqual([
      { value: NOT_LINKED, label: 'Not linked' },
      { value: 'd-front', label: 'Ground Floor - Front Door' },
      { value: 'd-garage', label: 'Ground Floor - Garage' },
      { value: 'd-side', label: `Side Gate${NO_HUB_SUFFIX}` },
    ])
    expect(row?.selectable).toBe(true)
    expect(row?.unlinkButton).toBe(false)
  })

  it('lets several cameras link to the same door', () => {
    const rows = buildDoorLinkRows(
      [DRIVEWAY, PORCH],
      { 'cam-drive': 'd-front', 'cam-porch': 'd-front' },
      loaded(FRONT),
    )
    expect(rows.map((row) => [row.status, row.doorLabel])).toEqual([
      ['linked', 'Ground Floor - Front Door'],
      ['linked', 'Ground Floor - Front Door'],
    ])
  })

  it('shows a stored door the loaded list lacks as "Unknown door", still selected', () => {
    const [row] = buildDoorLinkRows([DRIVEWAY], { 'cam-drive': 'd-gone' }, loaded(FRONT))
    expect(row).toMatchObject({
      doorId: 'd-gone',
      status: 'unknown-door',
      doorLabel: 'Unknown door (d-gone)',
      selectable: true,
      // "Not linked" in the select is the way to unlink it.
      unlinkButton: false,
    })
    // Among the options, so the select can show it as the current value.
    expect(row?.options?.map((option) => option.value)).toEqual([NOT_LINKED, 'd-gone', 'd-front'])
  })

  it('keeps every link through a failed list, with selects disabled and an Unlink button', () => {
    const links = { 'cam-drive': 'd-front', 'cam-gone': 'd-garage' }
    const rows = buildDoorLinkRows([DRIVEWAY, PORCH], links, FAILED)
    expect(rows.map((row) => [row.cameraId, row.doorId, row.status])).toEqual([
      ['cam-drive', 'd-front', 'pending'],
      ['cam-porch', null, 'unlinked'],
      ['cam-gone', 'd-garage', 'pending'],
    ])
    expect(rows.every((row) => !row.selectable)).toBe(true)
    // Only a linked row has something to unlink.
    expect(rows.map((row) => row.unlinkButton)).toEqual([true, false, true])
    // The stored door is listed by id, since nothing else is known about it.
    expect(rows[0]?.doorLabel).toBe('Door d-front')
    expect(rows[0]?.options).toEqual([
      { value: NOT_LINKED, label: 'Not linked' },
      { value: 'd-front', label: 'Door d-front' },
    ])
  })

  it('treats a loading list the same way: links kept, nothing to pick yet', () => {
    const [row] = buildDoorLinkRows([DRIVEWAY], { 'cam-drive': 'd-front' }, LOADING)
    expect(row).toMatchObject({ status: 'pending', selectable: false, unlinkButton: true })
  })

  it('keeps links through an empty list, as unknown doors that can be unlinked', () => {
    const [row] = buildDoorLinkRows([DRIVEWAY], { 'cam-drive': 'd-front' }, loaded())
    expect(row).toMatchObject({
      status: 'unknown-door',
      doorLabel: 'Unknown door (d-front)',
      selectable: false,
      unlinkButton: true,
    })
  })

  it('gives a link whose camera is not in the inventory its own row, after the cameras', () => {
    const links = { 'cam-z': 'd-front', 'cam-a': 'd-gone', 'cam-drive': 'd-garage' }
    const rows = buildDoorLinkRows([DRIVEWAY], links, loaded(FRONT, GARAGE))
    expect(rows.map((row) => row.cameraId)).toEqual(['cam-drive', 'cam-a', 'cam-z'])
    expect(rows[1]).toMatchObject({
      cameraLabel: UNKNOWN_CAMERA_LABEL,
      camera: 'unknown',
      status: 'unknown-door',
      doorLabel: 'Unknown door (d-gone)',
      options: null,
      selectable: false,
      unlinkButton: true,
    })
    expect(rows[2]).toMatchObject({ status: 'linked', doorLabel: 'Ground Floor - Front Door' })
  })

  it('lists stored links before the console is connected, as not loaded yet, not unknown', () => {
    const rows = buildDoorLinkRows([], { 'cam-b': 'd-front', 'cam-a': 'd-garage' }, LOADING)
    expect(rows).toEqual([
      expect.objectContaining({
        cameraId: 'cam-a',
        cameraLabel: notLoadedCameraLabel('cam-a'),
        camera: 'not-loaded',
        unlinkButton: true,
      }),
      expect.objectContaining({ cameraId: 'cam-b', camera: 'not-loaded' }),
    ])
    expect(notLoadedCameraLabel('cam-a')).toBe('Camera cam-a — not loaded yet')
    expect(rows.some((row) => row.cameraLabel === UNKNOWN_CAMERA_LABEL)).toBe(false)
    expect(buildDoorLinkRows([], {}, loaded(FRONT))).toEqual([])
  })

  it('calls a camera unknown only once there is an inventory it is missing from', () => {
    const links = { 'cam-gone': 'd-front' }
    expect(buildDoorLinkRows([], links, loaded(FRONT))[0]?.camera).toBe('not-loaded')
    expect(buildDoorLinkRows([DRIVEWAY], links, loaded(FRONT))[1]).toMatchObject({
      camera: 'unknown',
      cameraLabel: UNKNOWN_CAMERA_LABEL,
    })
  })

  it('does not read an inherited property as a link', () => {
    const [row] = buildDoorLinkRows([camera('constructor', 'Odd id')], {}, loaded(FRONT))
    expect(row?.doorId).toBeNull()
  })
})

describe('withLink / sameLink', () => {
  const links = { 'cam-1': 'd-front', 'cam-2': 'd-garage' }

  it('links, relinks and keeps every other link', () => {
    expect(withLink(links, 'cam-3', 'd-front')).toEqual({ ...links, 'cam-3': 'd-front' })
    expect(withLink(links, 'cam-1', 'd-garage')).toEqual({
      'cam-1': 'd-garage',
      'cam-2': 'd-garage',
    })
  })

  it('removes the key on unlink, by "Not linked" or by the button', () => {
    expect(withLink(links, 'cam-1', NOT_LINKED)).toEqual({ 'cam-2': 'd-garage' })
    expect(withLink(links, 'cam-1', null)).toEqual({ 'cam-2': 'd-garage' })
    expect(Object.keys(withLink(links, 'cam-1', null))).not.toContain('cam-1')
  })

  it('never mutates the map it was given', () => {
    const before = structuredClone(links)
    withLink(links, 'cam-1', null)
    withLink(links, 'cam-9', 'd-front')
    expect(links).toEqual(before)
  })

  it('tells a no-op change apart, so the card skips the save', () => {
    expect(sameLink(links, 'cam-1', 'd-front')).toBe(true)
    expect(sameLink(links, 'cam-1', 'd-garage')).toBe(false)
    expect(sameLink(links, 'cam-3', NOT_LINKED)).toBe(true)
    expect(sameLink(links, 'cam-3', null)).toBe(true)
    expect(sameLink(links, 'cam-1', NOT_LINKED)).toBe(false)
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

describe('doorLinkFieldId', () => {
  it('builds a DOM id from the camera id, not the row position', () => {
    expect(doorLinkFieldId('65a1f0c2')).toBe('door-link-65a1f0c2')
  })

  it('escapes everything else, one-to-one, so two cameras never share an id', () => {
    const ids = ['a b', 'a_b', 'a_20_b', 'a.b', 'a:b', 'ä']
    const dom = ids.map(doorLinkFieldId)
    expect(new Set(dom).size).toBe(ids.length)
    for (const id of dom) expect(id).toMatch(/^door-link-[A-Za-z0-9_]+$/)
  })
})

describe('cameraListNotice', () => {
  it('asks to connect while there is no inventory, and says the links are kept', () => {
    expect(cameraListNotice([], {})).toBe('Connect to the console to list cameras.')
    expect(cameraListNotice([], { 'cam-1': 'd-front' })).toMatch(/kept.*camera id/)
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
