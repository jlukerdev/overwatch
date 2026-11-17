// The players a camera cell renders, in order (P4.4; CELL-2, ARCHITECTURE §3). Pure, so the one
// guarantee pre-warm rests on is tested in the node environment (CLAUDE.md): `<Cell>` maps this list
// to the same keyed element type under one parent, and nothing else decides their order.
//
//  - **The shown camera always comes first**, keyed by its camera id. When a rotation step makes the
//    pre-warmed camera the shown one, its entry moves from second to first; React finds its key
//    later in the old list than the first new child, so it keeps the fiber (and the `<LivePlayer>`
//    with its open stream) and does not even move it in the DOM. The old shown entry is the one
//    removed. Put the pre-warm first and React would move it, still no remount; change the element
//    type for one of them and it would remount, which is why `<Cell>` renders every entry the same
//    way and only `hidden` differs.
//  - **At most one pre-warm**, never the shown camera (its key would collide), and only with a
//    quality to play it at.
import type { StreamQuality } from '@shared/quality'

export interface CellPlayer {
  /** The React key and the player's camera. */
  readonly cameraId: string
  readonly quality: StreamQuality
  /** The pre-warmed player: attached and decoding, not seen. */
  readonly hidden: boolean
}

/** The cell's players in render order (header). */
export function cellPlayers(
  cameraId: string,
  quality: StreamQuality,
  prewarmCameraId: string | null,
  prewarmQuality: StreamQuality | null,
): readonly CellPlayer[] {
  const shown: CellPlayer = { cameraId, quality, hidden: false }
  if (prewarmCameraId === null || prewarmQuality === null || prewarmCameraId === cameraId) {
    return [shown]
  }
  return [shown, { cameraId: prewarmCameraId, quality: prewarmQuality, hidden: true }]
}
