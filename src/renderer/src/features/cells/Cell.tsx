// One grid cell with a camera in it (CELL-1): the live player and, over it, the overlay with the
// camera's name and the auto-hiding controls (CellOverlay, P3.4; CELL-3/4, QUAL-7). Audio policy is
// Phase 5's (AUD-1), so the player is always muted here.
//
// **Fill (P3.5; FILL-1/2).** The same cell is the filled view: `<GridView>` enlarges its box to the
// grid area and hands it `filled`, the fill quality and the fill fit (features/fill/fillMode.ts). This
// file only reports the cell's clicks and double-clicks upward, as plain data, and — while filled —
// puts the back control (a 2×2 grid icon, ./BackToGridButton) first in the overlay's strip. Whether
// a click fills, unfills or does nothing is `fillClickStep`'s call, not this file's. A click on a control never arrives here (CellOverlay stops
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
// **Quality (P3.7; QUAL-4/5/7).** The slot also gets a quality picker (./QualityPicker): the cell's
// own in the grid, the fill picker while filled, and none for a package-channel cell
// (`inheritedQuality` is `null`). The picker's select already shows the quality playing, coloured
// per quality, so a cell with a picker has no quality badge; only the package-channel cell, which
// has no picker, keeps the badge (`PKG`) so it still says what it plays. This file only reports
// picks upward with the slot's key — saving a cell override, keeping fill's session pick and saving
// it for the View are `<GridView>`'s.
//
// **Strip order.** In fill, left to right: "100%" (zoomed only), back, position, quality picker. In
// the grid: position, quality picker. The badge, where there is one, comes last.
//
// **Name (VIEW-8).** The camera's name is drawn only when the View's `showNames` is on (`showName`);
// off, the overlay has no name chip, in the grid and in fill alike.
//
// **Position and next / previous (P4.3; CELL-2, CELL-3).** A cell with two or more cameras gets
// `<CellStepControls>` first in the strip — previous, `2/4`, next — in the grid and while filled.
// A press is reported upward as `onStep(slotKey, direction)`; what it does is the scheduler's
// (`stepSchedulerSet`): in the grid it dismisses the active triggers and restarts the interval, in
// fill it changes the pinned camera (FILL-3). Either way the cell gets a new `cameraId` and the
// player below restarts for it. A step in fill also resets the zoom first: the zoom was on the
// previous camera's picture, and the next camera starts at 1× like a freshly filled one (ZOOM-2).
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, useMemo, type JSX } from 'react'
import type { Fit } from '@shared/models'
import type { Quality, StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'
import { toFillClick, type FillClickEvent } from '../fill/fillMode'
import { useZoomPan, ZoomPanLayer } from '../zoom/ZoomPan'
import { BackToGridButton } from './BackToGridButton'
import { CellOverlay } from './CellOverlay'
import { CellStepControls } from './CellStepControls'
import { CellQualityPicker, FillQualityPicker } from './QualityPicker'
import type { StepDirection } from './schedulerSet'

export interface CellProps {
  /** The grid slot this cell is in (`GridSlot.key`), handed back with each click. */
  readonly slotKey: string
  readonly cameraId: string
  readonly name: string
  /** VIEW-8: the View's `showNames`; `false` draws no name over the picture. */
  readonly showName: boolean
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
   * What the cell plays in the grid with its override cleared (the picker's "Default (X)").
   * `null` means no picker at all: a package-channel cell (CAM-4).
   */
  readonly inheritedQuality: Quality | null
  /** QUAL-5: while filled, show the fill picker's Save (a pick changed what plays, `canSaveFillQuality`). */
  readonly canSaveFillQuality: boolean
  /** QUAL-4: a new override for this cell (`null` clears it). Stable, like `onClickEvent`. */
  readonly onQualityChange: (slotKey: string, quality: Quality | null) => void
  /** QUAL-5: a quality picked while filled, for this fill only. Stable. */
  readonly onFillQualityPick: (slotKey: string, quality: Quality) => void
  /** QUAL-5: the fill picker's Save, with the quality shown. Stable. */
  readonly onSaveFillQuality: (slotKey: string, quality: StreamQuality) => void
  /**
   * CELL-2/3: 0-based position of the camera shown in the cell's `cameraIds`, of `cameraCount`
   * (the strip reads it 1-based, `2/4`). With fewer than two cameras there are no step controls.
   */
  readonly cameraIndex: number
  readonly cameraCount: number
  /** P4.3: the user's next / previous on this cell's scheduler. Stable, like `onClickEvent`. */
  readonly onStep: (slotKey: string, direction: StepDirection) => void
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
  showName,
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
  cameraIndex,
  cameraCount,
  onStep,
}: CellProps): JSX.Element {
  const { cellRef, layerRef, zoomed, resetZoom } = useZoomPan(filled)
  // The same element object across renders that change nothing of the player's own, so a flip of
  // `zoomed` (or of `filled` alone) re-renders the overlay and never the player.
  // Keyed by camera (P4.2; CELL-2): when a multi-camera cell rotates or a motion event switches it,
  // this cell stays mounted and gets a new `cameraId`, and the key makes that a fresh player. The
  // controller is per camera anyway (LivePlayer rebuilds it on `cameraId`), so the key costs no
  // extra reconnect; what it buys is that everything a player sets up at mount — its placeholder,
  // its props ref — belongs to one camera, and the first frame after a switch is a clean
  // "Connecting…" rather than the old camera's picture under the new camera's name until the
  // rebuild's effect runs. Zoom lives in the cell and works only while filled; a filled cell is
  // pinned (FILL-3), so only the user's own step changes its camera there, and that resets the zoom
  // (header).
  const player = useMemo(
    () => <LivePlayer key={cameraId} cameraId={cameraId} quality={quality} muted fit={fit} />,
    [cameraId, quality, fit],
  )
  const qualityPicker =
    inheritedQuality === null ? null : filled ? (
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
    ) : (
      <CellQualityPicker
        override={cellQuality}
        inherited={inheritedQuality}
        playing={quality}
        onChange={(picked) => {
          onQualityChange(slotKey, picked)
        }}
      />
    )
  const zoomReset =
    filled && zoomed ? (
      <button
        type="button"
        className="cellOverlay__back"
        aria-label="Reset zoom to 100%"
        title={ZOOM_RESET_TITLE}
        onClick={resetZoom}
      >
        100%
      </button>
    ) : null

  return (
    // A mouse target only: the cell is not focusable, and fill is left from the keyboard by `Esc`
    // or the back control. `gridCell--fillable` is the pointer cursor (cells.css); `gridCell--filled`
    // keeps touch gestures for the zoom (zoom.css). The zoom's cursor classes are the hook's.
    <div
      ref={cellRef}
      className={filled ? 'gridCell gridCell--filled' : 'gridCell gridCell--fillable'}
      onClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'click'))
      }}
      onDoubleClick={(event) => {
        onClickEvent(slotKey, filled, toFillClick(event, 'dblclick'))
      }}
    >
      <ZoomPanLayer layerRef={layerRef}>{player}</ZoomPanLayer>
      <CellOverlay
        name={showName ? name : undefined}
        // The badge only where no picker already shows the quality: a package-channel cell (header).
        quality={qualityPicker === null ? quality : undefined}
        autoHideMs={overlayAutoHideMs}
      >
        {/* Left to right (CellOverlay header). In fill: 100%, back, position, quality. In the grid:
            position, quality. The step's zoom reset gives the next camera 1× (header); in the grid
            it is a no-op. */}
        {zoomReset}
        {filled ? <BackToGridButton onBack={onBack} /> : null}
        <CellStepControls
          slotKey={slotKey}
          index={cameraIndex}
          count={cameraCount}
          onStep={onStep}
          onBeforeStep={resetZoom}
        />
        {qualityPicker}
      </CellOverlay>
    </div>
  )
})
