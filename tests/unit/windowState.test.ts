// P7.1: the main window's size and place across launches (src/main/windowState.ts) — reading
// window-state.json, deciding whether saved bounds still fit on the connected displays, and the
// tracker that saves them (debounced on move/resize, at once on close, never after the window is gone).
//
// Everything is a fake: the file is a string or a thrown error, the displays are plain work areas,
// the window is an emitter with settable bounds, and the timers are vitest's fake ones.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_SLACK_PX,
  MIN_WINDOW_SIZE,
  SAVE_DEBOUNCE_MS,
  fitBoundsToDisplays,
  parseWindowState,
  readSavedWindowBounds,
  serializeWindowState,
  trackWindowState,
  type DisplayLike,
  type Rect,
  type TrackedWindowLike,
} from '../../src/main/windowState'

/** A 1920×1080 display with a 25 px menu bar, and a 1440×900 one to its right. */
const MAIN: DisplayLike = { workArea: { x: 0, y: 25, width: 1920, height: 1055 } }
const RIGHT: DisplayLike = { workArea: { x: 1920, y: 0, width: 1440, height: 900 } }

const enoent = (): never => {
  throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
}

describe('reading window-state.json', () => {
  it('uses the defaults, silently, when there is no file (first run)', () => {
    const log = vi.fn()
    expect(readSavedWindowBounds(enoent, log)).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('logs and ignores a file that cannot be read', () => {
    const log = vi.fn()
    const read = (): never => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    expect(readSavedWindowBounds(read, log)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
  })

  it('logs and ignores a file that is not JSON', () => {
    const log = vi.fn()
    expect(readSavedWindowBounds(() => '{ not json', log)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
    expect(parseWindowState('')).toEqual({ kind: 'invalid', problem: 'it is not valid JSON' })
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['no version', '{"x":0,"y":0,"width":800,"height":600}'],
    ['a future version', '{"version":2,"x":0,"y":0,"width":800,"height":600}'],
    ['a missing field', '{"version":1,"x":0,"y":0,"width":800}'],
    ['a string coordinate', '{"version":1,"x":"0","y":0,"width":800,"height":600}'],
    ['a fractional size', '{"version":1,"x":0,"y":0,"width":800.5,"height":600}'],
    ['a zero size', '{"version":1,"x":0,"y":0,"width":0,"height":600}'],
    ['a negative size', '{"version":1,"x":0,"y":0,"width":800,"height":-1}'],
    ['an absurd coordinate', '{"version":1,"x":1e12,"y":0,"width":800,"height":600}'],
  ])('rejects %s', (_label, text) => {
    const log = vi.fn()
    expect(parseWindowState(text).kind).toBe('invalid')
    expect(readSavedWindowBounds(() => text, log)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expected shape'))
  })

  it('reads back what it writes', () => {
    const bounds: Rect = { x: -200, y: 40, width: 1000, height: 700 }
    expect(readSavedWindowBounds(() => serializeWindowState(bounds), vi.fn())).toEqual(bounds)
  })

  it('ignores fields it does not know', () => {
    const text = '{"version":1,"x":10,"y":30,"width":900,"height":600,"maximized":true}'
    expect(parseWindowState(text)).toEqual({
      kind: 'ok',
      bounds: { x: 10, y: 30, width: 900, height: 600 },
    })
  })
})

describe('fitting saved bounds to the connected displays', () => {
  it('restores bounds that are fully on a display unchanged', () => {
    const saved = { x: 100, y: 60, width: 1100, height: 700 }
    expect(fitBoundsToDisplays(saved, [MAIN, RIGHT])).toEqual(saved)
  })

  it('restores bounds on a second display', () => {
    const saved = { x: 2000, y: 50, width: 800, height: 600 }
    expect(fitBoundsToDisplays(saved, [MAIN, RIGHT])).toEqual(saved)
  })

  it('drops bounds on a display that is no longer connected', () => {
    expect(fitBoundsToDisplays({ x: 2000, y: 50, width: 800, height: 600 }, [MAIN])).toBeNull()
  })

  it('drops bounds when there are no displays at all', () => {
    expect(fitBoundsToDisplays({ x: 0, y: 25, width: 800, height: 600 }, [])).toBeNull()
  })

  it('restores a window saved at y=0 (menu bar auto-hidden) below a work area that starts at 25', () => {
    expect(fitBoundsToDisplays({ x: 100, y: 0, width: 800, height: 600 }, [MAIN])).toEqual({
      x: 100,
      y: 25,
      width: 800,
      height: 600,
    })
  })

  it('drops bounds with too little width on screen', () => {
    // 60 px on the display's left edge: less than the 100 px needed.
    expect(fitBoundsToDisplays({ x: -740, y: 100, width: 800, height: 600 }, [MAIN])).toBeNull()
  })

  it('drops bounds with too little height on screen', () => {
    // 20 px below the work area's top: less than the 32 px needed.
    expect(fitBoundsToDisplays({ x: 100, y: -555, width: 800, height: 600 }, [MAIN])).toBeNull()
  })

  it('pulls a partly off-screen window onto its display, to within the edge slack', () => {
    // 200 px visible on the left edge: enough to keep, then moved on (8 px slack on the left).
    expect(fitBoundsToDisplays({ x: -600, y: 100, width: 800, height: 600 }, [MAIN])).toEqual({
      x: -EDGE_SLACK_PX,
      y: 100,
      width: 800,
      height: 600,
    })
    // Hanging off the bottom-right (8 px slack on each).
    expect(fitBoundsToDisplays({ x: 1500, y: 800, width: 800, height: 600 }, [MAIN])).toEqual({
      x: 1120 + EDGE_SLACK_PX,
      y: 480 + EDGE_SLACK_PX,
      width: 800,
      height: 600,
    })
  })

  it('picks the display the window overlaps most when it spans two', () => {
    // 520 px on MAIN, 1000 px on RIGHT: it lands on RIGHT (its left edge within the slack).
    const fitted = fitBoundsToDisplays({ x: 1400, y: 100, width: 1520, height: 700 }, [MAIN, RIGHT])
    expect(fitted).toEqual({ x: 1920 - EDGE_SLACK_PX, y: 100, width: 1440, height: 700 })
  })

  describe('Windows edge snapping (invisible resize border)', () => {
    const WIN: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

    it.each([
      ['left half', { x: -7, y: 0, width: 974, height: 1047 }],
      ['right half', { x: 953, y: 0, width: 974, height: 1040 }],
      ['bottom edge', { x: 300, y: 447, width: 800, height: 600 }],
      ['exactly 8 px out on the left', { x: -8, y: 100, width: 800, height: 600 }],
    ])('keeps a window snapped to the %s where it was', (_label, saved) => {
      const height = Math.min(saved.height, WIN.workArea.height)
      expect(fitBoundsToDisplays(saved, [WIN])).toEqual({ ...saved, height })
    })

    it('moves a window more than 8 px out only back to the slack', () => {
      expect(fitBoundsToDisplays({ x: -9, y: 100, width: 800, height: 600 }, [WIN])?.x).toBe(-8)
      expect(fitBoundsToDisplays({ x: 1129, y: 100, width: 800, height: 600 }, [WIN])?.x).toBe(1128)
      expect(fitBoundsToDisplays({ x: 300, y: 449, width: 800, height: 600 }, [WIN])?.y).toBe(448)
    })

    it('keeps the top edge strict', () => {
      expect(fitBoundsToDisplays({ x: 300, y: -5, width: 800, height: 600 }, [WIN])?.y).toBe(0)
    })
  })

  it('clamps the size to a smaller work area (a resolution change)', () => {
    const small: DisplayLike = { workArea: { x: 0, y: 25, width: 1280, height: 775 } }
    expect(fitBoundsToDisplays({ x: 0, y: 25, width: 1920, height: 1055 }, [small])).toEqual({
      x: 0,
      y: 25,
      width: 1280,
      height: 775,
    })
  })

  it('clamps the size up to the window minimum', () => {
    expect(fitBoundsToDisplays({ x: 100, y: 100, width: 200, height: 150 }, [MAIN])).toEqual({
      x: 100,
      y: 100,
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    })
  })

  it('keeps the minimum on a work area smaller than it, at its top-left', () => {
    const tiny: DisplayLike = { workArea: { x: 0, y: 0, width: 600, height: 380 } }
    expect(fitBoundsToDisplays({ x: 0, y: 0, width: 600, height: 380 }, [tiny])).toEqual({
      x: 0,
      y: 0,
      ...MIN_WINDOW_SIZE,
    })
  })
})

class FakeWindow extends EventEmitter implements TrackedWindowLike {
  normal: Rect = { x: 100, y: 100, width: 1280, height: 800 }
  /** What `getBounds` would say; the tracker must never read it. */
  current: Rect = this.normal
  destroyed = false

  getNormalBounds(): Rect {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return this.normal
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  moveTo(bounds: Rect): void {
    this.normal = bounds
    this.current = bounds
    this.emit('move')
  }

  destroy(): void {
    this.emit('close')
    this.destroyed = true
    this.emit('closed')
  }
}

describe('saving the bounds', () => {
  let win: FakeWindow
  let writes: string[]
  let log: ReturnType<typeof vi.fn<(line: string) => void>>

  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }

  const start = () =>
    trackWindowState({
      window: win,
      write: (text) => {
        writes.push(text)
      },
      log,
      timers,
    })

  const written = (i: number): unknown => JSON.parse(writes[i] ?? 'null')

  beforeEach(() => {
    vi.useFakeTimers()
    win = new FakeWindow()
    writes = []
    log = vi.fn<(line: string) => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once, after the moves stop', () => {
    start()
    win.moveTo({ x: 110, y: 100, width: 1280, height: 800 })
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1)
    win.moveTo({ x: 120, y: 100, width: 1280, height: 800 })
    win.emit('resize')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1)
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(writes).toHaveLength(1)
    expect(written(0)).toEqual({ version: 1, x: 120, y: 100, width: 1280, height: 800 })
  })

  it('skips a save that would write the same bounds again', () => {
    start()
    win.emit('move')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    win.emit('resize')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(writes).toHaveLength(1)
  })

  it('does not rewrite the bounds it was restored to, but saves any change from them', () => {
    trackWindowState({
      window: win,
      write: (text) => {
        writes.push(text)
      },
      log,
      timers,
      restored: win.normal,
    })
    win.emit('move')
    win.emit('resize')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    win.emit('close')
    expect(writes).toHaveLength(0)
    win.moveTo({ x: 101, y: 100, width: 1280, height: 800 })
    win.emit('close')
    expect(writes).toHaveLength(1)
  })

  it('saves the normal bounds, not the maximized or full-screen ones', () => {
    start()
    win.normal = { x: 300, y: 200, width: 1000, height: 700 }
    win.current = { x: 0, y: 25, width: 1920, height: 1055 }
    win.emit('resize')
    win.emit('close')
    expect(written(0)).toEqual({ version: 1, x: 300, y: 200, width: 1000, height: 700 })
  })

  it('flushes a pending save on close, synchronously, and clears the timer', () => {
    start()
    win.moveTo({ x: 400, y: 300, width: 900, height: 600 })
    win.emit('close')
    expect(writes).toHaveLength(1)
    expect(written(0)).toEqual({ version: 1, x: 400, y: 300, width: 900, height: 600 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps tracking when a close is cancelled', () => {
    start()
    win.emit('close')
    win.moveTo({ x: 500, y: 300, width: 900, height: 600 })
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(writes).toHaveLength(2)
  })

  it('writes nothing after the window is gone', () => {
    start()
    win.moveTo({ x: 400, y: 300, width: 900, height: 600 })
    win.destroy()
    expect(writes).toHaveLength(1)
    win.emit('move')
    win.emit('resize')
    win.emit('close')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4)
    expect(writes).toHaveLength(1)
    expect(win.listenerCount('move')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
  })

  it('writes nothing after dispose, and clears a pending timer', () => {
    const tracker = start()
    win.moveTo({ x: 400, y: 300, width: 900, height: 600 })
    tracker.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    tracker.flush()
    win.emit('close')
    expect(writes).toHaveLength(0)
  })

  it('does not read a destroyed window', () => {
    const tracker = start()
    win.destroyed = true
    tracker.flush()
    expect(writes).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs a failed write and tries again on the next change', () => {
    let fail = true
    trackWindowState({
      window: win,
      write: (text) => {
        if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        writes.push(text)
      },
      log,
      timers,
    })
    win.emit('move')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'))
    fail = false
    win.emit('close')
    expect(writes).toHaveLength(1)
  })
})
