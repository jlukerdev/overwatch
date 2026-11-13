// P1.1: the Quality / StreamQuality split in src/shared/quality.ts (QUAL preamble, QUAL-1, CAM-4).
// resolveQuality() and its tests arrive in P2.2.
import { describe, expect, it } from 'vitest'
import {
  isQuality,
  isStreamQuality,
  PACKAGE_CHANNEL,
  QUALITIES,
  QualitySchema,
  STREAM_QUALITIES,
  StreamQualitySchema,
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
