// The overlay over a cell's player (P3.4; CELL-3, CELL-4, QUAL-7): the camera's name, top left
// (unless the View hides names, VIEW-8), and a controls strip, top right, that shows on hover and
// hides `ui.overlayAutoHideSec` after the last movement, taking the idle cursor with it.
//
// What is in the strip, and when the rest arrives. Everything is passed in by `<Cell>` as `children`,
// in its order — in fill, left to right: the zoom's reset to 100% (P3.6, ZOOM-2; disabled at 1×),
// fill's back control (P3.5, FILL-1, a 2×2 grid icon), a multi-camera cell's previous / `2/4` / next
// (P4.3, CELL-2/3, ./CellStepControls), the mute toggle and the volume slider (P5.1, AUD-1/2/3,
// ./AudioControls; only on a camera with audio, the slider only in fill), and the fill quality
// picker with its Save after it (QUAL-5); in the grid, the position group, the mute toggle and the
// cell's own quality picker (QUAL-4). The quality badge (QUAL-7, e.g. `PKG`)
// comes last, and only where no picker already shows the quality: a package-channel cell (the user's
// call, 2026-11-16; the pickers carry the per-quality colour instead). The back control used to sit
// apart, top centre; it is in the strip now, after "100%", by the same call. A per-cell motion
// badge was deferred to after the prototype (user decision 2026-11-15). No placeholder buttons, and
// no control shown while it would do nothing (the 100% control at 1×, next / previous on a
// one-camera cell): a control that does nothing is a control someone presses. A strip with no
// controls draws no empty slot (cells.css).
//
// **The bottom slot** (`bottom`, P5.4; DOOR-3). Not in the strip: the door unlock control
// (features/door/UnlockButton) sits alone at the bottom centre of the cell, larger than the strip's
// chips, because it acts on the house rather than the picture. The slot is the strip's twin for
// events — it stops pointer, click and double-click events from reaching the cell (FILL-1), and the
// zoom skips presses that start in it (ZoomPan) — and it follows the strip's shown / hidden state
// (CELL-4): the button fades with the strip via `cellOverlay--controlsShown`, except while it holds
// itself shown (a hold, a request, the green moment; door.css `data-held`). Only `<Cell>` fills it,
// never `<MissingCell>`. An empty slot draws nothing (cells.css).
//
// **Name and badge are optional.** No name when the View hides names (VIEW-8), or on a multi-camera
// cell's "Camera not found" / "No package camera" placeholder (./MissingCell), whose centred label
// already says what it is; no badge where a picker shows the quality, or where nothing streams.
//
// Thin on purpose (no jsdom here; CLAUDE.md). When the strip is shown is `reduceOverlayVisibility`
// (./overlayVisibility), pure and tested; this file only feeds it events and draws its answer.
//
// **The overlay takes no pointer itself; the cell is what listens.** The root covers the cell but is
// `pointer-events: none`, so whatever is under it — the player, its placeholder and that
// placeholder's `title` explaining an offline camera (CAM-3) — still gets the pointer. Hover is
// therefore watched on the cell element (the root's `parentElement`, `.gridCell`) with native
// listeners attached in an effect: `pointerenter`/`pointerleave` there see the whole cell, children
// included, and `pointermove` bubbles up to it from anything inside. The idle cursor is hidden on
// that element too, with `classList.toggle`, so hiding it never re-renders anything.
//
// **Mounted under a resting pointer, it starts shown.** A step between a camera and a missing camera
// in a multi-camera cell (P4.3) swaps `<Cell>` for `<MissingCell>` or back, which mounts a new
// overlay — hidden, since its state is new — under a pointer that has not moved, so no
// `pointerenter` comes. The user's next click at the same spot, meant for next / previous, would then
// land on the bare cell: in the grid it would fill it, in fill two of them could be a double-click
// that leaves. So when the listeners are attached, a cell that already `matches(':hover')` gets the
// `pointerEnter` it missed, and the strip shows for the usual delay as if the pointer had just come
// in. That costs one selector match per mount (or auto-hide setting change), and covers any other
// remount under the pointer too. Keyboard focus on the pressed button does not survive the swap; it
// falls back to the page, and Tab reaches the strip again.
//
// **What takes the pointer.** The name and the badge (when present) do (`pointer-events: auto`), so
// their `title`s work for a name cut off by the ellipsis and for what the badge means; they have no handlers, so a
// click on them still bubbles to the cell like anywhere else. The controls in the `children` slot do
// while the strip is shown. Everything else in the overlay, the empty space of the top row included,
// lets the pointer through to the cell. While the strip is hidden nothing in it takes the pointer, so
// a click where an invisible button sits is a cell click too.
//
// **Controls keep their clicks.** The slot around the controls — and only that — stops pointer and
// click events from bubbling, so pressing a button is never also FILL-1's "click on the cell" (SPEC:
// "outside the controls"), which `<Cell>` listens for on the cell (P3.5). The name and the badge are not
// controls and are left alone. That `stopPropagation` is React's, so it does not stop the zoom's
// *native* listeners on the cell, which run first; those skip a press that starts in this slot
// themselves (features/zoom/ZoomPan.tsx), so pressing a control never pans.
//
// **Hot path.** `pointermove` fires many times a second. The reducer's state lives in a ref, and the
// one thing React draws, `controlsShown`, is mirrored in a ref and only `setState`d when it flips; a
// move over a cell whose strip is already shown is a reducer call and two comparisons. There is one
// `setTimeout` at a time, for the earliest deadline: if moves push the deadline out, the timeout
// fires early, its check changes nothing and a new timeout covers the rest; if the deadline ever
// comes *earlier* than the scheduled one (a shorter delay from the settings), the timeout is replaced.
//
// **Keyboard.** The controls are ordinary focusable elements and stay in the tab order while hidden
// (no `inert`, no `aria-hidden`): tabbing into the strip reveals it, and keyboard focus inside holds
// it open. Only `:focus-visible` focus counts — a mouse click focuses a button too, and that must not
// pin the strip open after the pointer has gone. A control focused by a click becomes focus-visible
// once a key is pressed on it, so a keydown inside re-checks. A blur caused by the whole window
// losing focus is not focus leaving the overlay: focus comes back to the same control with the
// window, so it is ignored. A select is held by *any* focus (`focusHoldsControls`): its native
// dropdown takes the pointer while open, so no movement would keep the strip up under it. A pick from
// a select (a `change` in the slot) counts as movement, so the strip — and the select showing the new
// quality — stays up for a full delay after the dropdown closes rather than vanishing at once. A
// select focused by the *mouse* lets go when the pointer leaves the cell: it is blurred there
// (`releasesOnPointerLeave`), so a dropdown closed with no pick does not pin the strip for ever.
// (Its `Esc` blur is the picker's, QualityPicker.) The keydown re-check only counts a control that
// still has the focus, so a key that blurred its select does not hold the strip again.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { qualityBadgeLabel, type StreamQuality } from '@shared/quality'
import {
  focusHoldsControls,
  INITIAL_OVERLAY_VISIBILITY,
  isControlsShown,
  isCursorHidden,
  reduceOverlayVisibility,
  releasesOnPointerLeave,
  type OverlayVisibilityEvent,
  type OverlayVisibilityState,
} from './overlayVisibility'
import './cells.css'

export interface CellOverlayProps {
  /** The camera name, top left; absent when the View hides names or on a placeholder (header). */
  readonly name?: string | undefined
  /** The stream for the QUAL-7 badge; absent where a picker shows it or nothing streams (header). */
  readonly quality?: StreamQuality | undefined
  /** `ui.overlayAutoHideSec` in ms, already sanitised by `overlayAutoHideMs`. */
  readonly autoHideMs: number
  /** Controls for the strip, top right, in order (see the header for which task adds which). */
  readonly children?: ReactNode
  /** The bottom-centre slot: the door unlock control (P5.4, header). */
  readonly bottom?: ReactNode
}

/** Set on the cell element while the idle cursor is hidden (cells.css). */
const CURSOR_HIDDEN_CLASS = 'gridCell--cursorHidden'

/** Keeps a control's pointer and click events from reaching the cell (FILL-1, header). */
function stopAtControls(event: SyntheticEvent): void {
  event.stopPropagation()
}

/** Keyboard focus, as opposed to focus from a click (header, "Keyboard"). */
function isKeyboardFocus(element: EventTarget | null): boolean {
  return element instanceof Element && element.matches(':focus-visible')
}

/** Focus that holds the strip: keyboard focus, or any on a select (`focusHoldsControls`). */
function holdsFocus(element: EventTarget | null): boolean {
  return (
    element instanceof Element &&
    focusHoldsControls({ tagName: element.tagName, focusVisible: isKeyboardFocus(element) })
  )
}

/**
 * The focused control inside `root`, as `releasesOnPointerLeave` reads it, or `null` when the focus
 * is elsewhere.
 */
function focusedControlIn(root: HTMLElement | null): HTMLElement | null {
  const focused = document.activeElement
  return root !== null && focused instanceof HTMLElement && root.contains(focused) ? focused : null
}

/** Whether `(x, y)` is strictly inside `rect` (a real leave reports a point on or past its edge). */
function isInside(rect: DOMRect, x: number, y: number): boolean {
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
}

export function CellOverlay({
  name,
  quality,
  autoHideMs,
  children,
  bottom,
}: CellOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** The `.gridCell` around the overlay, once mounted. */
  const cellRef = useRef<HTMLElement | null>(null)
  const stateRef = useRef<OverlayVisibilityState>(INITIAL_OVERLAY_VISIBILITY)
  const shownRef = useRef(false)
  const cursorHiddenRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  /** The deadline `timerRef` was set for. */
  const timerDeadlineRef = useRef<number | null>(null)
  const [controlsShown, setControlsShown] = useState(false)

  const dispatch = useCallback(
    (event: OverlayVisibilityEvent): void => {
      const clearTimer = (): void => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = null
        timerDeadlineRef.current = null
      }
      const step = (current: OverlayVisibilityEvent): void => {
        const previous = stateRef.current
        const next = reduceOverlayVisibility(previous, current, autoHideMs)
        if (next !== previous) {
          stateRef.current = next
          const shown = isControlsShown(next)
          if (shown !== shownRef.current) {
            shownRef.current = shown
            setControlsShown(shown)
          }
          const cursorHidden = isCursorHidden(next)
          if (cursorHidden !== cursorHiddenRef.current) {
            cursorHiddenRef.current = cursorHidden
            cellRef.current?.classList.toggle(CURSOR_HIDDEN_CLASS, cursorHidden)
          }
        }
        // Scheduled even when the state did not change: a check that came before a pushed-out
        // deadline leaves the state as it is, and still needs a timeout for the rest.
        const hideAt = next.hideAt
        if (hideAt === null) {
          clearTimer()
          return
        }
        const scheduled = timerDeadlineRef.current
        if (timerRef.current !== null && scheduled !== null && scheduled <= hideAt) return
        // No timeout yet, or one for a later deadline than this one: (re)schedule for this one.
        clearTimer()
        timerDeadlineRef.current = hideAt
        timerRef.current = window.setTimeout(
          () => {
            timerRef.current = null
            timerDeadlineRef.current = null
            step({ type: 'check', now: performance.now() })
          },
          Math.max(0, hideAt - performance.now()),
        )
      }
      step(event)
    },
    [autoHideMs],
  )

  // Hover is watched on the cell (header). Re-attached only if `dispatch` changes, i.e. when the
  // auto-hide setting does.
  useEffect(() => {
    const cell = rootRef.current?.parentElement ?? null
    if (cell === null) return undefined
    cellRef.current = cell
    const onEnter = (): void => {
      dispatch({ type: 'pointerEnter', now: performance.now() })
    }
    const onMove = (): void => {
      dispatch({ type: 'pointerMove', now: performance.now() })
    }
    const onLeave = (event: PointerEvent): void => {
      dispatch({ type: 'pointerLeave' })
      // A mouse-focused select lets go (header): blurred, which `onBlur` turns into a `focusOut`.
      const focused = focusedControlIn(rootRef.current)
      if (focused === null) return
      const release = releasesOnPointerLeave(
        { tagName: focused.tagName, focusVisible: isKeyboardFocus(focused) },
        {
          toElement: event.relatedTarget instanceof Element,
          insideCell: isInside(cell.getBoundingClientRect(), event.clientX, event.clientY),
        },
      )
      if (!release) return
      focused.blur()
      dispatch({ type: 'focusOut' })
    }
    cell.addEventListener('pointerenter', onEnter)
    cell.addEventListener('pointermove', onMove)
    cell.addEventListener('pointerleave', onLeave)
    // Mounted under a resting pointer (header): the enter it will never get.
    if (cell.matches(':hover')) onEnter()
    return () => {
      cell.removeEventListener('pointerenter', onEnter)
      cell.removeEventListener('pointermove', onMove)
      cell.removeEventListener('pointerleave', onLeave)
    }
  }, [dispatch])

  // On unmount: no timeout left behind, and no hidden cursor left on a cell that outlives us.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      timerDeadlineRef.current = null
      cellRef.current?.classList.remove(CURSOR_HIDDEN_CLASS)
    },
    [],
  )

  const onFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      // A mouse-focused control does not hold the strip (header), unless it is a select; it also
      // ends any keyboard hold.
      dispatch({ type: holdsFocus(event.target) ? 'focusIn' : 'focusOut' })
    },
    [dispatch],
  )

  const onBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      const to = event.relatedTarget
      // The window losing focus, not focus leaving the overlay (header).
      if (to === null && !document.hasFocus()) return
      // Focus moving between two controls inside is not leaving; `onFocus` sees the new one.
      if (to instanceof Node && event.currentTarget.contains(to)) return
      dispatch({ type: 'focusOut' })
    },
    [dispatch],
  )

  // A pick in a select is activity over the cell (header, "Keyboard").
  const onControlChange = useCallback((): void => {
    dispatch({ type: 'pointerMove', now: performance.now() })
  }, [dispatch])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // A click-focused control turns focus-visible once a key is pressed on it (header). Only one
      // that still has the focus: the picker blurs a mouse-focused select on `Esc` before this runs.
      if (
        !stateRef.current.focusWithin &&
        event.target === document.activeElement &&
        holdsFocus(event.target)
      ) {
        dispatch({ type: 'focusIn' })
      }
    },
    [dispatch],
  )

  return (
    <div
      ref={rootRef}
      className={controlsShown ? 'cellOverlay cellOverlay--controlsShown' : 'cellOverlay'}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="cellOverlay__top">
        {name !== undefined ? (
          <span className="cellOverlay__name" title={name}>
            {name}
          </span>
        ) : null}
        <div className="cellOverlay__controls">
          {children !== undefined ? (
            <div
              className="cellOverlay__slot"
              onPointerDown={stopAtControls}
              onPointerUp={stopAtControls}
              onClick={stopAtControls}
              onDoubleClick={stopAtControls}
              onChange={onControlChange}
            >
              {children}
            </div>
          ) : null}
          {/* `data-quality` gives each quality its own colour (cells.css). */}
          {quality !== undefined ? (
            <span className="cellOverlay__badge" title="Stream quality" data-quality={quality}>
              {qualityBadgeLabel(quality)}
            </span>
          ) : null}
        </div>
      </div>
      {bottom !== undefined && bottom !== null ? (
        // Stops the same events as the strip's slot (header): a press here is never a cell click.
        <div
          className="cellOverlay__bottom"
          onPointerDown={stopAtControls}
          onPointerUp={stopAtControls}
          onClick={stopAtControls}
          onDoubleClick={stopAtControls}
        >
          {bottom}
        </div>
      ) : null}
    </div>
  )
}
