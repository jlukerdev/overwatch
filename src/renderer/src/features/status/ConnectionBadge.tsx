// CON-5: the connection indicator, always on screen. It shows Protect, and Access only while Access
// is switched on (DOOR-0) — a badge for a feature the user turned off is noise.
//
// Each badge is a button that opens the Settings screen, where the connection is tested and fixed
// (CON-4). It still starts nothing by itself: no retry, no "connect". Connecting spends a
// rate-limit permit (SPEC R9) and must stay a deliberate act.
//
// While an endpoint is in `error` the badge carries the reason too, cut with an ellipsis by the
// CSS (`.badge__reason`), so a console that went away says why without a hover; the full sentence
// is in the tooltip and in Settings. The wording is `badgeText.ts`, pure and tested.
//
// Two places draw it: the app header (`ConnectionBadge`, every endpoint), and the Live screen's
// focus mode, which hides the header and so shows `ConnectionAlerts` — only the endpoints that are
// not connected — beside its exit control (features/viewSwitcher/focusMode.ts).
//
// In RTSP mode there is no console to report on (MODE-3/4), so both draw nothing.
import type { JSX } from 'react'
import { type EndpointName, type EndpointStatus } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { focusModeAlerts } from '../viewSwitcher/focusMode'
import { badgeAriaLabel, badgeReason, badgeTitle, PHASE_LABELS } from './badgeText'

const ENDPOINT_LABELS: Readonly<Record<EndpointName, string>> = {
  protect: 'Protect',
  access: 'Access',
}

export interface ConnectionBadgeProps {
  /** Opens the Settings screen (the app shell asks about unsaved editor changes first). */
  readonly onOpenSettings: () => void
}

export function ConnectionBadge({ onOpenSettings }: ConnectionBadgeProps): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  const rtsp = useAppStore((s) => s.settings?.mode === 'rtsp')
  if (connection === null || rtsp) return null

  return (
    <div className="badges">
      <Badge endpoint="protect" status={connection.protect} onOpenSettings={onOpenSettings} />
      {connection.access.phase === 'disabled' ? null : (
        <Badge endpoint="access" status={connection.access} onOpenSettings={onOpenSettings} />
      )}
    </div>
  )
}

/**
 * Focus mode's stand-in for the header badges (CON-5): one badge per endpoint that is not
 * connected, nothing at all while everything is. Drawn over live video, hence `badge--floating`.
 */
export function ConnectionAlerts({ onOpenSettings }: ConnectionBadgeProps): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  const mode = useAppStore((s) => s.settings?.mode ?? 'protect')
  const alerts = focusModeAlerts(connection, mode)
  if (connection === null || alerts.length === 0) return null

  return (
    <div className="badges" role="status">
      {alerts.map((endpoint) => (
        <Badge
          key={endpoint}
          endpoint={endpoint}
          status={connection[endpoint]}
          onOpenSettings={onOpenSettings}
          floating
        />
      ))}
    </div>
  )
}

function Badge({
  endpoint,
  status,
  onOpenSettings,
  floating = false,
}: {
  readonly endpoint: EndpointName
  readonly status: EndpointStatus
  readonly onOpenSettings: () => void
  readonly floating?: boolean
}): JSX.Element {
  const label = ENDPOINT_LABELS[endpoint]
  const reason = badgeReason(status)
  return (
    <button
      type="button"
      className={`badge badge--${status.phase}${floating ? ' badge--floating' : ''}`}
      title={badgeTitle(status)}
      aria-label={badgeAriaLabel(label, status)}
      onClick={onOpenSettings}
    >
      <span className="badge__dot" aria-hidden="true" />
      <span className="badge__label">{label}</span>
      <span className="badge__phase">{PHASE_LABELS[status.phase]}</span>
      {reason === null ? null : <span className="badge__reason">{reason}</span>}
    </button>
  )
}
