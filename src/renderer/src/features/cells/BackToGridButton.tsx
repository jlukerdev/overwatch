// FILL-1's back control (P3.5): a 2×2 grid icon, first in a filled cell's overlay strip — left of
// the "100%", the position and the quality picker (the user's call, 2026-11-16; it was top centre
// before). Shared by the camera cell (./Cell) and a filled multi-camera cell's missing-camera
// placeholder (./MissingCell).
import type { JSX } from 'react'
import { GridIcon } from '../../ui/icons'

export function BackToGridButton({ onBack }: { readonly onBack: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="cellOverlay__back cellOverlay__iconButton"
      aria-label="Back to grid"
      title="Back to grid (Esc)"
      onClick={onBack}
    >
      <GridIcon className="cellOverlay__icon" />
    </button>
  )
}
