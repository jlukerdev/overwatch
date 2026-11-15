// One grid cell with a camera in it (CELL-1): the live player and the camera's name. Minimal on
// purpose — the overlay, quality/audio controls and fill mode come later in Phase 3 (CellOverlay,
// FILL-1) and audio policy is Phase 5's (AUD-1), so the player is always muted here.
//
// The cell owns no size: `<GridView>` positions a box for it from the View's layout (VIEW-5/7) and
// the cell fills that box. The player then fits the camera inside it by the View's `fit` (contain or
// cover, player.css), which is how a camera whose shape differs from the View's `aspect` — or a
// spanned cell a few px off it because of the gap (VIEW-7) — is never distorted.
import { memo, type JSX } from 'react'
import type { Fit } from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'

export interface CellProps {
  readonly cameraId: string
  readonly name: string
  /** The effective stream, resolved by the caller (QUAL-3, or the package channel for CAM-4). */
  readonly quality: StreamQuality
  /** VIEW-5: the View's fit mode. */
  readonly fit: Fit
}

/**
 * Memoised: the slot list is rebuilt on every camera-state push (any camera's `state` changes the
 * inventory array), and without this every cell — and every `LivePlayer` — would re-render with it.
 * The props are primitives, so the default shallow compare is exact; a player still re-renders for
 * its own camera through its own store selector. Its position is not a prop: the grid moves the box
 * around the cell, so a window resize does not re-render the cell either.
 */
export const Cell = memo(function Cell({ cameraId, name, quality, fit }: CellProps): JSX.Element {
  return (
    <div className="gridCell">
      <LivePlayer cameraId={cameraId} quality={quality} muted fit={fit} />
      <span className="gridCell__label" title={name}>
        {name}
      </span>
    </div>
  )
})
