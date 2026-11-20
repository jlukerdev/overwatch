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
// **The zoomed picture is drawn on a canvas** (F1.0.2-9; zoomMath's "Drawn on a canvas"). The
// videos are never touched: they keep playing at 1×, as the stylesheet's `contain` draws them
// (player.css). While zoomed, `<ZoomPanLayer>`'s cell-sized `<canvas>`, laid over the player, is
// shown and draws the visible video's current frame into zoomMath's `zoomDrawRect`, clipped by the
// canvas. A transform was the obvious way and the wrong one, and an `object-view-box` crop the
// second: both make the video's quad up to 8× the cell (Chromium lays the video out at the zoomed
// size and clips it), and on Windows Chromium draws video through a DirectComposition overlay sized
// from that quad. A trace of a 2688×1512 camera showed a swap chain rebuilt at up to 16384×9216 per
// zoom step, presents of up to 2.1 s, then the GPU process crashing and every player reconnecting.
// With the canvas the video and its overlay stay the cell's size at every zoom, a zoom step is only
// a redraw, and the placeholder (a blurred still, the "Connecting…" label) is never blown up: it is
// under the canvas, and shows only while there is no frame to draw.
//
// **Which video, and when.** The visible video is the last, in DOM order, inside a
// `.livePlayer__layer` that is not `--pending` and not inside a pre-warm wrapper
// (`.gridCell__player--prewarm`, Cell.tsx); with none, or one without a current frame and a size,
// the canvas is hidden and the player shows as at 1×. They are the light-DOM children of the
// `<vp-mse-player>` elements LivePlayer appends imperatively — one, or two during a quality swap
// (QUAL-6) or a reconnect — so `paint` finds the visible one each time rather than keeping a
// reference. The canvas is drawn by `paint` (once per animation frame of a gesture, at once on a
// reset) and, while zoomed, on each new frame of the visible video: one `requestVideoFrameCallback`
// is kept pending on it, and each callback paints, which re-registers on whatever video is visible
// by then. What can change the visible video without a frame of it — a layer's `--pending` going,
// a layer removed, a pre-warm wrapper becoming the shown one — is watched by a `MutationObserver`
// on the layer while zoomed, and a video learning its size by capture-phase `loadedmetadata` and
// `resize` listeners (media events do not bubble, but they do pass through their ancestors in the
// capture phase); both repaint. The background the canvas clears to is the player's own
// (`.livePlayer`'s computed colour, read once per zoom), so its bars are the letterbox's. The
// overlay (name, badge, controls) is the layer's sibling and is never touched. The layer is
// **always rendered**, filled or not, zoomed or not: wrapping the player only while zoomed would
// re-parent it, which is a remount — a new connection, the very thing FILL-2's "same player,
// enlarged" exists to avoid. At 1× the canvas is hidden and 0×0, and no frame callback is pending.
//
// **The cell listens, not the layer.** Wheel, pointer and click listeners go on the cell element
// (`.gridCell`), native and attached in an effect (as CellOverlay's hover listeners are), so a wheel
// or a drag that starts over the name chip works too. Native listeners on the cell run *before*
// React's (React listens at the root), so the overlay slot's `stopPropagation` does not reach them:
// a press, wheel, click or double-click on a control (`.cellOverlay__slot`, or the bottom slot's
// unlock control, `.cellOverlay__bottom`, P5.4) is skipped here by
// checking its target, which keeps pressing a button from ever panning and leaves the wheel to a
// control that scrolls (the picker). Everywhere else `wheel` is `{ passive: false }` and always
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
// on "100%" or the back-to-grid control must still work. A press on a control is still fed to the guard as a press,
// so that leftover swallow is forgotten before any later click on the picture.
//
// **Hot path.** Wheel ticks and pointer moves arrive many times a frame. The zoom state lives in a
// ref, and the canvas is redrawn from it once per animation frame however many events came in. The one thing React draws is `zoomed` (scale > 1), mirrored in a ref and
// `setState`d only when it flips, because it decides whether the 100% control is there; a wheel
// tick at 3× re-renders nothing. The cursor classes are toggled with `classList`, not
// through React's `className`, so they never re-render anything either. The cell's rect is read at
// each press, each wheel event and each resize, and reused by every move in between, so a pointer
// move never forces a layout; the cell does not move under a gesture.
//
// **Cursor.** `grab` while zoomed and `grabbing` while a drag pans (zoom.css). CELL-4's idle hide
// still wins: zoom.css's cursor rules apply only `:not(.gridCell--cursorHidden)`, so whichever
// stylesheet loads first, a cursor resting on a zoomed picture still gets out of the way.
//
// **Reset on leaving fill** (ZOOM-2). Esc, the back control, a plain double-click, a View switch or
// the slot going away all end in `enabled` going false, and the effect's cleanup goes back to the identity at once
// (not on the next frame) by hiding and emptying the canvas and cancelling its frame callback,
// cancels the animation frame, drops every listener and the resize observer, releases any
// pointer capture and clears the cursor classes. Unmount is the same cleanup. **Resize** is watched
// only while zoomed: a `ResizeObserver` on the cell re-clamps to the new box at the same scale, so a
// window resize never leaves a gap at an edge, and repaints even when the clamp changes nothing —
// the drawing depends on the box, not only on the state, and the canvas's backing store is resized
// to the new box.
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
  zoomDrawRect,
  type ClickGuardEvent,
  type ClickGuardState,
  type ZoomBox,
  type ZoomPoint,
  type ZoomRect,
  type ZoomState,
} from './zoomMath'
import './zoom.css'

/** On the cell while zoomed: the `grab` cursor (zoom.css). */
const ZOOMED_CLASS = 'gridCell--zoomed'
/** On the cell while a drag pans: `grabbing`. */
const PANNING_CLASS = 'gridCell--panning'
/**
 * CellOverlay's control slots — the strip's and the bottom one (the unlock control, P5.4): a press,
 * wheel or click there is a control's, never zoom's (header).
 */
const CONTROLS_SELECTOR = '.cellOverlay__slot, .cellOverlay__bottom'
/** On `<ZoomPanLayer>`'s canvas while it shows the zoomed picture (zoom.css). */
const CANVAS_ON_CLASS = 'zoomPan__canvas--on'
/** The videos that may be the visible one (header, "Which video"); pre-warm ones are filtered out. */
const SHOWN_VIDEO_SELECTOR = '.livePlayer__layer:not(.livePlayer__layer--pending) video'
const PREWARM_SELECTOR = '.gridCell__player--prewarm'

export interface ZoomPan {
  /** For the cell element (`.gridCell`): where every listener goes. */
  readonly cellRef: RefObject<HTMLDivElement | null>
  /** For `<ZoomPanLayer>`: where the video to draw is found. */
  readonly layerRef: RefObject<HTMLDivElement | null>
  /** For `<ZoomPanLayer>`'s canvas: where the zoomed picture is drawn. */
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
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
  // The fill / back transition (GridView.tsx) runs a transform on the cell's slot for ~170 ms, and
  // a rect read under it would be the shrunken, offset box. A wheel or a press in that window ends
  // the transition at once, so the rect read below is the cell's real one.
  for (const animation of cell.closest('.gridView__slot')?.getAnimations() ?? []) animation.finish()
  const rect = cell.getBoundingClientRect()
  return { left: rect.left, top: rect.top, box: { width: rect.width, height: rect.height } }
}

/** A video's pending `requestVideoFrameCallback`, with the element it was registered on. */
interface PendingFrame {
  readonly video: HTMLVideoElement
  readonly id: number
}

/**
 * Shows or hides the canvas, writing its class only when that changes: even an unchanged write is a
 * mutation, which the layer's `MutationObserver` would answer with another paint.
 */
function showCanvas(canvas: HTMLCanvasElement, on: boolean): void {
  if (canvas.classList.contains(CANVAS_ON_CLASS) !== on)
    canvas.classList.toggle(CANVAS_ON_CLASS, on)
}

/** The visible video in the layer, or `null` (header, "Which video"). */
function visibleVideo(layer: HTMLElement): HTMLVideoElement | null {
  let found: HTMLVideoElement | null = null
  for (const video of layer.querySelectorAll<HTMLVideoElement>(SHOWN_VIDEO_SELECTOR)) {
    if (video.closest(PREWARM_SELECTOR) === null) found = video
  }
  return found
}

/** The video has a frame to draw and knows its size. */
function hasFrame(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

/** The colour behind the player (player.css's `.livePlayer` background), never hard-coded here. */
function playerBackground(layer: HTMLElement, video: HTMLVideoElement): string {
  const player = video.closest('.livePlayer') ?? layer.querySelector('.livePlayer')
  if (player !== null) {
    const colour = getComputedStyle(player).backgroundColor
    if (colour !== '' && colour !== 'transparent' && colour !== 'rgba(0, 0, 0, 0)') return colour
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--bg-sunken').trim()
}

/**
 * One frame on the canvas: cleared to the player's background, then the video drawn into `rect`
 * (cell-local CSS px), scaled to the backing store's device px; the canvas clips what reaches past it.
 */
function drawFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rect: ZoomRect,
  dpr: number,
  background: string,
): void {
  context.fillStyle = background
  context.fillRect(0, 0, context.canvas.width, context.canvas.height)
  context.imageSmoothingEnabled = true
  context.drawImage(video, rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr)
}

/** The event started on one of the overlay's controls, which zoom leaves alone (header). */
function isOnControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROLS_SELECTOR) !== null
}

export function useZoomPan(enabled: boolean): ZoomPan {
  const cellRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The canvas's 2D context, made once; it also keeps the canvas reachable after an unmount. */
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  /** The colour the canvas clears to, read at the first draw of each zoom (header). */
  const backgroundRef = useRef<string | null>(null)
  /** The one pending video frame callback while zoomed (header, "Which video, and when"). */
  const pendingFrameRef = useRef<PendingFrame | null>(null)
  /** `paint`, for the video frame callbacks `paint` itself registers. */
  const paintRef = useRef<(() => void) | null>(null)
  const stateRef = useRef<ZoomState>(ZOOM_IDENTITY)
  const zoomedRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  /** The cell's rect as last measured (header, "Hot path"); `null` until the first press or wheel. */
  const rectRef = useRef<MeasuredCell | null>(null)
  const [zoomed, setZoomed] = useState(false)

  /** Cancels the pending video frame callback, if any. */
  const cancelFrameCallback = useCallback((): void => {
    const pending = pendingFrameRef.current
    if (pending === null) return
    pendingFrameRef.current = null
    pending.video.cancelVideoFrameCallback(pending.id)
  }, [])

  /**
   * Back to 1×: the canvas hidden and emptied (a 0×0 backing store holds no memory), no frame
   * callback pending. Needs neither ref an unmount may already have cleared: the context knows its
   * canvas.
   */
  const stopCanvas = useCallback((): void => {
    cancelFrameCallback()
    backgroundRef.current = null
    const canvas = canvasRef.current ?? contextRef.current?.canvas ?? null
    if (canvas === null) return
    showCanvas(canvas, false)
    if (canvas.width !== 0) canvas.width = 0
    if (canvas.height !== 0) canvas.height = 0
  }, [cancelFrameCallback])

  /**
   * Draws the current state on the canvas now (header, "The zoomed picture is drawn on a canvas"),
   * and keeps a frame callback pending on the visible video so its next frame is drawn too. At the
   * identity the canvas is stopped; with no frame to draw it is only hidden, and the callback waits
   * for one.
   */
  const paint = useCallback((): void => {
    const state = stateRef.current
    const layer = layerRef.current
    const canvas = canvasRef.current
    if (!isZoomed(state) || layer === null || canvas === null) {
      stopCanvas()
      return
    }
    // Normally cached by the press or wheel that zoomed. Without a cached rect, the cell's layout
    // size: unlike `measureCell` it never ends the fill transition from a paint, and a transform on
    // the slot does not change it.
    const cell = cellRef.current
    const box: ZoomBox | null =
      rectRef.current?.box ??
      (cell === null ? null : { width: cell.clientWidth, height: cell.clientHeight })
    const video = visibleVideo(layer)

    // One callback, on the visible video; moved when the visible video changes.
    if (pendingFrameRef.current !== null && pendingFrameRef.current.video !== video) {
      cancelFrameCallback()
    }
    if (video !== null && pendingFrameRef.current === null) {
      const pending: PendingFrame = {
        video,
        id: video.requestVideoFrameCallback(() => {
          if (pendingFrameRef.current === pending) pendingFrameRef.current = null
          paintRef.current?.()
        }),
      }
      pendingFrameRef.current = pending
    }

    const rect =
      box === null || video === null || !hasFrame(video)
        ? null
        : zoomDrawRect(state, box, { width: video.videoWidth, height: video.videoHeight })
    if (box === null || video === null || rect === null) {
      showCanvas(canvas, false)
      return
    }
    let context = contextRef.current
    if (context?.canvas !== canvas) {
      context = contextRef.current = canvas.getContext('2d', { alpha: false })
    }
    if (context === null) {
      showCanvas(canvas, false)
      return
    }

    const dpr = window.devicePixelRatio || 1
    const width = Math.round(box.width * dpr)
    const height = Math.round(box.height * dpr)
    // Assigning a size clears the canvas (and resets the context), so only when it changes.
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    backgroundRef.current ??= playerBackground(layer, video)
    drawFrame(context, video, rect, dpr, backgroundRef.current)
    showCanvas(canvas, true)
  }, [cancelFrameCallback, stopCanvas])

  useEffect(() => {
    paintRef.current = paint
    return () => {
      paintRef.current = null
    }
  }, [paint])

  /** Paints on the next animation frame, once however many times it is asked (header). */
  const schedulePaint = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      paint()
    })
  }, [paint])

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
      schedulePaint()
    },
    [paint, schedulePaint],
  )

  const resetZoom = useCallback((): void => {
    apply(ZOOM_IDENTITY)
  }, [apply])

  // Every gesture, only while filled (header). Cleanup is ZOOM-2's reset on leaving fill.
  useEffect(() => {
    const cell = cellRef.current
    if (!enabled || cell === null) return undefined

    const onWheel = (event: WheelEvent): void => {
      // A control's own wheel (the quality picker's), as a press there is never a pan (header).
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
  // for the next move. The observer's first report, right after `observe`, is a no-op clamp. The
  // repaint is asked for either way: a new box is a new drawing and a new canvas size even when the
  // clamp keeps the state (`apply` skips an unchanged one, and `schedulePaint` coalesces with its
  // frame when it did not).
  useEffect(() => {
    const cell = cellRef.current
    if (!enabled || !zoomed || cell === null) return undefined
    const observer = new ResizeObserver(() => {
      const measured = (rectRef.current = measureCell(cell))
      apply(clampPan(stateRef.current, measured.box))
      schedulePaint()
    })
    observer.observe(cell)
    return () => {
      observer.disconnect()
    }
  }, [enabled, zoomed, apply, schedulePaint])

  // A video that learns its size mid-zoom — a quality swap's or a reconnect's new layer, or a stream
  // whose resolution changed — is drawn at its new size at once (header). Capture phase, because
  // media events do not bubble. Attached for as long as the cell is filled, not only while zoomed: a
  // video whose size arrives between the first zoomed paint and React committing `zoomed` would
  // otherwise wait for its next frame. At 1× the paint only stops the canvas, which costs nothing.
  useEffect(() => {
    const layer = layerRef.current
    if (!enabled || layer === null) return undefined
    const onMediaSize = (): void => {
      paint()
    }
    layer.addEventListener('loadedmetadata', onMediaSize, { capture: true })
    layer.addEventListener('resize', onMediaSize, { capture: true })
    // A change of which video is visible (a swap's layer promoted, the old one removed, a pre-warm
    // wrapper shown) repaints too (header, "Which video"): the frame callback may sit on a video that
    // is gone. For the same reason as the listeners above, for as long as the cell is filled: a swap
    // between the first zoomed paint and React committing `zoomed` would otherwise freeze the canvas.
    // The canvas's own class is the hook's, not a change of video.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.target !== canvasRef.current)) schedulePaint()
    })
    mutations.observe(layer, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => {
      layer.removeEventListener('loadedmetadata', onMediaSize, { capture: true })
      layer.removeEventListener('resize', onMediaSize, { capture: true })
      mutations.disconnect()
    }
  }, [enabled, paint, schedulePaint])

  return { cellRef, layerRef, canvasRef, zoomed, resetZoom }
}

export interface ZoomPanLayerProps {
  /** `useZoomPan`'s `layerRef`. */
  readonly layerRef: RefObject<HTMLDivElement | null>
  /** `useZoomPan`'s `canvasRef`. */
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  /** The player, and only the player (header, "The zoomed picture is drawn on a canvas"). */
  readonly children: ReactNode
}

/**
 * The element around the player, and the canvas over it where `useZoomPan` draws the zoomed
 * picture; neither is ever transformed. Always rendered, so the player never remounts (FILL-2).
 */
export function ZoomPanLayer({ layerRef, canvasRef, children }: ZoomPanLayerProps): JSX.Element {
  return (
    <div className="zoomPan" ref={layerRef}>
      {children}
      <canvas className="zoomPan__canvas" ref={canvasRef} aria-hidden />
    </div>
  )
}
