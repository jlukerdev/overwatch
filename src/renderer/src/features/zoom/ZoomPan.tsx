// Digital zoom and pan for the filled cell (P3.6; ZOOM-1/2/3): `useZoomPan`, the hook `<Cell>` runs,
// and `<ZoomPanLayer>`, the element it puts around the player. Mouse wheel or trackpad pinch zooms
// at the cursor (1×–8×), two fingers pinch, a drag pans while zoomed, modifier + double-click and
// the overlay's "100%" control reset, and leaving fill resets.
//
// Thin on purpose (no jsdom here; CLAUDE.md). Every number — where the picture goes for a wheel
// tick, a pinch or a drag, how far it may pan, which clicks are zoom's — is the pure, tested
// ./zoomMath. This file only listens, measures the cell and writes the answer.
//
// **Fill only** (the user's call, 2026-11-15; SPEC ZOOM-1). The listeners are attached only while
// `enabled`, which `<Cell>` passes as `filled`. A grid cell never zooms or pans: a wheel over the
// grid is left to do nothing, and FILL-1's click-to-fill is untouched because nothing here is
// listening yet.
//
// **Only the player is scaled.** The transform is on `<ZoomPanLayer>`, which wraps `<LivePlayer>`
// and nothing else; the overlay (name, badge, controls) is its sibling and stays the size it is. The
// layer is **always rendered**, filled or not, zoomed or not: wrapping the player only while zoomed
// would re-parent it, which is a remount — a new connection, the very thing FILL-2's "same player,
// enlarged" exists to avoid. At 1× the layer has no transform at all.
//
// **The cell listens, not the layer.** Wheel, pointer and click listeners go on the cell element
// (`.gridCell`), native and attached in an effect (as CellOverlay's hover listeners are), so a wheel
// or a drag that starts over the name chip works too. Native listeners on the cell run *before*
// React's (React listens at the root), so the overlay slot's `stopPropagation` does not reach them:
// a press, wheel, click or double-click on a control (`.cellOverlay__slot`) is skipped here by
// checking its target, which keeps pressing a button from ever panning and leaves the wheel to a
// control that scrolls (P3.7's picker). Everywhere else `wheel` is `{ passive: false }` and always
// `preventDefault`ed while filled, so Chromium's own Ctrl+wheel / pinch page zoom never fires over
// the filled camera.
//
// **Every press is captured.** Each tracked pointer is captured at its press, at 1× too, so its
// `pointerup` reaches the cell wherever it is released; an uncaptured mouse let go outside the cell
// would stay "pressed" here for good, ignoring every later press and panning on plain hover once
// zoomed. A press held at 1× and then wheel-zoomed simply starts panning. The rest of the ways a
// press can end unseen are covered too: `lostpointercapture` ends it, a mouse move with no button
// down ends it, and a window `blur` (Alt+Tab mid-drag) drops all of them.
//
// **A drag is not a click.** The browser sends a `click` after any press and release on the same
// element, however far the pointer went. A capture-phase `click` / `dblclick` listener on the cell
// asks `clickGuardStep` and stops the ones that ended a drag, before they reach `<Cell>`'s
// `onClick`, so a pan never arms — or fires — fill's double-click exit. The same listener handles
// ZOOM-2's modifier + double-click (fillClickStep already ignores it). It never swallows a click on
// a control: a touch drag or pinch ends with no click to clear the swallow it sets, and the next tap
// on "100%" or "← Grid" must still work. A press on a control is still fed to the guard as a press,
// so that leftover swallow is forgotten before any later click on the picture.
//
// **Hot path.** Wheel ticks and pointer moves arrive many times a frame. The zoom state lives in a
// ref, and the transform is written straight onto the layer's `style`, once per animation frame
// however many events came in. The one thing React draws is `zoomed` (scale > 1), mirrored in a ref
// and `setState`d only when it flips, because it decides whether the 100% control is there; a wheel
// tick at 3× re-renders nothing. `will-change: transform` is set only while zoomed: a layer promoted
// for nothing costs GPU memory per cell. The cursor classes are toggled with `classList`, not
// through React's `className`, so they never re-render anything either. The cell's rect is read at
// each press, each wheel event and each resize, and reused by every move in between, so a pointer
// move never forces a layout; the cell does not move under a gesture.
//
// **Cursor.** `grab` while zoomed and `grabbing` while a drag pans (zoom.css). CELL-4's idle hide
// still wins: zoom.css's cursor rules apply only `:not(.gridCell--cursorHidden)`, so whichever
// stylesheet loads first, a cursor resting on a zoomed picture still gets out of the way.
//
// **Reset on leaving fill** (ZOOM-2). Esc, the back control, a plain double-click, a View switch or
// the slot going away all end in `enabled` going false, and the effect's cleanup puts the layer back
// to the identity at once (not on the next frame), cancels the frame, drops every listener and the
// resize observer, releases any pointer capture and clears the cursor classes. Unmount is the same
// cleanup. **Resize** is watched only while zoomed: a `ResizeObserver` on the cell re-clamps to the
// new box at the same scale, so a window resize never leaves a gap at an edge.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  INITIAL_CLICK_GUARD,
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
} from './zoomMath'
import './zoom.css'

/** On the cell while zoomed: the `grab` cursor (zoom.css). */
const ZOOMED_CLASS = 'gridCell--zoomed'
/** On the cell while a drag pans: `grabbing`. */
const PANNING_CLASS = 'gridCell--panning'
/** CellOverlay's controls slot: a press, wheel or click there is a control's, never zoom's (header). */
const CONTROLS_SELECTOR = '.cellOverlay__slot'

export interface ZoomPan {
  /** For the cell element (`.gridCell`): where every listener goes. */
  readonly cellRef: RefObject<HTMLDivElement | null>
  /** For `<ZoomPanLayer>`: what is transformed. */
  readonly layerRef: RefObject<HTMLDivElement | null>
  /** Scale > 1: the 100% control is shown. */
  readonly zoomed: boolean
  /** ZOOM-2's 100% control. Stable. */
  readonly resetZoom: () => void
}

/** A pressed pointer: where it was last used (its press point, until it becomes a drag). */
interface TrackedPointer {
  x: number
  y: number
  readonly touch: boolean
}

/** The cell's rect: where it is in client px, for cell-local points, and its size. */
interface MeasuredCell {
  readonly left: number
  readonly top: number
  readonly box: ZoomBox
}

/** A layout read: only at a press, a wheel event or a resize, never per move (header). */
function measureCell(cell: HTMLElement): MeasuredCell {
  const rect = cell.getBoundingClientRect()
  return { left: rect.left, top: rect.top, box: { width: rect.width, height: rect.height } }
}

/** The event started on one of the overlay's controls, which zoom leaves alone (header). */
function isOnControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROLS_SELECTOR) !== null
}

export function useZoomPan(enabled: boolean): ZoomPan {
  const cellRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<ZoomState>(ZOOM_IDENTITY)
  const zoomedRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  /** The cell's rect as last measured (header, "Hot path"); `null` until the first press or wheel. */
  const rectRef = useRef<MeasuredCell | null>(null)
  const [zoomed, setZoomed] = useState(false)

  /** Writes the current state onto the layer now. */
  const paint = useCallback((): void => {
    const layer = layerRef.current
    if (layer === null) return
    const state = stateRef.current
    layer.style.transform = zoomTransform(state)
    layer.style.willChange = isZoomed(state) ? 'transform' : ''
  }, [])

  /** The one way the state changes: React only hears about a flip of `zoomed` (header). */
  const apply = useCallback(
    (next: ZoomState, immediate = false): void => {
      if (next === stateRef.current && !immediate) return
      stateRef.current = next
      const nowZoomed = isZoomed(next)
      if (nowZoomed !== zoomedRef.current) {
        zoomedRef.current = nowZoomed
        cellRef.current?.classList.toggle(ZOOMED_CLASS, nowZoomed)
        setZoomed(nowZoomed)
      }
      if (immediate) {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
        frameRef.current = null
        paint()
        return
      }
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        paint()
      })
    },
    [paint],
  )

  const resetZoom = useCallback((): void => {
    apply(ZOOM_IDENTITY)
  }, [apply])

  // Every gesture, only while filled (header). Cleanup is ZOOM-2's reset on leaving fill.
  useEffect(() => {
    const cell = cellRef.current
    if (!enabled || cell === null) return undefined

    const onWheel = (event: WheelEvent): void => {
      // A control's own wheel (P3.7's picker may scroll), as a press there is never a pan (header).
      if (isOnControl(event.target)) return
      // Always, even at a limit: Chromium's page zoom must never fire over the filled camera.
      event.preventDefault()
      // Once per wheel event is cheap enough, and keeps the cached rect fresh for the next drag.
      const { left, top, box } = (rectRef.current = measureCell(cell))
      const factor = wheelZoomFactor(event, box.height)
      apply(
        zoomAt(stateRef.current, factor, { x: event.clientX - left, y: event.clientY - top }, box),
      )
    }

    // Pressed pointers, by id, in client px. At most one mouse/pen, or two fingers.
    const pointers = new Map<number, TrackedPointer>()
    let dragged = false
    let guard: ClickGuardState = INITIAL_CLICK_GUARD
    const feedGuard = (event: ClickGuardEvent): boolean => {
      const result = clickGuardStep(guard, event)
      guard = result.state
      return result.swallow
    }

    const capture = (pointerId: number): void => {
      try {
        cell.setPointerCapture(pointerId)
      } catch {
        // The pointer is already gone (released before this ran); nothing to capture.
      }
    }
    const release = (pointerId: number): void => {
      if (cell.hasPointerCapture(pointerId)) cell.releasePointerCapture(pointerId)
    }

    const onPointerDown = (event: PointerEvent): void => {
      const touch = event.pointerType === 'touch'
      if (!touch && event.button !== 0) return
      if (isOnControl(event.target)) {
        // Not tracked, but still a press: it forgets a swallow a touch drag left behind (header).
        if (pointers.size === 0) feedGuard({ type: 'press' })
        return
      }
      if (pointers.size > 0) {
        // A second finger joins a pinch; anything else alongside a press is ignored.
        const first = pointers.values().next().value
        if (!touch || first?.touch !== true || pointers.size >= 2) return
        dragged = true // a pinch is not a click
      } else {
        dragged = false
        feedGuard({ type: 'press' })
      }
      rectRef.current = measureCell(cell)
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, touch })
      // Every tracked press, so its release is seen wherever it happens (header).
      capture(event.pointerId)
    }

    /** One pointer's press is over: forget it, and when it was the last, tell the guard. */
    const endPointer = (pointerId: number): void => {
      if (!pointers.delete(pointerId)) return
      release(pointerId)
      if (pointers.size > 0) return
      cell.classList.remove(PANNING_CLASS)
      feedGuard({ type: 'release', dragged })
    }

    const onPointerMove = (event: PointerEvent): void => {
      const pointer = pointers.get(event.pointerId)
      if (pointer === undefined) return
      if (!pointer.touch && event.buttons === 0) {
        // Its release never reached us (header): the press is over, and this move is a hover.
        endPointer(event.pointerId)
        return
      }
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        if (a === undefined || b === undefined) return
        const { left, top, box } = rectRef.current ?? measureCell(cell)
        const local = (p: { x: number; y: number }): ZoomPoint => ({ x: p.x - left, y: p.y - top })
        const previous = [local(a), local(b)] as const
        pointer.x = event.clientX
        pointer.y = event.clientY
        apply(pinchStep(stateRef.current, previous, [local(a), local(b)], box))
        return
      }
      const now = { x: event.clientX, y: event.clientY }
      if (!dragged) {
        // Until the threshold the pointer keeps its press point, so the pan, once it starts, makes
        // up the few px it waited for.
        if (!isDragDistance(pointer, now)) return
        dragged = true
      }
      const dx = now.x - pointer.x
      const dy = now.y - pointer.y
      pointer.x = now.x
      pointer.y = now.y
      // At 1× the drag is only tracked (a wheel mid-press may yet zoom, and then it pans).
      if (!zoomedRef.current) return
      cell.classList.add(PANNING_CLASS)
      // A pan needs only the box's size, which the cached rect has.
      apply(panBy(stateRef.current, dx, dy, (rectRef.current ?? measureCell(cell)).box))
    }

    const onPointerEnd = (event: PointerEvent): void => {
      endPointer(event.pointerId)
    }

    // The window lost focus mid-press (Alt+Tab, a dialog): its release may never come (header).
    const onBlur = (): void => {
      for (const pointerId of [...pointers.keys()]) endPointer(pointerId)
    }

    // Capture phase: before the event reaches the cell's own React `onClick` (header). A control's
    // click is the control's, and is never swallowed.
    const onClick = (event: MouseEvent): void => {
      if (isOnControl(event.target)) return
      if (!feedGuard({ type: 'click', detail: event.detail })) return
      event.stopPropagation()
      event.preventDefault()
    }
    const onDoubleClick = (event: MouseEvent): void => {
      if (isOnControl(event.target)) return
      if (feedGuard({ type: 'dblclick' })) {
        event.stopPropagation()
        event.preventDefault()
        return
      }
      if (!isZoomResetDblClick(event)) return
      // Not stopped: fillClickStep sees it too, and ignores it (and disarms).
      event.preventDefault()
      apply(ZOOM_IDENTITY)
    }

    cell.addEventListener('wheel', onWheel, { passive: false })
    cell.addEventListener('pointerdown', onPointerDown)
    cell.addEventListener('pointermove', onPointerMove)
    cell.addEventListener('pointerup', onPointerEnd)
    cell.addEventListener('pointercancel', onPointerEnd)
    // After a `pointerup` this finds nothing left to end; on its own, the capture was taken away.
    cell.addEventListener('lostpointercapture', onPointerEnd)
    cell.addEventListener('click', onClick, { capture: true })
    cell.addEventListener('dblclick', onDoubleClick, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      cell.removeEventListener('wheel', onWheel)
      cell.removeEventListener('pointerdown', onPointerDown)
      cell.removeEventListener('pointermove', onPointerMove)
      cell.removeEventListener('pointerup', onPointerEnd)
      cell.removeEventListener('pointercancel', onPointerEnd)
      cell.removeEventListener('lostpointercapture', onPointerEnd)
      cell.removeEventListener('click', onClick, { capture: true })
      cell.removeEventListener('dblclick', onDoubleClick, { capture: true })
      window.removeEventListener('blur', onBlur)
      for (const pointerId of pointers.keys()) release(pointerId)
      pointers.clear()
      rectRef.current = null
      cell.classList.remove(PANNING_CLASS, ZOOMED_CLASS)
      // ZOOM-2: leaving fill resets, at once rather than on the next frame.
      apply(ZOOM_IDENTITY, true)
    }
  }, [enabled, apply])

  // Resize while zoomed: same scale, re-clamped to the new box (header), and the new rect cached
  // for the next move. The observer's first report, right after `observe`, is a no-op clamp.
  useEffect(() => {
    const cell = cellRef.current
    if (!enabled || !zoomed || cell === null) return undefined
    const observer = new ResizeObserver(() => {
      const measured = (rectRef.current = measureCell(cell))
      apply(clampPan(stateRef.current, measured.box))
    })
    observer.observe(cell)
    return () => {
      observer.disconnect()
    }
  }, [enabled, zoomed, apply])

  return { cellRef, layerRef, zoomed, resetZoom }
}

export interface ZoomPanLayerProps {
  /** `useZoomPan`'s `layerRef`. */
  readonly layerRef: RefObject<HTMLDivElement | null>
  /** The player, and only the player (header, "Only the player is scaled"). */
  readonly children: ReactNode
}

/** The transformed element around the player. Always rendered, so the player never remounts. */
export function ZoomPanLayer({ layerRef, children }: ZoomPanLayerProps): JSX.Element {
  return (
    <div className="zoomPan" ref={layerRef}>
      {children}
    </div>
  )
}
