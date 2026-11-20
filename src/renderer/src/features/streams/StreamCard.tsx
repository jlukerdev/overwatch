// One RTSP stream on the Streams screen (RTSP-1): the camera icon (no thumbnails in v1.0.2), its
// name, the QUAL-7 chips saying which qualities have an address, and Edit / Delete. The chips come
// from booleans only (RTSP-2): the renderer never holds a stream URL.
import type { JSX } from 'react'
import type { RtspQualitiesStored } from '@shared/rtsp'
import { RTSP_QUALITIES } from '@shared/rtsp'
import { qualityBadgeLabel } from '@shared/quality'
import { CameraIcon, PencilIcon, TrashIcon } from '../../ui/icons'

const NONE: RtspQualitiesStored = { high: false, medium: false, low: false }

export function StreamCard({
  id,
  name,
  stored,
  onEdit,
  onDelete,
}: {
  id: string
  name: string
  /** Which qualities have an address; `undefined` when none do. */
  stored: RtspQualitiesStored | undefined
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  const has = stored ?? NONE
  const headingId = `stream-${id}-name`
  return (
    <li className="card streamCard" aria-labelledby={headingId}>
      <span className="streamCard__icon" aria-hidden="true">
        <CameraIcon />
      </span>
      <div className="streamCard__body">
        <h3 className="streamCard__name" id={headingId} title={name}>
          {name}
        </h3>
        <ul className="qualityChips" aria-label="Stream addresses" title="Stream addresses">
          {RTSP_QUALITIES.map((quality) => (
            <li
              key={quality}
              className={has[quality] ? 'qualityChip' : 'qualityChip qualityChip--absent'}
              title={has[quality] ? 'Address saved' : 'No address'}
            >
              {qualityBadgeLabel(quality)}
              <span className="visuallyHidden">
                {has[quality] ? ' (address saved)' : ' (no address)'}
              </span>
            </li>
          ))}
        </ul>
        <div className="streamCard__actions row">
          <button
            type="button"
            className="button button--sm"
            aria-label={`Edit ${name}`}
            onClick={onEdit}
          >
            <PencilIcon />
            Edit
          </button>
          <button
            type="button"
            className="button button--sm button--danger"
            aria-label={`Delete ${name}`}
            onClick={onDelete}
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
