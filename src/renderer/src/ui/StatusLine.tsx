// The one way a card reports the outcome of an action (UX polish): the shared `.status`
// line (styles.css) — an icon and a sentence, coloured by kind. Save, key save/clear, Test
// connection, Connect, certificate accept, the stream defaults and the door links all use it, so a
// success or a failure looks the same wherever it happened. It changes how an outcome is drawn,
// never what is reported or when: each card still decides that, next to the control that caused it.
//
// Not for field validation: "Enter the console IP or host name." stays under its field as
// `.field__error`, because it is about what is typed there, not about something that was tried.
import type { JSX, ReactNode } from 'react'
import { AlertIcon, CheckIcon, InfoIcon } from './icons'

export type StatusKind = 'ok' | 'warn' | 'error' | 'muted'

export function StatusLine({
  kind,
  busy = false,
  role,
  className,
  title,
  children,
}: {
  kind: StatusKind
  /** A spinner in place of the icon: something is still being read. */
  busy?: boolean
  role?: 'status' | 'alert'
  /** Extra classes after `status status--<kind>` (spacing in a particular card). */
  className?: string
  /** The whole message as a tooltip, where the line may be cut short. */
  title?: string
  children: ReactNode
}): JSX.Element {
  const classes = `status status--${kind}${className === undefined ? '' : ` ${className}`}`
  return (
    <p className={classes} role={role} title={title}>
      {busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : kind === 'ok' ? (
        <CheckIcon />
      ) : kind === 'muted' ? (
        <InfoIcon />
      ) : (
        <AlertIcon />
      )}
      <span>{children}</span>
    </p>
  )
}
