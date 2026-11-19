// P3.7: the quality pickers' vocabulary and edit (src/renderer/src/features/quality/qualityChoice.ts;
// QUAL-2/3/4/5).
//
// What these tests protect:
//  - the options are QUALITIES in order, each named, and no option value collides: "inherit" (`''`)
//    and the fill picker's Save are never read back as a quality.
//  - a level round-trips through a select value, `null` included.
//  - the inherit option names what inheriting gives with the QUAL-7 badge's text.
//  - `setCellQuality` edits only the cell at that top-left slot, and hands back the same View when
//    nothing changes.
import type { Cell, View } from '@shared/models'
import { QUALITIES, qualityBadgeLabel } from '@shared/quality'
import { uniformCells } from '@shared/viewLayout'
import { describe, expect, it } from 'vitest'
import {
  inheritOptionLabel,
  INHERIT_OPTION,
  parseQualityOption,
  QUALITY_OPTIONS,
  qualityName,
  qualityOptionValue,
  setCellQuality,
} from '../../src/renderer/src/features/quality/qualityChoice'

function view(cells: Cell[]): View {
  return {
    id: 'v',
    name: 'V',
    cols: 2,
    rows: 2,
    fit: 'contain',
    aspect: { w: 16, h: 9 },
    gap: 0,
    gridQuality: null,
    fillQuality: null,
    showNames: true,
    cells,
  }
}

describe('quality options', () => {
  it('offers every quality, best first, each with a name', () => {
    expect(QUALITY_OPTIONS).toEqual(QUALITIES)
    for (const quality of QUALITY_OPTIONS) expect(qualityName(quality)).not.toBe('')
    expect(new Set(QUALITY_OPTIONS.map(qualityName)).size).toBe(QUALITY_OPTIONS.length)
    // The words every select shows, the Cameras screen's QUAL-1 defaults included (QualityOptions).
    expect(QUALITY_OPTIONS.map(qualityName)).toEqual(['High', 'Medium', 'Low'])
  })

  it('round-trips every level through a select value', () => {
    for (const level of [...QUALITIES, null]) {
      expect(parseQualityOption(qualityOptionValue(level))).toBe(level)
    }
    expect(qualityOptionValue(null)).toBe(INHERIT_OPTION)
  })

  it('never reads the inherit option as a quality', () => {
    expect(parseQualityOption(INHERIT_OPTION)).toBeNull()
    expect(QUALITY_OPTIONS.map(qualityOptionValue)).not.toContain(INHERIT_OPTION)
  })

  it('reads anything else, the package channel included, as inherit', () => {
    expect(parseQualityOption('package')).toBeNull()
    expect(parseQualityOption('HIGH')).toBeNull()
  })

  it('names what inheriting gives with the badge text, or only the prefix when unknown', () => {
    for (const quality of QUALITIES) {
      // The grid cell picker's prefix (QualityPicker.tsx, QUAL-4).
      expect(inheritOptionLabel('Default', quality)).toBe(`Default (${qualityBadgeLabel(quality)})`)
    }
    expect(inheritOptionLabel('App default', undefined)).toBe('App default')
    expect(inheritOptionLabel('App default', null)).toBe('App default')
  })
})

describe('setCellQuality (QUAL-4)', () => {
  const [high, medium] = QUALITIES

  it('sets the override of the cell at that top-left slot only', () => {
    const v = view(uniformCells(2, 2))
    const next = setCellQuality(v, 1, 0, high)
    expect(next.cells.map((c) => c.quality)).toEqual([null, high, null, null])
    expect(v.cells.map((c) => c.quality)).toEqual([null, null, null, null])
  })

  it('clears the override with null', () => {
    const v = setCellQuality(view(uniformCells(2, 2)), 0, 1, medium)
    expect(setCellQuality(v, 0, 1, null).cells.map((c) => c.quality)).toEqual([
      null,
      null,
      null,
      null,
    ])
  })

  it('addresses a spanned cell by its top-left slot, not a slot it covers', () => {
    const cells: Cell[] = uniformCells(1, 1).map((cell) => ({ ...cell, colSpan: 2, rowSpan: 2 }))
    const v = view(cells)
    expect(setCellQuality(v, 0, 0, high).cells[0]?.quality).toBe(high)
    expect(setCellQuality(v, 1, 1, high)).toBe(v)
  })

  it('returns the same View when there is no such cell or nothing changes', () => {
    const v = view(uniformCells(2, 2))
    expect(setCellQuality(v, 5, 5, high)).toBe(v)
    expect(setCellQuality(v, 0, 0, null)).toBe(v)
  })
})
