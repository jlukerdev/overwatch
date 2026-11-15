// One row of the camera list (P1.7, CAM-1/CAM-3).
//
// Thin on purpose: every rule it would otherwise encode — the name fallback, what "online" means,
// whether audio is available, which placeholder to show — comes in as a `CameraPresentation` from
// `camerasStore`, which is where it can be unit-tested without a DOM (CLAUDE.md).
import type { JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { CameraPresentation, RtspsSummary, ThumbnailEntry } from '../../state/camerasStore'

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
  return (
    <li className="cameraCard card">
      <div className="cameraCard__thumb">{thumbnail}</div>
      <h3 className="cameraCard__name" title={name}>
        {name}
      </h3>
      <div className="row cameraCard__meta">
        <span className={stateClass(presentation)}>
          <span className="badge__dot" aria-hidden="true" />
          <span className="badge__phase">{presentation.stateLabel}</span>
        </span>
        {/* AUD-1/CAM-1: `hasMic && micEnabled`. A camera with a muted mic is not an audio source,
            so the badge is absent rather than struck through. */}
        {presentation.audio ? <span className="badge cameraCard__audio">Audio</span> : null}
      </div>
      {/* The model is CAM-1's second column. Shown as the id when the console gave no model, and
          hidden when the heading already fell back to one of those two. */}
      <p className="cameraCard__model mono">{subtitle(camera, name)}</p>
      {rtsps === null ? null : <RtspsLine summary={rtsps} />}
    </li>
  )
}

/**
 * QUAL-7: "RTSPS: HIGH · MED · LOW", an absent quality dimmed and struck through. Muted throughout,
 * failure included: whether a stream exists yet is a detail (QUAL-8 creates one on first use), so
 * nothing here may look like an error.
 */
function RtspsLine({ summary }: { summary: RtspsSummary }): JSX.Element {
  return (
    <p className="cameraCard__rtsps">
      RTSPS:{' '}
      {summary.kind === 'loading'
        ? '…'
        : summary.kind === 'unknown'
          ? 'streams unknown'
          : summary.kind === 'none'
            ? 'none yet'
            : summary.badges.map((badge, index) => (
                <span key={badge.quality}>
                  {index === 0 ? null : ' · '}
                  <span
                    className={
                      badge.present
                        ? 'cameraCard__rtspsQuality'
                        : 'cameraCard__rtspsQuality cameraCard__rtspsQuality--absent'
                    }
                    title={badge.present ? 'On the console' : 'Not created yet'}
                  >
                    {badge.label}
                  </span>
                </span>
              ))}
    </p>
  )
}

/** Reuses the header badge's dot colours (styles.css) so one state reads the same app-wide. */
function stateClass(presentation: CameraPresentation): string {
  if (presentation.online) return 'badge badge--connected'
  if (presentation.placeholder === 'connecting') return 'badge badge--connecting'
  return 'badge badge--error'
}

function subtitle(camera: Camera, name: string): string {
  const model = camera.model.trim()
  if (model !== '' && model !== name) return model
  return camera.id === name ? '' : camera.id
}
