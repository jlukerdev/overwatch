// P3.5: fill mode's rules (src/renderer/src/features/fill/fillMode.ts; FILL-1/2/3).
//
// What these tests protect:
//  - a fill state only fills while its View is on screen and its slot is still a camera slot, so a
//    View switch, a camera leaving the console or an edited-away cell all leave fill.
//  - a plain primary click fills a grid cell; modifiers, other buttons and the later clicks of a
//    multi-click do not.
//  - a plain double-click leaves fill, but only when its first click arrived while filled — a
//    double-click on a grid cell fills and stays filled (no bounce). Modifier + double-click is
//    ZOOM-2's and never leaves.
//  - `Esc` leaves, with the View shortcuts' manners (no repeat, no modifiers, not while typing, not
//    if already handled).
//  - fill fits with `contain`.
import { describe, expect, it } from 'vitest'
import {
  FILL_FIT,
  fillClickStep,
  filledSlotKey,
  isFillExitKey,
  type FillClickEvent,
  type FillClickResult,
  type FillExitKey,
} from '../../src/renderer/src/features/fill/fillMode'
import type { GridSlot } from '../../src/renderer/src/features/grid/gridLayout'
import type { ViewShortcutTarget } from '../../src/renderer/src/features/viewSwitcher/viewShortcut'

const PLACEMENT = { col: 0, row: 0, colSpan: 1, rowSpan: 1 }

const SLOTS: GridSlot[] = [
  {
    kind: 'camera',
    key: 'cam:a#0',
    placement: PLACEMENT,
    cameraId: 'a',
    name: 'Front',
    quality: 'low',
    fillQuality: 'high',
    fit: 'cover',
  },
  {
    kind: 'missing',
    key: 'cam:gone#0',
    placement: { ...PLACEMENT, col: 1 },
    ref: 'gone',
    label: 'Camera not found (gone)',
  },
  { kind: 'empty', key: 'empty:2,0', placement: { ...PLACEMENT, col: 2 } },
]

describe('filledSlotKey (FILL-1)', () => {
  it('is null for the grid', () => {
    expect(filledSlotKey(null, 'v1', SLOTS)).toBeNull()
  })

  it('names the slot while its View is on screen and it is a camera slot', () => {
    expect(filledSlotKey({ viewId: 'v1', slotKey: 'cam:a#0' }, 'v1', SLOTS)).toBe('cam:a#0')
  })

  it('is null once another View is on screen', () => {
    expect(filledSlotKey({ viewId: 'v1', slotKey: 'cam:a#0' }, 'v2', SLOTS)).toBeNull()
  })

  it('is null when the slot is gone (cell edited away)', () => {
    expect(filledSlotKey({ viewId: 'v1', slotKey: 'cam:b#0' }, 'v1', SLOTS)).toBeNull()
  })

  it('is null when the slot is no longer a camera slot (camera left the console)', () => {
    expect(filledSlotKey({ viewId: 'v1', slotKey: 'cam:gone#0' }, 'v1', SLOTS)).toBeNull()
    expect(filledSlotKey({ viewId: 'v1', slotKey: 'empty:2,0' }, 'v1', SLOTS)).toBeNull()
  })
})

function click(detail: number, overrides: Partial<FillClickEvent> = {}): FillClickEvent {
  return {
    type: 'click',
    button: 0,
    detail,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }
}

function dblclick(overrides: Partial<FillClickEvent> = {}): FillClickEvent {
  return click(2, { type: 'dblclick', ...overrides })
}

/**
 * Runs a sequence of events against one cell the way `<GridView>` does: `filled` follows the
 * actions, `armed` the results. Returns each step's action and the final state.
 */
function run(
  events: readonly FillClickEvent[],
  start: { armed: boolean; filled: boolean } = { armed: false, filled: false },
): { actions: FillClickResult['action'][]; filled: boolean; armed: boolean } {
  let { armed, filled } = start
  const actions: FillClickResult['action'][] = []
  for (const event of events) {
    const result = fillClickStep(armed, filled, event)
    armed = result.armed
    if (result.action === 'fill') filled = true
    if (result.action === 'unfill') filled = false
    actions.push(result.action)
  }
  return { actions, filled, armed }
}

describe('fillClickStep: entering (FILL-1)', () => {
  it('fills on a plain primary click in the grid', () => {
    expect(fillClickStep(false, false, click(1))).toEqual({ armed: false, action: 'fill' })
  })

  it('fills on a click with no click count (synthesised)', () => {
    expect(fillClickStep(false, false, click(0)).action).toBe('fill')
  })

  it('does not fill with a modifier held', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(fillClickStep(false, false, click(1, { [modifier]: true })).action).toBeNull()
    }
  })

  it('does not fill on another button', () => {
    expect(fillClickStep(false, false, click(1, { button: 1 })).action).toBeNull()
    expect(fillClickStep(false, false, click(1, { button: 2 })).action).toBeNull()
  })

  it('does not fill on the later clicks of a multi-click', () => {
    expect(fillClickStep(false, false, click(2)).action).toBeNull()
    expect(fillClickStep(false, false, click(3)).action).toBeNull()
  })

  it('a grid click disarms any stale arming', () => {
    expect(fillClickStep(true, false, click(1)).armed).toBe(false)
    expect(fillClickStep(true, false, dblclick()).armed).toBe(false)
  })
})

describe('fillClickStep: leaving by double-click (FILL-1)', () => {
  it('a single click in fill does nothing but arm', () => {
    expect(fillClickStep(false, true, click(1))).toEqual({ armed: true, action: null })
  })

  it('a plain double-click in fill leaves', () => {
    const result = run([click(1), click(2), dblclick()], { armed: false, filled: true })
    expect(result.actions).toEqual([null, null, 'unfill'])
    expect(result.filled).toBe(false)
    expect(result.armed).toBe(false)
  })

  it('a double-click on a grid cell fills and stays filled (no bounce)', () => {
    const result = run([click(1), click(2), dblclick()])
    expect(result.actions).toEqual(['fill', null, null])
    expect(result.filled).toBe(true)
  })

  it('after a grid double-click, the next double-click leaves', () => {
    const result = run([click(1), click(2), dblclick(), click(1), click(2), dblclick()])
    expect(result.actions).toEqual(['fill', null, null, null, null, 'unfill'])
    expect(result.filled).toBe(false)
  })

  it('a triple-click that leaves fill does not re-fill on its third click', () => {
    const result = run([click(1), click(2), dblclick(), click(3)], { armed: false, filled: true })
    expect(result.actions).toEqual([null, null, 'unfill', null])
    expect(result.filled).toBe(false)
  })

  it('a slow click in fill, then a double-click, leaves', () => {
    const result = run([click(1), click(1), click(2), dblclick()], { armed: false, filled: true })
    expect(result.actions.at(-1)).toBe('unfill')
  })

  it('modifier + double-click never leaves (ZOOM-2 reset, P3.6)', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      const result = run(
        [
          click(1, { [modifier]: true }),
          click(2, { [modifier]: true }),
          dblclick({ [modifier]: true }),
        ],
        { armed: false, filled: true },
      )
      expect(result.actions).toEqual([null, null, null])
      expect(result.filled).toBe(true)
    }
  })

  it('a dblclick of another button never leaves', () => {
    expect(fillClickStep(true, true, dblclick({ button: 2 })).action).toBeNull()
  })
})

function esc(overrides: Partial<FillExitKey> = {}): FillExitKey {
  return {
    key: 'Escape',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  }
}

const BODY: ViewShortcutTarget = { tagName: 'BODY', isContentEditable: false }

describe('isFillExitKey (FILL-1)', () => {
  it('leaves on a plain Escape', () => {
    expect(isFillExitKey(esc(), BODY)).toBe(true)
    expect(isFillExitKey(esc(), null)).toBe(true)
    expect(isFillExitKey(esc(), { tagName: 'BUTTON', isContentEditable: false })).toBe(true)
  })

  it('ignores other keys', () => {
    expect(isFillExitKey(esc({ key: 'Backspace' }), BODY)).toBe(false)
    expect(isFillExitKey(esc({ key: 'Esc' }), BODY)).toBe(false)
  })

  it('ignores Escape with a modifier, on repeat, or already handled', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(isFillExitKey(esc({ [modifier]: true }), BODY)).toBe(false)
    }
    expect(isFillExitKey(esc({ repeat: true }), BODY)).toBe(false)
    expect(isFillExitKey(esc({ defaultPrevented: true }), BODY)).toBe(false)
  })

  it('ignores Escape typed into text entry', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isFillExitKey(esc(), { tagName, isContentEditable: false })).toBe(false)
    }
    expect(isFillExitKey(esc(), { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})

describe('FILL_FIT', () => {
  it('shows the whole camera in fill', () => {
    expect(FILL_FIT).toBe('contain')
  })
})
