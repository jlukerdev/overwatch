// The main-process half of the IPC contract (P1.5): one handler per channel in `src/shared/ipc.ts`,
// assembled into a plain `Map` from channel to handler and only then bound to Electron.
//
// The split is deliberate. `createIpcRouter` is a pure function of its injected dependencies — no
// Electron, no window, no `app` — so every rule below is unit-testable by calling a handler with a
// payload, and `registerIpcHandlers` is the three-line adapter that hands the map to `ipcMain`.
//
// Four rules every handler keeps, in this order:
//
//  1. **Validate the request** with that channel's own schema (CLAUDE.md). The preload validates
//     too, but it is not a trust boundary main controls: a renderer that was compromised invokes
//     the channel directly.
//  2. **Answer `not-ready` before touching anything.** `startServices()` is allowed to fail — a
//     corrupt config or an unavailable keystore must still leave an app the user can look at — so
//     the handlers are registered unconditionally and say so, rather than being absent and turning
//     every call into a rejected `invoke` with no `kind` to branch on.
//  3. **Never throw** (rule 2 of the contract). The body is wrapped and converted by `toIpcError`,
//     so a failure arrives as a value with a safe message instead of main's stack.
//  4. **A mutation answers with the whole `AppState`** (rule 3 of the contract). Saving a host or
//     accepting a certificate changes the pin, what is resolvable and whether Access is on, so the
//     new truth is built in one place ({@link appState}) rather than patched by the renderer.
//
// **No secret crosses this file** (CON-2, NFR-9). `setSecret` writes one into the keystore and into
// main's in-memory credentials and answers with booleans; nothing reads a credential back out, and
// no message, log line or error carries one.
import {
  IPC,
  ipcFail,
  ipcOk,
  type AcceptCertInput,
  type AppState,
  type CertInfo,
  type EndpointName,
  type IpcSecretKey,
  type IpcResult,
  type PinCheck,
} from '@shared/ipc'
import { SettingsSchema, type ConsoleConfig, type Settings } from '@shared/models'
import type { z } from 'zod'
import type { Config } from '../config/schema'
import type { ConfigStore } from '../config/store'
import { accessEndpoint, protectEndpoint, type ConsoleEndpoint } from '../console/endpoints'
import type { ConnectionManager } from '../connection'
import type { Secrets, SecretsStore } from '../secrets/secrets'
import { StreamRegistryError, type StreamRegistry } from '../streams/registry'
import {
  fetchLeafCert,
  fingerprintsMatch,
  type LeafCertInfo,
  type PinCheckResult,
  type PinRegistry,
} from '../tls/pinning'
import { toIpcError } from './errors'

/** One channel's handler: a payload in, a contract result out. It never rejects (rule 3). */
export type IpcHandler = (payload: unknown) => Promise<IpcResult<unknown>>

/**
 * The slice of Electron's `ipcMain` this module uses. Declared structurally so nothing here imports
 * Electron at all, not even a type: `src/main/index.ts` passes the real `ipcMain`, which satisfies
 * this as is, and that call is where the two shapes are checked against each other.
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(channel: string): void
}

/**
 * The slice of main's `Services` the handlers use directly. Everything to do with connecting, the
 * camera inventory and persisting the console block goes through the {@link ConnectionManager}
 * instead, which is why `config` and the clients are absent here.
 */
export interface IpcHandlerServices {
  readonly secrets: Pick<SecretsStore, 'isEncryptionAvailable' | 'set' | 'clear'>
  /**
   * The decrypted credentials the clients read synchronously. `setSecret`/`clearSecret` update this
   * **in place** together with the keystore, so an edited key is used by the next request without
   * anything being rebuilt (CON-1).
   */
  readonly credentials: Secrets
  /**
   * Read per call: the manager replaces it when the console block is saved, and the View handlers
   * replace it when the View list is (VIEW-6). Writable for that reason.
   */
  current: Config
  /** Where the View handlers persist to. The same store the manager saves the console block with. */
  readonly config: Pick<ConfigStore, 'update'>
  readonly pins: Pick<PinRegistry, 'checkEndpoint' | 'pinnedFingerprint' | 'acceptPin' | 'repin'>
}

export interface IpcRouterDeps {
  /** `null` until `startServices()` has finished, or for ever if it failed (rule 2). */
  readonly getServices: () => IpcHandlerServices | null
  readonly getManager: () => ConnectionManager | null
  /**
   * The go2rtc stream registry (P2.2), in the same style as {@link IpcRouterDeps.getManager}:
   * `null` until `src/main/index.ts` has built the sidecar manager and the registry, or for ever
   * if `startServices()` failed. Only `ensureStream` reads it, so a missing registry answers
   * `not-ready` on that one channel instead of making every other call unavailable.
   */
  readonly getRegistry: () => StreamRegistry | null
  /**
   * `app.getVersion()`, injected rather than imported: reading it from Electron here would make
   * this module — and so every handler test — need an Electron runtime.
   */
  readonly appVersion: () => string
  /**
   * Reads an endpoint's leaf certificate **without** consulting the stored pin. Defaults to
   * `fetchLeafCert`; injected so the certificate handlers can be tested without a TLS socket.
   */
  readonly readLeaf?: typeof fetchLeafCert
  /**
   * Rewrites the settings the renderer is *shown*, in memory only. The P2.5 perf harness uses it to
   * run the grid at the quality under test (`withPerfGridQuality`) without writing anything: the
   * stored config, `services.current`, is never touched by this hook. Absent in normal runs.
   */
  readonly settingsView?: (settings: Settings) => Settings
  /**
   * A reason View writes (`setViews`, `setLastView`) are refused right now, or `null` to allow
   * them. The perf harness sets it while its in-memory perf View is shown: the renderer then sees
   * only `[perf]`, so any View mutation it sends would persist that list over the user's Views.
   * Refused before anything is written. Absent in normal runs.
   */
  readonly viewWritesBlocked?: () => string | null
  /**
   * The same for the QUAL-1 defaults (`setStreams`). During a perf run the renderer is shown the
   * run's grid quality as `defaultGridQuality` (`settingsView`), so a Settings save would send that
   * value back and persist the harness's quality as the user's own. Absent in normal runs.
   */
  readonly streamsWritesBlocked?: () => string | null
}

/** Everything a handler body may assume exists, having passed rule 2. */
interface Ready {
  readonly services: IpcHandlerServices
  readonly manager: ConnectionManager
}

const NOT_READY =
  'View Protect is still starting up, or its services failed to start. Look at the application ' +
  'log and try again.'

/** First zod issue as one line, for a message the UI can show. Quotes no value. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'validation failed'
  const path = issue.path.join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/**
 * Removes one credential from the in-memory set. Deleted, not blanked: `credentialStored` is "the
 * field is there", and an empty string would read as a stored credential that fails every request.
 * Written as a switch because the key is dynamic and a literal one keeps it exhaustive.
 */
function forget(credentials: Secrets, key: IpcSecretKey): void {
  switch (key) {
    case 'protectApiKey':
      delete credentials.protectApiKey
      break
    case 'accessToken':
      delete credentials.accessToken
      break
  }
}

/**
 * Stands in for the stored fingerprint in a `mismatch` the contract has no arm for: the pin in
 * `config.json` is not a fingerprint at all. `PinCheck` requires a string there, and this says what
 * happened in words rather than inventing a plausible-looking hex value.
 */
const UNUSABLE_STORED_PIN = '(the stored value is not a SHA-256 fingerprint)'

/**
 * Whether the stored pin can be compared at all. `pinnedFingerprint` **throws** for a stored value
 * that is not a fingerprint, so this is also the one way to tell that state apart from "nothing
 * pinned yet" without reading an error message.
 */
function storedPinIsUsable(pins: IpcHandlerServices['pins'], endpoint: ConsoleEndpoint): boolean {
  try {
    pins.pinnedFingerprint(endpoint.host, endpoint.port)
    return true
  } catch {
    return false
  }
}

/** The endpoint a channel's `EndpointName` means. Throws `ConsoleEndpointError` (CON-1). */
function endpointFor(which: EndpointName, services: IpcHandlerServices): ConsoleEndpoint {
  const consoleConfig = services.current.console
  return which === 'protect' ? protectEndpoint(consoleConfig) : accessEndpoint(consoleConfig)
}

/** `LeafCertInfo` trimmed to what the CON-3 dialog shows: no DER, no key, no extensions. */
function toCertInfo(cert: LeafCertInfo): CertInfo {
  return {
    hostPort: cert.hostPort,
    fingerprint256: cert.fingerprint256,
    subjectCommonName: cert.subjectCommonName,
    issuerCommonName: cert.issuerCommonName,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    selfSigned: cert.selfSigned,
  }
}

/** The registry's three states as the contract's three (the shapes differ only in `endpoint`). */
function toPinCheck(result: PinCheckResult): PinCheck {
  switch (result.state) {
    case 'no-pin':
      return { state: 'no-pin', cert: toCertInfo(result.cert) }
    case 'match':
      return {
        state: 'match',
        cert: toCertInfo(result.cert),
        fingerprint256: result.fingerprint256,
      }
    case 'mismatch':
      return {
        state: 'mismatch',
        cert: toCertInfo(result.cert),
        expected: result.expected,
        actual: result.actual,
        message: result.message,
      }
  }
}

/**
 * Everything the renderer needs to draw itself (contract rule 3), built from the live services so
 * that `settings` and the connection status can never disagree.
 *
 * `SettingsSchema.parse` is what drops the `schemaVersion` envelope: zod strips unknown keys, so the
 * storage detail cannot reach the UI and the reply is a copy rather than main's own object.
 */
function appState(
  ready: Ready,
  version: string,
  settingsView: (settings: Settings) => Settings = (settings) => settings,
): AppState {
  const { services, manager } = ready
  return {
    version,
    settings: settingsView(SettingsSchema.parse(services.current)),
    keystoreAvailable: services.secrets.isEncryptionAvailable(),
    // CON-2, NFR-9: whether a credential is stored, never a character of it.
    secretsStored: {
      protectApiKey: (services.credentials.protectApiKey ?? '') !== '',
      accessToken: (services.credentials.accessToken ?? '') !== '',
    },
    connection: manager.status(),
    cameras: manager.cachedCameras(),
  }
}

/**
 * Every channel's handler, keyed by channel string. Pure: the only way in is the injected
 * dependencies, so a test needs no Electron, no window and no console.
 */
export function createIpcRouter(deps: IpcRouterDeps): ReadonlyMap<string, IpcHandler> {
  const router = new Map<string, IpcHandler>()
  const readLeaf = deps.readLeaf ?? fetchLeafCert

  /** Rules 1–3 in one place, so no handler can forget one. */
  function on<Req, Value>(
    spec: {
      readonly channel: string
      readonly request: z.ZodType<Req>
      readonly value: z.ZodType<Value>
    },
    body: (input: Req, ready: Ready) => Promise<IpcResult<Value>>,
  ): void {
    router.set(spec.channel, async (payload) => {
      const request = spec.request.safeParse(payload)
      if (!request.success) {
        return ipcFail('invalid-request', `${spec.channel}: ${firstIssue(request.error)}`)
      }
      const services = deps.getServices()
      const manager = deps.getManager()
      if (services === null || manager === null) {
        // Retryable: the services may simply not be up yet.
        return ipcFail('not-ready', NOT_READY, { retryable: true })
      }
      try {
        return await body(request.data, { services, manager })
      } catch (err) {
        return { ok: false, error: toIpcError(err) }
      }
    })
  }

  /** `AppState` for the channels that answer with it (rule 4). */
  const state = (ready: Ready): IpcResult<AppState> =>
    ipcOk(appState(ready, deps.appVersion(), deps.settingsView))

  on(IPC.getState, (_input, ready) => Promise.resolve(state(ready)))

  on(IPC.setConsole, async (input, ready) => {
    // The fingerprints are **not** in `ConsoleInput`: only `acceptCertificate`/`repinCertificate`
    // may write one, so saving a Settings form can never pin anything (CON-3). They are carried
    // over from the stored block here, and the manager clears whichever one no longer applies.
    const next: ConsoleConfig = {
      ...ready.services.current.console,
      host: input.host,
      accessEnabled: input.accessEnabled,
      // `null` is both the contract's and config.json's "cleared", and means "derive
      // `https://<host>:12445/api/v1/developer`" (SPEC §6), so it passes straight through.
      accessBaseUrl: input.accessBaseUrl,
    }
    await ready.manager.applyConsoleChange(next)
    return state(ready)
  })

  on(IPC.setSecret, async (input, ready) => {
    const { secrets, credentials } = ready.services
    if (!secrets.isEncryptionAvailable()) {
      // CON-2 allows no plaintext fallback, so this is a real limitation to report, not a warning
      // to swallow: the key cannot be stored at all and will be asked for again next launch.
      return ipcFail(
        'internal',
        'The OS keystore (Keychain on macOS, DPAPI on Windows) is not available, so the ' +
          'credential cannot be stored. View Protect never writes a secret in plaintext (CON-2).',
      )
    }
    const replaced = credentials[input.key] !== input.value
    await secrets.set(input.key, input.value)
    // Into the live object the clients hold a reference to, so the next request uses it (CON-1).
    credentials[input.key] = input.value
    // CON-4: a new Protect key has to prove itself with a connect before a launch uses it unasked.
    if (input.key === 'protectApiKey' && replaced) await ready.manager.credentialReplaced()
    return state(ready)
  })

  on(IPC.clearSecret, async (input, ready) => {
    const { secrets, credentials } = ready.services
    // No keystore check: removing a stored secret has to work even when it cannot be written again.
    await secrets.clear(input.key)
    // Before the manager is told, so that what it emits already derives from the missing
    // credential — the clients read this object synchronously.
    forget(credentials, input.key)
    if (input.key === 'protectApiKey') {
      // The devices feed authenticates with the key that has just been deleted (CON-1/2). Access
      // has no subscription, so its token needs nothing beyond the delete above (DOOR-0).
      await ready.manager.credentialCleared()
    }
    return state(ready)
  })

  on(IPC.checkCertificate, async (input, ready) => {
    const endpoint = endpointFor(input.endpoint, ready.services)
    if (storedPinIsUsable(ready.services.pins, endpoint)) {
      const result = await ready.services.pins.checkEndpoint(endpoint.host, endpoint.port)
      return ipcOk(toPinCheck(result))
    }
    // `config.json` only requires a non-empty string for the two fingerprint fields, so a
    // hand-edited or truncated value is possible — and `checkEndpoint` throws on one rather than
    // reading it as "unpinned", because treating it as unpinned would silently trust the next
    // certificate (CON-3). Answering with the throw would be a dead end: the UI could not render
    // the re-pin control that the error text itself tells the user to use. So the leaf is read
    // directly and reported as a mismatch, which is the arm that offers a re-pin. `expected` says
    // in words what is stored, because there is no fingerprint to put there.
    const cert = await readLeaf(endpoint.host, endpoint.port)
    return ipcOk({
      state: 'mismatch',
      cert: toCertInfo(cert),
      expected: UNUSABLE_STORED_PIN,
      actual: cert.fingerprint256,
      message:
        `The certificate pin stored for ${endpoint.hostPort} is not a SHA-256 fingerprint, so it ` +
        'cannot be compared with anything. The endpoint is presenting ' +
        `${cert.fingerprint256}. Check that fingerprint on the console itself and re-pin it to ` +
        'replace the stored value (CON-3).',
    })
  })

  on(IPC.acceptCertificate, async (input, ready) => {
    const { endpoint, check, refusal } = await confirmPresented(input, ready)
    if (refusal !== null) return refusal
    if (check.state !== 'no-pin') {
      // An accept is the *first* pin. Letting it overwrite one would make a mismatch resolvable by
      // clicking the same button the dialog shows on first connect, which CON-3 forbids: replacing
      // a pin is `repinCertificate`, a separate, explicit action.
      return ipcFail(
        check.state === 'mismatch' ? 'pin-mismatch' : 'bad-request',
        check.state === 'mismatch'
          ? check.message
          : `${endpoint.hostPort} already has an accepted certificate. Use "re-pin" to replace it ` +
              '(CON-3).',
        { endpoint: endpoint.hostPort },
      )
    }
    ready.services.pins.acceptPin(endpoint.host, endpoint.port, input.fingerprint256)
    return state(ready)
  })

  on(IPC.repinCertificate, async (input, ready) => {
    const endpoint = endpointFor(input.endpoint, ready.services)
    // The leaf is read **directly**, not through `checkEndpoint`: that compares against the stored
    // pin and throws when the stored value is unusable, which is one of the two states a re-pin
    // exists to recover from (the other being an ordinary mismatch). `repin()` is written to work
    // whatever is stored for exactly this reason (pinning.ts), so this path must not need the
    // stored value to be readable either. The CON-3 re-read still happens — against what the user
    // accepted, which is the comparison that matters.
    const cert = await readLeaf(endpoint.host, endpoint.port)
    const refusal = staleFingerprintRefusal(endpoint, cert.fingerprint256, input.fingerprint256)
    if (refusal !== null) return refusal
    ready.services.pins.repin(endpoint.host, endpoint.port, input.fingerprint256)
    return state(ready)
  })

  on(IPC.testConnection, async (_input, ready) => ipcOk(await ready.manager.testConnection()))

  on(IPC.connect, async (_input, ready) => {
    await ready.manager.connect()
    return state(ready)
  })

  on(IPC.disconnect, async (_input, ready) => {
    await ready.manager.disconnect()
    return state(ready)
  })

  on(IPC.listCameras, async (_input, ready) => ipcOk(await ready.manager.cameras()))

  on(IPC.snapshot, async (input, ready) => ipcOk(await ready.manager.snapshot(input)))

  // QUAL-7: booleans only. The manager reduces the GET's URLs to "is there one" before anything
  // comes back here, so no RTSPS URL is ever in this file's hands (CON-2, NFR-9).
  on(IPC.cameraStreamQualities, async (input, ready) =>
    ipcOk(await ready.manager.streamQualities(input.cameraId)),
  )

  /** A write-block hook's refusal, or `null` when the write may go ahead. */
  const writeRefusal = (blocked: (() => string | null) | undefined): IpcResult<never> | null => {
    const reason = blocked?.() ?? null
    // 'bad-request': the request is well formed but not one main will act on in this state, and
    // retrying it unchanged will not help while the block lasts.
    return reason === null ? null : ipcFail('bad-request', reason)
  }
  const viewWriteRefusal = (): IpcResult<never> | null => writeRefusal(deps.viewWritesBlocked)

  on(IPC.setViews, async (input, ready) => {
    const refused = viewWriteRefusal()
    if (refused) return refused
    // `input` has already passed `ViewSchema` for every View (tiling included), unique ids and a
    // `lastViewId` that names one of them (SetViewsInputSchema).
    await saveFields(ready, { views: input.views, lastViewId: input.lastViewId })
    return state(ready)
  })

  on(IPC.setLastView, async (input, ready) => {
    const refused = viewWriteRefusal()
    if (refused) return refused
    const { viewId } = input
    if (viewId !== null && !ready.services.current.views.some((view) => view.id === viewId)) {
      // A switch to a View that is not stored is a stale id on the renderer's side (the View was
      // deleted in between). Refused rather than stored: a dangling `lastViewId` is tolerated on
      // load (VIEW-6), but there is no reason to *write* one.
      return ipcFail('not-found', 'That View no longer exists.')
    }
    await saveFields(ready, { lastViewId: viewId })
    return state(ready)
  })

  on(IPC.setStreams, async (input, ready) => {
    const refused = writeRefusal(deps.streamsWritesBlocked)
    if (refused) return refused
    // QUAL-1. Both fields are required `Quality` values (SetStreamsInputSchema), so this cannot
    // store the package channel or default a field the renderer forgot to send.
    await saveFields(ready, { streams: input })
    return state(ready)
  })

  // DOOR-1 (P5.3). The DOOR-0 check is the manager's, before the client is even resolved, so a
  // switched-off Access answers `disabled` with no request made. Every other failure arrives
  // already mapped (`not-configured`, `pin-required`, `auth`, …) — the same `IpcError` the manager
  // put in the Access status, endpoint included — so it is passed through rather than re-mapped.
  on(IPC.listDoors, (_input, ready) => ready.manager.doors())

  on(IPC.setDoorLinks, async (input, ready) => {
    // DOOR-2: local config only, so no Access call and no DOOR-0 refusal — the links are kept while
    // Access is off (DOOR-0) and a save is as valid then as at any other time. Nothing is checked
    // against the inventory or the door list on purpose: a link whose camera or door the app cannot
    // see right now is the user's to remove, never main's to prune. No perf-run block either: the
    // harness's `settingsView` does not touch `doorLinks`, so what the renderer sends back is the
    // user's own map, not a value the harness put on screen.
    await saveFields(ready, { doorLinks: input.links })
    return state(ready)
  })

  on(IPC.ensureStream, async (input) => {
    const registry = deps.getRegistry()
    if (registry === null) {
      // Rule 2 again, for the one dependency the other channels do not need: the sidecar and the
      // registry are built after `startServices()`, so a call that arrives before that (or after a
      // failed startup) says so rather than looking like a gateway that crashed.
      return ipcFail('not-ready', NOT_READY, { retryable: true })
    }
    try {
      // QUAL-8. The handle carries a stream name, a loopback port and an epoch — never the RTSPS
      // URL the registry read to build it (CON-2, NFR-9, SPEC §6.1).
      return ipcOk(await registry.ensureStream(input.cameraId, input.quality))
    } catch (err) {
      // The registry's own refusals already carry the contract's kind and its `retryable`: an
      // unknown camera is `not-found`, a package channel on a camera without one is `bad-request`,
      // and go2rtc not being up is `gateway-down`, retryable, because main keeps restarting it and
      // announces the new runtime on `IPC_EVENTS.streamRuntime`. Everything else — a 401 from the
      // console, a 429 on the GET, an unpinned certificate — is a Protect failure and goes through
      // `toIpcError` below, which keeps the kind the client decided on.
      if (err instanceof StreamRegistryError) {
        return ipcFail(err.kind, err.message, { retryable: err.retryable })
      }
      throw err
    }
  })

  return router
}

/**
 * VIEW-6, QUAL-1, DOOR-2: persists top-level settings fields (the View list, the active View, the
 * stream quality defaults, the door links), then makes them the live config.
 *
 * Both halves touch only the fields in `patch`. On disk, `config.update` applies them to the latest
 * stored config inside the store's write queue, so a console or pin write queued ahead of this one
 * is kept rather than overwritten with the console block as it was when this call started. In
 * memory, only those fields are taken from the result and merged onto `services.current` **as it
 * is after the write**: the whole result would be wrong, because the pin store puts an accepted pin
 * into `current` before its own write is queued, so `current` can be ahead of anything this write
 * returned.
 */
type SavedField = 'views' | 'lastViewId' | 'streams' | 'doorLinks'

async function saveFields(ready: Ready, patch: Partial<Pick<Config, SavedField>>): Promise<void> {
  const { services } = ready
  const saved = await services.config.update((latest) => ({ ...latest, ...patch }))
  services.current = {
    ...services.current,
    ...('views' in patch ? { views: saved.views } : {}),
    ...('lastViewId' in patch ? { lastViewId: saved.lastViewId } : {}),
    ...('streams' in patch ? { streams: saved.streams } : {}),
    ...('doorLinks' in patch ? { doorLinks: saved.doorLinks } : {}),
  }
}

/**
 * CON-3's re-read, shared by accept and re-pin: the leaf is fetched again and compared with the
 * fingerprint the **user was shown**. Without this, a certificate swapped between the dialog
 * opening and the click would be pinned sight unseen — the dialog would have shown one certificate
 * and the app would have trusted another.
 */
async function confirmPresented(
  input: AcceptCertInput,
  ready: Ready,
): Promise<{
  readonly endpoint: ConsoleEndpoint
  readonly check: PinCheckResult
  readonly refusal: IpcResult<never> | null
}> {
  const endpoint = endpointFor(input.endpoint, ready.services)
  const check = await ready.services.pins.checkEndpoint(endpoint.host, endpoint.port)
  return {
    endpoint,
    check,
    refusal: staleFingerprintRefusal(endpoint, check.cert.fingerprint256, input.fingerprint256),
  }
}

/**
 * The refusal when the certificate on the wire is no longer the one the user accepted, or `null`
 * when the two agree. Shared by accept and re-pin because both are a decision about a specific
 * certificate: whichever of them is clicked, what gets pinned must be what was on screen.
 */
function staleFingerprintRefusal(
  endpoint: ConsoleEndpoint,
  presented: string,
  accepted: string,
): IpcResult<never> | null {
  if (fingerprintsMatch(presented, accepted)) return null
  return ipcFail(
    'pin-mismatch',
    `${endpoint.hostPort} is now presenting a different certificate (${presented}) from the one ` +
      `that was accepted (${accepted}). Nothing was pinned. Check the console's own fingerprint ` +
      'before trusting the new one (CON-3).',
    { endpoint: endpoint.hostPort },
  )
}

/**
 * Binds the router to Electron and returns the undo. Every channel is removed on dispose, so a
 * reload or a shutdown cannot leave a handler bound to services that are gone.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  router: ReadonlyMap<string, IpcHandler>,
): () => void {
  for (const [channel, handler] of router) {
    // The `IpcMainInvokeEvent` is deliberately dropped: it carries `sender` and `ports`, and no
    // handler has any business with either.
    ipcMain.handle(channel, (_event: unknown, payload: unknown) => handler(payload))
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of router.keys()) ipcMain.removeHandler(channel)
  }
}
