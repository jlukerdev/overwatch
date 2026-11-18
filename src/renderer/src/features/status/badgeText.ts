// What the connection badge says (CON-5), as pure functions of an endpoint's status, so the wording
// is tested in the node environment and the component (ConnectionBadge.tsx) only lays it out.
//
// Three texts per badge:
//  - the **phase**, always shown, short because it sits in the header;
//  - the **reason**, shown in the badge itself only while the endpoint is in `error`: main's
//    one-sentence message, which the CSS cuts with an ellipsis so the header never reflows;
//  - the **tooltip**, everything in full (address, the error, the console version), and the
//    **accessible name**, which also says what pressing the badge does (it opens Settings, where
//    the connection is tested and fixed, CON-4).
import type { ConnectionPhase, EndpointStatus } from '@shared/ipc'

/** Phase → what the user reads. */
export const PHASE_LABELS: Readonly<Record<ConnectionPhase, string>> = {
  disabled: 'Off',
  unconfigured: 'Not set up',
  idle: 'Ready',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
}

/**
 * The failure to show inside the badge: the error's message on one line, without its closing full
 * stop, only while the phase is `error`. A reconnect in progress keeps its last failure for the
 * tooltip alone, because "Reconnecting…" is already the news. `null` when there is nothing to show.
 */
export function badgeReason(status: EndpointStatus): string | null {
  if (status.phase !== 'error' || status.error === null) return null
  const reason = status.error.message.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  return reason === '' ? null : reason
}

/** The tooltip: the address, the last failure in full, and the console version, whichever exist. */
export function badgeTitle(status: EndpointStatus): string {
  return [
    status.hostPort ?? 'No address yet',
    status.error === null ? null : status.error.message,
    status.version === null ? null : `Version ${status.version}`,
    'Click to open Settings',
  ]
    .filter((part): part is string => part !== null)
    .join(' — ')
}

/** The accessible name, e.g. "Protect: connected. Open settings". */
export function badgeAriaLabel(label: string, status: EndpointStatus): string {
  const phase = PHASE_LABELS[status.phase].replace(/…$/, '').toLowerCase()
  const reason = badgeReason(status)
  return `${label}: ${phase}${reason === null ? '' : ` (${reason})`}. Open settings`
}
