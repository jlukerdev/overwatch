// One grid cell with a camera in it (CELL-1): the live player and, over it, the overlay with the
// camera's name and the auto-hiding controls (CellOverlay, P3.4; CELL-3/4, QUAL-7). Fill mode is
// P3.5's (FILL-1) and audio policy Phase 5's (AUD-1), so the player is always muted here.
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, type JSX } from 'react'
import type { Fit } from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'
import { CellOverlay } from './CellOverlay'

export interface CellProps {
  readonly cameraId: string
  readonly name: string
  /** The effective stream, resolved by the caller (QUAL-3, or the package channel for CAM-4). */
  readonly quality: StreamQuality
  /** VIEW-5: the View's fit mode. */
  readonly fit: Fit
  /** CELL-4: `ui.overlayAutoHideSec` in ms, already defaulted (`overlayAutoHideMs`). */
  readonly overlayAutoHideMs: number
}

/**
 * Memoised: the slot list is rebuilt on every camera-state push (any camera's `state` changes the
 * inventory array), and without this every cell — and every `LivePlayer` — would re-render with it.
 * The props are primitives, so the default shallow compare is exact; a player still re-renders for
 * its own camera through its own store selector. The overlay's hover state is the overlay's own, so
 * showing and hiding the controls re-renders the overlay and never the player. Its position is not a prop: the grid moves the box
 * around the cell, so a window resize does not re-render the cell either.
 */
export const Cell = memo(function Cell({
  cameraId,
  name,
  quality,
  fit,
  overlayAutoHideMs,
}: CellProps): JSX.Element {
  return (
    <div className="gridCell">
      <LivePlayer cameraId={cameraId} quality={quality} muted fit={fit} />
      <CellOverlay name={name} quality={quality} autoHideMs={overlayAutoHideMs} />
    </div>
  )
})
