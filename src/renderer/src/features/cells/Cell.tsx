// One grid cell with a camera in it (CELL-1): the live player and the camera's name. Minimal on
// purpose for P2.4 — the overlay, quality/audio controls and fill mode are Phase 3's (CellOverlay,
// FILL-1) and audio policy is Phase 5's (AUD-1), so the player is always muted here.
//
// The cell owns no size: the grid track decides it (grid.css), and the player fills whatever box it
// is given with `object-fit: contain` (player.css), which is VIEW-5's "keeps the camera's aspect".
import { memo, type JSX } from 'react'
import type { StreamQuality } from '@shared/quality'
import { LivePlayer } from '../../player/LivePlayer'

export interface CellProps {
  readonly cameraId: string
  readonly name: string
  /** The effective quality, resolved by the caller (QUAL-3). */
  readonly quality: StreamQuality
}

/**
 * Memoised: the slot list is rebuilt on every camera-state push (any camera's `state` changes the
 * inventory array), and without this every cell — and every `LivePlayer` — would re-render with it.
 * The props are three primitives, so the default shallow compare is exact; a player still re-renders
 * for its own camera through its own store selector.
 */
export const Cell = memo(function Cell({ cameraId, name, quality }: CellProps): JSX.Element {
  return (
    <div className="gridCell">
      <LivePlayer cameraId={cameraId} quality={quality} muted />
      <span className="gridCell__label" title={name}>
        {name}
      </span>
    </div>
  )
})
