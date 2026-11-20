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
// thrown error, no stack. A failed Test connection is information (CON-4), not a crash. Every
// outcome of an action is drawn the same way, as a `.status` line (./StatusLine); only a field's
// own validation message stays under the field as `.field__error`.
//
// Secrets are write-only (CON-2, NFR-9): the two password fields start empty, are never seeded, and
// each has its own Save — `setConsole` carries no credential at all.
//
// The stream quality defaults (QUAL-1) are no longer here either: since P5.7 they are the Cameras
// screen's Settings bar (features/cameras/StreamsSettings.tsx).
//
// The door links (DOOR-2) are no longer here: since P5.6 they live on the Doors screen
// (features/doors/), each door's cameras on the door's own card. The form's unsaved Access checkbox
// reveals the token and API-root fields, but nothing that would make an Access call (DOOR-0).
//
// Layout (P5.8): one left-aligned column of readable width, the controls straight on the screen
// with no card (user feedback 2026-11-19), scrolling with the app body like the other screens — the
// **Mode** cards first (MODE-2, ./ModePicker), the keystore warning (only without a keystore), then
// **Console** (address and credentials, then Certificate, then Connection), and the app version
// quietly at the foot. There is no section sidebar (the P5.3 cleanup's sidebar went in P5.8), and
// the screen is opened from the gear button at the header's end rather than a nav tab (App.tsx).
// Help text is one short line at most; what a requirement mandates (CON-2's keystore notice, CON-3's
// compare-the-fingerprint prompt, DOOR-0's "the token and links are kept") is kept, only shorter.
//
// **RTSP mode** (MODE-3): the Mode cards, the keystore warning (stream URLs are secrets too, CON-2),
// one line pointing to the Streams screen, and the version. Every UniFi setting — the whole Console
// group with its certificates and connection — is not drawn at all, so nothing here can make a
// Protect or Access call (MODE-4).
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { AccessProbe, IpcError, IpcSecretKey, ProtectProbe, Settings } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { CameraIcon, CheckIcon, PlugIcon, PulseIcon, TrashIcon } from '../../ui/icons'
import { CertificateCard } from './CertificateCard'
import { ModePicker } from './ModePicker'
import { StatusLine, type StatusKind } from '../../ui/StatusLine'
import {
  consoleDraftFrom,
  consoleInputFrom,
  consoleSignature,
  describeEndpointStatus,
  hasUnsavedConsoleInput,
  isConsoleDirty,
  type ConsoleDraft,
  type ConsoleFieldErrors,
} from './settingsForm'
import './settings.css'

export interface SettingsPageProps {
  /** Opens the Streams screen (RTSP mode's pointer line). */
  readonly onOpenStreams: () => void
}

export function SettingsPage({ onOpenStreams }: SettingsPageProps): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const keystoreAvailable = useAppStore((s) => s.keystoreAvailable)
  // MODE-2: whether the Console form holds input a switch to RTSP would discard (ConsoleCard reports
  // it), so the mode cards can ask about that first.
  const [consoleUnsaved, setConsoleUnsaved] = useState(false)

  // `settings` is null only until the first `getState()` lands, which the shell already waits for;
  // this is the type-level version of that guarantee rather than a state the user ever sees.
  if (settings === null) {
    return (
      <div className="settings settings--loading">
        <p className="app__muted">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="settings">
      <ModePicker
        mode={settings.mode}
        unsavedConsole={settings.mode === 'protect' && consoleUnsaved}
      />
      {keystoreAvailable ? null : <KeystoreWarning mode={settings.mode} />}
      {settings.mode === 'rtsp' ? (
        <StreamsPointer onOpenStreams={onOpenStreams} />
      ) : (
        <ConsoleCard
          settings={settings}
          keystoreAvailable={keystoreAvailable}
          onUnsavedChange={setConsoleUnsaved}
        >
          <CertificateSection accessEnabled={settings.console.accessEnabled} />
          <ConnectionCard accessEnabled={settings.console.accessEnabled} />
        </ConsoleCard>
      )}
      <AppVersion />
    </div>
  )
}

/** MODE-3: in RTSP mode the cameras are set up on the Streams screen, not here. */
function StreamsPointer({ onOpenStreams }: SettingsPageProps): JSX.Element {
  return (
    <div className="row settings__streams">
      <p className="settings__streamsText">
        Add and edit your cameras&rsquo; RTSP addresses on the Streams screen.
      </p>
      <button type="button" className="button" onClick={onOpenStreams}>
        <CameraIcon />
        Open Streams
      </button>
    </div>
  )
}

/** The app version, quiet, at the foot of the column; nothing until the first state lands. */
function AppVersion(): JSX.Element | null {
  const version = useAppStore((s) => s.version)
  return version === '' ? null : <p className="settings__version">OverWatch v{version}</p>
}

/**
 * CON-2 has no plaintext fallback, so when `safeStorage` has no keystore the honest thing is to say
 * that a key cannot be kept at all — not to fail silently on Save and look like a bug. RTSP mode
 * keeps the warning (MODE-3) because stream addresses are secrets too (RTSP-2), worded for them.
 */
function KeystoreWarning({ mode }: { mode: Settings['mode'] }): JSX.Element {
  return (
    <section
      className="card settings__keystore"
      aria-labelledby="settings-keystore-title"
      role="alert"
    >
      <h2 className="card__title settings__groupTitle" id="settings-keystore-title">
        Secure storage is not available
      </h2>
      <p className="settings__mismatchText">
        {mode === 'rtsp' ? (
          <>
            Stream addresses can&rsquo;t be saved without Keychain or DPAPI; they are never stored
            as plain text.
          </>
        ) : (
          <>
            Keys and tokens can&rsquo;t be saved without Keychain or DPAPI, so you&rsquo;ll be asked
            for them each time the app opens; they are never stored as plain text.
          </>
        )}
      </p>
    </section>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-1 / CON-2 / DOOR-0: the console address, the credentials and the Access switch

function ConsoleCard({
  settings,
  keystoreAvailable,
  onUnsavedChange,
  children,
}: {
  settings: Settings
  keystoreAvailable: boolean
  /** Told whether the form holds input a mode switch would discard (MODE-2). */
  onUnsavedChange: (unsaved: boolean) => void
  /** The Certificate and Connection subsections, after the address and credentials. */
  children: ReactNode
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
  const unsaved = hasUnsavedConsoleInput(draft, settings)
  useEffect(() => {
    onUnsavedChange(unsaved)
  }, [unsaved, onUnsavedChange])
  // Unmounted (a switch to RTSP went ahead): nothing is left unsaved.
  useEffect(
    () => () => {
      onUnsavedChange(false)
    },
    [onUnsavedChange],
  )

  return (
    <section aria-labelledby="settings-console-title">
      <h2 className="card__title settings__groupTitle" id="settings-console-title">
        UniFi Console
      </h2>
      <h3 className="settings__subhead">Address and credentials</h3>
      <p className="card__hint">
        Saving only stores these details; press Connect below to connect.
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
          The IP address or host name, without https://. Add a port only if it isn&rsquo;t 443.
        </p>
        {errors.host === undefined ? null : <p className="field__error">{errors.host}</p>}
      </div>

      <SecretField
        secretKey="protectApiKey"
        label="Protect Integration API key"
        hint="Create one in Protect → Integrations. It is never shown again once saved."
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
          While this is off the app never contacts Access; a saved token and door links are kept.
        </p>
      </div>

      {draft.accessEnabled ? (
        <>
          <SecretField
            secretKey="accessToken"
            label="Access API token"
            hint="Create one in Access → Settings → General → Advanced → API Token. It is never shown again once saved."
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
              Leave empty to use port 12445 on the console; set it only for a proxy or a test
              server.
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
          <CheckIcon />
          {saving ? 'Saving…' : 'Save console'}
        </button>
        {dirty ? <StatusLine kind="muted">Unsaved changes</StatusLine> : null}
      </div>
      {saveError === null ? null : (
        <StatusLine kind="error" className="settings__outcome">
          {saveError.message}
        </StatusLine>
      )}

      {children}
    </section>
  )
}

/**
 * One write-only credential (CON-2). The field is always empty on arrival: the renderer can store a
 * secret and can clear it, but there is no channel that reads one back — the "Saved" check chip
 * beside the label is the whole of what it may know (`AppState.secretsStored`).
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
      <div className="row settings__labelRow">
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
        {stored ? (
          <span className="settings__chip settings__chip--ok">
            <CheckIcon />
            Saved
          </span>
        ) : null}
      </div>
      <div className="row">
        <input
          id={inputId}
          className="field__input settings__grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={stored ? 'Enter a new one to replace it' : ''}
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
          <CheckIcon />
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
            <TrashIcon />
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        ) : null}
      </div>
      <p className="field__hint">{hint}</p>
      {error === undefined ? null : <p className="field__error">{error}</p>}
      {callError === null ? null : <StatusLine kind="error">{callError.message}</StatusLine>}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-3: one card per endpoint, and Access only while it is switched on (DOOR-0)

function CertificateSection({ accessEnabled }: { accessEnabled: boolean }): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  if (connection === null) return null

  return (
    <div className="settings__subsection">
      <h3 className="settings__subhead">Certificate</h3>
      <CertificateCard endpoint="protect" label="Protect" status={connection.protect} />
      {accessEnabled ? (
        <CertificateCard endpoint="access" label="Access" status={connection.access} />
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-4 / CON-5: Test connection, Connect, and the per-endpoint facts. There is no Disconnect: the
// user removed it on 2026-11-17, because it closed only the Protect live-update feeds while video
// kept playing through go2rtc, and Access holds no connection at all.

function ConnectionCard({ accessEnabled }: { accessEnabled: boolean }): JSX.Element | null {
  const connection = useAppStore((s) => s.connection)
  const testConnection = useAppStore((s) => s.testConnection)
  const connect = useAppStore((s) => s.connect)

  const [busy, setBusy] = useState<'test' | 'connect' | null>(null)
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

  const runConnect = async (): Promise<void> => {
    setBusy('connect')
    setConnectError(null)
    const result = await connect()
    setBusy(null)
    if (!result.ok) setConnectError(result.error)
  }

  return (
    <div className="settings__subsection">
      <h3 className="settings__subhead">Connection</h3>
      <p className="card__hint">
        Once a connection works, the app connects by itself each time it opens, until you change the
        address or replace the key.
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
          <PulseIcon />
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy !== null}
          onClick={() => {
            void runConnect()
          }}
        >
          <PlugIcon />
          {busy === 'connect' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {connectError === null ? null : (
        <StatusLine kind="error" className="settings__outcome">
          {connectError.message}
        </StatusLine>
      )}
      {testError === null ? null : (
        <StatusLine kind="error" className="settings__outcome">
          {testError.message}
        </StatusLine>
      )}

      {probes === null ? null : (
        <dl className="settings__facts settings__probes">
          <dt className="field__label">Protect</dt>
          <dd>
            <StatusLine kind={probes.protect.state === 'ok' ? 'ok' : 'error'}>
              {probes.protect.state === 'ok'
                ? `Reachable. Protect version ${probes.protect.applicationVersion}.`
                : probes.protect.error.message}
            </StatusLine>
          </dd>
          <dt className="field__label">Access</dt>
          <dd>
            <StatusLine kind={accessProbeKind(probes.access)}>
              {describeAccessProbe(probes.access)}
            </StatusLine>
          </dd>
        </dl>
      )}
    </div>
  )
}

function accessProbeKind(probe: AccessProbe): StatusKind {
  if (probe.state === 'ok') return 'ok'
  return probe.state === 'error' ? 'error' : 'muted'
}

function describeAccessProbe(probe: AccessProbe): string {
  if (probe.state === 'disabled') return 'Access is off, so it was not contacted.'
  if (probe.state === 'error') return probe.error.message
  const count = String(probe.doorCount)
  return probe.doorCount === 1 ? 'Reachable. 1 door.' : `Reachable. ${count} doors.`
}
