// A snapshot's JPEG bytes as an <img> (P1.7, extracted in P5.2): the camera list's thumbnails and
// the View editor's cell backgrounds (VIEW-3).
//
// The only module that touches `URL.createObjectURL`, and it does so inside an effect whose cleanup
// revokes it. That is deliberate: the shared cache (state/thumbnailsStore) holds **bytes**, so the
// lifetime of every object URL is tied to the lifetime of the <img> that uses it. React runs the
// cleanup both when the image unmounts and when the bytes are replaced, so a refresh of a
// 15-camera wall cannot leave a megabyte of revoked-never blobs behind.
import { useEffect, useRef, type JSX } from 'react'

export interface SnapshotImageProps {
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly className: string
  readonly title?: string
}

export function SnapshotImage({
  bytes,
  mimeType,
  className,
  title,
}: SnapshotImageProps): JSX.Element {
  const imageRef = useRef<HTMLImageElement | null>(null)

  // The object URL is pushed straight onto the <img> rather than held in state: an effect's job is
  // to feed an external system (here, the DOM) from React's state, and putting the URL in state
  // would cost a second render per image — fifteen of them on every refresh.
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
      className={className}
      // Decorative everywhere it is used: the camera's name is already beside it as text.
      alt=""
      title={title}
      draggable={false}
    />
  )
}
