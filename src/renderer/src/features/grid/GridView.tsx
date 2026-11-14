// CSS-grid view that fills its box (VIEW-5): one cell per slot, `cols × rows`, reflowing with the
// window and never scrolling. Layout only — which camera goes where, and at what quality, is decided
// by the caller (gridLayout.ts now, real Views in Phase 3), so this component is reusable as is.
import type { JSX } from 'react'
import { Cell } from '../cells/Cell'
import { gridTemplate, type GridSize, type GridSlot } from './gridLayout'
import './grid.css'

export interface GridViewProps extends GridSize {
  /** Exactly `cols × rows` slots, in reading order. */
  readonly slots: readonly GridSlot[]
}

export function GridView({ cols, rows, slots }: GridViewProps): JSX.Element {
  return (
    <div className="gridView" style={gridTemplate({ cols, rows })}>
      {slots.map((slot) =>
        slot.kind === 'camera' ? (
          <Cell key={slot.key} cameraId={slot.cameraId} name={slot.name} quality={slot.quality} />
        ) : (
          <div key={slot.key} className="gridCell gridCell--empty" aria-hidden="true" />
        ),
      )}
    </div>
  )
}
