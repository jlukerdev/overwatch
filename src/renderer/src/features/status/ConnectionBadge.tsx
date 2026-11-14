// CON-5: the connection indicator, always on screen. It shows Protect, and Access only while Access
// is switched on (DOOR-0) — a badge for a feature the user turned off is noise.
//
// It renders status and nothing else: no retry button, no "connect" action. Those live in Settings
// (CON-4), because connecting spends a rate-limit permit (SPEC R9) and must stay a deliberate act.
import type { JSX } from 'react'
import { type ConnectionPhase, type EndpointStatus } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'

/** Phase → what the user reads. Short, because this sits in the header. */
const PHASE_LABELS: Readonly<Record<ConnectionPhase, string>> = {
  disabled: 'off',
  unconfigured: 'not set up',
  idle: 'ready',
  connecting: 'connecting…',
  connected: 'connected',
  reconnecting: 'reconnecting…',
  error: 'error',
}

export function ConnectionBadge(): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  if (connection === null) return null

  return (
    <div className="badges">
      <Badge label="Protect" status={connection.protect} />
      {connection.access.phase === 'disabled' ? null : (
        <Badge label="Access" status={connection.access} />
      )}
    </div>
  )
}

function Badge({ label, status }: { label: string; status: EndpointStatus }): JSX.Element {
  // The error message goes in the title rather than the badge: it can be a sentence, and the header
  // must not reflow when a console goes away. Settings shows the same text in full (CON-4).
  const title = [
    status.hostPort ?? 'no address yet',
    status.error === null ? null : status.error.message,
    status.version === null ? null : `version ${status.version}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ')

  return (
    <span className={`badge badge--${status.phase}`} title={title}>
      <span className="badge__dot" aria-hidden="true" />
      <span className="badge__label">{label}</span>
      <span className="badge__phase">{PHASE_LABELS[status.phase]}</span>
    </span>
  )
}
