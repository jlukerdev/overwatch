// P1.1: the Quality / StreamQuality split in src/shared/quality.ts (QUAL preamble, QUAL-1, CAM-4).
// P2.2: the two inheritance chains, `resolveGridQuality` and `resolveFillQuality` (QUAL-2/3/5).
// P3.4: the overlay's quality badge text, `qualityBadgeLabel` (QUAL-7).
//
// The chains are three lines of code and the single most consequential three lines in the app: get
// one level wrong and every cell of a 4x4 View streams `high` (NFR-2/4), or a per-cell override
// silently stops working. So every combination is enumerated rather than sampled, and the two
// escapes are pinned down too — `package` must never come out of a `Quality` chain (CAM-4), and a
// level holding something that is not a quality must *inherit* rather than be passed on.
import { describe, expect, it } from 'vitest'
import {
  isQuality,
  isStreamQuality,
  PACKAGE_CHANNEL,
  QUALITIES,
  QualitySchema,
  qualityBadgeLabel,
  resolveFillQuality,
  resolveGridQuality,
  STREAM_QUALITIES,
  StreamQualitySchema,
  type CellQualityOverride,
  type Quality,
  type QualityDefaults,
  type ViewQualityOverrides,
} from '../../src/shared/quality'

describe('quality', () => {
  it('offers exactly the three user-selectable qualities, best first (QUAL-4)', () => {
    expect(QUALITIES).toEqual(['high', 'medium', 'low'])
    for (const q of QUALITIES) expect(QualitySchema.parse(q)).toBe(q)
  })

  it('keeps the package channel out of Quality (CAM-4)', () => {
    expect(QualitySchema.safeParse(PACKAGE_CHANNEL).success).toBe(false)
    expect(isQuality(PACKAGE_CHANNEL)).toBe(false)
    expect(STREAM_QUALITIES).toEqual(['high', 'medium', 'low', 'package'])
    expect(StreamQualitySchema.parse(PACKAGE_CHANNEL)).toBe('package')
    expect(isStreamQuality(PACKAGE_CHANNEL)).toBe(true)
  })

  it('rejects anything else', () => {
    for (const v of ['', 'ultra', 'High', 'LOW', 'main']) {
      expect(isQuality(v)).toBe(false)
      expect(isStreamQuality(v)).toBe(false)
    }
    expect(isQuality('medium')).toBe(true)
    expect(isStreamQuality('medium')).toBe(true)
  })
})

describe('qualityBadgeLabel (QUAL-7)', () => {
  it('labels every stream quality, including the package channel', () => {
    expect(qualityBadgeLabel('high')).toBe('HIGH')
    expect(qualityBadgeLabel('medium')).toBe('MED')
    expect(qualityBadgeLabel('low')).toBe('LOW')
    expect(qualityBadgeLabel('package')).toBe('PKG')
  })

  it('gives each stream quality a distinct, non-empty label', () => {
    const labels = STREAM_QUALITIES.map(qualityBadgeLabel)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(STREAM_QUALITIES.length)
  })
})

/** The levels, each `null` unless the case under test sets it. */
function levels(over: {
  cell?: Quality | null
  grid?: Quality | null
  fill?: Quality | null
  defaultGrid?: Quality
  defaultFill?: Quality
}): { cell: CellQualityOverride; view: ViewQualityOverrides; streams: QualityDefaults } {
  return {
    cell: { quality: over.cell ?? null },
    view: { gridQuality: over.grid ?? null, fillQuality: over.fill ?? null },
    // The app-wide defaults of QUAL-1, which is also what `StreamsConfigSchema` defaults to.
    streams: {
      defaultGridQuality: over.defaultGrid ?? 'low',
      defaultFillQuality: over.defaultFill ?? 'high',
    },
  }
}

describe('resolveGridQuality (QUAL-3)', () => {
  it('prefers the cell, then the View, then the app default', () => {
    // cell -> view -> settings. All eight combinations of "set / inherit" over the three levels,
    // with a distinct value per level so a swapped pair cannot pass by coincidence.
    const cases: { cell: Quality | null; grid: Quality | null; expected: Quality }[] = [
      { cell: 'high', grid: 'medium', expected: 'high' },
      { cell: 'high', grid: null, expected: 'high' },
      { cell: null, grid: 'medium', expected: 'medium' },
      { cell: null, grid: null, expected: 'low' },
    ]
    for (const { cell, grid, expected } of cases) {
      expect(
        resolveGridQuality(levels({ cell, grid, defaultGrid: 'low' })),
        `${String(cell)}/${String(grid)}`,
      ).toBe(expected)
    }
    // ...and the app default is read, not assumed: changing it changes the inherited answer.
    expect(resolveGridQuality(levels({ defaultGrid: 'medium' }))).toBe('medium')
    expect(resolveGridQuality(levels({ defaultGrid: 'high' }))).toBe('high')
  })

  it('resolves every quality at every level', () => {
    for (const q of QUALITIES) {
      expect(resolveGridQuality(levels({ cell: q, grid: 'low', defaultGrid: 'low' }))).toBe(q)
      expect(resolveGridQuality(levels({ grid: q, defaultGrid: 'low' }))).toBe(q)
      expect(resolveGridQuality(levels({ defaultGrid: q }))).toBe(q)
    }
  })

  it('ignores the fill levels entirely (QUAL-5 is a separate chain)', () => {
    expect(
      resolveGridQuality(levels({ fill: 'high', defaultGrid: 'low', defaultFill: 'high' })),
    ).toBe('low')
  })
})

describe('resolveFillQuality (QUAL-5)', () => {
  it('prefers the View, then the app default', () => {
    expect(resolveFillQuality(levels({ fill: 'medium', defaultFill: 'high' }))).toBe('medium')
    expect(resolveFillQuality(levels({ defaultFill: 'high' }))).toBe('high')
    expect(resolveFillQuality(levels({ defaultFill: 'low' }))).toBe('low')
    for (const q of QUALITIES) expect(resolveFillQuality(levels({ fill: q }))).toBe(q)
  })

  it('ignores the cell and the grid levels, so a cell override cannot follow a camera into fill (FILL-2)', () => {
    const resolved = resolveFillQuality(levels({ cell: 'low', grid: 'low', defaultFill: 'high' }))
    expect(resolved).toBe('high')
  })
})

describe('what the chains refuse', () => {
  // The package channel is a stream *source* (CAM-4, QUAL-8), never an inheritable quality: it only
  // exists on a doorbell, so resolving it for an arbitrary camera would register a stream Protect
  // has no alias for. The types already forbid it; this is the runtime half, for a hand-edited
  // config that reached a caller without going through `QualitySchema`.
  const asQuality = (value: string): Quality => value as Quality

  it('never resolves to the package channel, at any level', () => {
    expect(
      resolveGridQuality(levels({ cell: asQuality(PACKAGE_CHANNEL), defaultGrid: 'low' })),
    ).toBe('low')
    expect(
      resolveGridQuality(levels({ grid: asQuality(PACKAGE_CHANNEL), defaultGrid: 'medium' })),
    ).toBe('medium')
    expect(
      resolveFillQuality(levels({ fill: asQuality(PACKAGE_CHANNEL), defaultFill: 'high' })),
    ).toBe('high')
    // Even as the app default, which is unreachable through `StreamsConfigSchema`: the result is
    // still one of QUALITIES, never 'package'.
    expect(
      QUALITIES.includes(resolveGridQuality(levels({ defaultGrid: asQuality(PACKAGE_CHANNEL) }))),
    ).toBe(true)
  })

  it('treats a malformed or absent level as "inherit"', () => {
    for (const bad of ['', 'ultra', 'HIGH', 'Low', 'main']) {
      expect(resolveGridQuality(levels({ cell: asQuality(bad), grid: 'medium' })), bad).toBe(
        'medium',
      )
      expect(resolveFillQuality(levels({ fill: asQuality(bad), defaultFill: 'high' })), bad).toBe(
        'high',
      )
    }
    // An absent key, i.e. what an older config schema or a partial object leaves `undefined`.
    const absent = {
      cell: {} as CellQualityOverride,
      view: {} as ViewQualityOverrides,
      streams: { defaultGridQuality: 'medium', defaultFillQuality: 'medium' } as QualityDefaults,
    }
    expect(resolveGridQuality(absent)).toBe('medium')
    expect(resolveFillQuality(absent)).toBe('medium')
  })

  it('still answers with a quality when every level is unusable', () => {
    // There is no "no quality" answer: the player's alternative is no video. The last resort is the
    // cheapest of QUALITIES, so a broken config degrades downwards instead of hammering the console.
    const broken = {
      cell: {} as CellQualityOverride,
      view: {} as ViewQualityOverrides,
      streams: {} as QualityDefaults,
    }
    expect(resolveGridQuality(broken)).toBe(QUALITIES[QUALITIES.length - 1])
    expect(resolveFillQuality(broken)).toBe(QUALITIES[QUALITIES.length - 1])
    expect(isQuality(resolveGridQuality(broken))).toBe(true)
  })
})
