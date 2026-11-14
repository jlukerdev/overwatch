// CON-3, one endpoint's half of it: show the certificate, let the user accept it once, and block
// hard when it changes. One of these per endpoint, because pinning is per host:port — Protect is
// behind 443 and the Access developer API answers on 12445, so one pin cannot cover both (SPEC §6).
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
import { describeCert, formatFingerprint } from './settingsForm'

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
        ? 'The new certificate is pinned. This console is now trusted again.'
        : 'Certificate pinned. The app will refuse to connect if it changes.',
    )
  }

  return (
    <section className="card">
      <div className="row settings__cardHead">
        <h3 className="card__title">{label} certificate</h3>
        <span className="settings__factValue">{status.pinned ? 'pinned' : 'not accepted yet'}</span>
        <button
          type="button"
          className="button settings__push"
          disabled={busy !== null}
          onClick={() => {
            void runCheck()
          }}
        >
          {busy === 'check' ? 'Checking…' : 'Check certificate'}
        </button>
      </div>
      <p className="card__hint">
        {status.hostPort ?? 'No address yet — save a console host first.'}
      </p>

      {error === null ? null : <p className="field__error">{error.message}</p>}
      {note === null ? null : <p className="settings__note">{note}</p>}

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
        <p className="settings__ok">This certificate matches the stored pin.</p>
        <p className="mono settings__fingerprint">{formatFingerprint(check.fingerprint256)}</p>
        <p className="field__hint">{describeCert(check.cert)}</p>
      </div>
    )
  }

  if (check.state === 'no-pin') {
    return (
      <div className="settings__certBody">
        <p className="card__hint">
          Nothing is pinned for this address yet. Compare this fingerprint with the one your console
          shows, then trust it — the app will accept no other certificate afterwards.
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
          {busy === 'pin' ? 'Pinning…' : 'Trust this certificate'}
        </button>
      </div>
    )
  }

  return (
    <div className="settings__certBody settings__mismatch" role="alert">
      <p className="settings__mismatchTitle">Certificate does not match the pinned one</p>
      <p className="settings__mismatchText">{check.message}</p>
      <dl className="settings__prints">
        <dt className="field__label">Pinned</dt>
        <dd className="mono settings__fingerprint">{formatFingerprint(check.expected)}</dd>
        <dt className="field__label">Presented now</dt>
        <dd className="mono settings__fingerprint">{formatFingerprint(check.actual)}</dd>
      </dl>
      <p className="field__hint">{describeCert(check.cert)}</p>
      <p className="settings__mismatchText">
        This is what a console that was reinstalled or had its certificate renewed looks like — and
        also what someone intercepting the connection looks like. Only continue if you know why it
        changed.
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
          {busy === 'pin' ? 'Re-pinning…' : 'Replace the pinned certificate'}
        </button>
      ) : null}
    </div>
  )
}
