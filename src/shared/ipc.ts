// The typed IPC contract (P1.5): every channel the renderer may use, with a zod schema for the
// request and one for the reply. Both sides validate — main checks each request before acting on it
// (CLAUDE.md) and the preload checks each reply before it reaches React — so a shape mismatch shows
// up at the boundary with a channel name attached, not three components later.
//
// `src/shared` is imported by main, preload **and** the renderer bundle, so there are no Node and no
// Electron imports here: only zod and the domain schemas from ./models.
//
// Three rules shape this file:
//
//  1. **No secrets cross the bridge** (CON-2, NFR-9). The API key, the Access token and every RTSPS
//     URL stay in main. The renderer learns only *whether* a credential is stored
//     (`AppState.secretsStored`), never a character of it, and it can write one but never read one
//     back. Nothing here carries a stream URL either; P2.2 sends loopback go2rtc names instead.
//  2. **Failure is a value, not a throw.** Every call answers with {@link IpcResult}: `{ ok: true,
//     value }` or `{ ok: false, error }` with a trimmed {@link IpcError}. An Error thrown out of an
//     `ipcMain.handle` would reach the renderer as a string with main's stack glued to it, which is
//     both useless to the UI and the easiest way to leak a path or a query. The handlers convert; the
//     renderer branches.
//  3. **Mutations answer with the whole {@link AppState}.** Saving a host, storing a key or
//     accepting a certificate changes several things at once (the pin, what is resolvable, whether
//     Access is on), so returning the new truth is both shorter and safer than having the renderer
//     patch its own copy and drift from main.
import { z } from 'zod'
import {
  CameraSchema,
  CameraStateChangeSchema,
  SettingsSchema,
  type Camera,
  type CameraStateChange,
} from './models'

/** Global name the preload exposes the API under (`window.viewProtect`). */
export const BRIDGE_KEY = 'viewProtect'

// -------------------------------------------------------------------------------------------------
// Result envelope and errors

/**
 * What the renderer may be told about a failure. Deliberately narrow: a `kind` it can branch on and
 * a message written for a person, with no stack, no cause chain, no URL and no query string.
 *
 * `kind` mirrors `ProtectErrorKind` (src/main/protect/errors.ts) plus the cases that are the
 * bridge's own: a call that arrived before the services existed, a request that failed validation,
 * and a console that is not configured yet. It is a string union rather than an open string because
 * both ends of this one are ours — unlike Protect's `state` values (see the leniency rule in
 * ./models), nothing upstream can extend it.
 */
export const IPC_ERROR_KINDS = [
  /** The window asked before `startServices()` finished, or it failed outright. */
  'not-ready',
  /** The payload did not match this channel's request schema. A bug on the renderer side. */
  'invalid-request',
  /** No console host yet, or a host that cannot be parsed into an endpoint (CON-1). */
  'not-configured',
  /** Access is switched off, so the app makes no Access call at all (DOOR-0). */
  'disabled',
  /** The endpoint has no accepted certificate yet: run the CON-3 dialog. */
  'pin-required',
  /** The presented certificate does not match the pin. Blocked until the user re-pins (CON-3). */
  'pin-mismatch',
  /** Missing, wrong or expired credential (401/403). Settings' business to fix. */
  'auth',
  'rate-limit',
  'not-found',
  'bad-request',
  /** The console answered that the resource is unavailable — e.g. a snapshot of an offline camera. */
  'unavailable',
  'server',
  'timeout',
  'network',
  /** The console's answer did not match the contract. */
  'invalid-response',
  /** Anything else. The message is still safe to show; the detail went to main's log. */
  'internal',
] as const
export const IpcErrorKindSchema = z.enum(IPC_ERROR_KINDS)
export type IpcErrorKind = z.infer<typeof IpcErrorKindSchema>

export const IpcErrorSchema = z.object({
  kind: IpcErrorKindSchema,
  /** One sentence, safe to render as is. Never a secret, a path or a full URL. */
  message: z.string(),
  /** `host:port` the failure belongs to, when it belongs to one. */
  endpoint: z.string().nullable().default(null),
  /** True when trying the same call again could plausibly succeed (CON-5's retry affordance). */
  retryable: z.boolean().default(false),
})
export type IpcError = z.infer<typeof IpcErrorSchema>

export type IpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError }

const IpcFailureSchema = z.object({ ok: z.literal(false), error: IpcErrorSchema })

/** Wraps a call's value schema in the `{ ok }` envelope rule 2 describes. */
export function ipcResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), IpcFailureSchema])
}

/** `{ ok: true, value }`. */
export function ipcOk<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

/** `{ ok: false, error }`, with the two optional error fields defaulted. */
export function ipcFail(
  kind: IpcErrorKind,
  message: string,
  extra: { endpoint?: string | null; retryable?: boolean } = {},
): IpcResult<never> {
  return {
    ok: false,
    error: {
      kind,
      message,
      endpoint: extra.endpoint ?? null,
      retryable: extra.retryable ?? false,
    },
  }
}

// -------------------------------------------------------------------------------------------------
// Shared vocabulary

/** The two endpoints the app talks to. Pins, credentials and status all come in pairs of these. */
export const ENDPOINT_NAMES = ['protect', 'access'] as const
export const EndpointNameSchema = z.enum(ENDPOINT_NAMES)
export type EndpointName = z.infer<typeof EndpointNameSchema>

/**
 * Which credential a `setSecret`/`clearSecret` call means. The same two keys as
 * `SecretKey` in src/main/secrets/secrets.ts, repeated here because `src/shared` may not import from
 * `src/main`; `tests/unit/ipcContract.test.ts` holds the two lists together.
 */
export const SECRET_KEYS = ['protectApiKey', 'accessToken'] as const
export const SecretKeySchema = z.enum(SECRET_KEYS)
export type IpcSecretKey = z.infer<typeof SecretKeySchema>

/**
 * Which credentials exist in the keystore (CON-1) — booleans only, never the values (CON-2, NFR-9).
 * Settings uses it to show "stored" next to a field it leaves empty, so a saved key is visible
 * without ever being readable.
 */
export const SecretsStoredSchema = z.object({
  protectApiKey: z.boolean(),
  accessToken: z.boolean(),
})
export type SecretsStored = z.infer<typeof SecretsStoredSchema>

/**
 * CON-5's status, per endpoint. The phases are what the indicator shows:
 * - `disabled`: Access is off (DOOR-0). Never used for Protect.
 * - `unconfigured`: no host, no key, or an address that cannot be parsed (CON-1).
 * - `idle`: configured and pinned, but nothing has been asked of it yet. Nothing connects at
 *   startup on purpose (CON-4, and R9's budget).
 * - `connecting` / `connected` / `reconnecting`: the live device feed's state (CAM-2).
 * - `error`: the last attempt failed. `error` carries why.
 */
export const CONNECTION_PHASES = [
  'disabled',
  'unconfigured',
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'error',
] as const
export const ConnectionPhaseSchema = z.enum(CONNECTION_PHASES)
export type ConnectionPhase = z.infer<typeof ConnectionPhaseSchema>

export const EndpointStatusSchema = z.object({
  endpoint: EndpointNameSchema,
  phase: ConnectionPhaseSchema,
  /** `host:port` as resolved, or `null` while the address is unusable. */
  hostPort: z.string().nullable().default(null),
  /** CON-3: a certificate has been accepted for this endpoint. */
  pinned: z.boolean().default(false),
  /** CON-1/2: the key or token is in the keystore. Never the value itself. */
  credentialStored: z.boolean().default(false),
  /** Protect's `applicationVersion` from the last successful `GET /meta/info` (CON-4). */
  version: z.string().nullable().default(null),
  /** The last failure, while `phase` is `error` or a reconnect is in progress. */
  error: IpcErrorSchema.nullable().default(null),
  /** When this status last changed, ms since the epoch. */
  updatedAt: z.number(),
})
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>

export const ConnectionStatusSchema = z.object({
  protect: EndpointStatusSchema,
  access: EndpointStatusSchema,
})
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>

/**
 * Everything the renderer needs to draw itself, in one object (rule 3).
 *
 * `settings` is the persisted config **without** the `schemaVersion` envelope — a storage detail the
 * UI has no use for. It does include `console.certFingerprint` and `console.accessCertFingerprint`,
 * which are public values from a plain-text file, not secrets (SPEC §6).
 */
export const AppStateSchema = z.object({
  /** package.json version, same value as `window.viewProtect.version`. */
  version: z.string(),
  settings: SettingsSchema,
  /**
   * False when `safeStorage` has no backing keystore. CON-2 forbids a plaintext fallback, so
   * Settings has to say that a key cannot be saved and will be asked for again next launch.
   */
  keystoreAvailable: z.boolean(),
  secretsStored: SecretsStoredSchema,
  connection: ConnectionStatusSchema,
  /** The inventory as main last read it (CAM-1). Empty before the first successful connect. */
  cameras: z.array(CameraSchema),
})
export type AppState = z.infer<typeof AppStateSchema>

/**
 * The leaf certificate, trimmed for the CON-3 accept dialog. No DER, no public key, no extensions:
 * the fingerprint is what gets pinned and the rest is only there so the user can recognise the
 * console they are looking at.
 */
export const CertInfoSchema = z.object({
  hostPort: z.string(),
  /** Colon-separated uppercase SHA-256 of the DER leaf — what the user compares and accepts. */
  fingerprint256: z.string(),
  subjectCommonName: z.string().nullable(),
  issuerCommonName: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string(),
  selfSigned: z.boolean(),
})
export type CertInfo = z.infer<typeof CertInfoSchema>

/** The three CON-3 states, mirroring `PinCheckResult` in src/main/tls/pinning.ts. */
export const PinCheckSchema = z.discriminatedUnion('state', [
  /** Nothing pinned yet: show the fingerprint and offer "Trust this certificate". */
  z.object({ state: z.literal('no-pin'), cert: CertInfoSchema }),
  /**
   * Pinned and presented agree — that is what `match` means, so `fingerprint256` and
   * `cert.fingerprint256` are the same value here. Both are present because the other two arms need
   * them apart: `no-pin` has only a presented one, `mismatch` has two that differ.
   */
  z.object({ state: z.literal('match'), cert: CertInfoSchema, fingerprint256: z.string() }),
  /** Blocked. Only an explicit re-pin may replace the stored fingerprint. */
  z.object({
    state: z.literal('mismatch'),
    cert: CertInfoSchema,
    expected: z.string(),
    actual: z.string(),
    /** Ready to show: carries both fingerprints. */
    message: z.string(),
  }),
])
export type PinCheck = z.infer<typeof PinCheckSchema>

/** CON-4, Protect half: `GET /v1/meta/info`. */
export const ProtectProbeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), applicationVersion: z.string() }),
  z.object({ state: z.literal('error'), error: IpcErrorSchema }),
])
export type ProtectProbe = z.infer<typeof ProtectProbeSchema>

/** CON-4, Access half: `GET /doors`, or nothing at all while Access is off (DOOR-0). */
export const AccessProbeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), doorCount: z.int().min(0) }),
  z.object({ state: z.literal('error'), error: IpcErrorSchema }),
  z.object({ state: z.literal('disabled') }),
])
export type AccessProbe = z.infer<typeof AccessProbeSchema>

/**
 * The "Test connection" answer (CON-4). Each half reports separately — a working Protect key and a
 * wrong Access token is a normal, informative state — and `connection` carries the status both
 * probes just produced, so the indicator updates from the same reply.
 */
export const TestConnectionSchema = z.object({
  protect: ProtectProbeSchema,
  access: AccessProbeSchema,
  connection: ConnectionStatusSchema,
})
export type TestConnection = z.infer<typeof TestConnectionSchema>

/**
 * A camera thumbnail (CAM-1). Bytes, not a data URL: the renderer wraps them in a `Blob` and an
 * object URL, which keeps a 1.1 MB full-HD JPEG (SPEC §5.1) out of the string heap and lets the
 * thumbnail be revoked when the row unmounts.
 *
 * `unavailable` is CAM-3's rule applied: for an offline camera the contract says 503, but that path
 * is unverified (R11) and any failure counts, so main turns *any* snapshot failure for a camera that
 * is not `CONNECTED` into this, with `reason` as text for the placeholder. A failure that is not
 * about the camera — a bad key, an unpinned console — still comes back as an `IpcError`, because
 * those are Settings' business and must not be mistaken for an offline camera.
 */
export const SnapshotResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    /** `image/jpeg` in everything P0.3 saw. */
    mimeType: z.string(),
    /**
     * `z.custom` rather than `z.instanceof`: the latter infers `Uint8Array<ArrayBuffer>`, while the
     * bytes undici hands main are a plain `Uint8Array` (`ArrayBufferLike`), so every producer and
     * consumer would need a cast to say the same thing.
     */
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
      message: 'expected image bytes',
    }),
    capturedAt: z.number(),
  }),
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
])
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>

// -------------------------------------------------------------------------------------------------
// Requests

/**
 * The console fields the user may edit (CON-1, DOOR-0). **Not** the fingerprints: those are written
 * only by `acceptCertificate`/`repinCertificate` after the user has seen the certificate, so the
 * renderer cannot pin anything by saving a settings form.
 *
 * `host` is passed through as typed, trimmed but otherwise unparsed: `parseConsoleHost` in main owns
 * what a valid address is (CON-1, SPEC §6) and its error message is what Settings shows. An empty
 * string is allowed and means "not configured yet".
 */
/**
 * The scheme through `URL`, not `startsWith('https://')`: `URL` lower-cases it, so `HTTPS://host`
 * is the same address — and the Settings form checks it the same way. Checking the raw string here
 * instead would let the form accept an address the bridge then rejects as `invalid-request`.
 */
function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export const ConsoleInputSchema = z.object({
  host: z.string().trim(),
  accessEnabled: z.boolean(),
  /**
   * `null` derives `https://<host>:12445/api/v1/developer`; a value is the API root (SPEC §6).
   *
   * `https` is required rather than assumed. `z.url()` alone would accept `udm.local:12445`, which
   * `new URL()` reads as the scheme `udm.local:` and a path — and the Access token may only travel
   * over TLS (CON-2, R5), so a missing or wrong scheme is refused here instead of being upgraded.
   * `accessEndpoint()` in main refuses it too; this is the message the user reads.
   *
   * An emptied field is sent as `null`, not as `''`: `ConsoleConfigSchema` (src/shared/models.ts)
   * has no empty-string arm, so accepting one here would pass validation and then be unstorable.
   */
  accessBaseUrl: z
    .url()
    .refine((value) => httpsUrl(value), { message: 'must be an https:// URL' })
    .nullable(),
})
export type ConsoleInput = z.infer<typeof ConsoleInputSchema>

export const SecretInputSchema = z.object({
  key: SecretKeySchema,
  /** Trimmed, because a key pasted from a console UI often carries a newline. */
  value: z.string().trim().min(1),
})
export type SecretInput = z.infer<typeof SecretInputSchema>

export const SecretKeyInputSchema = z.object({ key: SecretKeySchema })
export type SecretKeyInput = z.infer<typeof SecretKeyInputSchema>

export const EndpointInputSchema = z.object({ endpoint: EndpointNameSchema })
export type EndpointInput = z.infer<typeof EndpointInputSchema>

/**
 * `fingerprint256` is the one the user was *shown*, not "whatever the console presents now": main
 * re-reads the leaf and refuses if it has changed in between. Without that, a certificate swapped
 * between the dialog opening and the click would be pinned sight unseen (CON-3).
 */
export const AcceptCertInputSchema = z.object({
  endpoint: EndpointNameSchema,
  fingerprint256: z.string().min(1),
})
export type AcceptCertInput = z.infer<typeof AcceptCertInputSchema>

export const SnapshotInputSchema = z.object({
  cameraId: z.string().min(1),
  /**
   * Only ever true for a camera whose `supportsFullHdSnapshot` is set: otherwise the console answers
   * `400 BAD_REQUEST` and sends no smaller image instead (SPEC §5.1). Main checks the flag too.
   */
  highQuality: z.boolean().default(false),
})
export type SnapshotInput = z.infer<typeof SnapshotInputSchema>

// -------------------------------------------------------------------------------------------------
// The channel table
//
// One entry per channel: the request schema main validates and the value schema the preload
// validates inside the `{ ok }` envelope. Channel strings are namespaced `vp:<area>/<verb>` so they
// cannot collide with Electron's own or with a dependency's.

export interface IpcCall<Req extends z.ZodType, Value extends z.ZodType> {
  readonly channel: string
  readonly request: Req
  /** The success payload. The wire shape is `ipcResultSchema(value)`. */
  readonly value: Value
}

function call<Req extends z.ZodType, Value extends z.ZodType>(
  channel: string,
  request: Req,
  value: Value,
): IpcCall<Req, Value> {
  return { channel, request, value }
}

/** No request payload. `parse(undefined)` succeeds, so a stray argument is still a bad request. */
const NoInput = z.void()

export const IPC = {
  /** Everything the renderer needs at mount (rule 3). Sends nothing to the console. */
  getState: call('vp:app/state', NoInput, AppStateSchema),
  /** CON-1/DOOR-0: save the console address and the Access switch. Does not connect. */
  setConsole: call('vp:console/set', ConsoleInputSchema, AppStateSchema),
  /** CON-1/2: store a credential in the OS keystore. Write-only — nothing reads one back. */
  setSecret: call('vp:secret/set', SecretInputSchema, AppStateSchema),
  clearSecret: call('vp:secret/clear', SecretKeyInputSchema, AppStateSchema),
  /** CON-3: read the leaf certificate and compare it with the pin. Opens a TLS socket, no request. */
  checkCertificate: call('vp:cert/check', EndpointInputSchema, PinCheckSchema),
  /** CON-3: pin the fingerprint the user accepted. Fails if the endpoint is already pinned. */
  acceptCertificate: call('vp:cert/accept', AcceptCertInputSchema, AppStateSchema),
  /** CON-3: replace an existing pin. Only ever from an explicit user action. */
  repinCertificate: call('vp:cert/repin', AcceptCertInputSchema, AppStateSchema),
  /** CON-4: `GET /meta/info` and, when Access is on, `GET /doors`. */
  testConnection: call('vp:connection/test', NoInput, TestConnectionSchema),
  /** Load the inventory and open the devices feed (CAM-1/2). Idempotent. */
  connect: call('vp:connection/start', NoInput, AppStateSchema),
  /** Close the devices feed and go back to `idle`. The app stays configured. */
  disconnect: call('vp:connection/stop', NoInput, AppStateSchema),
  /** CAM-1: re-read `GET /v1/cameras`. The authoritative inventory, per R11. */
  listCameras: call('vp:cameras/list', NoInput, z.array(CameraSchema)),
  /** CAM-1/3: one thumbnail. */
  snapshot: call('vp:cameras/snapshot', SnapshotInputSchema, SnapshotResultSchema),
} as const

/**
 * main → renderer pushes. These are plain `webContents.send` payloads, not results: an event only
 * ever reports something that happened, so there is no failure arm — a failed connect arrives as the
 * `error` field of a `connection` event.
 */
export const IPC_EVENTS = {
  /** CON-5: the status changed. Sent on every transition, including every reconnect. */
  connection: { channel: 'vp:event/connection', payload: ConnectionStatusSchema },
  /**
   * CAM-2: the inventory was re-read (after a connect, a reconnect, or an add/remove on the devices
   * feed). The whole list, because the feed's shapes are unverified and `GET /v1/cameras` is the
   * authority (R11) — a patch stream would make the renderer trust the feed.
   */
  cameras: { channel: 'vp:event/cameras', payload: z.array(CameraSchema) },
  /** CAM-2/3: one camera's `state` changed on the devices feed. The G1 10-second path. */
  cameraState: { channel: 'vp:event/cameraState', payload: CameraStateChangeSchema },
} as const

/** Every channel string, for the handler-coverage test and for a `removeHandler` sweep. */
export const IPC_CHANNELS: readonly string[] = Object.values(IPC).map((c) => c.channel)
export const IPC_EVENT_CHANNELS: readonly string[] = Object.values(IPC_EVENTS).map((e) => e.channel)

// -------------------------------------------------------------------------------------------------
// The API the preload exposes on `window.viewProtect`
//
// Every method answers with an `IpcResult`: the preload turns a rejected `invoke` (main threw, the
// channel is missing, the reply failed validation) into `{ ok: false }` too, so a component never
// has to both branch on `ok` and wrap the call in a try/catch.

/** Unsubscribes a listener. Call it from the effect's cleanup. */
export type Unsubscribe = () => void

export interface ViewProtectApi {
  readonly version: string

  getState(): Promise<IpcResult<AppState>>
  setConsole(input: ConsoleInput): Promise<IpcResult<AppState>>
  setSecret(input: SecretInput): Promise<IpcResult<AppState>>
  clearSecret(input: SecretKeyInput): Promise<IpcResult<AppState>>
  checkCertificate(input: EndpointInput): Promise<IpcResult<PinCheck>>
  acceptCertificate(input: AcceptCertInput): Promise<IpcResult<AppState>>
  repinCertificate(input: AcceptCertInput): Promise<IpcResult<AppState>>
  testConnection(): Promise<IpcResult<TestConnection>>
  connect(): Promise<IpcResult<AppState>>
  disconnect(): Promise<IpcResult<AppState>>
  listCameras(): Promise<IpcResult<Camera[]>>
  snapshot(input: SnapshotInput): Promise<IpcResult<SnapshotResult>>

  onConnection(listener: (status: ConnectionStatus) => void): Unsubscribe
  onCameras(listener: (cameras: Camera[]) => void): Unsubscribe
  onCameraState(listener: (change: CameraStateChange) => void): Unsubscribe
}

// Imported for the signatures above; re-exported so the renderer can take the whole contract plus
// the domain types it carries from one module.
export type { Camera, CameraStateChange, Settings } from './models'
