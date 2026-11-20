// The Streams screen (MODE-3, RTSP-1): RTSP mode's stand-in for the Cameras screen, where each
// camera's RTSP addresses are added and edited. It is in the header's nav only in RTSP mode
// (navScreens.ts) and is the start screen there until a stream and a View exist (initialScreen.ts).
//
// For now a placeholder: the stream list, the Add / Edit dialog and the quality Settings bar follow.
import type { JSX } from 'react'
import { CameraIcon } from '../../ui/icons'

export function StreamsScreen(): JSX.Element {
  return (
    <div className="emptyState">
      <span className="emptyState__icon">
        <CameraIcon />
      </span>
      <h2 className="emptyState__title">Streams</h2>
      <p className="emptyState__hint">Adding RTSP streams is coming next.</p>
    </div>
  )
}
