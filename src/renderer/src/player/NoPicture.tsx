// A cell with no picture, drawn on purpose (CAM-3, CAM-2/4; UX polish): a small centred composition
// — an icon and one label — instead of a line of muted text. Used by the player's placeholder
// (LivePlayer.tsx: connecting, offline, the gateway down, an error) and by a cell whose camera
// cannot play at all (features/cells/MissingCell.tsx: "Camera not found" / "No package camera"), so
// every empty cell on a wall has one look.
//
// The icon says which kind it is (`tone`, playerMachine.ts `placeholderTone`): a spinner while a
// picture is on its way, the camera-off icon for a camera that is away, the alert icon for a
// failure on this side. The label is the text the cell always had; `title` is on the icon + label
// only, as it was on the old text, so the rest of the cell stays the cell's.
//
// **The snapshot behind a spinner** (`snapshot`; placeholderSnapshot.ts has the rules). A cached
// still of the camera, dimmed and blurred (player.css), under the spinner and its label on a dark
// chip: it is never on screen without that treatment, so it cannot be mistaken for live video. The
// blur is a CSS filter on one static image, rasterised once — not a `backdrop-filter`, and never
// over a playing stream (the placeholder exists only while no layer is on screen).
//
// **It scales with its box.** `.livePlayer` and `.gridCell` are size containers (player.css,
// grid.css), and the rules there shrink the icon with the cell, put icon and label on one row in a
// short cell and drop the label (kept for assistive tech, and in the `title`) in a very narrow one,
// so a 4×4 wall in a small window never overflows.
//
// It takes no pointer except for the `title`, and has no handlers: a click anywhere on it is a click
// on the cell (FILL-1), as on the old text.
import type { JSX } from 'react'
import { AlertIcon, CameraOffIcon } from '../ui/icons'
import { SnapshotImage } from '../ui/SnapshotImage'
import type { PlaceholderTone } from './playerMachine'
import './player.css'

export interface NoPictureProps {
  readonly tone: PlaceholderTone
  /** The one line that says why there is no picture. */
  readonly label: string
  /** Tooltip for the icon and label; the label itself when there is nothing to add. */
  readonly title?: string | undefined
  /** A cached still to draw dimmed behind a spinner (header); only with `tone: 'progress'`. */
  readonly snapshot?: { readonly bytes: Uint8Array; readonly mimeType: string } | null | undefined
  /** An extra class on the root, e.g. the player's `livePlayer__placeholder`. */
  readonly className?: string | undefined
}

function ToneIcon({ tone }: { readonly tone: PlaceholderTone }): JSX.Element {
  switch (tone) {
    case 'progress':
      return <span className="spinner noPicture__icon" aria-hidden="true" />
    case 'offline':
      return <CameraOffIcon className="noPicture__icon" />
    case 'alert':
      return <AlertIcon className="noPicture__icon" />
  }
}

export function NoPicture({
  tone,
  label,
  title,
  snapshot,
  className,
}: NoPictureProps): JSX.Element {
  // Never a still without the spinner over it (header).
  const still = tone === 'progress' ? (snapshot ?? null) : null
  const classes = ['noPicture', `noPicture--${tone}`]
  if (still !== null) classes.push('noPicture--still')
  if (className !== undefined) classes.push(className)
  return (
    <div className={classes.join(' ')}>
      {still !== null ? (
        <SnapshotImage bytes={still.bytes} mimeType={still.mimeType} className="noPicture__still" />
      ) : null}
      <div className="noPicture__body" title={title ?? label}>
        <ToneIcon tone={tone} />
        <span className="noPicture__label">{label}</span>
      </div>
    </div>
  )
}
