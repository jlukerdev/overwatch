// Digital zoom's arithmetic (P3.6; ZOOM-1/2/3): where the picture sits for a wheel tick, a pinch or
// a drag, how far it may go, and which clicks belong to zoom rather than to the cell. Pure, so every
// rule is tested in the node environment (this project has no jsdom; CLAUDE.md) and `useZoomPan`
// (./ZoomPan.tsx) only feeds it pointer events and draws its answer on the cell's canvas.
//
// **One mapping, origin top-left.** The state is `{ scale, x, y }`: a point `p` of the unzoomed
// picture (cell-local px) is drawn at `(x, y) + scale · p`, as `translate(x, y) scale(scale)` with
// `transform-origin: 0 0` would draw it. Every point here — the cursor, a pinch's fingers — is in
// the same cell-local px, measured from the cell's top-left. The box is the cell's own (the whole
// grid area while filled), so there is no second coordinate system to convert between.
//
// **Drawn on a canvas, not on the video** ({@link zoomDrawRect}). The state is never written onto
// the `<video>`: a CSS transform and an `object-view-box` crop both make the video's quad up to 8×
// the cell (Chromium lays the video out at the zoomed size and clips it), and on Windows, where
// Chromium puts video in a DirectComposition overlay sized from that quad, each zoom step rebuilt a
// swap chain up to 16384×9216 — a trace showed presents of up to 2.1 s, then the GPU process
// crashing and every player reconnecting (F1.0.2-9). Instead the video keeps playing at 1×, and
// while zoomed a cell-sized canvas over it draws the frame into {@link zoomDrawRect}: the contained
// picture moved by the state, clipped by the canvas. The video and its overlay stay the cell's size
// at every zoom, and a zoom step is only a redraw. The two are the same picture; the tests check it
// point by point. It is the renderer's own drawing and nothing else (ZOOM-3): no stream, quality or
// camera setting moves.
//
// The rules, and why:
//
//  - **1× to 8×** ({@link MIN_ZOOM}, {@link MAX_ZOOM}; ZOOM-1). Below 1× there is nothing to see
//    that `contain` (FILL_FIT) does not already show; past 8× a 4K camera's pixels are already
//    blocks on a large monitor.
//  - **Zoom is about the cursor** ({@link zoomAt}). The content point under the cursor stays under
//    it, which is what makes "zoom into that car" one gesture instead of zoom-then-pan. At a limit
//    the scale stops, and so does the picture: a wheel tick past 8× does not slide it about.
//  - **The picture always covers the cell** ({@link clampPan}). `x` stays in
//    `[width · (1 − scale), 0]`, and `y` likewise, so the zoomed picture's box never leaves a gap at
//    any edge and a drag can never pan the camera off screen. The letterbox bars of a `contain`ed
//    camera are part of that picture and scale with it; that keeps the clamp one rectangle rather
//    than one per camera shape, and they leave the screen as soon as the zoom is deep enough.
//  - **1× is exactly the identity.** A scale within {@link SNAP_EPSILON} of 1 snaps to
//    {@link ZOOM_IDENTITY} — offsets of `-0.0000001px` from repeated multiply-and-divide would
//    otherwise leave the picture a hair off, and "zoomed" (the 100% control, the canvas) would
//    stay on for a state the viewer cannot tell from 1×.
//  - **A wheel tick is a factor, not a step** ({@link wheelZoomFactor}). `exp(−delta · k)` makes
//    zooming in and back out by the same distance land on the same scale, and treats one big tick
//    and many small ones alike. Line and page `deltaMode`s are turned into px first. Chromium
//    delivers a trackpad pinch as a `ctrlKey` wheel with small deltas, so that gets a larger `k`;
//    the same goes for a real Ctrl+wheel, which is fine — it is the gesture people expect to zoom.
//    One event's factor is clamped, so a mouse that reports a page per notch cannot jump 1× → 8×.
//  - **Two fingers pinch about their midpoint** ({@link pinchStep}): the scale follows the ratio
//    of their distances, and the midpoint's movement pans, in one step, so a pinch that also drifts
//    does what the fingers do.
//  - **A drag is not a click** ({@link DRAG_THRESHOLD_PX}, {@link clickGuardStep}). A press that
//    moved further than a few px was a pan (or an attempt at one), and the `click` the browser sends
//    at its release must not reach the cell, where fill would count it as the first half of a
//    double-click that leaves (fillClickStep's arming). The same holds for the `dblclick` of a pair
//    whose first or second press was a drag.
//  - **Modifier + double-click resets** ({@link isZoomResetDblClick}; ZOOM-2). It is the one
//    double-click fillClickStep leaves alone, for this.
//  - **A resize keeps the scale and re-clamps** ({@link clampPan} with the new box), so the picture
//    stays as deep as it was and never shows a gap at the edge the window just moved.
//
// **Identity is meaningful.** A step that changes nothing returns the very same state object, so
// the hook skips the frame with `===`.

/** Where the zoomed picture is: content point `p` is drawn at `(x, y) + scale · p` (header). */
export interface ZoomState {
  readonly scale: number
  /** Translation in CSS px, `<= 0` (clampPan). */
  readonly x: number
  readonly y: number
}

/** The cell's size in CSS px. */
export interface ZoomBox {
  readonly width: number
  readonly height: number
}

/** A point in cell-local CSS px (from the cell's top-left). */
export interface ZoomPoint {
  readonly x: number
  readonly y: number
}

export const ZOOM_IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 }

/** ZOOM-1's range. */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

/** A scale this close to 1 is 1 (header, "1× is exactly the identity"). */
export const SNAP_EPSILON = 1e-3

/** Wheel px per CSS-px of delta for an ordinary wheel: one 100 px notch is about ×1.22. */
export const WHEEL_ZOOM_K = 0.002
/** Same, for a `ctrlKey` wheel (trackpad pinch): its events carry a few px each. */
export const PINCH_WHEEL_ZOOM_K = 0.01
/** One `deltaMode: 1` line, in px (Firefox's and Chromium's usual line height). */
export const WHEEL_LINE_PX = 16
/** The most one wheel event may zoom in by; its inverse is the most it may zoom out by. */
export const MAX_WHEEL_FACTOR = 2

/** How far a press may move and still be a click (header, "A drag is not a click"). */
export const DRAG_THRESHOLD_PX = 4

/** `WheelEvent.deltaMode`. */
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The state is zoomed in: the 100% control is shown and the cursor offers to grab. */
export function isZoomed(state: ZoomState): boolean {
  return state.scale > MIN_ZOOM
}

/**
 * `state` with its translation clamped so the picture covers `box` (header). Snaps a scale near 1
 * to the identity. Returns `state` itself when nothing changes.
 */
export function clampPan(state: ZoomState, box: ZoomBox): ZoomState {
  return clampMove(state, state.x, state.y, box)
}

/**
 * `state` moved to `(x, y)` and clamped, compared against `state` itself, so a move that changes
 * nothing — none asked for, or pushed against an edge — is still `state` (header, "Identity").
 */
function clampMove(state: ZoomState, x: number, y: number, box: ZoomBox): ZoomState {
  const scale = clamp(state.scale, MIN_ZOOM, MAX_ZOOM)
  if (scale - MIN_ZOOM < SNAP_EPSILON) return state === ZOOM_IDENTITY ? state : ZOOM_IDENTITY
  const nextX = clamp(x, box.width * (1 - scale), 0)
  const nextY = clamp(y, box.height * (1 - scale), 0)
  return scale === state.scale && nextX === state.x && nextY === state.y
    ? state
    : { scale, x: nextX, y: nextY }
}

/**
 * Multiply the scale by `factor`, keeping the content point under `point` where it is, then clamp
 * (header, "Zoom is about the cursor"). At a limit the scale and the picture stay put.
 */
export function zoomAt(
  state: ZoomState,
  factor: number,
  point: ZoomPoint,
  box: ZoomBox,
): ZoomState {
  if (!Number.isFinite(factor) || factor <= 0) return state
  const scale = clamp(state.scale * factor, MIN_ZOOM, MAX_ZOOM)
  if (scale === state.scale) return clampPan(state, box)
  // The content point under the cursor, then where it must be drawn from at the new scale.
  const contentX = (point.x - state.x) / state.scale
  const contentY = (point.y - state.y) / state.scale
  return clampPan({ scale, x: point.x - scale * contentX, y: point.y - scale * contentY }, box)
}

/**
 * Move the picture by `(dx, dy)` px, then clamp. At 1× there is nowhere to go. A move that changes
 * nothing, a zero one included, returns `state` itself.
 */
export function panBy(state: ZoomState, dx: number, dy: number, box: ZoomBox): ZoomState {
  return clampMove(state, state.x + dx, state.y + dy, box)
}

/** The parts of a `WheelEvent` {@link wheelZoomFactor} reads. */
export interface ZoomWheel {
  readonly deltaY: number
  readonly deltaMode: number
  readonly ctrlKey: boolean
}

/**
 * The scale factor for one wheel event (header, "A wheel tick is a factor"): > 1 zooms in (wheel
 * up, fingers apart), < 1 out. `boxHeight` is what a `deltaMode: 2` "page" means here.
 */
export function wheelZoomFactor(event: ZoomWheel, boxHeight: number): number {
  const px =
    event.deltaMode === DOM_DELTA_LINE
      ? event.deltaY * WHEEL_LINE_PX
      : event.deltaMode === DOM_DELTA_PAGE
        ? event.deltaY * boxHeight
        : event.deltaY
  if (!Number.isFinite(px) || px === 0) return 1
  const k = event.ctrlKey ? PINCH_WHEEL_ZOOM_K : WHEEL_ZOOM_K
  return clamp(Math.exp(-px * k), 1 / MAX_WHEEL_FACTOR, MAX_WHEEL_FACTOR)
}

/** Two touch points, cell-local. */
export type ZoomPointerPair = readonly [ZoomPoint, ZoomPoint]

/**
 * One move of a two-finger pinch: scale by the ratio of the fingers' distances about their previous
 * midpoint, and pan by how far that midpoint moved (header). Fingers on top of each other give no
 * ratio, so only the pan applies.
 */
export function pinchStep(
  state: ZoomState,
  previous: ZoomPointerPair,
  current: ZoomPointerPair,
  box: ZoomBox,
): ZoomState {
  const before = Math.hypot(previous[1].x - previous[0].x, previous[1].y - previous[0].y)
  const after = Math.hypot(current[1].x - current[0].x, current[1].y - current[0].y)
  const ratio = before >= 1 && after >= 1 ? after / before : 1
  const midBefore = midpoint(previous)
  const midAfter = midpoint(current)
  const scale = clamp(state.scale * ratio, MIN_ZOOM, MAX_ZOOM)
  // The content point under the old midpoint is drawn under the new one, at the new scale.
  const contentX = (midBefore.x - state.x) / state.scale
  const contentY = (midBefore.y - state.y) / state.scale
  return clampPan(
    { scale, x: midAfter.x - scale * contentX, y: midAfter.y - scale * contentY },
    box,
  )
}

function midpoint(pair: ZoomPointerPair): ZoomPoint {
  return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }
}

/** A press that went from `start` to `now` has moved far enough to be a drag (header). */
export function isDragDistance(start: ZoomPoint, now: ZoomPoint): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > DRAG_THRESHOLD_PX
}

/**
 * Which `click` / `dblclick` events zoom swallows before they reach the cell (header, "A drag is
 * not a click"). Fed every press, release, click and double-click on the filled cell.
 */
export interface ClickGuardState {
  /** The press just released was a drag: its `click` is coming and is not a click. */
  readonly swallowClick: boolean
  /** The last `click` was swallowed. */
  readonly lastClickSwallowed: boolean
  /** The first click (`detail` 1) of the current multi-click was swallowed. */
  readonly pairStartedWithDrag: boolean
}

export const INITIAL_CLICK_GUARD: ClickGuardState = {
  swallowClick: false,
  lastClickSwallowed: false,
  pairStartedWithDrag: false,
}

export type ClickGuardEvent =
  /** A primary press began. Forgets a swallow that never met its click (a cancelled pointer). */
  | { readonly type: 'press' }
  /** The press ended; `dragged` if it moved past the threshold or was part of a pinch. */
  | { readonly type: 'release'; readonly dragged: boolean }
  | { readonly type: 'click'; readonly detail: number }
  | { readonly type: 'dblclick' }

export interface ClickGuardResult {
  readonly state: ClickGuardState
  /** Stop this event before it reaches the cell. Always `false` for press and release. */
  readonly swallow: boolean
}

export function clickGuardStep(state: ClickGuardState, event: ClickGuardEvent): ClickGuardResult {
  switch (event.type) {
    case 'press':
      return { state: { ...state, swallowClick: false }, swallow: false }
    case 'release':
      return { state: { ...state, swallowClick: event.dragged }, swallow: false }
    case 'click': {
      const swallow = state.swallowClick
      return {
        state: {
          swallowClick: false,
          lastClickSwallowed: swallow,
          // `detail` counts the clicks of the current multi-click; only its first one starts a pair.
          pairStartedWithDrag: event.detail <= 1 ? swallow : state.pairStartedWithDrag,
        },
        swallow,
      }
    }
    case 'dblclick':
      return {
        state: { ...state, lastClickSwallowed: false, pairStartedWithDrag: false },
        swallow: state.pairStartedWithDrag || state.lastClickSwallowed,
      }
  }
}

/** The parts of a `dblclick` `MouseEvent` {@link isZoomResetDblClick} reads. */
export interface ZoomResetDblClick {
  /** 0 is the primary button. */
  readonly button: number
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/**
 * ZOOM-2: a primary-button double-click with Ctrl, Cmd, Alt or Shift held resets to 100%. Any of
 * them, on every platform: on macOS Ctrl+click is a context click and never makes a double-click,
 * which is why the 100% control's tooltip names only the others there (Cell.tsx).
 */
export function isZoomResetDblClick(event: ZoomResetDblClick): boolean {
  return event.button === 0 && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
}

/** A video's natural size in px (`videoWidth` / `videoHeight`). */
export interface ZoomNaturalSize {
  readonly width: number
  readonly height: number
}

function isPositiveSize(size: ZoomBox | ZoomNaturalSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}

/** A rectangle in cell-local CSS px. */
export interface ZoomRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where the unzoomed player draws a `natural`-sized video in `box`: `object-fit: contain`, centred,
 * at its own aspect, with bars on one axis (SPEC FILL; player.css). Contain because a filled cell
 * always plays at fillMode's `FILL_FIT`, whatever the View's `fit`: if that ever follows the View,
 * this needs the fit too, or the picture jumps from cropped to letterboxed as the zoom leaves 1×. `null` whenever a size is not a
 * positive finite number (no metadata yet, a cell not laid out).
 */
export function containRect(box: ZoomBox, natural: ZoomNaturalSize): ZoomRect | null {
  if (!isPositiveSize(box) || !isPositiveSize(natural)) return null
  const aspect = natural.width / natural.height
  const wide = aspect > box.width / box.height
  const width = wide ? box.width : box.height * aspect
  const height = wide ? box.width / aspect : box.height
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }
}

/**
 * Where the canvas draws the video for `state` (header, "Drawn on a canvas"): the {@link containRect}
 * moved by the state's mapping, `(x, y) + scale · p`, exactly as `translate(x, y) scale(scale)` with
 * origin top-left drew the contained video. In cell-local CSS px; it reaches past the box when zoomed,
 * and the canvas clips it. `null` as for {@link containRect}.
 */
export function zoomDrawRect(
  state: ZoomState,
  box: ZoomBox,
  natural: ZoomNaturalSize,
): ZoomRect | null {
  const content = containRect(box, natural)
  if (content === null) return null
  return {
    left: state.x + state.scale * content.left,
    top: state.y + state.scale * content.top,
    width: state.scale * content.width,
    height: state.scale * content.height,
  }
}
