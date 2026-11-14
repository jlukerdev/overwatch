// P2.4: the grid's pure decisions (VIEW-1, VIEW-5, CELL-1, QUAL-3).
//
// What these tests protect:
//  - the CSS template uses `minmax(0, 1fr)`, so a cell's content can never push the grid past the
//    window (VIEW-5's "no scrollbars").
//  - the temporary presets are VIEW-1 sizes and the assignment fills them in the camera list's
//    order, with empty slots past the camera count and no camera past the slot count.
//  - keys are camera ids, so a size change keeps the shared players mounted (no reconnects).
//  - the grid quality comes from the settings default through QUAL-3's chain, never a literal.
import type { Camera } from '@shared/ipc'
import { QUALITIES } from '@shared/quality'
import { describe, expect, it } from 'vitest'
import {
  assignTempGridSlots,
  emptySlotKey,
  gridTemplate,
  isValidGridSize,
  MAX_GRID_DIMENSION,
  slotCount,
  TEMP_GRID_PRESETS,
  tempGridQuality,
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

/** `n` cameras named `Cam 1`…`Cam n`, handed over in reverse so the sort has work to do. */
function cameras(n: number): Camera[] {
  return Array.from({ length: n }, (_, i) =>
    camera({ id: `id${String(i + 1)}`, name: `Cam ${String(i + 1)}` }),
  ).reverse()
}

const QUALITY = QUALITIES[1]

function cameraIds(slots: readonly GridSlot[]): (string | null)[] {
  return slots.map((slot) => (slot.kind === 'camera' ? slot.cameraId : null))
}

describe('gridTemplate (VIEW-5)', () => {
  it('gives every track an equal share with a zero minimum, so content cannot overflow', () => {
    expect(gridTemplate({ cols: 4, rows: 3 })).toEqual({
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
    })
  })
})

describe('isValidGridSize / slotCount (VIEW-1)', () => {
  it('accepts whole sizes from 1×1 to 4×4', () => {
    expect(isValidGridSize({ cols: 1, rows: 1 })).toBe(true)
    expect(isValidGridSize({ cols: MAX_GRID_DIMENSION, rows: MAX_GRID_DIMENSION })).toBe(true)
  })

  it.each([
    { cols: 0, rows: 3 },
    { cols: 3, rows: 5 },
    { cols: 2.5, rows: 2 },
    { cols: Number.NaN, rows: 2 },
  ])('rejects %o', (size) => {
    expect(isValidGridSize(size)).toBe(false)
  })

  it('counts cols × rows', () => {
    expect(slotCount({ cols: 4, rows: 3 })).toBe(12)
  })
})

describe('TEMP_GRID_PRESETS', () => {
  it('are exactly 3×3 and 4×3, as cols × rows, and valid VIEW-1 sizes', () => {
    expect(TEMP_GRID_PRESETS.map((p) => [p.cols, p.rows])).toEqual([
      [3, 3],
      [4, 3],
    ])
    expect(TEMP_GRID_PRESETS.every(isValidGridSize)).toBe(true)
    expect(new Set(TEMP_GRID_PRESETS.map((p) => p.id)).size).toBe(TEMP_GRID_PRESETS.length)
  })
})

describe('assignTempGridSlots', () => {
  it('fills slots in the camera list order (numeric, by display name)', () => {
    const slots = assignTempGridSlots(cameras(9), { cols: 3, rows: 3 }, QUALITY)
    expect(cameraIds(slots)).toEqual([
      'id1',
      'id2',
      'id3',
      'id4',
      'id5',
      'id6',
      'id7',
      'id8',
      'id9',
    ])
  })

  it('leaves slots past the camera count empty, with distinct keys', () => {
    const slots = assignTempGridSlots(cameras(10), { cols: 4, rows: 3 }, QUALITY)
    expect(slots).toHaveLength(12)
    expect(cameraIds(slots).slice(10)).toEqual([null, null])
    expect(slots[10]).toEqual({ kind: 'empty', key: emptySlotKey(10) })
    expect(new Set(slots.map((s) => s.key)).size).toBe(12)
  })

  it('shows only the first cols × rows cameras when there are more', () => {
    const slots = assignTempGridSlots(cameras(15), { cols: 3, rows: 3 }, QUALITY)
    expect(slots).toHaveLength(9)
    expect(cameraIds(slots)).not.toContain('id10')
  })

  it('keys a camera by its id, so 3×3 → 4×3 keeps the same nine players', () => {
    const inventory = cameras(12)
    const small = assignTempGridSlots(inventory, { cols: 3, rows: 3 }, QUALITY)
    const large = assignTempGridSlots(inventory, { cols: 4, rows: 3 }, QUALITY)
    expect(large.slice(0, 9).map((s) => s.key)).toEqual(small.map((s) => s.key))
    expect(small.map((s) => s.key)).toEqual(cameraIds(small))
  })

  it('keeps offline cameras in place rather than shifting later cameras up (CAM-3)', () => {
    const inventory = [
      camera({ id: 'a', name: 'A' }),
      camera({ id: 'b', name: 'B', state: 'DISCONNECTED' }),
      camera({ id: 'c', name: 'C' }),
    ]
    expect(cameraIds(assignTempGridSlots(inventory, { cols: 2, rows: 2 }, QUALITY))).toEqual([
      'a',
      'b',
      'c',
      null,
    ])
  })

  it('uses the display-name fallback and passes the given quality through', () => {
    const [slot] = assignTempGridSlots(
      [camera({ id: 'x', name: null, model: 'G4 Bullet' })],
      { cols: 1, rows: 1 },
      QUALITY,
    )
    expect(slot).toEqual({
      kind: 'camera',
      key: 'x',
      cameraId: 'x',
      name: 'G4 Bullet',
      quality: QUALITY,
    })
  })

  it('renders nothing for an invalid size instead of a runaway grid', () => {
    expect(assignTempGridSlots(cameras(3), { cols: 0, rows: 3 }, QUALITY)).toEqual([])
    expect(assignTempGridSlots(cameras(3), { cols: 100, rows: 100 }, QUALITY)).toEqual([])
  })

  it('returns all-empty slots when there are no cameras', () => {
    expect(cameraIds(assignTempGridSlots([], { cols: 3, rows: 3 }, QUALITY))).toEqual(
      Array.from({ length: 9 }, () => null),
    )
  })
})

describe('tempGridQuality (QUAL-1/3)', () => {
  it.each(QUALITIES)('is the settings grid default (%s), not the fill default', (quality) => {
    const fill = QUALITIES.find((q) => q !== quality) ?? quality
    expect(tempGridQuality({ defaultGridQuality: quality, defaultFillQuality: fill })).toBe(quality)
  })
})
