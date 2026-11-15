// What a multi-camera cell's position control says (P4.3; CELL-2, CELL-3): the `2/4` between the
// previous and next buttons in the overlay's strip, and whether a cell gets that group at all. Pure,
// so it is tested in the node environment (CLAUDE.md); `<CellStepControls>` only draws it.
//
//  - **Only cells with two or more cameras** show the group — the same threshold that gives a cell a
//    scheduler (`MIN_SCHEDULED_CAMERAS`, ./schedulerSet), so a button is never drawn with nothing
//    behind it to step. A one-camera cell's strip is as it was.
//  - **The index is 0-based everywhere in code** — the scheduler's `SchedulerView.index`, the grid
//    slot's `position.index`, `<Cell>`'s `cameraIndex` — and becomes 1-based only here, in the text
//    a person reads: the first camera of four is `1/4`, "Camera 1 of 4".
import { MIN_SCHEDULED_CAMERAS } from './schedulerSet'

/** Whether a cell with `count` cameras shows the position and next / previous controls (header). */
export function showsStepControls(count: number): boolean {
  return count >= MIN_SCHEDULED_CAMERAS
}

/** The position as the strip shows it, e.g. `2/4` for 0-based `index` 1 of `count` 4. */
export function positionText(index: number, count: number): string {
  return `${String(index + 1)}/${String(count)}`
}

/** The position's tooltip, e.g. "Camera 2 of 4". */
export function positionTitle(index: number, count: number): string {
  return `Camera ${String(index + 1)} of ${String(count)}`
}
