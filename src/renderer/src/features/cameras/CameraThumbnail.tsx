// One camera's thumbnail or its placeholder (P1.7, CAM-1/CAM-3).
//
// This is the only module that touches `URL.createObjectURL`, and it does so inside an effect whose
// cleanup revokes it. That is deliberate: the cache in `camerasStore` holds JPEG **bytes**, so the
// lifetime of every object URL is tied to the lifetime of the <img> that uses it. React runs the
// cleanup both when the row unmounts and when the bytes are replaced, so a refresh of a 15-camera
// wall cannot leave a megabyte of revoked-never blobs behind.
import { useEffect, useRef, type JSX } from 'react'
import type { CameraPlaceholder, ThumbnailEntry } from '../../state/camerasStore'

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

  return <ThumbnailImage name={name} bytes={entry.bytes} mimeType={entry.mimeType} />
}

function ThumbnailImage({
  name,
  bytes,
  mimeType,
}: {
  name: string
  bytes: Uint8Array
  mimeType: string
}): JSX.Element {
  const imageRef = useRef<HTMLImageElement | null>(null)

  // The object URL is pushed straight onto the <img> rather than held in state: an effect's job is
  // to feed an external system (here, the DOM) from React's state, and putting the URL in state
  // would cost a second render per thumbnail — fifteen of them on every refresh.
  useEffect(() => {
    // Copied into a fresh `Uint8Array` because the bytes that cross IPC are typed
    // `Uint8Array<ArrayBufferLike>`, which `BlobPart` does not accept (it rules out a
    // `SharedArrayBuffer` view). One copy of a few tens of kilobytes per snapshot is cheaper than
    // a cast that lies about where the buffer came from.
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }))
    const image = imageRef.current
    if (image !== null) image.src = url
    return () => {
      // Replaces as well as unmounts: a Refresh hands down new bytes and this frees the old image.
      if (image !== null) image.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }, [bytes, mimeType])

  return (
    <img
      ref={imageRef}
      className="cameraCard__image"
      // The name is already the card's heading, so the image adds nothing for a screen reader.
      alt=""
      title={name}
      draggable={false}
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
