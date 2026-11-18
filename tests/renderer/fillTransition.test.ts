// UX polish (FILL-1): the fill / back transition's geometry and when it runs.
//
// What these tests protect: the slot is only ever scaled uniformly (a camera is never stretched,
// VIEW-5), it starts fitted inside and centred on the box it came from, and the two directions are
// inverses; nothing animates on a View switch, under reduced motion, at zero size or when the
// filled slot did not change.
import type { Rect } from '@shared/viewLayout'
import { describe, expect, it } from 'vitest'
import {
  fillTransitionPlan,
  flipTransform,
  flipTransformCss,
} from '../../src/renderer/src/features/fill/fillTransition'

const AREA: Rect = { x: 0, y: 0, width: 1000, height: 600 }
/** A 16:9 cell, wider in shape than the area. */
const CELL: Rect = { x: 500, y: 300, width: 320, height: 180 }

/** Where a box laid out at `to` is drawn under `flip` (origin 0 0). */
function drawn(to: Rect, flip: { x: number; y: number; scale: number }): Rect {
  return {
    x: to.x + flip.x,
    y: to.y + flip.y,
    width: to.width * flip.scale,
    height: to.height * flip.scale,
  }
}

function centre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

describe('flipTransform', () => {
  it('filling: draws the area fitted inside the cell, centred on it', () => {
    const flip = flipTransform(CELL, AREA)
    expect(flip).not.toBeNull()
    if (flip === null) return
    // The tighter axis decides: 180 / 600, not 320 / 1000.
    expect(flip.scale).toBeCloseTo(0.3)
    const start = drawn(AREA, flip)
    expect(start.height).toBeCloseTo(CELL.height)
    expect(start.width).toBeLessThanOrEqual(CELL.width)
    expect(centre(start).x).toBeCloseTo(centre(CELL).x)
    expect(centre(start).y).toBeCloseTo(centre(CELL).y)
  })

  it('leaving: draws the cell fitted inside the area, centred on it', () => {
    const flip = flipTransform(AREA, CELL)
    expect(flip).not.toBeNull()
    if (flip === null) return
    expect(flip.scale).toBeCloseTo(1000 / 320)
    const start = drawn(CELL, flip)
    expect(start.width).toBeCloseTo(AREA.width)
    expect(start.height).toBeLessThanOrEqual(AREA.height)
    expect(centre(start).x).toBeCloseTo(centre(AREA).x)
    expect(centre(start).y).toBeCloseTo(centre(AREA).y)
  })

  it('maps a cell the shape of the area exactly onto it, both ways', () => {
    const cell: Rect = { x: 100, y: 60, width: 500, height: 300 }
    const fill = flipTransform(cell, AREA)
    const back = flipTransform(AREA, cell)
    expect(fill).not.toBeNull()
    expect(back).not.toBeNull()
    if (fill === null || back === null) return
    const start = drawn(AREA, fill)
    expect(start.x).toBeCloseTo(cell.x)
    expect(start.y).toBeCloseTo(cell.y)
    expect(start.width).toBeCloseTo(cell.width)
    expect(start.height).toBeCloseTo(cell.height)
    const end = drawn(cell, back)
    expect(end.x).toBeCloseTo(AREA.x)
    expect(end.y).toBeCloseTo(AREA.y)
    expect(end.width).toBeCloseTo(AREA.width)
    expect(end.height).toBeCloseTo(AREA.height)
  })

  it('has nothing to animate for the same box, or a box with no size', () => {
    expect(flipTransform(AREA, AREA)).toBeNull()
    expect(flipTransform({ ...CELL, width: 0 }, AREA)).toBeNull()
    expect(flipTransform(CELL, { ...AREA, height: 0 })).toBeNull()
    expect(flipTransform({ ...CELL, width: Number.NaN }, AREA)).toBeNull()
  })

  it('writes a translate then one uniform scale', () => {
    expect(flipTransformCss({ x: 12.5, y: -3, scale: 0.25 })).toBe(
      'translate(12.5px, -3px) scale(0.25)',
    )
  })
})

describe('fillTransitionPlan', () => {
  const base = { sameView: true, drawable: true, reducedMotion: false }

  it('animates the slot that filled, and the one that went back', () => {
    expect(fillTransitionPlan({ ...base, previousKey: null, nextKey: 'a' })).toEqual({
      slotKey: 'a',
      direction: 'fill',
    })
    expect(fillTransitionPlan({ ...base, previousKey: 'a', nextKey: null })).toEqual({
      slotKey: 'a',
      direction: 'unfill',
    })
  })

  it('animates the new slot in when one filled slot replaces another', () => {
    expect(fillTransitionPlan({ ...base, previousKey: 'a', nextKey: 'b' })).toEqual({
      slotKey: 'b',
      direction: 'fill',
    })
  })

  it('does nothing while the filled slot is unchanged', () => {
    expect(fillTransitionPlan({ ...base, previousKey: null, nextKey: null })).toBeNull()
    expect(fillTransitionPlan({ ...base, previousKey: 'a', nextKey: 'a' })).toBeNull()
  })

  it('does nothing on a View switch, under reduced motion or at zero size', () => {
    const change = { previousKey: 'a', nextKey: null }
    expect(fillTransitionPlan({ ...base, ...change, sameView: false })).toBeNull()
    expect(fillTransitionPlan({ ...base, ...change, reducedMotion: true })).toBeNull()
    expect(fillTransitionPlan({ ...base, ...change, drawable: false })).toBeNull()
  })
})
