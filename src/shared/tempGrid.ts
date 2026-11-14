// TEMPORARY (P2.4 only): the temp live grid's two presets, shared by the renderer's grid
// (`features/grid/gridLayout.ts` re-exports them) and the P2.5 perf harness in main, which picks one
// by the label on its button. Phase 3 (P3.x, VIEW-1/2) replaces the temp grid with real Views;
// delete this file then.
//
// Free of imports on purpose: pure data that the renderer bundle, main and the tests share.

export interface TempGridPreset {
  readonly id: string
  /** The text on the preset's toolbar button. */
  readonly label: string
  readonly cols: number
  readonly rows: number
}

/**
 * The two sizes P2.4 asks for. 3×3 is nine streams and 4×3 twelve, which brackets the "10 streams"
 * P2.5 measures. Both are VIEW-1 presets, so the numbers are not invented here.
 */
export const TEMP_GRID_PRESETS: readonly TempGridPreset[] = [
  { id: '3x3', label: '3×3', cols: 3, rows: 3 },
  { id: '4x3', label: '4×3', cols: 4, rows: 3 },
]
