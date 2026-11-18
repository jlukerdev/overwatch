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
// The Streams card (QUAL-1, P3.7) is the exception to "nothing saves as you type": a select has no
// half-typed state, so each one saves on change and shows its own failure. The card runs one save
// at a time (both selects are disabled while it is in flight) and builds each payload from the
// store's defaults at the moment of the change, so a quick Grid-then-Fill change cannot have the
// second save write back the Grid value the first one replaced.
//
// The Door links card (DOOR-1/2, P5.3, in ./DoorLinksCard) follows the same save-on-change rule and
// is mounted only while the **saved** Access switch is on (DOOR-0): the form's unsaved checkbox
// reveals the token and API-root fields, but nothing that would make an Access call.
//
// Layout (user request 2026-11-17): a section sidebar on the left and the groups in their own
// scroll container on the right — the keystore warning (only without a keystore), **Console**
// (address and credentials, then Certificate, then Connection), **Streams**, and **Door links**
// last. The sidebar highlights the group in view (measured against the scroll container, decided
// by ./settingsSections.ts) and scrolls to a group on click; its rows are the shared `.sideItem`,
// and the app version sits quietly at its foot. Help text is one short line at
// most; what a requirement mandates (CON-2's keystore notice, CON-3's compare-the-fingerprint prompt,
// DOOR-0's "the token and links are kept") is kept, only shorter.
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { GroupTitle } from './GroupTitle'
import type { AccessProbe, IpcError, IpcSecretKey, ProtectProbe, Settings } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { CheckIcon, PlugIcon, PulseIcon, TrashIcon } from '../../ui/icons'
import { CertificateCard } from './CertificateCard'
import { DoorLinksCard } from './DoorLinksCard'
import { StatusLine, type StatusKind } from '../../ui/StatusLine'
import { doorListKey } from './doorLinks'
import { QualityOptions } from '../quality/QualityOptions'
import {
  activeSection,
  CONSOLE_SECTION,
  KEYSTORE_SECTION,
  sectionTitleId,
  settingsSections,
  STREAMS_SECTION,
  type SettingsSection,
} from './settingsSections'
import {
  streamsInputFrom,
  consoleDraftFrom,
  consoleInputFrom,
  consoleSignature,
  describeEndpointStatus,
  isConsoleDirty,
  type ConsoleDraft,
  type ConsoleFieldErrors,
  type StreamsField,
} from './settingsForm'
import './settings.css'

export function SettingsPage(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const keystoreAvailable = useAppStore((s) => s.keystoreAvailable)
  const secretsStored = useAppStore((s) => s.secretsStored)

  // `settings` is null only until the first `getState()` lands, which the shell already waits for;
  // this is the type-level version of that guarantee rather than a state the user ever sees.
  if (settings === null) {
    return (
      <div className="settings settings--loading">
        <p className="app__muted">Loading settings…</p>
      </div>
    )
  }

  // What the door list depends on: the Door links card remounts on it (a new endpoint, pin or token
  // reloads the list), and the layout re-attaches its size watcher to the new card's element.
  const doorsKey = doorListKey(settings, secretsStored)

  return (
    <SettingsLayout
      sections={settingsSections({
        keystoreAvailable,
        accessEnabled: settings.console.accessEnabled,
      })}
      layoutKey={doorsKey}
    >
      {keystoreAvailable ? null : <KeystoreWarning />}
      <ConsoleCard settings={settings} keystoreAvailable={keystoreAvailable}>
        <CertificateSection accessEnabled={settings.console.accessEnabled} />
        <ConnectionCard accessEnabled={settings.console.accessEnabled} />
      </ConsoleCard>
      <StreamsCard streams={settings.streams} />
      {settings.console.accessEnabled ? (
        <DoorLinksCard key={doorsKey} links={settings.doorLinks} />
      ) : null}
    </SettingsLayout>
  )
}

// -------------------------------------------------------------------------------------------------
// The section sidebar and the scroll container

/** Smooth unless the user asked the OS for less motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** How long a sidebar click keeps its section current if `scrollend` never fires. */
const SCROLL_LOCK_FALLBACK_MS = 1000

/**
 * The sidebar plus the groups' own scroll container. The container — not `.app__body` — is what
 * scrolls (`.settings` fills the body exactly), so the sidebar stays put without `position:
 * sticky`.
 *
 * Which link is current is `activeSection`'s decision (./settingsSections.ts), fed from a
 * rAF-throttled measure of each group's top against the container: on scroll, on a window resize,
 * and when a group changes size (a ResizeObserver — the door list landing grows the page without a
 * scroll). A sidebar click locks its section as current until that programmatic scroll settles
 * (`scrollend`, with a timeout fallback), so a short last group cannot take the highlight mid-way.
 */
function SettingsLayout({
  sections,
  layoutKey,
  children,
}: {
  sections: readonly SettingsSection[]
  /** Changes whenever a group's element is replaced (the Door links card remounts on it). */
  layoutKey: string
  children: ReactNode
}): JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const lock = useRef<{ id: string; release: () => void } | null>(null)
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null)
  const version = useAppStore((s) => s.version)
  // The list's identity changes every render; its ids are what the callbacks depend on.
  const ids = sections.map((section) => section.id).join(' ')

  const measure = useCallback((): void => {
    frame.current = null
    const root = content.current
    if (root === null) return
    const rootTop = root.getBoundingClientRect().top
    const order = ids.split(' ').map((id) => ({ id }))
    const tops = new Map<string, number>()
    for (const { id } of order) {
      const element = document.getElementById(id)
      if (element !== null) tops.set(id, element.getBoundingClientRect().top - rootTop)
    }
    const metrics = {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    }
    setActive(activeSection(order, tops, metrics, lock.current?.id ?? null))
  }, [ids])

  const schedule = useCallback((): void => {
    frame.current ??= requestAnimationFrame(measure)
  }, [measure])

  useEffect(() => {
    const root = content.current
    if (root === null) return
    schedule()
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resizes = new ResizeObserver(schedule)
    for (const id of ids.split(' ')) {
      const element = document.getElementById(id)
      if (element !== null) resizes.observe(element)
    }
    return () => {
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resizes.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [ids, layoutKey, schedule])

  // A lock still pending at unmount must not fire into a gone component.
  useEffect(
    () => () => {
      lock.current?.release()
    },
    [],
  )

  const go = (section: SettingsSection): void => {
    const root = content.current
    const target = document.getElementById(section.id)
    if (root === null || target === null) return
    lock.current?.release()
    let timer = 0
    const release = (): void => {
      if (lock.current?.release !== release) return
      lock.current = null
      window.clearTimeout(timer)
      root.removeEventListener('scrollend', release)
      schedule()
    }
    lock.current = { id: section.id, release }
    root.addEventListener('scrollend', release)
    timer = window.setTimeout(release, SCROLL_LOCK_FALLBACK_MS)
    setActive(section.id)
    // The section, not its heading, so the card's top border and padding stay in view
    // (`scroll-margin-top` on the groups). The heading takes the focus (tabIndex -1), so the
    // keyboard continues from that group.
    target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
    document.getElementById(sectionTitleId(section))?.focus({ preventScroll: true })
  }

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="sideItem settings__navItem"
            aria-current={active === section.id ? 'true' : undefined}
            onClick={() => {
              go(section)
            }}
          >
            {section.label}
          </button>
        ))}
        {/* Empty until the first state lands; the header no longer carries it. */}
        {version === '' ? null : <p className="settings__version">View Protect v{version}</p>}
      </nav>
      <div className="settings__content" ref={content}>
        {children}
      </div>
    </div>
  )
}

/**
 * CON-2 has no plaintext fallback, so when `safeStorage` has no keystore the honest thing is to say
 * that a key cannot be kept at all — not to fail silently on Save and look like a bug.
 */
function KeystoreWarning(): JSX.Element {
  return (
    <section
      className="card settings__keystore"
      id={KEYSTORE_SECTION.id}
      aria-labelledby={sectionTitleId(KEYSTORE_SECTION)}
      role="alert"
    >
      <GroupTitle section={KEYSTORE_SECTION}>Secure storage is not available</GroupTitle>
      <p className="settings__mismatchText">
        Keys and tokens can&rsquo;t be saved without Keychain or DPAPI, so you&rsquo;ll be asked for
        them each time the app opens; they are never stored as plain text.
      </p>
    </section>
  )
}

// -------------------------------------------------------------------------------------------------
// CON-1 / CON-2 / DOOR-0: the console address, the credentials and the Access switch

function ConsoleCard({
  settings,
  keystoreAvailable,
  children,
}: {
  settings: Settings
  keystoreAvailable: boolean
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

  return (
    <section
      className="card"
      id={CONSOLE_SECTION.id}
      aria-labelledby={sectionTitleId(CONSOLE_SECTION)}
    >
      <GroupTitle section={CONSOLE_SECTION}>Console</GroupTitle>
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

// -------------------------------------------------------------------------------------------------
// QUAL-1: the app-wide grid and fill quality defaults

function StreamsCard({ streams }: { streams: Settings['streams'] }): JSX.Element {
  const setStreams = useAppStore((s) => s.setStreams)
  // One save at a time for the whole card (header): while one is in flight both selects are
  // disabled, so a second change cannot start from the defaults the first one is replacing.
  const [saving, setSaving] = useState(false)
  /** The last failed save, shown under the select that made it. */
  const [saveError, setSaveError] = useState<{ field: StreamsField; error: IpcError } | null>(null)

  const save = async (field: StreamsField, value: string): Promise<void> => {
    // The store's defaults as they are now, not the `streams` this render was given: an answer
    // that landed since is already in the store, and the other default must go out as stored.
    const stored = useAppStore.getState().settings?.streams ?? streams
    const input = streamsInputFrom(stored, field, value)
    if (input === null) return
    setSaving(true)
    setSaveError(null)
    const result = await setStreams(input)
    setSaving(false)
    if (!result.ok) setSaveError({ field, error: result.error })
  }

  const select = (field: StreamsField, label: string): JSX.Element => (
    <QualitySelect
      value={streams[field]}
      field={field}
      label={label}
      disabled={saving}
      error={saveError?.field === field ? saveError.error : null}
      onChange={(value) => {
        void save(field, value)
      }}
    />
  )

  return (
    <section
      className="card"
      id={STREAMS_SECTION.id}
      aria-labelledby={sectionTitleId(STREAMS_SECTION)}
    >
      <GroupTitle section={STREAMS_SECTION}>Streams</GroupTitle>
      <p className="card__hint">
        The default quality in the grid and when a camera fills the window. A View can set its own,
        and a cell its own grid quality.
      </p>
      <div className="settings__streamsGrid">
        {select('defaultGridQuality', 'Grid quality')}
        {select('defaultFillQuality', 'Fill quality')}
      </div>
    </section>
  )
}

/**
 * One QUAL-1 default. Controlled by the stored value, not by a draft: the select shows what main
 * holds, so a failed save snaps back to the stored quality and says why underneath. The saving
 * itself is the card's (`StreamsCard`), which serialises the two selects.
 */
function QualitySelect({
  value,
  field,
  label,
  disabled,
  error,
  onChange,
}: {
  value: Settings['streams'][StreamsField]
  field: StreamsField
  label: string
  disabled: boolean
  error: IpcError | null
  onChange: (value: string) => void
}): JSX.Element {
  const id = `streams-${field}`
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input settings__select"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      >
        <QualityOptions />
      </select>
      {error === null ? null : <StatusLine kind="error">{error.message}</StatusLine>}
    </div>
  )
}
