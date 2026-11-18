// One card of the camera list (P1.7, CAM-1/CAM-3; simplified in the UX polish pass).
//
// Thin on purpose: every rule it would otherwise encode — the name fallback, what "online" means,
// whether audio is available, which placeholder to show — comes in as a `CameraPresentation` from
// `camerasStore`, which is where it can be unit-tested without a DOM (CLAUDE.md).
//
// The picture leads: the thumbnail fills the card's top edge to edge, the name is the one strong
// line, and everything else is quiet — a state dot and label, a microphone for audio, the model,
// and the RTSPS qualities as small chips. The card is not interactive, so it has no hover state.
import type { JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { CameraPresentation, RtspsSummary, ThumbnailEntry } from '../../state/camerasStore'
import { MicIcon } from '../../ui/icons'

export interface CameraCardProps {
  readonly camera: Camera
  readonly name: string
  readonly presentation: CameraPresentation
  readonly entry: ThumbnailEntry | undefined
  /** QUAL-7: which RTSPS qualities exist on the console, `null` to show nothing (offline). */
  readonly rtsps: RtspsSummary | null
  /** Injected rather than imported so this file has no opinion about thumbnails (see above). */
  readonly thumbnail: JSX.Element
}

export function CameraCard({
  camera,
  name,
  presentation,
  rtsps,
  thumbnail,
}: CameraCardProps): JSX.Element {
  const model = subtitle(camera, name)
  return (
    <li className={presentation.online ? 'cameraCard' : 'cameraCard cameraCard--offline'}>
      <div className="cameraCard__thumb">{thumbnail}</div>
      <div className="cameraCard__body">
        <div className="row cameraCard__head">
          <h3 className="cameraCard__name" title={name}>
            {name}
          </h3>
          {/* AUD-1/CAM-1: `hasMic && micEnabled`. A camera with a muted mic is not an audio
              source, so the microphone is absent rather than crossed out. */}
          {presentation.audio ? (
            <span
              className="cameraCard__audio"
              role="img"
              aria-label="Audio available"
              title="Audio available"
            >
              <MicIcon />
            </span>
          ) : null}
        </div>
        <p className={stateClass(presentation)}>
          <span className="badge__dot" aria-hidden="true" />
          <span className="badge__phase">{presentation.stateLabel}</span>
        </p>
        {/* The model is CAM-1's second column. Shown as the id when the console gave no model,
            and left out when the heading already fell back to one of those two. */}
        {model === '' ? null : (
          <p className="cameraCard__model" title={model}>
            {model}
          </p>
        )}
        {rtsps === null ? null : <RtspsLine summary={rtsps} />}
      </div>
    </li>
  )
}

/**
 * QUAL-7: which RTSPS qualities exist on the console, one small chip each — a present one in the
 * normal colour, an absent one dimmed (not struck through, not hidden: the card says what is
 * missing too). Muted throughout, failure included: whether a stream exists yet is a detail
 * (QUAL-8 creates one on first use), so nothing here may look like an error.
 */
function RtspsLine({ summary }: { summary: RtspsSummary }): JSX.Element {
  if (summary.kind !== 'known') {
    return (
      <p className="cameraCard__rtsps cameraCard__rtspsNote">
        {summary.kind === 'loading'
          ? 'Checking streams…'
          : summary.kind === 'unknown'
            ? 'Stream details unavailable'
            : 'No RTSPS streams created yet'}
      </p>
    )
  }
  return (
    <ul className="cameraCard__rtsps" aria-label="RTSPS streams" title="RTSPS streams">
      {summary.badges.map((badge) => (
        <li
          key={badge.quality}
          className={
            badge.present
              ? 'cameraCard__rtspsQuality'
              : 'cameraCard__rtspsQuality cameraCard__rtspsQuality--absent'
          }
          title={badge.present ? 'On the console' : 'Not created yet'}
        >
          {badge.label}
          <span className="visuallyHidden">
            {badge.present ? ' (on the console)' : ' (not created yet)'}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Reuses the header badge's dot colours (styles.css) so one state reads the same app-wide;
 * `.cameraCard__state` (cameras.css) takes the pill's border and background away, leaving the dot
 * and the label.
 */
function stateClass(presentation: CameraPresentation): string {
  if (presentation.online) return 'badge badge--connected cameraCard__state'
  if (presentation.placeholder === 'connecting') return 'badge badge--connecting cameraCard__state'
  return 'badge badge--error cameraCard__state'
}

function subtitle(camera: Camera, name: string): string {
  const model = camera.model.trim()
  if (model !== '' && model !== name) return model
  return camera.id === name ? '' : camera.id
}
