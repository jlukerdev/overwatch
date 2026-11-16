// P3.2: what a View puts on screen (src/renderer/src/features/grid/gridLayout.ts; VIEW-1/2/5,
// CELL-1, CAM-4, QUAL-3).
//
// What these tests protect:
//  - every cell becomes exactly one slot, in the View's order, carrying its placement for `cellRect`.
//  - (P4.2, CELL-2) a cell shows the camera its scheduler picks (`shown`: slot key → index), its
//    first by default or when the index is out of range; the slot's key follows the cell's first
//    ref, so it is stable while the shown camera changes; `schedulerEntries` uses exactly the same
//    keys; a missing ref in a multi-camera cell takes its turn as a `missing` slot; camera and
//    missing slots carry their `position` for P4.3.
//  - quality comes from QUAL-3's chain (cell → View → settings), never a literal; a
//    `<cameraId>:package` ref plays the package channel instead (CAM-4).
//  - fill quality (P3.5) comes from QUAL-5's chain (View → settings), and a package ref stays on the
//    package channel in fill too.
//  - keys follow the camera across Views and stay distinct for duplicates in one View, so a View
//    switch keeps shared players mounted and React never sees two siblings with one key.
//  - (P3.7, QUAL-4) a camera slot carries its picker's data: the cell's own override and what it
//    gets with the override cleared (View, then settings); a package ref has no picker.
//  - a camera the inventory no longer has gets a `missing` slot, not a player; so does a package
//    ref to a camera without `hasPackageCamera`.
import type { Camera } from '@shared/ipc'
import type { Cell, View } from '@shared/models'
import { PACKAGE_CHANNEL, type QualityDefaults } from '@shared/quality'
import { LAYOUT_PRESETS, presetCells, uniformCells } from '@shared/viewLayout'
import { describe, expect, it } from 'vitest'
import {
  buildViewSlots,
  cameraSlotKey,
  cellSlotKeys,
  emptySlotKey,
  parseCameraRef,
  schedulerEntries,
  type GridSlot,
} from '../../src/renderer/src/features/grid/gridLayout'

function camera(overrides: Partial<Camera> & { id: string }): Camera {
  return {
    name: null,
    model: '',
    state: 'CONNECTED',
    hasMic: false,
    micEnabled: false,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: false,
    hasPackageCamera: false,
    ...overrides,
  }
}

const INVENTORY: Camera[] = [
  camera({ id: 'a', name: 'Front' }),
  camera({ id: 'b', name: 'Back' }),
  camera({ id: 'd', name: 'Doorbell', hasPackageCamera: true }),
  camera({ id: 'm', model: 'G4 Bullet' }),
]

const STREAMS: QualityDefaults = { defaultGridQuality: 'low', defaultFillQuality: 'high' }

/** A View whose cells hold `ids[i]` (a string, an array, or nothing) in canonical order. */
function view(
  cols: number,
  rows: number,
  ids: readonly (string | readonly string[] | null)[],
  overrides: Partial<View> = {},
  cells: Cell[] = uniformCells(cols, rows),
): View {
  return {
    id: 'v',
    name: 'V',
    cols,
    rows,
    fit: 'contain',
    aspect: { w: 16, h: 9 },
    gap: 0,
    gridQuality: null,
    fillQuality: null,
    showNames: true,
    cells: cells.map((cell, i) => {
      const entry = ids[i] ?? null
      return {
        ...cell,
        cameraIds: entry === null ? [] : typeof entry === 'string' ? [entry] : [...entry],
      }
    }),
    ...overrides,
  }
}

function slots(
  v: View,
  cameras: readonly Camera[] = INVENTORY,
  shown?: ReadonlyMap<string, number>,
): GridSlot[] {
  return buildViewSlots({ view: v, cameras, streams: STREAMS, ...(shown ? { shown } : {}) })
}

function cameraSlot(slot: GridSlot | undefined): Extract<GridSlot, { kind: 'camera' }> {
  if (slot?.kind !== 'camera') throw new Error(`expected a camera slot, got ${String(slot?.kind)}`)
  return slot
}

describe('parseCameraRef (CAM-4)', () => {
  it('reads a plain camera id as itself', () => {
    expect(parseCameraRef('abc123')).toEqual({ cameraId: 'abc123', packageChannel: false })
  })

  it('reads `<id>:package` as the package channel of that camera', () => {
    expect(parseCameraRef(`abc123:${PACKAGE_CHANNEL}`)).toEqual({
      cameraId: 'abc123',
      packageChannel: true,
    })
  })

  it('does not treat a bare `:package` or another suffix as a package ref', () => {
    expect(parseCameraRef(':package')).toEqual({ cameraId: ':package', packageChannel: false })
    expect(parseCameraRef('abc:low')).toEqual({ cameraId: 'abc:low', packageChannel: false })
    expect(parseCameraRef('abc:packages')).toEqual({
      cameraId: 'abc:packages',
      packageChannel: false,
    })
  })
})

describe('buildViewSlots: placement and contents', () => {
  it('makes one slot per cell, in order, with each cell’s placement', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === '1+5')
    if (preset === undefined) throw new Error('missing preset')
    const v = view(3, 3, ['a', 'b'], {}, presetCells(preset))
    const result = slots(v)
    expect(result).toHaveLength(preset.cells.length)
    expect(result.map((s) => s.placement)).toEqual(preset.cells)
    expect(result.map((s) => s.kind)).toEqual([
      'camera',
      'camera',
      'empty',
      'empty',
      'empty',
      'empty',
    ])
  })

  it('names the camera by its display name, with the model as fallback', () => {
    const result = slots(view(2, 1, ['a', 'm']))
    expect(result.map((s) => cameraSlot(s).name)).toEqual(['Front', 'G4 Bullet'])
  })

  it('shows the first camera of a multi-camera cell without a scheduler', () => {
    const slot = cameraSlot(slots(view(1, 1, [['b', 'a']]))[0])
    expect(slot.cameraId).toBe('b')
    expect(slot.position).toEqual({ index: 0, count: 2 })
  })

  it('passes the View’s fit through', () => {
    const slot = cameraSlot(slots(view(1, 1, ['a'], { fit: 'cover' }))[0])
    expect(slot.fit).toBe('cover')
  })

  it('renders a View with every cell empty as empty slots', () => {
    expect(slots(view(2, 2, [])).map((s) => s.kind)).toEqual(['empty', 'empty', 'empty', 'empty'])
  })
})

describe('buildViewSlots: quality (QUAL-3, CAM-4)', () => {
  it('falls back to the settings default with no overrides', () => {
    expect(cameraSlot(slots(view(1, 1, ['a']))[0]).quality).toBe('low')
  })

  it('takes the View override over the settings default', () => {
    expect(cameraSlot(slots(view(1, 1, ['a'], { gridQuality: 'medium' }))[0]).quality).toBe(
      'medium',
    )
  })

  it('takes the cell override over the View', () => {
    const v = view(2, 1, ['a', 'b'], { gridQuality: 'medium' })
    const cells = v.cells.map((cell, i) => (i === 0 ? { ...cell, quality: 'high' as const } : cell))
    const result = slots({ ...v, cells })
    expect(result.map((s) => cameraSlot(s).quality)).toEqual(['high', 'medium'])
  })

  it('plays the package channel for a package ref, whatever the overrides say', () => {
    const v = view(1, 1, [`d:${PACKAGE_CHANNEL}`], { gridQuality: 'high' })
    const slot = cameraSlot(slots(v)[0])
    expect(slot).toMatchObject({
      cameraId: 'd',
      quality: PACKAGE_CHANNEL,
      name: 'Doorbell (package)',
    })
  })
})

describe('buildViewSlots: fill quality (FILL-2, QUAL-5)', () => {
  it('falls back to the settings fill default with no overrides', () => {
    expect(cameraSlot(slots(view(1, 1, ['a']))[0]).fillQuality).toBe('high')
  })

  it('takes the View’s fill override over the settings default', () => {
    const v = view(1, 1, ['a'], { fillQuality: 'medium' })
    expect(cameraSlot(slots(v)[0]).fillQuality).toBe('medium')
  })

  it('ignores the grid chain: neither a cell nor a View grid override changes it', () => {
    const v = view(2, 1, ['a', 'b'], { gridQuality: 'medium' })
    const cells = v.cells.map((cell, i) => (i === 0 ? { ...cell, quality: 'low' as const } : cell))
    const result = slots({ ...v, cells })
    expect(result.map((s) => cameraSlot(s).fillQuality)).toEqual(['high', 'high'])
  })

  it('follows the settings default when it is not `high`', () => {
    const result = buildViewSlots({
      view: view(1, 1, ['a']),
      cameras: INVENTORY,
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'medium' },
    })
    expect(cameraSlot(result[0]).fillQuality).toBe('medium')
  })

  it('keeps the package channel in fill for a package ref', () => {
    const v = view(1, 1, [`d:${PACKAGE_CHANNEL}`], { fillQuality: 'high' })
    expect(cameraSlot(slots(v)[0]).fillQuality).toBe(PACKAGE_CHANNEL)
  })
})

describe('buildViewSlots: quality picker (QUAL-4)', () => {
  it('carries the cell override and what clearing it gives: the View’s grid quality', () => {
    const v = view(2, 1, ['a', 'b'], { gridQuality: 'medium' })
    const cells = v.cells.map((cell, i) => (i === 0 ? { ...cell, quality: 'high' as const } : cell))
    const result = slots({ ...v, cells })
    expect(result.map((s) => cameraSlot(s).qualityChoice)).toEqual([
      { override: 'high', inherited: 'medium' },
      { override: null, inherited: 'medium' },
    ])
  })

  it('falls back to the settings grid default for what clearing gives', () => {
    expect(cameraSlot(slots(view(1, 1, ['a']))[0]).qualityChoice).toEqual({
      override: null,
      inherited: 'low',
    })
  })

  it('has no picker for a package ref', () => {
    const v = view(1, 1, [`d:${PACKAGE_CHANNEL}`])
    expect(cameraSlot(slots(v)[0]).qualityChoice).toBeNull()
  })
})

describe('buildViewSlots: keys', () => {
  it('keys a camera by ref and occurrence, so it is the same in two Views', () => {
    const first = slots(view(2, 1, ['a', 'b']))
    const second = slots(view(3, 3, [null, null, 'b', 'a']))
    const keyOf = (list: GridSlot[], id: string): string | undefined =>
      list.find((s) => s.kind === 'camera' && s.cameraId === id)?.key
    expect(keyOf(first, 'a')).toBe(cameraSlotKey('a', 0))
    expect(keyOf(second, 'a')).toBe(keyOf(first, 'a'))
    expect(keyOf(second, 'b')).toBe(keyOf(first, 'b'))
  })

  it('gives duplicates of one camera distinct keys, and a package ref its own', () => {
    const result = slots(view(2, 2, ['a', 'a', `a:${PACKAGE_CHANNEL}`]))
    expect(result.map((s) => s.key)).toEqual([
      cameraSlotKey('a', 0),
      cameraSlotKey('a', 1),
      cameraSlotKey(`a:${PACKAGE_CHANNEL}`, 0),
      emptySlotKey({ col: 1, row: 1 }),
    ])
  })

  it('keys empty slots by position, and never collides with a camera key', () => {
    const result = slots(view(4, 4, ['a']))
    const keys = result.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(result[1]?.key).toBe(emptySlotKey({ col: 1, row: 0 }))
  })
})

describe('buildViewSlots: a camera no longer on the console (CAM-2)', () => {
  it('gives it a missing slot with its ref and its camera key, and no player', () => {
    const [slot] = slots(view(1, 1, ['gone']))
    expect(slot).toEqual({
      kind: 'missing',
      key: cameraSlotKey('gone', 0),
      placement: { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      ref: 'gone',
      label: 'Camera not found (gone)',
      position: { index: 0, count: 1 },
    })
  })

  it('treats a package ref to a missing camera the same way', () => {
    expect(slots(view(1, 1, [`gone:${PACKAGE_CHANNEL}`]))[0]?.kind).toBe('missing')
  })

  it('becomes a camera slot again, under the same key, when the camera comes back', () => {
    const v = view(1, 1, ['z'])
    const before = slots(v)[0]
    const after = slots(v, [...INVENTORY, camera({ id: 'z', name: 'Back again' })])[0]
    expect(before?.kind).toBe('missing')
    expect(after?.kind).toBe('camera')
    expect(after?.key).toBe(before?.key)
  })
})

describe('buildViewSlots: a package ref to a camera without a package camera (CAM-4)', () => {
  it('gives it a missing slot naming the camera, with its camera key, and no player', () => {
    const [slot] = slots(view(1, 1, [`a:${PACKAGE_CHANNEL}`]))
    expect(slot).toEqual({
      kind: 'missing',
      key: cameraSlotKey(`a:${PACKAGE_CHANNEL}`, 0),
      placement: { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      ref: `a:${PACKAGE_CHANNEL}`,
      label: 'No package camera (Front)',
      position: { index: 0, count: 1 },
    })
  })

  it('still shows the camera itself in another cell', () => {
    const result = slots(view(2, 1, ['a', `a:${PACKAGE_CHANNEL}`]))
    expect(result.map((s) => s.kind)).toEqual(['camera', 'missing'])
  })

  it('becomes a package player, under the same key, when the flag comes back', () => {
    const v = view(1, 1, [`a:${PACKAGE_CHANNEL}`])
    const before = slots(v)[0]
    const withPackage = INVENTORY.map((c) => (c.id === 'a' ? { ...c, hasPackageCamera: true } : c))
    const after = cameraSlot(slots(v, withPackage)[0])
    expect(before?.kind).toBe('missing')
    expect(after).toMatchObject({ quality: PACKAGE_CHANNEL, key: before?.key })
  })
})

describe('buildViewSlots: multi-camera cells (P4.2, CELL-2)', () => {
  const key = cameraSlotKey('a', 0)

  it('draws the ref the shown map picks, with its position', () => {
    const slot = cameraSlot(slots(view(1, 1, [['a', 'b', 'm']]), INVENTORY, new Map([[key, 2]]))[0])
    expect(slot).toMatchObject({
      cameraId: 'm',
      name: 'G4 Bullet',
      position: { index: 2, count: 3 },
    })
  })

  it('keeps the slot key on the first ref whichever camera is shown', () => {
    const v = view(1, 1, [['a', 'b']])
    const keys = [0, 1].map((index) => slots(v, INVENTORY, new Map([[key, index]]))[0]?.key)
    expect(keys).toEqual([key, key])
  })

  it('falls back to the first ref for an index out of range or not a whole number', () => {
    const v = view(1, 1, [['a', 'b']])
    for (const index of [2, -1, 0.5, Number.NaN]) {
      const slot = cameraSlot(slots(v, INVENTORY, new Map([[key, index]]))[0])
      expect(slot.cameraId).toBe('a')
      expect(slot.position).toEqual({ index: 0, count: 2 })
    }
  })

  it('ignores the map for slots it does not name', () => {
    const v = view(2, 1, [['a', 'b'], 'm'])
    const result = slots(v, INVENTORY, new Map([['cam:other#0', 1]]))
    expect(result.map((s) => cameraSlot(s).cameraId)).toEqual(['a', 'm'])
  })

  it('draws a missing ref in its turn as "Camera not found", under the same key', () => {
    const v = view(1, 1, [['a', 'gone']])
    const slot = slots(v, INVENTORY, new Map([[key, 1]]))[0]
    expect(slot).toMatchObject({
      kind: 'missing',
      key,
      ref: 'gone',
      label: 'Camera not found (gone)',
      position: { index: 1, count: 2 },
    })
  })

  it('applies the package rules to the shown ref', () => {
    const v = view(1, 1, [['b', `d:${PACKAGE_CHANNEL}`, `a:${PACKAGE_CHANNEL}`]])
    const k = cameraSlotKey('b', 0)
    expect(cameraSlot(slots(v, INVENTORY, new Map([[k, 1]]))[0]).quality).toBe(PACKAGE_CHANNEL)
    expect(slots(v, INVENTORY, new Map([[k, 2]]))[0]?.kind).toBe('missing')
  })
})

describe('schedulerEntries and cellSlotKeys (P4.2)', () => {
  it('lists each cell with cameras under exactly the key buildViewSlots gives it', () => {
    // Duplicate first refs across cells, a package ref and empty cells.
    const v = view(3, 2, [['a', 'b'], 'a', null, ['a', 'm'], `d:${PACKAGE_CHANNEL}`, null])
    const entries = schedulerEntries(v)
    const camKeys = slots(v)
      .filter((s) => s.kind !== 'empty')
      .map((s) => s.key)
    expect(entries.map((e) => e.key)).toEqual(camKeys)
    expect(entries.map((e) => e.key)).toEqual([
      cameraSlotKey('a', 0),
      cameraSlotKey('a', 1),
      cameraSlotKey('a', 2),
      cameraSlotKey(`d:${PACKAGE_CHANNEL}`, 0),
    ])
    expect(entries[0]?.cell).toBe(v.cells[0])
  })

  it('counts occurrences of first refs only', () => {
    // `b` second in the first cell does not bump the key of the cell led by `b`.
    expect(cellSlotKeys(view(2, 1, [['a', 'b'], 'b']))).toEqual([
      cameraSlotKey('a', 0),
      cameraSlotKey('b', 0),
    ])
  })

  it('is null for an empty cell, and lists no entry for it', () => {
    const v = view(2, 1, [null, 'a'])
    expect(cellSlotKeys(v)).toEqual([null, cameraSlotKey('a', 0)])
    expect(schedulerEntries(v).map((e) => e.key)).toEqual([cameraSlotKey('a', 0)])
  })
})
