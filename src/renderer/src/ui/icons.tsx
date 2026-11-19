// The app's icon set (P3.8): small inline SVGs, drawn on a 16×16 grid in `currentColor`, so an icon
// takes its button's colour (primary, danger, muted…) and needs no asset or npm dependency.
//
// Every icon is decorative (`aria-hidden`): the button it sits in carries the accessible name, as
// visible text or, for an icon-only button, an `aria-label`. An icon adds no text node, so a
// button's `textContent` is still exactly its label (the P2.5 perf harness clicks nav buttons by
// text).
import type { JSX, ReactNode } from 'react'

interface IconProps {
  /** Extra classes after `icon`. */
  readonly className?: string
}

/** The shared frame: a 16×16 stroked outline, sized by `.icon` (styles.css). */
function Svg({ className, children }: IconProps & { readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  )
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3z" />
      <path d="M9 4l3 3" />
    </Svg>
  )
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Svg>
  )
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4.5M6.75 7v4.5M9.25 7v4.5" />
    </Svg>
  )
}

export function UndoIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5.5 3L2.5 6l3 3" />
      <path d="M2.5 6h7a4 4 0 0 1 0 8H6" />
    </Svg>
  )
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 8.5l3.25 3.25L13 5" />
    </Svg>
  )
}

export function XIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function ChevronUpIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 10l4-4 4 4" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  )
}

/** A multi-camera cell's previous camera (CELL-3). */
export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 4l-4 4 4 4" />
    </Svg>
  )
}

/** A multi-camera cell's next camera (CELL-3). */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  )
}

/** Merge: two cells joined into one. */
export function MergeIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M4.5 8h2M9.5 8h2M6 6.5L7.5 8 6 9.5M10 6.5L8.5 8 10 9.5" />
    </Svg>
  )
}

/** Split: one cell divided back into its slots. */
export function SplitIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10M3.5 8h2.5M10 8h2.5" />
    </Svg>
  )
}

export function EraserIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 13.5h7.5M2.9 9.6l6-6a1.5 1.5 0 0 1 2.1 0l2.4 2.4a1.5 1.5 0 0 1 0 2.1L8 13.5H5.6l-2.7-2.7a.85.85 0 0 1 0-1.2z" />
      <path d="M6 6.5L10.5 11" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </Svg>
  )
}

export function GearIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      {/* Six broad teeth on one outline (user feedback 2026-11-19: the eight thin spokes read as a sun). */}
      <path d="M6.21 3.33L6.48 1.42H9.52L9.79 3.33A5 5 0 0 1 11.15 4.11L12.94 3.4L14.46 6.03L12.94 7.22A5 5 0 0 1 12.94 8.78L14.46 9.97L12.94 12.6L11.15 11.89A5 5 0 0 1 9.79 12.67L9.52 14.58H6.48L6.21 12.67A5 5 0 0 1 4.85 11.89L3.06 12.6L1.54 9.97L3.06 8.78A5 5 0 0 1 3.06 7.22L1.54 6.03L3.06 3.4L4.85 4.11A5 5 0 0 1 6.21 3.33Z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  )
}

/** Connect / test a connection. */
export function PlugIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5.5 1.5v3M10.5 1.5v3" />
      <path d="M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0z" />
      <path d="M8 11.5v3" />
    </Svg>
  )
}

/**
 * The 2×2 grid: the Live screen, and FILL-1's "back to the grid". Filled squares rather than
 * outlines so it reads at the overlay's small size.
 */
export function GridIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <g fill="currentColor" stroke="none">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
        <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
        <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
        <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
      </g>
    </Svg>
  )
}

export function CameraIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" />
      <path d="M10.5 7l4-2.25v6.5L10.5 9" />
    </Svg>
  )
}

/** A certificate / pinned trust. */
export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z" />
      <path d="M5.5 8l1.75 1.75L10.5 6.5" />
    </Svg>
  )
}

/** Save to storage (a floppy disk), for the fill picker's Save. */
export function SaveIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 3.5a1 1 0 0 1 1-1h7.5l2.5 2.5v7.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      <path d="M5 2.5v3h5v-3M5 13.5v-4h6v4" />
    </Svg>
  )
}

/** Test a connection: a pulse line. */
export function PulseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
    </Svg>
  )
}

/**
 * ZOOM-2's reset to 100%: a magnifier with a minus, "zoom back out". The control's tooltip says it
 * resets to 100%.
 */
export function ZoomResetIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5l4 4M4.75 7h4.5" />
    </Svg>
  )
}

/**
 * AUD-2's mute toggle while the cell is heard: a speaker with sound waves. The button's label says
 * what a press does ("Mute").
 */
export function SpeakerIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
      <path d="M10.5 6a2.75 2.75 0 0 1 0 4M12.25 4.25a5.25 5.25 0 0 1 0 7.5" />
    </Svg>
  )
}

/** AUD-1/2's mute toggle while the cell is muted (every cell starts so): the speaker, crossed out. */
export function SpeakerMutedIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
      <path d="M10.5 6l4 4M14.5 6l-4 4" />
    </Svg>
  )
}

/** A window with its left pane marked: collapses / expands a sidebar. */
export function SidebarIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </Svg>
  )
}

/** Four corners pointing out: hide the app chrome, give the picture the window. */
export function ExpandIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </Svg>
  )
}

/** Four corners pointing in: bring the app chrome back. */
export function CollapseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />
    </Svg>
  )
}

/** A camera with a slash: offline, or no camera here. */
export function CameraOffIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5.5 4.5h3.5a1.5 1.5 0 0 1 1.5 1.5v1l3-1.5v5l-2-1" />
      <path d="M10.5 10.5a1.5 1.5 0 0 1-1.5 1H3.5A1.5 1.5 0 0 1 2 10V6a1.5 1.5 0 0 1 1-1.4" />
      <path d="M2 2l12 12" />
    </Svg>
  )
}

/** A triangle with an exclamation mark: a warning or an error line. */
export function AlertIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.4v.1" />
    </Svg>
  )
}

/** A circled "i": a neutral note. */
export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5v.1" />
    </Svg>
  )
}

/** A microphone: the camera is an audio source. */
export function MicIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="6" y="2" width="4" height="7" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" />
    </Svg>
  )
}

/** A closed padlock: a door's lock state, locked (DOOR-6, the Doors screen's cards). */
export function LockIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7" />
    </Svg>
  )
}

/** A padlock with its shackle swung open: a door's lock state, unlocked (DOOR-6). */
export function LockOpenIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 4.9-.75" />
    </Svg>
  )
}

/** A closed door in its frame: a door's unlock control at rest (DOOR-3, features/door/UnlockButton). */
export function DoorIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="4" y="1.5" width="8" height="13" rx="0.5" />
      <path d="M2.5 14.5h11M9.5 8.5v.5" />
    </Svg>
  )
}

/** An open door, its leaf swung in on the hinge: the door was just unlocked (DOOR-3). */
export function DoorOpenIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 14.5v-13H4M2.5 14.5h11M4 1.5l5.5 1.75v9.5L4 14.5zM8 8.25v.5" />
    </Svg>
  )
}
