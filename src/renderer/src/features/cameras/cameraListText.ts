// What the camera list says around its grid (UX polish), as a pure function: the header's count.
// Here rather than in the component so a test can reach it (no jsdom, CLAUDE.md). The rules about
// *which* body the screen shows stay in `../../state/camerasStore`; the setup checklist of the
// empty screen is shared with Live (`../../state/setupChecklist`).

/**
 * The header's count: "1 camera", "12 cameras". `null` for none — the body below the header
 * already says why the list is empty, so a second "no cameras" beside the title would only repeat it.
 */
export function cameraCountLabel(count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? '1 camera' : `${String(count)} cameras`
}
