// One grid cell with a camera in it (CELL-1): the live player and, over it, the overlay with the
// camera's name and the auto-hiding controls (CellOverlay, P3.4; CELL-3/4, QUAL-7). Audio policy is
// Phase 5's (AUD-1), so the player is always muted here.
//
// **Fill (P3.5; FILL-1/2).** The same cell is the filled view: `<GridView>` enlarges its box to the
// grid area and hands it `filled`, the fill quality and the fill fit (features/fill/fillMode.ts). This
// file only reports the cell's clicks and double-clicks upward, as plain data, and — while filled —
// puts the back control in the overlay's slot. Whether a click fills, unfills or does nothing is
// `fillClickStep`'s call, not this file's. A click on a control never arrives here (CellOverlay stops
// it at its slot), so a control press is never a cell click.
//
// **Zoom (P3.6; ZOOM-1/2/3), filled only.** `useZoomPan(filled)` (features/zoom/ZoomPan.tsx) listens
// on this cell's element while it is filled, and transforms `<ZoomPanLayer>`, which wraps the player
// and nothing else, so the overlay is never scaled. The layer is rendered whether filled or not: the
// player must never be re-parented, which would remount it and break FILL-2's "same player". While
// zoomed the overlay's slot also gets the "100%" control (ZOOM-2); it is not there at 1×, where it
// would do nothing. A drag's trailing click is stopped by the hook before `onClick` below sees it, so
// panning never arms fill's double-click exit, and modifier + double-click — the reset — is one
// `fillClickStep` ignores. The control's tooltip names the modifiers that work on this platform: on
// macOS Ctrl+click is a context click, so it offers ⌘/⌥/⇧ there.
//
// **Quality (P3.7; QUAL-4/5).** The slot also gets a quality picker (./QualityPicker): the cell's own
// in the grid, the fill picker while filled, and none for a package-channel cell (`inheritedQuality`
// is `null`). This file only reports picks upward with the slot's key — saving a cell override,
// keeping fill's session pick and saving it for the View are `<GridView>`'s.
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, useMemo, type JSX, type MouseEvent } from 'react'
import type { Fit } from '@shared/models'
import type { Quality, StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'
import type { FillClickEvent } from '../fill/fillMode'
import { useZoomPan, ZoomPanLayer } from '../zoom/ZoomPan'
import { CellOverlay } from './CellOverlay'
import { CellQualityPicker, FillQualityPicker } from './QualityPicker'

export interface CellProps {
  /** The grid slot this cell is in (`GridSlot.key`), handed back with each click. */
  readonly slotKey: string
  readonly cameraId: string
  readonly name: string
  /** The effective stream, resolved by the caller (QUAL-3, or the package channel for CAM-4). */
  readonly quality: StreamQuality
  /** VIEW-5: the View's fit mode. */
  readonly fit: Fit
  /** CELL-4: `ui.overlayAutoHideSec` in ms, already defaulted (`overlayAutoHideMs`). */
  readonly overlayAutoHideMs: number
  /** FILL-1: this cell is the filled one (it covers the grid area, and shows the back control). */
  readonly filled: boolean
  /**
   * A click or double-click on the cell outside its controls, with whether it was filled when it
   * arrived. Must be stable (a `useCallback`) or the memo below is lost.
   */
  readonly onClickEvent: (slotKey: string, filled: boolean, event: FillClickEvent) => void
  /** FILL-1's back control. Stable, like `onClickEvent`. */
  readonly onBack: () => void
  /** QUAL-4: the cell's own quality override; `null` inherits. */
  readonly cellQuality: Quality | null
  /**
   * What the cell plays in the grid with its override cleared (the picker's "View default (X)").
   * `null` means no picker at all: a package-channel cell (CAM-4).
   */
  readonly inheritedQuality: Quality | null
  /** QUAL-5: while filled, show "Save for this View" (a pick changed what plays, `canSaveFillQuality`). */
  readonly canSaveFillQuality: boolean
  /** QUAL-4: a new override for this cell (`null` clears it). Stable, like `onClickEvent`. */
  readonly onQualityChange: (slotKey: string, quality: Quality | null) => void
  /** QUAL-5: a quality picked while filled, for this fill only. Stable. */
  readonly onFillQualityPick: (slotKey: string, quality: Quality) => void
  /** QUAL-5: "Save for this View" with the quality shown. Stable. */
  readonly onSaveFillQuality: (slotKey: string, quality: StreamQuality) => void
}

/**
 * ZOOM-2's 100% tooltip. macOS turns Ctrl+click into a context click, so Ctrl + double-click never
 * reaches the cell there; `isZoomResetDblClick` still accepts it, but the tooltip offers only the
 * modifiers that work. `userAgent` rather than the deprecated `navigator.platform`: Electron's says
 * "Macintosh" on macOS.
 */
const ZOOM_RESET_TITLE = navigator.userAgent.includes('Mac')
  ? 'Reset zoom to 100% (or ⌘/⌥/⇧ + double-click)'
  : 'Reset zoom to 100% (or Ctrl/Alt/Shift + double-click)'

/** The parts of a mouse event `fillClickStep` reads. */
function toFillClick(event: MouseEvent, type: FillClickEvent['type']): FillClickEvent {
  return {
    type,
    button: event.button,
    detail: event.detail,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  }
}

/**
 * Memoised: the slot list is rebuilt on every camera-state push (any camera's `state` changes the
 * inventory array), and without this every cell — and every `LivePlayer` — would re-render with it.
 * The props are primitives, so the default shallow compare is exact; a player still re-renders for
 * its own camera through its own store selector; the callbacks are the grid's stable ones. The
 * overlay's hover state is the overlay's own, so showing and hiding the controls re-renders the
 * overlay and never the player. Its position is not a prop: the grid moves the box around the cell,
 * so a window resize does not re-render the cell either. Zoom's one piece of React state, `zoomed`,
 * re-renders the cell when it flips (for the 100% control), and the player element is memoised on
 * its own props so that flip never re-renders the player.
 */
export const Cell = memo(function Cell({
  slotKey,
  cameraId,
  name,
  quality,
  fit,
  overlayAutoHideMs,
  filled,
  onClickEvent,
  onBack,
  cellQuality,
  inheritedQuality,
  canSaveFillQuality,
  onQualityChange,
  onFillQualityPick,
  onSaveFillQuality,
}: CellProps): JSX.Element {
  const zoom = useZoomPan(filled)
  // The same element object across renders that change nothing of the player's own, so a flip of
  // `zoom.zoomed` (or of `filled` alone) re-renders the overlay and never the player.
  const player = useMemo(
    () => <LivePlayer cameraId={cameraId} quality={quality} muted fit={fit} />,
    [cameraId, quality, fit],
  )
  return (
    // A mouse target only: the cell is not focusable, and fill is left from the keyboard by `Esc`
    // or the back control. `gridCell--fillable` is the pointer cursor (cells.css); `gridCell--filled`
    // keeps touch gestures for the zoom (zoom.css). The zoom's cursor classes are the hook's.
    <div
      ref={zoom.cellRef}
      className={filled ? 'gridCell gridCell--filled' : 'gridCell gridCell--fillable'}
      onClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'click'))
      }}
      onDoubleClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'dblclick'))
      }}
    >
      <ZoomPanLayer layerRef={zoom.layerRef}>{player}</ZoomPanLayer>
      <CellOverlay name={name} quality={quality} autoHideMs={overlayAutoHideMs}>
        {filled ? (
          <>
            {inheritedQuality !== null ? (
              <FillQualityPicker
                shown={quality}
                canSave={canSaveFillQuality}
                onPick={(picked) => {
                  onFillQualityPick(slotKey, picked)
                }}
                onSave={() => {
                  onSaveFillQuality(slotKey, quality)
                }}
              />
            ) : null}
            {zoom.zoomed ? (
              <button
                type="button"
                className="cellOverlay__back"
                aria-label="Reset zoom to 100%"
                title={ZOOM_RESET_TITLE}
                onClick={zoom.resetZoom}
              >
                100%
              </button>
            ) : null}
            <button
              type="button"
              className="cellOverlay__back"
              aria-label="Back to grid"
              title="Back to grid (Esc)"
              onClick={onBack}
            >
              ← Grid
            </button>
          </>
        ) : inheritedQuality !== null ? (
          <CellQualityPicker
            override={cellQuality}
            inherited={inheritedQuality}
            onChange={(picked) => {
              onQualityChange(slotKey, picked)
            }}
          />
        ) : undefined}
      </CellOverlay>
    </div>
  )
})
