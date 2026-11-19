// The main window's size and place across launches (P7.1, OverWatch v1.0.1): the window opens where
// and as large as it was when it last closed.
//
// **What is kept.** Only the window's *normal* bounds — `getNormalBounds()`, the rect it has when it
// is neither maximized, full screen nor minimized — so a window closed in any of those states opens
// next time as a normal window at its normal size and place. It never reopens maximized or full
// screen (user decision 2026-11-19).
//
// **Where.** `<userData>/window-state.json` (`WINDOW_STATE_FILE`), its own small file and not
// config.json: window geometry is per-machine UI state, not the user's Views or settings, and has no
// part in config's schemaVersion and migrations. The file is `{ version: 1, x, y, width, height }`,
// validated with zod on read. No file (first run), a file that is not JSON or one that fails the
// schema all mean "use the defaults" — never a crash; a bad file is logged (no contents, nothing
// secret is in it anyway) and simply overwritten by the next save.
//
// **Is it still on screen? (`fitBoundsToDisplays`)** Monitors get unplugged and resolutions change,
// so saved bounds are checked against the displays connected *now*, by their work areas (the screen
// minus the menu bar, Dock and taskbar):
//  1. The saved rect counts as visible on a display when the **whole window** overlaps that display's
//     work area by at least `MIN_VISIBLE_WIDTH_PX` wide (or the window's whole width, if narrower)
//     and `MIN_VISIBLE_HEIGHT_PX` tall (or its whole height). Overlap, not "the title bar is inside":
//     a window saved at y=0 while the macOS menu bar was auto-hidden must still come back once the
//     work area starts at y=25 (rule 4 then moves it down). If no display counts, the saved bounds
//     are dropped and the window opens at the default size (`DEFAULT_WINDOW_SIZE`), centred by
//     Electron.
//  2. Of the displays that count, the one the window overlaps most (by area) is chosen.
//  3. The size is clamped to that work area and to the window's minimum (`MIN_WINDOW_SIZE`); the
//     minimum wins on a work area smaller than it.
//  4. The position is then moved just enough to put the window inside that work area (a window
//     hanging partly off an edge is pulled back on), so its title bar can always be grabbed. The
//     left, right and bottom edges allow `EDGE_SLACK_PX` outside the work area first: a window
//     snapped to an edge on Windows has bounds about 7 px outside it (the invisible resize border),
//     and a strict clamp would drift it inward on every launch. The top edge is strict. A window
//     larger than the work area (the minimum won in rule 3) sits at the work area's top-left.
//
// **Restoring (src/main/index.ts).** The window is created at the default size and then given the
// fitted bounds with `setBounds`, before it is shown: bounds passed to the constructor can be scaled
// by the primary display's factor on Windows with mixed DPI, while `setBounds` places the window on
// the display the bounds name.
//
// **When it is saved (`trackWindowState`).** A `resize` or `move` (re)starts a `SAVE_DEBOUNCE_MS`
// timer, so a drag writes once, after it stops, and a crash still keeps the last place. `close`
// cancels the timer and saves at once, synchronously (the process may exit before a promise
// settles). A close the renderer cancels (the unsaved-View prompt, "Stay") keeps tracking; `closed`
// — the window is gone — ends it: the timer is cleared, the listeners removed, and nothing is
// written after that. A save whose bounds equal the last one written is skipped. Write failures are
// logged and never thrown at the window.
//
// The perf harness (P2.5) neither restores nor saves: its summary records the window size, which
// must stay the 1280×800 default for runs to compare (wired in src/main/index.ts).
//
// No Electron import: the window, the displays, the file I/O and the timers are injected, so
// tests/unit/windowState.test.ts drives every rule in plain Node.
import { z } from 'zod'
import { errorCode } from './fs/atomic'

/** The file under `userData` that holds the window's last normal bounds. */
export const WINDOW_STATE_FILE = 'window-state.json'

/** The window's size on a first run, or when the saved bounds are unusable. Electron centres it. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const

/** The window's `minWidth` / `minHeight`. */
export const MIN_WINDOW_SIZE = { width: 640, height: 400 } as const

/** How long after the last `resize` / `move` the bounds are written. */
export const SAVE_DEBOUNCE_MS = 500

/** How tall the window's overlap with a display's work area must be for it to count (rule 1). */
export const MIN_VISIBLE_HEIGHT_PX = 32

/** How wide that overlap must be (rule 1). */
export const MIN_VISIBLE_WIDTH_PX = 100

/** How far the left, right and bottom edges may sit outside the work area (rule 4). */
export const EDGE_SLACK_PX = 8

/** A rectangle in screen coordinates (Electron's `Rectangle`). */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The slice of Electron's `Display` read here. */
export interface DisplayLike {
  readonly workArea: Rect
}

const coord = z.number().int().min(-1_000_000).max(1_000_000)
const size = z.number().int().min(1).max(1_000_000)

const WindowStateSchema = z.object({
  version: z.literal(1),
  x: coord,
  y: coord,
  width: size,
  height: size,
})

/** What `serializeWindowState` writes. */
export function serializeWindowState(bounds: Rect): string {
  const { x, y, width, height } = bounds
  return `${JSON.stringify({ version: 1, x, y, width, height }, null, 2)}\n`
}

/** The outcome of reading the file: bounds, or why there are none. */
export type ParsedWindowState =
  | { readonly kind: 'ok'; readonly bounds: Rect }
  | { readonly kind: 'invalid'; readonly problem: string }

/** Parses the file's text. Never throws. */
export function parseWindowState(text: string): ParsedWindowState {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'invalid', problem: 'it is not valid JSON' }
  }
  const parsed = WindowStateSchema.safeParse(json)
  if (!parsed.success) return { kind: 'invalid', problem: 'it does not match the expected shape' }
  const { x, y, width, height } = parsed.data
  return { kind: 'ok', bounds: { x, y, width, height } }
}

/**
 * Reads the saved bounds through `readText` (the file's contents; throws ENOENT when there is no
 * file). Returns null — the defaults — for no file, an unreadable file or an invalid one, and logs
 * the last two. Never throws.
 */
export function readSavedWindowBounds(
  readText: () => string,
  log: (line: string) => void,
): Rect | null {
  let text: string
  try {
    text = readText()
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      log(
        `could not read ${WINDOW_STATE_FILE} (${errorCode(err) ?? 'unknown error'}); using the default size`,
      )
    }
    return null
  }
  const parsed = parseWindowState(text)
  if (parsed.kind === 'invalid') {
    log(`ignoring ${WINDOW_STATE_FILE}: ${parsed.problem}; using the default size`)
    return null
  }
  return parsed.bounds
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * The bounds to open the window with, given the saved ones and the displays connected now, or
 * null when the saved bounds are not usefully on any of them (open at the default instead). The
 * rules are in the header comment.
 */
export function fitBoundsToDisplays(saved: Rect, displays: readonly DisplayLike[]): Rect | null {
  const needWidth = Math.min(MIN_VISIBLE_WIDTH_PX, saved.width)
  const needHeight = Math.min(MIN_VISIBLE_HEIGHT_PX, saved.height)
  let best: Rect | null = null
  let bestArea = -1
  for (const { workArea } of displays) {
    const seen = overlap(saved, workArea)
    if (seen.width < needWidth || seen.height < needHeight) continue
    const area = seen.width * seen.height
    if (area > bestArea) {
      best = workArea
      bestArea = area
    }
  }
  if (best === null) return null

  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(saved.width, best.width))
  const height = Math.max(MIN_WINDOW_SIZE.height, Math.min(saved.height, best.height))
  const x =
    width > best.width
      ? best.x
      : clamp(saved.x, best.x - EDGE_SLACK_PX, best.x + best.width - width + EDGE_SLACK_PX)
  const y =
    height > best.height
      ? best.y
      : clamp(saved.y, best.y, best.y + best.height - height + EDGE_SLACK_PX)
  return { x, y, width, height }
}

/** The slice of Electron's `BrowserWindow` the tracker uses; the real one satisfies it as is. */
export interface TrackedWindowLike {
  getNormalBounds(): Rect
  isDestroyed(): boolean
  on(event: 'resize' | 'move' | 'close' | 'closed', listener: () => void): unknown
  removeListener(event: 'resize' | 'move' | 'close' | 'closed', listener: () => void): unknown
}

export interface WindowStateTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TrackWindowStateOptions {
  readonly window: TrackedWindowLike
  /** Writes the file's whole text, atomically and synchronously (`writeFileAtomicSync`). */
  readonly write: (text: string) => void
  readonly log: (line: string) => void
  /**
   * The bounds the window was just given from the file, if any: a save of exactly these is
   * skipped, so the `move` / `resize` that restoring them may fire writes nothing.
   */
  readonly restored?: Rect | null
  readonly timers?: WindowStateTimers
  readonly debounceMs?: number
}

export interface WindowStateTracker {
  /** Cancels a pending save and saves now. A no-op once disposed. */
  flush(): void
  /** Stops tracking: clears the timer and the listeners. Nothing is written after this. */
  dispose(): void
}

const realTimers: WindowStateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/** Saves the window's normal bounds as it is moved and resized, and when it closes. */
export function trackWindowState(options: TrackWindowStateOptions): WindowStateTracker {
  const { window: win, write, log } = options
  const timers = options.timers ?? realTimers
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS
  let timer: unknown = null
  let disposed = false
  let lastWritten: string | null =
    options.restored == null ? null : serializeWindowState(options.restored)

  const clearTimer = (): void => {
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  const save = (): void => {
    if (disposed || win.isDestroyed()) return
    let text: string
    try {
      text = serializeWindowState(win.getNormalBounds())
    } catch (err) {
      log(`could not read the window bounds: ${String(err)}`)
      return
    }
    if (text === lastWritten) return
    try {
      write(text)
      lastWritten = text
    } catch (err) {
      log(`could not save ${WINDOW_STATE_FILE} (${errorCode(err) ?? 'unknown error'})`)
    }
  }

  const schedule = (): void => {
    if (disposed) return
    clearTimer()
    timer = timers.setTimeout(() => {
      timer = null
      save()
    }, debounceMs)
  }

  const flush = (): void => {
    clearTimer()
    save()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearTimer()
    win.removeListener('resize', schedule)
    win.removeListener('move', schedule)
    win.removeListener('close', flush)
    win.removeListener('closed', dispose)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', flush)
  win.on('closed', dispose)
  return { flush, dispose }
}
