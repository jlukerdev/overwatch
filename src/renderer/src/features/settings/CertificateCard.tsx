// CON-3, one endpoint's half of it: show the certificate, let the user accept it once, and block
// hard when it changes. One of these per endpoint, because pinning is per host:port — Protect is
// behind 443 and the Access developer API answers on 12445, so one pin cannot cover both (SPEC §6).
//
// On screen a stored pin is called an "accepted" certificate: the user accepts one (CON-3), and
// "pin" is the code's word for what that stores. Outcomes are `.status` lines (./StatusLine).
//
// The three `PinCheck` states are three different jobs, not three colours of the same message:
//
//  - `no-pin` is trust-on-first-use. The fingerprint is shown in `.mono` with the subject, issuer,
//    validity and whether it is self-signed, and the accept call sends back **the fingerprint that
//    was on screen** — not "whatever the console presents now". Main re-reads the leaf and refuses
//    if it changed in between, so a certificate swapped between the check and the click is never
//    pinned sight unseen (ipc.ts, `AcceptCertInput`).
//  - `match` is a receipt. Nothing to do.
//  - `mismatch` is the one state that matters: the console is not the one the user accepted, or
//    something is in the middle. Re-pinning is offered, but only behind a second explicit step —
//    the checkbox has to be ticked before the button exists at all — because a one-click re-pin
//    turns the whole TOFU mechanism into a formality.
import { useState, type JSX } from 'react'
import type { EndpointName, EndpointStatus, IpcError, PinCheck } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { AlertIcon, CheckIcon, ShieldIcon } from '../../ui/icons'
import { describeCert, formatFingerprint } from './settingsForm'
import { StatusLine } from '../../ui/StatusLine'

/** Which call is in flight. Each button disables only itself, so the others stay usable. */
type Busy = 'check' | 'pin' | null

export function CertificateCard({
  endpoint,
  label,
  status,
}: {
  endpoint: EndpointName
  label: string
  status: EndpointStatus
}): JSX.Element {
  const checkCertificate = useAppStore((s) => s.checkCertificate)
  const acceptCertificate = useAppStore((s) => s.acceptCertificate)
  const repinCertificate = useAppStore((s) => s.repinCertificate)

  const [check, setCheck] = useState<PinCheck | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<IpcError | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** The second step in front of a re-pin. Reset with every new check, never remembered. */
  const [repinConfirmed, setRepinConfirmed] = useState(false)

  const confirmId = `repin-confirm-${endpoint}`

  const runCheck = async (): Promise<void> => {
    setBusy('check')
    setError(null)
    setNote(null)
    setRepinConfirmed(false)
    const result = await checkCertificate(endpoint)
    setBusy(null)
    if (!result.ok) {
      setCheck(null)
      setError(result.error)
      return
    }
    setCheck(result.value)
  }

  /** Accept and re-pin differ only in which channel they are allowed to use (ipc.ts). */
  const pin = async (fingerprint256: string, replacing: boolean): Promise<void> => {
    setBusy('pin')
    setError(null)
    const input = { endpoint, fingerprint256 }
    const result = replacing ? await repinCertificate(input) : await acceptCertificate(input)
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // The pin is stored, so the fingerprint on screen is now the expected one: drop the check rather
    // than leave a stale "not pinned yet" panel behind. The next check reads `match`.
    setCheck(null)
    setRepinConfirmed(false)
    setNote(
      replacing
        ? 'The new certificate is accepted. This console is trusted again.'
        : 'Certificate accepted. The app will refuse to connect if it ever changes.',
    )
  }

  return (
    // A block inside the Console group's Certificate subsection (SettingsPage), not a card of its own.
    <section className="settings__cert" aria-label={`${label} certificate`}>
      <div className="row settings__cardHead">
        <h4 className="settings__certTitle">{label}</h4>
        <span className={status.pinned ? 'settings__chip settings__chip--ok' : 'settings__chip'}>
          {status.pinned ? <CheckIcon /> : null}
          {status.pinned ? 'Accepted' : 'Not accepted yet'}
        </span>
        <button
          type="button"
          className="button settings__push"
          disabled={busy !== null}
          onClick={() => {
            void runCheck()
          }}
        >
          <ShieldIcon />
          {busy === 'check' ? 'Checking…' : 'Check certificate'}
        </button>
      </div>
      <p className="card__hint">
        {status.hostPort ?? 'No address yet. Save a console address first.'}
      </p>

      {error === null ? null : (
        <StatusLine kind="error" className="settings__outcome">
          {error.message}
        </StatusLine>
      )}
      {note === null ? null : (
        <StatusLine kind="ok" className="settings__outcome">
          {note}
        </StatusLine>
      )}

      {check === null ? null : (
        <CheckPanel
          check={check}
          busy={busy}
          confirmId={confirmId}
          repinConfirmed={repinConfirmed}
          onConfirmChange={setRepinConfirmed}
          onPin={(fingerprint, replacing) => {
            void pin(fingerprint, replacing)
          }}
        />
      )}
    </section>
  )
}

function CheckPanel({
  check,
  busy,
  confirmId,
  repinConfirmed,
  onConfirmChange,
  onPin,
}: {
  check: PinCheck
  busy: Busy
  confirmId: string
  repinConfirmed: boolean
  onConfirmChange: (confirmed: boolean) => void
  onPin: (fingerprint256: string, replacing: boolean) => void
}): JSX.Element {
  if (check.state === 'match') {
    return (
      <div className="settings__certBody">
        <StatusLine kind="ok">This certificate matches the one you accepted.</StatusLine>
        <p className="mono settings__fingerprint">{formatFingerprint(check.fingerprint256)}</p>
        <p className="field__hint">{describeCert(check.cert)}</p>
      </div>
    )
  }

  if (check.state === 'no-pin') {
    return (
      <div className="settings__certBody">
        <p className="card__hint">
          Compare this fingerprint with your console&rsquo;s before trusting it; no other will be
          accepted afterwards.
        </p>
        <p className="mono settings__fingerprint">{formatFingerprint(check.cert.fingerprint256)}</p>
        <p className="field__hint">{describeCert(check.cert)}</p>
        <button
          type="button"
          className="button button--primary"
          disabled={busy !== null}
          onClick={() => {
            // Exactly what was rendered above, so the user accepts what they read (CON-3).
            onPin(check.cert.fingerprint256, false)
          }}
        >
          <CheckIcon />
          {busy === 'pin' ? 'Accepting…' : 'Trust this certificate'}
        </button>
      </div>
    )
  }

  return (
    <div className="settings__certBody settings__mismatch" role="alert">
      <p className="settings__mismatchTitle">
        <AlertIcon />
        This certificate does not match the one you accepted
      </p>
      <p className="settings__mismatchText">{check.message}</p>
      <dl className="settings__prints">
        <dt className="field__label">Accepted before</dt>
        <dd className="mono settings__fingerprint">{formatFingerprint(check.expected)}</dd>
        <dt className="field__label">Presented now</dt>
        <dd className="mono settings__fingerprint">{formatFingerprint(check.actual)}</dd>
      </dl>
      <p className="field__hint">{describeCert(check.cert)}</p>
      <p className="settings__mismatchText">
        A reinstall or a renewed certificate looks like this, and so does an interception: continue
        only if you know why it changed.
      </p>
      <div className="row">
        <input
          id={confirmId}
          type="checkbox"
          checked={repinConfirmed}
          onChange={(event) => {
            onConfirmChange(event.target.checked)
          }}
        />
        <label htmlFor={confirmId}>I checked the new fingerprint against the console itself.</label>
      </div>
      {repinConfirmed ? (
        <button
          type="button"
          className="button button--danger"
          disabled={busy !== null}
          onClick={() => {
            onPin(check.actual, true)
          }}
        >
          <ShieldIcon />
          {busy === 'pin' ? 'Replacing…' : 'Replace the accepted certificate'}
        </button>
      ) : null}
    </div>
  )
}
