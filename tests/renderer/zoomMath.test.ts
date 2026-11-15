// P3.6: digital zoom's arithmetic (src/renderer/src/features/zoom/zoomMath.ts; ZOOM-1/2/3).
//
// What these tests protect:
//  - zoom stays in 1×–8× and keeps the content point under the cursor (or a pinch's midpoint) fixed.
//  - the pan is clamped so the zoomed picture always covers the cell: no gap at any edge, at any
//    scale, after any wheel, pinch, drag or resize; and 1× is exactly the identity.
//  - a wheel event is a sane factor whatever its `deltaMode`, a ctrl+wheel (trackpad pinch) zooms
//    faster per px, and one event can never jump the whole range.
//  - a press that moved past the threshold is a drag, and its click (and the double-click it is
//    part of) is swallowed; an ordinary click is not.
//  - only a primary modifier + double-click resets.
//  - an unchanged step returns the same object, so the hook skips the frame.
import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD_PX,
  INITIAL_CLICK_GUARD,
  MAX_WHEEL_FACTOR,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_IDENTITY,
  clampPan,
  clickGuardStep,
  isDragDistance,
  isZoomResetDblClick,
  isZoomed,
  panBy,
  pinchStep,
  wheelZoomFactor,
  zoomAt,
  zoomTransform,
  type ClickGuardEvent,
  type ClickGuardState,
  type ZoomBox,
  type ZoomPoint,
  type ZoomState,
} from '../../src/renderer/src/features/zoom/zoomMath'

const BOX: ZoomBox = { width: 1600, height: 900 }

/** Where content point `p` is drawn. */
function screenOf(state: ZoomState, p: ZoomPoint): ZoomPoint {
  return { x: state.x + state.scale * p.x, y: state.y + state.scale * p.y }
}

/** Which content point is drawn at screen point `s`. */
function contentAt(state: ZoomState, s: ZoomPoint): ZoomPoint {
  return { x: (s.x - state.x) / state.scale, y: (s.y - state.y) / state.scale }
}

function expectCovers(state: ZoomState, box: ZoomBox = BOX): void {
  expect(state.scale).toBeGreaterThanOrEqual(MIN_ZOOM)
  expect(state.scale).toBeLessThanOrEqual(MAX_ZOOM)
  expect(state.x).toBeLessThanOrEqual(0)
  expect(state.y).toBeLessThanOrEqual(0)
  expect(state.x + state.scale * box.width).toBeGreaterThanOrEqual(box.width - 1e-9)
  expect(state.y + state.scale * box.height).toBeGreaterThanOrEqual(box.height - 1e-9)
}

describe('zoomAt (ZOOM-1)', () => {
  it('keeps the content point under the cursor fixed', () => {
    const cursor = { x: 400, y: 300 }
    const before = contentAt(ZOOM_IDENTITY, cursor)
    const next = zoomAt(ZOOM_IDENTITY, 2, cursor, BOX)
    expect(next.scale).toBe(2)
    const after = screenOf(next, before)
    expect(after.x).toBeCloseTo(cursor.x)
    expect(after.y).toBeCloseTo(cursor.y)
  })

  it('keeps it fixed across several steps from a zoomed, panned state', () => {
    let state = zoomAt(ZOOM_IDENTITY, 3, { x: 800, y: 450 }, BOX)
    state = panBy(state, -200, 100, BOX)
    const cursor = { x: 1000, y: 500 }
    const content = contentAt(state, cursor)
    state = zoomAt(state, 1.5, cursor, BOX)
    expect(state.scale).toBeCloseTo(4.5)
    expect(screenOf(state, content).x).toBeCloseTo(cursor.x)
    expect(screenOf(state, content).y).toBeCloseTo(cursor.y)
  })

  it('clamps to 8×, and a tick past the limit leaves the state untouched', () => {
    const atMax = zoomAt(ZOOM_IDENTITY, 100, { x: 10, y: 10 }, BOX)
    expect(atMax.scale).toBe(MAX_ZOOM)
    expectCovers(atMax)
    expect(zoomAt(atMax, 2, { x: 1500, y: 800 }, BOX)).toBe(atMax)
  })

  it('never goes below 1×, and zooming out at 1× is the same identity object', () => {
    expect(zoomAt(ZOOM_IDENTITY, 0.5, { x: 100, y: 100 }, BOX)).toBe(ZOOM_IDENTITY)
    const zoomed = zoomAt(ZOOM_IDENTITY, 2, { x: 100, y: 100 }, BOX)
    expect(zoomAt(zoomed, 0.1, { x: 1500, y: 800 }, BOX)).toBe(ZOOM_IDENTITY)
  })

  it('zooming in and back out by the same factor lands on the identity', () => {
    const cursor = { x: 1234, y: 567 }
    const zoomed = zoomAt(ZOOM_IDENTITY, 1.7, cursor, BOX)
    expect(zoomAt(zoomed, 1 / 1.7, cursor, BOX)).toBe(ZOOM_IDENTITY)
  })

  it('near the edge, clamps the pan rather than showing a gap', () => {
    // Zooming at the very corner keeps the corner fixed, and that is already in bounds.
    const corner = zoomAt(ZOOM_IDENTITY, 4, { x: 0, y: 0 }, BOX)
    expect(corner).toEqual({ scale: 4, x: 0, y: 0 })
    const far = zoomAt(ZOOM_IDENTITY, 4, { x: BOX.width, y: BOX.height }, BOX)
    expect(far.x).toBeCloseTo(BOX.width * (1 - 4))
    expect(far.y).toBeCloseTo(BOX.height * (1 - 4))
    expectCovers(far)
  })

  it('ignores a non-finite or non-positive factor', () => {
    const state = zoomAt(ZOOM_IDENTITY, 2, { x: 100, y: 100 }, BOX)
    expect(zoomAt(state, Number.NaN, { x: 0, y: 0 }, BOX)).toBe(state)
    expect(zoomAt(state, 0, { x: 0, y: 0 }, BOX)).toBe(state)
    expect(zoomAt(state, -2, { x: 0, y: 0 }, BOX)).toBe(state)
    expect(zoomAt(state, Number.POSITIVE_INFINITY, { x: 0, y: 0 }, BOX)).toBe(state)
  })
})

describe('panBy / clampPan (ZOOM-1)', () => {
  const zoomed: ZoomState = { scale: 2, x: -400, y: -200 }

  it('moves the picture by the drag', () => {
    expect(panBy(zoomed, 50, -30, BOX)).toEqual({ scale: 2, x: -350, y: -230 })
  })

  it('never pans past an edge', () => {
    expect(panBy(zoomed, 10_000, 10_000, BOX)).toEqual({ scale: 2, x: 0, y: 0 })
    expect(panBy(zoomed, -10_000, -10_000, BOX)).toEqual({ scale: 2, x: -1600, y: -900 })
  })

  it('does nothing at 1×', () => {
    expect(panBy(ZOOM_IDENTITY, 100, 100, BOX)).toBe(ZOOM_IDENTITY)
  })

  it('returns the same object when nothing moves', () => {
    expect(panBy(zoomed, 0, 0, BOX)).toBe(zoomed)
    expect(clampPan(zoomed, BOX)).toBe(zoomed)
    // Already against the edge: pushing further changes nothing.
    const edge: ZoomState = { scale: 2, x: 0, y: 0 }
    expect(panBy(edge, 5, 5, BOX)).toBe(edge)
  })

  it('snaps a scale within 1e-3 of 1 to the identity', () => {
    expect(clampPan({ scale: 1.0005, x: -0.3, y: -0.1 }, BOX)).toBe(ZOOM_IDENTITY)
    expect(clampPan({ scale: 1, x: -0.0000001, y: 0 }, BOX)).toBe(ZOOM_IDENTITY)
    expect(clampPan({ scale: 0.5, x: 10, y: 10 }, BOX)).toBe(ZOOM_IDENTITY)
    expect(clampPan({ scale: 1.01, x: -1, y: -1 }, BOX).scale).toBe(1.01)
  })

  it('clamps a scale above 8×', () => {
    expect(clampPan({ scale: 20, x: 0, y: 0 }, BOX).scale).toBe(MAX_ZOOM)
  })

  it('on resize keeps the scale and re-clamps to the new box', () => {
    // Panned to the far bottom-right of a big cell, then the window shrinks.
    const state: ZoomState = { scale: 3, x: -3200, y: -1800 }
    const smaller = { width: 800, height: 450 }
    const next = clampPan(state, smaller)
    expect(next.scale).toBe(3)
    expect(next).toEqual({ scale: 3, x: -1600, y: -900 })
    expectCovers(next, smaller)
    // Growing: an offset that was at the old far edge is still in bounds for the bigger box.
    const grown = clampPan({ scale: 3, x: -1600, y: -900 }, BOX)
    expect(grown).toEqual({ scale: 3, x: -1600, y: -900 })
  })
})

describe('wheelZoomFactor (ZOOM-1)', () => {
  const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => ({ deltaY, deltaMode, ctrlKey })

  it('zooms in on wheel up (negative delta) and out on wheel down', () => {
    expect(wheelZoomFactor(wheel(-100), 900)).toBeGreaterThan(1)
    expect(wheelZoomFactor(wheel(100), 900)).toBeLessThan(1)
  })

  it('is symmetric: up then down by the same delta is no zoom', () => {
    expect(wheelZoomFactor(wheel(-100), 900) * wheelZoomFactor(wheel(100), 900)).toBeCloseTo(1)
  })

  it('is 1 for no delta', () => {
    expect(wheelZoomFactor(wheel(0), 900)).toBe(1)
    expect(wheelZoomFactor(wheel(Number.NaN), 900)).toBe(1)
  })

  it('treats a line as 16 px and a page as the box height', () => {
    expect(wheelZoomFactor(wheel(-3, 1), 900)).toBeCloseTo(wheelZoomFactor(wheel(-48), 900))
    expect(wheelZoomFactor(wheel(-0.1, 2), 900)).toBeCloseTo(wheelZoomFactor(wheel(-90), 900))
  })

  it('zooms more per px for a ctrl+wheel (trackpad pinch)', () => {
    expect(wheelZoomFactor(wheel(-5, 0, true), 900)).toBeGreaterThan(
      wheelZoomFactor(wheel(-5), 900),
    )
  })

  it('clamps one event, so a huge delta cannot cross the whole range', () => {
    expect(wheelZoomFactor(wheel(-100_000), 900)).toBe(MAX_WHEEL_FACTOR)
    expect(wheelZoomFactor(wheel(100_000), 900)).toBe(1 / MAX_WHEEL_FACTOR)
    expect(wheelZoomFactor(wheel(-1, 2), 900)).toBe(MAX_WHEEL_FACTOR)
  })

  it('one ordinary notch is a modest step', () => {
    const notch = wheelZoomFactor(wheel(-100), 900)
    expect(notch).toBeGreaterThan(1.05)
    expect(notch).toBeLessThan(1.5)
  })
})

describe('pinchStep (ZOOM-1)', () => {
  it('scales by the ratio of the finger distances about the midpoint', () => {
    const previous = [
      { x: 700, y: 450 },
      { x: 900, y: 450 },
    ] as const
    const current = [
      { x: 600, y: 450 },
      { x: 1000, y: 450 },
    ] as const
    const content = contentAt(ZOOM_IDENTITY, { x: 800, y: 450 })
    const next = pinchStep(ZOOM_IDENTITY, previous, current, BOX)
    expect(next.scale).toBeCloseTo(2)
    expect(screenOf(next, content).x).toBeCloseTo(800)
    expect(screenOf(next, content).y).toBeCloseTo(450)
  })

  it('pans by the midpoint movement when the distance is unchanged', () => {
    const state: ZoomState = { scale: 2, x: -400, y: -200 }
    const previous = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ] as const
    const current = [
      { x: 130, y: 80 },
      { x: 330, y: 80 },
    ] as const
    const next = pinchStep(state, previous, current, BOX)
    expect(next.scale).toBeCloseTo(2)
    expect(next.x).toBeCloseTo(-370)
    expect(next.y).toBeCloseTo(-220)
  })

  it('stays in range and covers the cell', () => {
    const together = [
      { x: 800, y: 450 },
      { x: 801, y: 450 },
    ] as const
    const apart = [
      { x: 0, y: 0 },
      { x: 1600, y: 900 },
    ] as const
    const max = pinchStep(ZOOM_IDENTITY, together, apart, BOX)
    expect(max.scale).toBe(MAX_ZOOM)
    expectCovers(max)
    expect(pinchStep(max, apart, together, BOX)).toBe(ZOOM_IDENTITY)
  })

  it('fingers on top of each other only pan', () => {
    const state: ZoomState = { scale: 2, x: -400, y: -200 }
    const same = [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ] as const
    const moved = [
      { x: 150, y: 100 },
      { x: 250, y: 100 },
    ] as const
    expect(pinchStep(state, same, moved, BOX).scale).toBe(2)
  })
})

describe('drag vs click (ZOOM-1, FILL-1)', () => {
  it('isDragDistance is past the threshold only', () => {
    const start = { x: 100, y: 100 }
    expect(isDragDistance(start, { x: 100 + DRAG_THRESHOLD_PX, y: 100 })).toBe(false)
    expect(isDragDistance(start, { x: 103, y: 102 })).toBe(false)
    expect(isDragDistance(start, { x: 100 + DRAG_THRESHOLD_PX + 1, y: 100 })).toBe(true)
    expect(isDragDistance(start, { x: 104, y: 104 })).toBe(true)
  })

  function run(events: readonly ClickGuardEvent[]): boolean[] {
    let state: ClickGuardState = INITIAL_CLICK_GUARD
    const swallowed: boolean[] = []
    for (const event of events) {
      const result = clickGuardStep(state, event)
      state = result.state
      if (event.type === 'click' || event.type === 'dblclick') swallowed.push(result.swallow)
    }
    return swallowed
  }

  const press = { type: 'press' } as const
  const up = (dragged: boolean) => ({ type: 'release', dragged }) as const
  const click = (detail: number) => ({ type: 'click', detail }) as const
  const dblclick = { type: 'dblclick' } as const

  it('lets an ordinary click and double-click through', () => {
    expect(run([press, up(false), click(1), press, up(false), click(2), dblclick])).toEqual([
      false,
      false,
      false,
    ])
  })

  it('swallows the click that ends a drag', () => {
    expect(run([press, up(true), click(1)])).toEqual([true])
  })

  it('only that one click: the next ordinary click goes through', () => {
    expect(run([press, up(true), click(1), press, up(false), click(1)])).toEqual([true, false])
  })

  it('swallows the double-click of a pair whose first press was a drag', () => {
    expect(run([press, up(true), click(1), press, up(false), click(2), dblclick])).toEqual([
      true,
      false,
      true,
    ])
  })

  it('swallows the double-click of a pair whose second press was a drag', () => {
    expect(run([press, up(false), click(1), press, up(true), click(2), dblclick])).toEqual([
      false,
      true,
      true,
    ])
  })

  it('a new press forgets a swallow whose click never came (a cancelled pointer)', () => {
    expect(run([press, up(true), press, up(false), click(1)])).toEqual([false])
  })

  it('a touch drag leaves no click behind, and the next press (a control tap) forgets its swallow', () => {
    // ZoomPan feeds a press on a control as a press, then never feeds that control's click; the
    // next click on the picture must go through.
    expect(run([press, up(true), press, click(1)])).toEqual([false])
  })

  it('press and release are never swallowed', () => {
    expect(clickGuardStep(INITIAL_CLICK_GUARD, press).swallow).toBe(false)
    expect(clickGuardStep(INITIAL_CLICK_GUARD, up(true)).swallow).toBe(false)
  })
})

describe('isZoomResetDblClick (ZOOM-2)', () => {
  const dbl = (overrides: Partial<Parameters<typeof isZoomResetDblClick>[0]> = {}) => ({
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  })

  it('is a primary double-click with any of Ctrl, Cmd, Alt or Shift', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(isZoomResetDblClick(dbl({ [modifier]: true }))).toBe(true)
    }
  })

  it('is not a plain double-click (that one leaves fill, FILL-1)', () => {
    expect(isZoomResetDblClick(dbl())).toBe(false)
  })

  it('is not another button', () => {
    expect(isZoomResetDblClick(dbl({ button: 2, ctrlKey: true }))).toBe(false)
  })
})

describe('isZoomed / zoomTransform (ZOOM-3)', () => {
  it('the identity is not zoomed and has no transform', () => {
    expect(isZoomed(ZOOM_IDENTITY)).toBe(false)
    expect(zoomTransform(ZOOM_IDENTITY)).toBe('')
  })

  it('a zoomed state is a translate then a scale', () => {
    const state: ZoomState = { scale: 2.5, x: -100, y: -40.5 }
    expect(isZoomed(state)).toBe(true)
    expect(zoomTransform(state)).toBe('translate(-100px, -40.5px) scale(2.5)')
  })
})
