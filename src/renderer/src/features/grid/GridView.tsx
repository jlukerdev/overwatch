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
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import type { QualityDefaults } from '@shared/quality'
import { cellRect, layoutGrid, type Rect } from '@shared/viewLayout'
import { useAppStore } from '../../state/appStore'
import { Cell } from '../cells/Cell'
import { overlayAutoHideMs } from '../cells/overlayVisibility'
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
        ? slots.map((slot) => (
            <div
              key={slot.key}
              className="gridView__slot"
              style={drawable ? slotStyle(cellRect(layout, slot.placement)) : HIDDEN_SLOT}
            >
              <SlotContent slot={slot} autoHideMs={autoHideMs} />
            </div>
          ))
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
}: {
  readonly slot: GridSlot
  readonly autoHideMs: number
}): JSX.Element {
  switch (slot.kind) {
    case 'camera':
      return (
        <Cell
          cameraId={slot.cameraId}
          name={slot.name}
          quality={slot.quality}
          fit={slot.fit}
          overlayAutoHideMs={autoHideMs}
        />
      )
    case 'missing':
      // No player: the camera is gone from the console, or has no package camera to play
      // (gridLayout.ts header). Still `gridCell--empty`, because nothing streams here.
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
