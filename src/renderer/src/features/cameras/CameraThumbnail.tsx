// One camera's thumbnail or its placeholder (P1.7, CAM-1/CAM-3).
//
// The image itself is `ui/SnapshotImage`, which owns the object URL's whole lifetime (created and
// revoked in one effect); the shared cache (state/thumbnailsStore) holds only the JPEG bytes.
import type { JSX } from 'react'
import type { CameraPlaceholder, ThumbnailEntry } from '../../state/camerasStore'
import { SnapshotImage } from '../../ui/SnapshotImage'

/** What a placeholder says. CAM-3's two words, and nothing that looks like a failure. */
const PLACEHOLDER_LABELS: Readonly<Record<CameraPlaceholder, string>> = {
  offline: 'Offline',
  connecting: 'Connecting…',
}

export interface CameraThumbnailProps {
  readonly name: string
  /** From `cameraPresentation`: non-null means show the placeholder, whatever the cache holds. */
  readonly placeholder: CameraPlaceholder | null
  readonly entry: ThumbnailEntry | undefined
}

export function CameraThumbnail({ name, placeholder, entry }: CameraThumbnailProps): JSX.Element {
  // The state field is what makes a camera offline (CAM-2/3, gate G1's 10 seconds), so it is
  // checked before the cache: a cached image must never outlive the state it was taken in.
  if (placeholder !== null) {
    return <Placeholder text={PLACEHOLDER_LABELS[placeholder]} />
  }

  if (entry === undefined || entry.status === 'loading') {
    return <Placeholder text="Loading…" muted />
  }

  // CAM-3: the console has no image for this camera. A placeholder with the reason in the title,
  // not an error — the 503 path is unverified (SPEC R11) and main maps any such failure here.
  if (entry.status === 'unavailable') {
    return <Placeholder text="No snapshot" title={entry.reason} muted />
  }

  if (entry.status === 'failed') {
    return <Placeholder text="Snapshot failed" title={entry.error.message} />
  }

  return (
    <SnapshotImage
      className="cameraCard__image"
      title={name}
      bytes={entry.bytes}
      mimeType={entry.mimeType}
    />
  )
}

function Placeholder({
  text,
  title,
  muted = false,
}: {
  text: string
  title?: string
  muted?: boolean
}): JSX.Element {
  return (
    <div
      className={
        muted ? 'cameraCard__placeholder cameraCard__placeholder--muted' : 'cameraCard__placeholder'
      }
      title={title}
    >
      {text}
    </div>
  )
}
