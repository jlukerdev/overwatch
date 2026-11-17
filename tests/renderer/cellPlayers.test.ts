import { describe, expect, it } from 'vitest'
import { cellPlayers } from '../../src/renderer/src/features/cells/cellPlayers'

describe('cellPlayers (P4.4)', () => {
  it('is just the shown camera without a pre-warm', () => {
    expect(cellPlayers('a', 'medium', null, null)).toEqual([
      { cameraId: 'a', quality: 'medium', hidden: false },
    ])
  })

  it('puts the shown camera first and the pre-warm second, hidden', () => {
    expect(cellPlayers('a', 'medium', 'b', 'high')).toEqual([
      { cameraId: 'a', quality: 'medium', hidden: false },
      { cameraId: 'b', quality: 'high', hidden: true },
    ])
  })

  it('keeps the pre-warmed entry under the same key once it is the shown camera', () => {
    const before = cellPlayers('a', 'medium', 'b', 'medium')
    const after = cellPlayers('b', 'medium', 'c', 'medium')
    expect(before[1]?.cameraId).toBe('b')
    expect(after[0]).toEqual({ cameraId: 'b', quality: 'medium', hidden: false })
  })

  it('never pre-warms the shown camera (key collision)', () => {
    expect(cellPlayers('a', 'medium', 'a', 'medium')).toHaveLength(1)
  })

  it('needs a quality to pre-warm', () => {
    expect(cellPlayers('a', 'medium', 'b', null)).toHaveLength(1)
  })
})
