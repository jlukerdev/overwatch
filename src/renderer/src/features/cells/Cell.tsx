// One grid cell with a camera in it (CELL-1): the live player and, over it, the overlay with the
// camera's name and the auto-hiding controls (CellOverlay, P3.4; CELL-3/4, QUAL-7).
//
// **Audio (P5.1; AUD-1/2/3).** A cell whose camera has audio (`audio`: `hasMic && micEnabled`) gets
// a mute toggle in its strip, in the grid and in fill, and while filled a volume slider after it
// (./AudioControls). Whether this cell is the one heard (`audible`) is decided above, by
// state/audioStore.ts through `<GridView>`: the single active source is a slot of the View *with the
// camera it showed when unmuted*, so a cell whose camera changes is muted. This file only reports a
// press upward with the slot key and the camera on screen, and hands `!audible` to the visible
// player alone. The pre-warmed player is always muted, like an incoming layer inside the player
// (LivePlayer), so nothing hidden is ever heard; it gets the same `volume`, so the step that shows it
// changes only its `muted`.
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
// filled the overlay's slot also has the zoom reset (ZOOM-2), an icon button that is always there
// and disabled at 1×, where it would do nothing (the user's call, 2026-11-16). A drag's trailing click is stopped by the hook before `onClick` below sees it, so
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
// **Strip order.** In fill, left to right: zoom reset (disabled at 1×), back, position, mute, volume,
// quality picker and its Save. In the grid: position, mute, quality picker. The badge, where there
// is one, comes last. Mute and volume sit together just before the picker: the camera's own
// controls, after the ones that move between cameras.
//
// **Door unlock (P5.4; DOOR-0/2/3/4).** Not in the strip: the overlay's bottom slot gets
// `<UnlockButton>` (features/door), a round padlock at the bottom centre of the cell, in the grid
// and in fill. It draws itself only while Access is saved as on, the camera (a package-channel
// cell: its doorbell) has a door link, the camera is connected, and this cell's picture is live —
// `streaming`, which the visible `<LivePlayer>` reports through `onPlayingChange` (memoised per
// camera, so the players' memo holds; the pre-warmed player reports nothing until it is the visible
// one, and is then handed the callback and re-reports). What was live is forgotten whenever the
// shown camera changes, so after a rotation the control waits for the new player's own report.
// It is keyed by the shown camera ref, so a rotation gives the next camera a fresh, idle control. A
// missing camera's placeholder (`<MissingCell>`) has none. The hold, the request and the toast are
// the button's; its presses never reach this cell's click handlers (CellOverlay's bottom slot).
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
// **Pre-warm (P4.4; ARCHITECTURE §3).** A rotating cell is handed, 2 s before its next rotation
// step, the camera that step will show and the quality it will play at (`prewarmCameraId`,
// `prewarmQuality`; features/cells/schedulerSet.ts, `prewarmTargets`). The cell then mounts a second
// `<LivePlayer>` for it, hidden (`gridCell__player--prewarm`, cells.css: `opacity: 0`, no pointer,
// `aria-hidden`, muted like every player here), so its stream is open and decoding before the
// switch. At the switch that same player becomes the visible one, without a remount: the players
// are a keyed list under `<ZoomPanLayer>` — the visible one first, in a wrapper keyed by its camera
// id, then the pre-warmed one in a wrapper of the same element type keyed by *its* camera id — so
// when the step hands the cell `cameraId` = the pre-warmed camera, React finds that key among the
// old children and keeps its fiber (the old visible wrapper is the one removed). Being later in the
// old list than the first new child, it is not even moved in the DOM. Only the wrapper's class and
// `aria-hidden` change; the `<LivePlayer>` inside gets the same camera, quality (the grid's resolved
// quality for that camera, computed the same way as the slot's own) and fit, so none of its effects
// re-run — no reconnect, and no QUAL-6 swap unless the View's quality really changed meanwhile, in
// which case the swap is the seamless one. A manual step onto the pre-warmed camera reuses it the
// same way, and so does a trigger that brings up the pre-warmed camera; a trigger or a step onto any
// other camera drops the hidden player. None in fill: a filled cell is pinned, so it has no upcoming
// rotation; nor in a cell covered by the filled one or drawn at zero size (GridView's `canPrewarm`). A missing camera's placeholder (`<MissingCell>`)
// has no players to hand over, so a step from it to a camera mounts that camera's player afresh.
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, useCallback, useMemo, useState, type JSX } from 'react'
import type { Fit } from '@shared/models'
import type { Quality, StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'
import { ZoomResetIcon } from '../../ui/icons'
import { MuteToggle, VolumeSlider } from './AudioControls'
import { UnlockButton } from '../door/UnlockButton'
import { toFillClick, type FillClickEvent } from '../fill/fillMode'
import { useZoomPan, ZoomPanLayer } from '../zoom/ZoomPan'
import { BackToGridButton } from './BackToGridButton'
import { CellOverlay } from './CellOverlay'
import { cellPlayers } from './cellPlayers'
import { CellStepControls } from './CellStepControls'
import { CellQualityPicker, FillQualityPicker } from './QualityPicker'
import type { StepDirection } from './schedulerSet'

export interface CellProps {
  /** The grid slot this cell is in (`GridSlot.key`), handed back with each click. */
  readonly slotKey: string
  readonly cameraId: string
  /** The shown ref as written, `<cameraId>` or `<cameraId>:package`: the unlock names it (P5.4). */
  readonly cameraRef: string
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
  /**
   * P4.4: the camera the next rotation step shows, to open hidden now (header), and the quality it
   * will play at once shown; both `null` for none. Primitives, so the memo stays exact.
   */
  readonly prewarmCameraId: string | null
  readonly prewarmQuality: StreamQuality | null
  /** AUD-1: the camera has a mic and it is on; shows the mute toggle (and, filled, the volume). */
  readonly audio: boolean
  /** AUD-2: this cell, with this camera, is the one heard (state/audioStore.ts). */
  readonly audible: boolean
  /** AUD-3: the app-wide level, 0…1, for the visible player and the slider (header). */
  readonly volume: number
  /**
   * AUD-2: the mute toggle, with the camera on screen when it was pressed; `unmute` false mutes.
   * Stable, like `onClickEvent`.
   */
  readonly onAudioToggle: (slotKey: string, cameraId: string, unmute: boolean) => void
  /** AUD-3: the volume slider. Stable. */
  readonly onVolumeChange: (volume: number) => void
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
  cameraRef,
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
  prewarmCameraId,
  prewarmQuality,
  audio,
  audible,
  volume,
  onAudioToggle,
  onVolumeChange,
}: CellProps): JSX.Element {
  const { cellRef, layerRef, zoomed, resetZoom } = useZoomPan(filled)
  // The visible player shows live video (header, "Door unlock"). Kept as *which* camera is live, so
  // the render that switches camera never shows the unlock control on the previous one's word.
  const [streamingCameraId, setStreamingCameraId] = useState<string | null>(null)
  // And forgotten whenever the shown camera changes (React's "adjust state on a prop change", in
  // render): rotating A → B → A must not find A's old "live" and show the button over A's fresh
  // "Connecting…" player. The new player's own report — made in its effect, after this — sets it.
  const [streamingFor, setStreamingFor] = useState(cameraId)
  if (streamingFor !== cameraId) {
    setStreamingFor(cameraId)
    setStreamingCameraId(null)
  }
  const streaming = streamingFor === cameraId && streamingCameraId === cameraId
  const onPlayingChange = useCallback(
    (playing: boolean): void => {
      setStreamingCameraId((current) =>
        playing ? cameraId : current === cameraId ? null : current,
      )
    },
    [cameraId],
  )
  // The same element object across renders that change nothing of the player's own, so a flip of
  // `zoomed` (or of `filled` alone) re-renders the overlay and never the player.
  // Keyed by camera (P4.2; CELL-2), on the wrapper: when a multi-camera cell rotates or a motion
  // event switches it, this cell stays mounted and gets a new `cameraId`, and the key makes that a
  // fresh player — unless that camera was pre-warmed, whose wrapper has the same key and so is the
  // one kept (P4.4, header). The
  // controller is per camera anyway (LivePlayer rebuilds it on `cameraId`), so the key costs no
  // extra reconnect; what it buys is that everything a player sets up at mount — its placeholder,
  // its props ref — belongs to one camera, and the first frame after a switch is a clean
  // "Connecting…" rather than the old camera's picture under the new camera's name until the
  // rebuild's effect runs. Zoom lives in the cell and works only while filled; a filled cell is
  // pinned (FILL-3), so only the user's own step changes its camera there, and that resets the zoom
  // (header).
  // The shown player first, then the pre-warm, all one element type under one parent, so the step
  // keeps the pre-warmed instance (header; the order is ./cellPlayers', tested there).
  const players = useMemo(
    () =>
      cellPlayers(cameraId, quality, prewarmCameraId, prewarmQuality).map((entry) => (
        <div
          key={entry.cameraId}
          className={
            entry.hidden ? 'gridCell__player gridCell__player--prewarm' : 'gridCell__player'
          }
          aria-hidden={entry.hidden ? true : undefined}
        >
          {/* Only the visible player can be heard (header); the pre-warm is always muted. */}
          <LivePlayer
            cameraId={entry.cameraId}
            quality={entry.quality}
            muted={entry.hidden || !audible}
            volume={volume}
            fit={fit}
            onPlayingChange={entry.hidden ? undefined : onPlayingChange}
          />
        </div>
      )),
    [cameraId, quality, prewarmCameraId, prewarmQuality, fit, audible, volume, onPlayingChange],
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
  const zoomReset = filled ? (
    <button
      type="button"
      className="cellOverlay__back cellOverlay__iconButton"
      aria-label="Reset zoom to 100%"
      title={ZOOM_RESET_TITLE}
      disabled={!zoomed}
      onClick={resetZoom}
    >
      <ZoomResetIcon className="cellOverlay__icon" />
    </button>
  ) : null

  // AUD-1: only on a camera with audio. The camera pressed for is the one on screen now, so a press
  // that lands after a switch names the new camera (header).
  const muteToggle = audio ? (
    <MuteToggle
      audible={audible}
      onToggle={(unmute) => {
        onAudioToggle(slotKey, cameraId, unmute)
      }}
    />
  ) : null
  const volumeSlider =
    audio && filled ? <VolumeSlider volume={volume} onChange={onVolumeChange} /> : null

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
      {/* Always a list, visible player first (header): the pre-warmed one must sit after it. */}
      <ZoomPanLayer layerRef={layerRef}>{players}</ZoomPanLayer>
      <CellOverlay
        name={showName ? name : undefined}
        // The badge only where no picker already shows the quality: a package-channel cell (header).
        quality={qualityPicker === null ? quality : undefined}
        autoHideMs={overlayAutoHideMs}
        bottom={
          <UnlockButton
            key={cameraRef}
            cameraRef={cameraRef}
            cameraName={name}
            streaming={streaming}
          />
        }
      >
        {/* Left to right (CellOverlay header). In fill: 100%, back, position, mute, volume,
            quality. In the grid: position, mute, quality. The step's zoom reset gives the next
            camera 1× (header); in the grid it is a no-op. */}
        {zoomReset}
        {filled ? <BackToGridButton onBack={onBack} /> : null}
        <CellStepControls
          slotKey={slotKey}
          index={cameraIndex}
          count={cameraCount}
          onStep={onStep}
          onBeforeStep={resetZoom}
        />
        {muteToggle}
        {volumeSlider}
        {qualityPicker}
      </CellOverlay>
    </div>
  )
})
