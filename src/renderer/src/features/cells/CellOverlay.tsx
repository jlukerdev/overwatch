// The overlay over a cell's player (P3.4; CELL-3, CELL-4, QUAL-7): the camera's name, always on
// screen, and a controls strip that shows on hover and hides `ui.overlayAutoHideSec` after the last
// movement, taking the idle cursor with it.
//
// What is in the strip, and when the rest arrives. Today: the effective quality badge (QUAL-7, e.g.
// `MED`); while filled, fill's back control (P3.5, FILL-1); and while filled *and* zoomed, the zoom's
// "100%" reset (P3.6, ZOOM-2) — both passed in by `<Cell>`. `children` is the slot for those
// buttons, top right next to the badge; later tasks add the quality picker (P3.7, QUAL-4), the
// position and next / previous plus the motion badge (P4.3, CELL-2/3), mute (P5.1, AUD) and unlock
// (P5.3, DOOR). No placeholder buttons until then, and no control shown while it would do nothing
// (the 100% control at 1×): a control that does nothing is a control someone presses.
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
// **What takes the pointer.** The name and the badge do (`pointer-events: auto`), so their `title`s
// work for a name cut off by the ellipsis and for what the badge means; they have no handlers, so a
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
// window, so it is ignored.
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
  INITIAL_OVERLAY_VISIBILITY,
  isControlsShown,
  isCursorHidden,
  reduceOverlayVisibility,
  type OverlayVisibilityEvent,
  type OverlayVisibilityState,
} from './overlayVisibility'
import './cells.css'

export interface CellOverlayProps {
  readonly name: string
  /** The effective stream the cell plays, for the QUAL-7 badge. */
  readonly quality: StreamQuality
  /** `ui.overlayAutoHideSec` in ms, already sanitised by `overlayAutoHideMs`. */
  readonly autoHideMs: number
  /** Controls for the strip, top right (see the header for which task adds which). */
  readonly children?: ReactNode
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

export function CellOverlay({
  name,
  quality,
  autoHideMs,
  children,
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
    const onLeave = (): void => {
      dispatch({ type: 'pointerLeave' })
    }
    cell.addEventListener('pointerenter', onEnter)
    cell.addEventListener('pointermove', onMove)
    cell.addEventListener('pointerleave', onLeave)
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
      // A mouse-focused control does not hold the strip (header); it also ends any keyboard hold.
      dispatch({ type: isKeyboardFocus(event.target) ? 'focusIn' : 'focusOut' })
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

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // A click-focused control turns focus-visible once a key is pressed on it (header).
      if (!stateRef.current.focusWithin && isKeyboardFocus(event.target)) {
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
        <span className="cellOverlay__name" title={name}>
          {name}
        </span>
        <div className="cellOverlay__controls">
          {children !== undefined ? (
            <div
              className="cellOverlay__slot"
              onPointerDown={stopAtControls}
              onPointerUp={stopAtControls}
              onClick={stopAtControls}
              onDoubleClick={stopAtControls}
            >
              {children}
            </div>
          ) : null}
          <span className="cellOverlay__badge" title="Stream quality">
            {qualityBadgeLabel(quality)}
          </span>
        </div>
      </div>
    </div>
  )
}
