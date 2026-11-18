// The fill / back transition (FILL-1, UX polish): the slot growing from its grid rectangle to the
// grid area, and shrinking back. Pure and unit-tested (no jsdom here, CLAUDE.md); `<GridView>` runs
// the answer as one Web Animation on the slot element.
//
// **FLIP, transform only.** `<GridView>` re-places the slot instantly, exactly as before (the class
// `gridView__slot--filled` or its rectangle): layout changes once, in the commit, and the player
// inside is the same element throughout (FILL-2). The animation then only *draws* the slot as if it
// were still where it came from and lets that go over {@link FILL_TRANSITION_MS}: one `transform`
// keyframe pair, run by the compositor, no width / height / top / left animated, nothing per frame
// in React or in layout. When it ends (or is cancelled) the slot has no transform at all.
//
// **One uniform scale, never a stretch** (VIEW-5: a camera is never distorted). A cell and the grid
// area rarely have the same shape, so the two rectangles cannot be mapped onto each other without
// scaling x and y differently. Instead the slot is scaled by one factor — the one that *fits* its
// new box inside the old one — about the old box's centre. For a picture the shape of its cell, that
// is also the scale at which the picture is exactly as large as it was before the click, so it
// seems to grow in place; the box around it is a little off the old rectangle on one axis, which
// nobody sees in a sixth of a second.
//
// **The slot, not the zoom layer.** `useZoomPan` owns the transform of `.zoomPan` inside the cell
// (features/zoom/ZoomPan.tsx); this one is on `.gridView__slot`, two elements up, so the two never
// write the same property.
//
// **When it runs** ({@link fillTransitionPlan}): only when the filled slot changed within one View
// that is on screen at a real size, and the user has not asked for reduced motion. A View switch
// while filled is not a transition — the grid under the fill is another grid — and neither is the
// first render.
import type { Rect } from '@shared/viewLayout'

/** Short enough not to delay anything, long enough to see where the cell went. */
export const FILL_TRANSITION_MS = 170

/** Decelerating (ease-out): the slot arrives rather than lands. */
export const FILL_TRANSITION_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/** A slot's starting transform, for `transform-origin: 0 0`: `translate(x, y) scale(scale)`. */
export interface FlipTransform {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/**
 * The transform that draws a box laid out at `to` fitted inside `from`, centred on it, at one
 * uniform scale (header). Both rectangles are in the same coordinates (the grid area's). `null`
 * when either has no size, or when there is nothing to animate (the same box).
 */
export function flipTransform(from: Rect, to: Rect): FlipTransform | null {
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return null
  const scale = Math.min(from.width / to.width, from.height / to.height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  const x = from.x + (from.width - to.width * scale) / 2 - to.x
  const y = from.y + (from.height - to.height * scale) / 2 - to.y
  if (scale === 1 && x === 0 && y === 0) return null
  return { x, y, scale }
}

/** The CSS `transform` for a {@link FlipTransform} (origin `0 0`, grid.css). */
export function flipTransformCss(flip: FlipTransform): string {
  return `translate(${String(flip.x)}px, ${String(flip.y)}px) scale(${String(flip.scale)})`
}

/** Which slot animates, and which way. */
export interface FillTransitionPlan {
  readonly slotKey: string
  /** `fill`: from its grid rectangle to the grid area. `unfill`: back. */
  readonly direction: 'fill' | 'unfill'
}

/**
 * What to animate after a render, or `null` for nothing (header). `previousKey` / `nextKey` are the
 * filled slot before and after; `sameView` is whether both renders drew the same View.
 *
 * Going straight from one filled slot to another (no UI does this today: the covered cells are
 * inert) animates the new one in; the old one is simply back in its place underneath.
 */
export function fillTransitionPlan(input: {
  readonly previousKey: string | null
  readonly nextKey: string | null
  readonly sameView: boolean
  /** The grid has a real size (`<GridView>`'s `drawable`). */
  readonly drawable: boolean
  /** `prefers-reduced-motion: reduce`. */
  readonly reducedMotion: boolean
}): FillTransitionPlan | null {
  const { previousKey, nextKey } = input
  if (previousKey === nextKey) return null
  if (!input.sameView || !input.drawable || input.reducedMotion) return null
  if (nextKey !== null) return { slotKey: nextKey, direction: 'fill' }
  if (previousKey !== null) return { slotKey: previousKey, direction: 'unfill' }
  return null
}
