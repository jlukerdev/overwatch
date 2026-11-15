// P4.3: what a multi-camera cell's position control says
// (src/renderer/src/features/cells/cellPosition.ts; CELL-2, CELL-3).
//
// What these tests protect: the controls appear exactly for the cells that have a scheduler (two or
// more cameras); the 0-based index reads 1-based in the text and the tooltip.
import { describe, expect, it } from 'vitest'
import {
  positionText,
  positionTitle,
  showsStepControls,
} from '../../src/renderer/src/features/cells/cellPosition'
import { MIN_SCHEDULED_CAMERAS } from '../../src/renderer/src/features/cells/schedulerSet'

describe('showsStepControls', () => {
  it('is on from two cameras, the scheduler threshold', () => {
    expect(showsStepControls(0)).toBe(false)
    expect(showsStepControls(1)).toBe(false)
    expect(showsStepControls(2)).toBe(true)
    expect(showsStepControls(9)).toBe(true)
    expect(showsStepControls(MIN_SCHEDULED_CAMERAS)).toBe(true)
    expect(showsStepControls(MIN_SCHEDULED_CAMERAS - 1)).toBe(false)
  })
})

describe('positionText and positionTitle', () => {
  it('read the 0-based index 1-based', () => {
    expect(positionText(0, 4)).toBe('1/4')
    expect(positionText(1, 4)).toBe('2/4')
    expect(positionText(3, 4)).toBe('4/4')
    expect(positionTitle(1, 4)).toBe('Camera 2 of 4')
  })
})
