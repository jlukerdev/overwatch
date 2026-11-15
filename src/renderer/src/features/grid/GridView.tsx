// The active View, drawn letterboxed (P3.2; VIEW-5, VIEW-7): the largest grid whose 1×1 cells are
// exactly the View's `aspect`, centred in whatever box this component is given, with the View's
// `gap` between cells and the page background in the bars and the gaps.
//
// Thin on purpose (no jsdom here; CLAUDE.md). The two decisions live in pure, tested code:
// `buildViewSlots` (./gridLayout) says what goes in each cell, `layoutGrid` / `cellRect`
// (@shared/viewLayout) say where. This file only measures its own box and places the result.
//
// **Absolutely positioned, not a CSS grid.** The P2.4 grid stretched `1fr` tracks to the window, so
// a cell had whatever shape the window had. VIEW-5 wants every unit cell at one exact aspect and
// spans of any rectangle, which `layoutGrid` already computes in px; CSS grid would have to be
// re-taught the same arithmetic. Values stay fractional — CSS lays out at subpixel precision, and
// rounding would make the grid narrower than it could be (see `layoutGrid`).
//
// **One component across View switches.** The Live screen renders the same `<GridView>` whatever the
// active View, and the slots are keyed by camera (`buildViewSlots`), so a camera that is in both the
// old and the new View keeps its player and its stream; only the box around it moves. The player is
// built for that: a moved `<vp-mse-player>` keeps playing (MsePlayer.ts, `onconnect`).
//
// **Fill lives here too** (P3.5; FILL-1/2/3, QUAL-5/6). Clicking a camera cell fills the grid area with
// it, and that is this component re-placing one slot, not another component appearing: the filled
// slot keeps its key, its `<Cell>` and its `<LivePlayer>`, gets `gridView__slot--filled` (the whole
// grid area; the header and the View switcher stay usable beside it, grid.css) instead of its rectangle, and is
// handed the slot's `fillQuality` and `FILL_FIT`. The player's own quality swap does the rest
// seamlessly (FILL-2). Every other slot stays mounted and laid out underneath — covered, not hidden —
// so its stream keeps running and leaving fill is instant; while covered it is `inert` and
// `aria-hidden`, so Tab and assistive tech cannot reach controls nobody can see. Which slot is
// filled, and which clicks and keys enter and leave, are the pure rules in features/fill/fillMode.ts;
// this file keeps the state, listens for `Esc` while filled, and draws the answer.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import type { QualityDefaults } from '@shared/quality'
import { cellRect, layoutGrid, type Rect } from '@shared/viewLayout'
import { useAppStore } from '../../state/appStore'
import { Cell } from '../cells/Cell'
import { overlayAutoHideMs } from '../cells/overlayVisibility'
import {
  FILL_FIT,
  fillClickStep,
  filledSlotKey,
  isFillExitKey,
  type FillClickEvent,
  type FillState,
} from '../fill/fillMode'
import { keyEventTarget } from '../viewSwitcher/viewShortcut'
import { buildViewSlots, type GridSlot } from './gridLayout'
import './grid.css'

export interface GridViewProps {
  readonly view: View
  /** The inventory: names, and whether a View's camera still exists. */
  readonly cameras: readonly Camera[]
  /** `settings.streams`, the last level of QUAL-3's chain. */
  readonly streams: QualityDefaults
}

interface BoxSize {
  readonly width: number
  readonly height: number
}

export function GridView({ view, cameras, streams }: GridViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // `null` until the first measure.
  const [box, setBox] = useState<BoxSize | null>(null)

  // The content box in CSS px, kept current through every window or sidebar resize (VIEW-5:
  // "reflows on resize"). The observer reports once right after `observe`, which is the first
  // measure; until then nothing is drawn (see the render below).
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (rect === undefined) return
      setBox((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      )
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [])

  // CELL-4. Read here, once for the grid, and handed down as a number so `<Cell>` stays memoised on
  // primitives. `undefined` before settings load, which `overlayAutoHideMs` turns into the default.
  const autoHideMs = overlayAutoHideMs(useAppStore((s) => s.settings?.ui.overlayAutoHideSec))

  const slots = useMemo(() => buildViewSlots({ view, cameras, streams }), [view, cameras, streams])

  // FILL-1. The state names a slot of a View; `filledSlotKey` decides whether it is still filled
  // (another View on screen, the camera gone, the cell edited away: no). A state that no longer
  // fills anything is dropped right away, in render (React's "adjust state when props change"), so
  // coming back to that View later does not re-fill a cell out of nowhere.
  const [fill, setFill] = useState<FillState>(null)
  const filledKey = filledSlotKey(fill, view.id, slots)
  if (fill !== null && filledKey === null) setFill(null)
  const isFilled = filledKey !== null

  // `fillClickStep`'s "armed" flag (fillMode.ts, "does not bounce"). Only event handlers touch it.
  const armedRef = useRef(false)
  // Disarmed on every way out of fill — Esc, the back control, a View switch, the slot going away —
  // not only by grid clicks, so a later way *into* fill that skips a grid click (a shortcut, Phase 4)
  // can never start armed and leave on its first double-click.
  useEffect(() => {
    if (!isFilled) armedRef.current = false
  }, [isFilled])

  // Stable across everything but a View switch, so memoised `<Cell>`s keep their memo. `filled` is
  // what that cell showed when the event arrived, which is what the user was looking at.
  const onCellClick = useCallback(
    (slotKey: string, filled: boolean, event: FillClickEvent): void => {
      const result = fillClickStep(armedRef.current, filled, event)
      armedRef.current = result.armed
      if (result.action === 'fill') setFill({ viewId: view.id, slotKey })
      else if (result.action === 'unfill') setFill(null)
    },
    [view.id],
  )

  const onBack = useCallback((): void => {
    setFill(null)
  }, [])

  // FILL-1's `Esc`: listening only while something is filled, so the key is free otherwise.
  useEffect(() => {
    if (!isFilled) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFillExitKey(event, keyEventTarget(event.target))) return
      event.preventDefault()
      setFill(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isFilled])

  const layout = layoutGrid({
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    cols: view.cols,
    rows: view.rows,
    aspect: view.aspect,
    gap: view.gap,
  })
  // Before the first measure nothing is drawn: there is no size yet, and mounting every player a
  // frame early would only start its streams sooner. After it, a zero layout (a transient 0×0 box
  // while the window is minimised or a sidebar animates, or a box too small to hold a cell) keeps
  // every slot **mounted** but hidden at zero size. Rendering none would unmount every
  // `<LivePlayer>` and reconnect every stream the moment the box comes back.
  const measured = box !== null
  const drawable = layout.unitWidth > 0 && layout.unitHeight > 0

  return (
    <div className="gridView" ref={rootRef}>
      {measured
        ? slots.map((slot) => {
            const filled = slot.key === filledKey
            // Under the filled cell: still playing, not reachable (header).
            const covered = isFilled && !filled
            return (
              <div
                key={slot.key}
                className={filled ? 'gridView__slot gridView__slot--filled' : 'gridView__slot'}
                // Filled: the class places it, whatever the layout says (even a zero one).
                style={
                  filled
                    ? undefined
                    : drawable
                      ? slotStyle(cellRect(layout, slot.placement))
                      : HIDDEN_SLOT
                }
                inert={covered}
                aria-hidden={covered ? true : undefined}
              >
                <SlotContent
                  slot={slot}
                  autoHideMs={autoHideMs}
                  filled={filled}
                  onCellClick={onCellClick}
                  onBack={onBack}
                />
              </div>
            )
          })
        : null}
    </div>
  )
}

/** A slot kept mounted through a zero layout: no size, not painted, not in the a11y tree. */
const HIDDEN_SLOT = {
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  visibility: 'hidden',
} as const

/** Left/top/size rather than a transform, so the box *is* the cell and the player fills it. */
function slotStyle(rect: Rect): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

function SlotContent({
  slot,
  autoHideMs,
  filled,
  onCellClick,
  onBack,
}: {
  readonly slot: GridSlot
  readonly autoHideMs: number
  readonly filled: boolean
  readonly onCellClick: (slotKey: string, filled: boolean, event: FillClickEvent) => void
  readonly onBack: () => void
}): JSX.Element {
  switch (slot.kind) {
    case 'camera':
      // Filled: the fill stream and fit. A change of `quality` is the player's seamless swap (FILL-2).
      return (
        <Cell
          slotKey={slot.key}
          cameraId={slot.cameraId}
          name={slot.name}
          quality={filled ? slot.fillQuality : slot.quality}
          fit={filled ? FILL_FIT : slot.fit}
          overlayAutoHideMs={autoHideMs}
          filled={filled}
          onClickEvent={onCellClick}
          onBack={onBack}
        />
      )
    case 'missing':
      // No player: the camera is gone from the console, or has no package camera to play
      // (gridLayout.ts header). Still `gridCell--empty`, because nothing streams here. Not fillable:
      // there is nothing to enlarge.
      return (
        <div className="gridCell gridCell--empty gridCell--missing">
          <span className="gridCell__missing" title={slot.ref}>
            {slot.label}
          </span>
        </div>
      )
    case 'empty':
      return <div className="gridCell gridCell--empty" aria-hidden="true" />
  }
}
