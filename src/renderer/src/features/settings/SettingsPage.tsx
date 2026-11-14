// The Settings screen (P1.6): CON-1 (address and credentials), CON-2 (write-only secrets), CON-3
// (the certificate, in ./CertificateCard), CON-4 (Test connection) and the CON-5 facts the header
// badge has no room for. DOOR-0's switch lives here too, and governs everything Access on screen.
//
// Shape of the thing: one controlled draft plus a Save button that calls `setConsole`. Nothing here
// saves as you type — a half-typed host is a host the app would try to resolve, and `setConsole`
// re-derives both endpoints and both pin lookups (SPEC §6).
//
// Every action reports where it happened. The store hands back the `IpcResult` as well as folding it
// in, so each failure is rendered next to the control that caused it and stays there: no toast, no
// thrown error, no stack. A failed Test connection is information (CON-4), not a crash.
//
// Secrets are write-only (CON-2, NFR-9): the two password fields start empty, are never seeded, and
// each has its own Save — `setConsole` carries no credential at all.
import { useState, type JSX } from 'react'
import type { AccessProbe, IpcError, IpcSecretKey, ProtectProbe, Settings } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { CertificateCard } from './CertificateCard'
import {
  consoleDraftFrom,
  consoleInputFrom,
  consoleSignature,
  describeEndpointStatus,
  isConsoleDirty,
  type ConsoleDraft,
  type ConsoleFieldErrors,
} from './settingsForm'
import './settings.css'

export function SettingsPage(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const keystoreAvailable = useAppStore((s) => s.keystoreAvailable)

  // `settings` is null only until the first `getState()` lands, which the shell already waits for;
  // this is the type-level version of that guarantee rather than a state the user ever sees.
  if (settings === null) {
    return (
      <div className="settings">
        <p className="app__muted">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="settings">
      {keystoreAvailable ? null : <KeystoreWarning />}
      <ConsoleCard settings={settings} keystoreAvailable={keystoreAvailable} />
      <CertificateSection accessEnabled={settings.console.accessEnabled} />
      <ConnectionCard accessEnabled={settings.console.accessEnabled} />
    </div>
  )
}

/**
 * CON-2 has no plaintext fallback, so when `safeStorage` has no keystore the honest thing is to say
 * that a key cannot be kept at all — not to fail silently on Save and look like a bug.
 */
function KeystoreWarning(): JSX.Element {
  return (
    <section className="card settings__keystore" role="alert">
      <h2 className="card__title">The OS keystore is not available</h2>
      <p className="settings__mismatchText">
        This system has no keystore for the app to encrypt credentials with (Keychain on macOS,
        DPAPI on Windows). The API key and the Access token cannot be saved, and the app will ask
        for them again the next time it starts. They are never written to disk in plain text.
      </p>
    </section>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-1 / CON-2 / DOOR-0: the console address, the credentials and the Access switch

function ConsoleCard({
  settings,
  keystoreAvailable,
}: {
  settings: Settings
  keystoreAvailable: boolean
}): JSX.Element {
  const secretsStored = useAppStore((s) => s.secretsStored)
  const setConsole = useAppStore((s) => s.setConsole)

  const [draft, setDraft] = useState<ConsoleDraft>(() => consoleDraftFrom(settings))
  const [errors, setErrors] = useState<ConsoleFieldErrors>({})
  const [saveError, setSaveError] = useState<IpcError | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-seed the draft when a save actually landed, and only then. Every mutating channel answers
  // with the whole `AppState` (ipc.ts rule 3), so keying this on the `settings` object itself would
  // discard a half-typed host every time a certificate was pinned or a key stored.
  const signature = consoleSignature(settings)
  const [syncedSignature, setSyncedSignature] = useState(signature)
  if (signature !== syncedSignature) {
    setSyncedSignature(signature)
    setDraft(consoleDraftFrom(settings))
    setErrors({})
  }

  const patch = (change: Partial<ConsoleDraft>): void => {
    setDraft((current) => ({ ...current, ...change }))
    setSaveError(null)
  }

  const save = async (): Promise<void> => {
    const validated = consoleInputFrom(draft, secretsStored)
    if (!validated.ok) {
      setErrors(validated.errors)
      return
    }
    setErrors({})
    setSaving(true)
    setSaveError(null)
    const result = await setConsole(validated.input)
    setSaving(false)
    if (!result.ok) setSaveError(result.error)
  }

  const dirty = isConsoleDirty(draft, settings)

  return (
    <section className="card">
      <h2 className="card__title">Console</h2>
      <p className="card__hint">
        Where the UniFi console is and what the app signs in with. Saving does not connect — use
        Test connection below.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="console-host">
          Console address
        </label>
        <input
          id="console-host"
          className="field__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="192.0.2.10 or udm.local:8443"
          value={draft.host}
          onChange={(event) => {
            patch({ host: event.target.value })
          }}
        />
        <p className="field__hint">
          The IP address or host name, with a port only if the console does not use 443. No https://
          in front of it.
        </p>
        {errors.host === undefined ? null : <p className="field__error">{errors.host}</p>}
      </div>

      <SecretField
        secretKey="protectApiKey"
        label="Protect Integration API key"
        hint="Created in the UniFi console under Protect → Integrations. Stored in the OS keystore and never shown again."
        stored={secretsStored.protectApiKey}
        keystoreAvailable={keystoreAvailable}
        value={draft.protectApiKey}
        onChange={(value) => {
          patch({ protectApiKey: value })
        }}
        onSaved={() => {
          patch({ protectApiKey: '' })
        }}
        error={errors.protectApiKey}
      />

      <div className="field">
        <div className="row">
          <input
            id="access-enabled"
            type="checkbox"
            checked={draft.accessEnabled}
            onChange={(event) => {
              patch({ accessEnabled: event.target.checked })
            }}
          />
          <label htmlFor="access-enabled">Enable UniFi Access</label>
        </div>
        <p className="field__hint">
          Off by default. While it is off the app makes no Access calls and hides every door
          control; a saved token and the door links are kept for when you turn it back on.
        </p>
      </div>

      {draft.accessEnabled ? (
        <>
          <SecretField
            secretKey="accessToken"
            label="Access API token"
            hint="The UniFi Access developer API token. Stored in the OS keystore and never shown again."
            stored={secretsStored.accessToken}
            keystoreAvailable={keystoreAvailable}
            value={draft.accessToken}
            onChange={(value) => {
              patch({ accessToken: value })
            }}
            onSaved={() => {
              patch({ accessToken: '' })
            }}
            error={errors.accessToken}
          />

          <div className="field">
            <label className="field__label" htmlFor="access-base-url">
              Access API root (optional)
            </label>
            <input
              id="access-base-url"
              className="field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://192.0.2.10:12445/api/v1/developer"
              value={draft.accessBaseUrl}
              onChange={(event) => {
                patch({ accessBaseUrl: event.target.value })
              }}
            />
            <p className="field__hint">
              Leave this empty for the usual address: port 12445 on the console host, whatever port
              the host field carries. Set it to point the app at a proxied Access API or at the
              development mock — it is the whole API root, origin and path.
            </p>
            {errors.accessBaseUrl === undefined ? null : (
              <p className="field__error">{errors.accessBaseUrl}</p>
            )}
          </div>
        </>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="button button--primary"
          disabled={saving || !dirty}
          onClick={() => {
            void save()
          }}
        >
          {saving ? 'Saving…' : 'Save console'}
        </button>
        {dirty ? <span className="field__hint">Unsaved changes</span> : null}
      </div>
      {saveError === null ? null : <p className="field__error">{saveError.message}</p>}
    </section>
  )
}

/**
 * One write-only credential (CON-2). The field is always empty on arrival: the renderer can store a
 * secret and can clear it, but there is no channel that reads one back — "stored" next to the label
 * is the whole of what it may know (`AppState.secretsStored`).
 */
function SecretField({
  secretKey,
  label,
  hint,
  stored,
  keystoreAvailable,
  value,
  onChange,
  onSaved,
  error,
}: {
  secretKey: IpcSecretKey
  label: string
  hint: string
  stored: boolean
  keystoreAvailable: boolean
  value: string
  onChange: (value: string) => void
  onSaved: () => void
  error: string | undefined
}): JSX.Element {
  const setSecret = useAppStore((s) => s.setSecret)
  const clearSecret = useAppStore((s) => s.clearSecret)

  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const [callError, setCallError] = useState<IpcError | null>(null)

  const inputId = `secret-${secretKey}`

  const save = async (): Promise<void> => {
    setBusy('save')
    setCallError(null)
    const result = await setSecret({ key: secretKey, value })
    setBusy(null)
    if (result.ok) {
      // Clearing the box is the only honest end state: what is on screen cannot be read back from
      // the keystore, so leaving it there would suggest it could be.
      onSaved()
      return
    }
    setCallError(result.error)
  }

  const clear = async (): Promise<void> => {
    setBusy('clear')
    setCallError(null)
    const result = await clearSecret({ key: secretKey })
    setBusy(null)
    if (!result.ok) setCallError(result.error)
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
        {stored ? <span className="settings__stored"> stored</span> : null}
      </label>
      <div className="row">
        <input
          id={inputId}
          className="field__input settings__grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={stored ? 'Enter a new value to replace it' : ''}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <button
          type="button"
          className="button"
          disabled={busy !== null || value.trim() === '' || !keystoreAvailable}
          onClick={() => {
            void save()
          }}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {stored ? (
          <button
            type="button"
            className="button button--danger"
            disabled={busy !== null}
            onClick={() => {
              void clear()
            }}
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        ) : null}
      </div>
      <p className="field__hint">{hint}</p>
      {error === undefined ? null : <p className="field__error">{error}</p>}
      {callError === null ? null : <p className="field__error">{callError.message}</p>}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-3: one card per endpoint, and Access only while it is switched on (DOOR-0)

function CertificateSection({ accessEnabled }: { accessEnabled: boolean }): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  if (connection === null) return null

  return (
    <>
      <CertificateCard endpoint="protect" label="Protect" status={connection.protect} />
      {accessEnabled ? (
        <CertificateCard endpoint="access" label="Access" status={connection.access} />
      ) : null}
    </>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-4 / CON-5: Test connection, Connect / Disconnect, and the per-endpoint facts

function ConnectionCard({ accessEnabled }: { accessEnabled: boolean }): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  const testConnection = useAppStore((s) => s.testConnection)
  const connect = useAppStore((s) => s.connect)
  const disconnect = useAppStore((s) => s.disconnect)

  const [busy, setBusy] = useState<'test' | 'connect' | 'disconnect' | null>(null)
  const [probes, setProbes] = useState<{ protect: ProtectProbe; access: AccessProbe } | null>(null)
  const [testError, setTestError] = useState<IpcError | null>(null)
  const [connectError, setConnectError] = useState<IpcError | null>(null)

  if (connection === null) return null

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setTestError(null)
    const result = await testConnection()
    setBusy(null)
    if (!result.ok) {
      // A transport-level failure of the call itself; a console that answered badly comes back as a
      // per-half probe instead, which is the normal CON-4 outcome.
      setProbes(null)
      setTestError(result.error)
      return
    }
    setProbes({ protect: result.value.protect, access: result.value.access })
  }

  const run = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setBusy(action)
    setConnectError(null)
    const result = action === 'connect' ? await connect() : await disconnect()
    setBusy(null)
    if (!result.ok) setConnectError(result.error)
  }

  return (
    <section className="card">
      <h2 className="card__title">Connection</h2>
      <p className="card__hint">
        Nothing connects on its own: the app opens the camera feed when you ask it to, so a console
        that is not set up costs nothing.
      </p>

      <dl className="settings__facts">
        <dt className="field__label">Protect</dt>
        <dd className="settings__factValue">{describeEndpointStatus(connection.protect)}</dd>
        {accessEnabled ? (
          <>
            <dt className="field__label">Access</dt>
            <dd className="settings__factValue">{describeEndpointStatus(connection.access)}</dd>
          </>
        ) : null}
      </dl>

      <div className="row settings__actions">
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => {
            void runTest()
          }}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy !== null}
          onClick={() => {
            void run('connect')
          }}
        >
          {busy === 'connect' ? 'Connecting…' : 'Connect'}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => {
            void run('disconnect')
          }}
        >
          {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
      {connectError === null ? null : <p className="field__error">{connectError.message}</p>}
      {testError === null ? null : <p className="field__error">{testError.message}</p>}

      {probes === null ? null : (
        <dl className="settings__facts settings__probes">
          <dt className="field__label">Protect</dt>
          <dd className={probes.protect.state === 'ok' ? 'settings__ok' : 'field__error'}>
            {probes.protect.state === 'ok'
              ? `Reachable — Protect ${probes.protect.applicationVersion}`
              : probes.protect.error.message}
          </dd>
          <dt className="field__label">Access</dt>
          <dd className={accessProbeClass(probes.access)}>{describeAccessProbe(probes.access)}</dd>
        </dl>
      )}
    </section>
  )
}

function accessProbeClass(probe: AccessProbe): string {
  if (probe.state === 'ok') return 'settings__ok'
  return probe.state === 'error' ? 'field__error' : 'settings__factValue'
}

function describeAccessProbe(probe: AccessProbe): string {
  if (probe.state === 'disabled') return 'Switched off — no Access calls were made.'
  if (probe.state === 'error') return probe.error.message
  const count = String(probe.doorCount)
  return probe.doorCount === 1 ? 'Reachable — 1 door' : `Reachable — ${count} doors`
}
