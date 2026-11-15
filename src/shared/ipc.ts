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
  CameraEventSchema,
  CameraSchema,
  CameraStateChangeSchema,
  SettingsSchema,
  ViewSchema,
  type Camera,
  type CameraEvent,
  type CameraStateChange,
} from './models'
import { QualitySchema, StreamQualitySchema } from './quality'
import {
  StreamHandleSchema,
  StreamRuntimeSchema,
  type StreamHandle,
  type StreamRuntime,
} from './streams'

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
  /**
   * The local go2rtc gateway is not up: it crashed, is restarting, or never came up (P2.1). Added
   * in P2.2 for `ensureStream`, and distinct from the kinds around it on purpose — the cell has to
   * show "video unavailable, retrying" rather than CAM-3's *camera* offline placeholder or a
   * Settings problem, because nothing the user can do in Settings fixes it and the camera itself is
   * fine. Always `retryable`: main restarts go2rtc and announces the new runtime
   * (`IPC_EVENTS.streamRuntime`).
   */
  'gateway-down',
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

/**
 * QUAL-7, second half: which RTSPS qualities a camera already has on the console, for the camera
 * list. **Booleans only** (rule 1): main reads `GET /v1/cameras/{id}/rtsps-stream`, whose values are
 * the RTSPS URLs themselves — and the 16-character alias in each one *is* the credential for that
 * camera's stream — so the URLs stay in main and only "is there one" crosses.
 *
 * A `z.record` over the `StreamQuality` enum, which zod treats as exhaustive: every key must be
 * present, so a reply cannot leave the renderer guessing whether a missing key means "absent" or
 * "not reported", and a quality added to `STREAM_QUALITIES` is a contract change rather than a key
 * nobody reads. `package` is `false` on every camera without a package channel (CAM-4).
 */
export const RtspsAvailabilitySchema = z.record(StreamQualitySchema, z.boolean())
export type RtspsAvailability = z.infer<typeof RtspsAvailabilitySchema>

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

/** QUAL-7: one camera's existing RTSPS qualities. A read: main GETs and never POSTs for it. */
export const CameraIdInputSchema = z.object({ cameraId: z.string().min(1) })
export type CameraIdInput = z.infer<typeof CameraIdInputSchema>

/**
 * One camera at one quality, for `ensureStream` (QUAL-8). `quality` is a `StreamQuality` so a
 * doorbell's package channel is addressable (CAM-4); the quality picker can still only produce a
 * `Quality`, because that is what the persisted model holds (src/shared/quality.ts).
 *
 * The renderer sends the **effective** quality it resolved with `resolveGridQuality` /
 * `resolveFillQuality`, never a constant (ARCHITECTURE §3). `cameraId` is the plain Protect id: the
 * package channel is the `quality` here, not a `<cameraId>:package` suffix, so main does not have to
 * re-split a composite id before building `<cameraId>_<quality>`.
 */
export const EnsureStreamInputSchema = z.object({
  cameraId: z.string().min(1),
  quality: StreamQualitySchema,
})
export type EnsureStreamInput = z.infer<typeof EnsureStreamInputSchema>

/**
 * VIEW-3/6: the whole View list plus the active View, as the renderer's View store computed them.
 *
 * The whole list rather than one View per call, because the operations the user performs on Views
 * — reorder, delete, duplicate — are list operations, and sending the list makes every save the
 * same atomic "this is the new truth" write that `config.json` gets anyway. A wall is at most a few
 * dozen small objects, so the cost is nothing next to the file write.
 *
 * Every View goes through `ViewSchema`, so the tiling rule (SPEC §6) is enforced here at the
 * boundary and not only on the next load — where a violation would cost every View (VIEW-6). On top
 * of the schema, two rules that only make sense for the list as a whole:
 *  - **ids are unique**: the switcher, `lastViewId` and the React keys all address a View by id;
 *  - **`lastViewId` names one of `views`** (or is `null`). The persisted file tolerates a dangling id
 *    (SettingsSchema), but the renderer computes both halves of this payload together, so a mismatch
 *    here is a bug on its side, not a state to persist.
 */
export const SetViewsInputSchema = z
  .object({
    views: z.array(ViewSchema),
    lastViewId: z.string().min(1).nullable(),
  })
  .check((ctx) => {
    const { views, lastViewId } = ctx.value
    const seen = new Map<string, number>()
    views.forEach((view, index) => {
      const first = seen.get(view.id)
      if (first === undefined) {
        seen.set(view.id, index)
        return
      }
      ctx.issues.push({
        code: 'custom',
        input: view.id,
        path: ['views', index, 'id'],
        message: `duplicate View id (views[${String(first)}] has the same id)`,
      })
    })
    if (lastViewId !== null && !seen.has(lastViewId)) {
      ctx.issues.push({
        code: 'custom',
        input: lastViewId,
        path: ['lastViewId'],
        message: 'must be the id of one of the Views sent, or null',
      })
    }
  })
export type SetViewsInput = z.infer<typeof SetViewsInputSchema>

/**
 * VIEW-4/6: switch the active View. Its own channel so that switching — the thing the user does
 * most, from the keyboard — sends one id instead of every View. `null` means "no View", which is
 * only meaningful while there are none.
 */
export const SetLastViewInputSchema = z.object({ viewId: z.string().min(1).nullable() })
export type SetLastViewInput = z.infer<typeof SetLastViewInputSchema>

/**
 * QUAL-1: the two app-wide quality defaults, as a pair. The same shape as `StreamsConfig`
 * (./models) — main stores the parsed input *as* the `streams` block, so a field added to one and
 * not the other is a type error there — so the request can hold nothing
 * `config.json` could not, and both values are a `Quality`, never the package channel
 * (src/shared/quality.ts). Both together rather than one per call, because the Settings card shows
 * both and the pair is one small object: the card sends the one it changed and the other as shown.
 *
 * Written out rather than reused from `StreamsConfigSchema`, because that one **defaults** a missing
 * field (`low`/`high`, for an older config file). Here a missing field is a bug on the renderer's
 * side, and defaulting it would silently reset the user's other choice.
 */
export const SetStreamsInputSchema = z.object({
  defaultGridQuality: QualitySchema,
  defaultFillQuality: QualitySchema,
})
export type SetStreamsInput = z.infer<typeof SetStreamsInputSchema>

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
  /**
   * QUAL-8: make a camera/quality pair playable and answer with its loopback handle. Main GETs the
   * camera's RTSPS streams, POSTs only the missing quality, registers `<cameraId>_<quality>` in
   * go2rtc and returns a {@link StreamHandle} — never the RTSPS URL (rule 1).
   *
   * Called the first time a cell needs a pair, and again after a `streamRuntime` event, because the
   * port in a handle from the previous go2rtc epoch is dead. Idempotent and cheap to repeat: an
   * already-registered stream costs nothing while no consumer is attached (ARCHITECTURE §2 rule 3),
   * which is also why there is no release call — see the Phase 2 note under IPC_EVENTS.
   */
  ensureStream: call('vp:streams/ensure', EnsureStreamInputSchema, StreamHandleSchema),
  /**
   * VIEW-3/6: replace the View list and the active View, and persist both to `config.json`. Every
   * View editor and list action ends here (P3.1); the renderer folds the answer back rather than
   * keeping its own copy (rule 3).
   */
  setViews: call('vp:views/set', SetViewsInputSchema, AppStateSchema),
  /** VIEW-4/6: make a View the active one and remember it across restarts. Must name a stored View. */
  setLastView: call('vp:views/active', SetLastViewInputSchema, AppStateSchema),
  /** QUAL-1: persist the app-wide grid and fill quality defaults. */
  setStreams: call('vp:streams/defaults', SetStreamsInputSchema, AppStateSchema),
  /**
   * QUAL-7: which RTSPS qualities exist on the console for one camera, as booleans — never the
   * URLs (rule 1). A plain `GET rtsps-stream` through the shared rate limiter; it creates nothing
   * (QUAL-8's POST belongs to `ensureStream` alone). The camera list asks with its thumbnails: on
   * demand, a few at a time, again on Refresh, never on a timer.
   */
  cameraStreamQualities: call('vp:cameras/rtsps', CameraIdInputSchema, RtspsAvailabilitySchema),
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
  /**
   * CELL-2 (P4.2): one push per mapped message on the events feed — `motion`, the `smartDetect*`
   * types and `ring` (SPEC §5.1), as a {@link CameraEvent}. The opening `add` arrives with `end:
   * null` and the closing `update` with `end` set.
   *
   * **Repeats are passed through on purpose.** The console sends the closing update two or three
   * times (P0.3 §5); the renderer's scheduler is idempotent on `(id, end)`, which is where the
   * dedupe belongs, so main forwards what it saw rather than guessing which copy is the real one.
   *
   * No secrets (rule 1): event and camera ids, the Protect type names and console timestamps only.
   * The events feed does not drive the `connection` status; that is the devices feed's job.
   */
  cameraEvent: { channel: 'vp:event/cameraEvent', payload: CameraEventSchema },
  /**
   * P2.1/P2.2: the go2rtc gateway came up on a (new) port, or went down. Every attached player
   * re-asks `ensureStream` on an `up` with an epoch it does not hold, and shows its placeholder on
   * a `down` — see {@link StreamRuntime} for why this is a union and not a nullable port.
   *
   * Pushed rather than polled because a crash-and-restart is invisible from the renderer otherwise:
   * a closed WebSocket looks the same as a network blip, and gate G2 asks for recovery without the
   * user doing anything.
   */
  streamRuntime: { channel: 'vp:event/streamRuntime', payload: StreamRuntimeSchema },
} as const

// What Phase 2 deliberately does **not** add to this contract:
//  - **No `releaseStream`.** go2rtc opens the upstream RTSPS session only while a consumer is
//    attached and drops it when the last one leaves (ARCHITECTURE §2 rule 3, SPEC §5.3), so closing
//    the player's WebSocket *is* the release. A release call would be a second, contradictory
//    lifecycle for the renderer to get wrong, and the app never deletes Protect streams anyway
//    (QUAL-8: they may be shared with other integrations).
//  - **No stream list, no `/api/streams` passthrough and no go2rtc config.** Those carry source
//    URLs, i.e. RTSPS URLs (rule 1). Codec detection (SPEC R7) reads `/api/streams` in *main* and,
//    if the player ever needs it, will arrive as a field on the handle — not as a new channel.
//  - **No port-only "where is go2rtc" call.** A port without a registered stream name is useless,
//    and a renderer that can ask for the port alone can try to attach to streams it never
//    requested. `ensureStream` plus the `streamRuntime` event cover everything the player needs.
//  - **`AppState` is unchanged.** The go2rtc runtime is not persisted config and changes on its own
//    schedule, so folding it into the state every mutation returns (rule 3) would make an unrelated
//    `setConsole` reply the carrier of gateway news.

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
  /** QUAL-8: on demand, per camera/quality pair, and again after a `streamRuntime` event. */
  ensureStream(input: EnsureStreamInput): Promise<IpcResult<StreamHandle>>
  /** VIEW-3/6: the whole View list and the active View, persisted. */
  setViews(input: SetViewsInput): Promise<IpcResult<AppState>>
  /** VIEW-4/6: switch the active View. */
  setLastView(input: SetLastViewInput): Promise<IpcResult<AppState>>
  /** QUAL-1: the app-wide grid and fill quality defaults, persisted. */
  setStreams(input: SetStreamsInput): Promise<IpcResult<AppState>>
  /** QUAL-7: which RTSPS qualities exist for a camera. Booleans only. */
  cameraStreamQualities(input: CameraIdInput): Promise<IpcResult<RtspsAvailability>>

  onConnection(listener: (status: ConnectionStatus) => void): Unsubscribe
  onCameras(listener: (cameras: Camera[]) => void): Unsubscribe
  onCameraState(listener: (change: CameraStateChange) => void): Unsubscribe
  /** CELL-2: motion, smart-detect and ring events, repeats included (see `IPC_EVENTS.cameraEvent`). */
  onCameraEvent(listener: (event: CameraEvent) => void): Unsubscribe
  onStreamRuntime(listener: (runtime: StreamRuntime) => void): Unsubscribe
}

// Imported for the signatures above; re-exported so the renderer can take the whole contract plus
// the domain types it carries from one module.
export type { Camera, CameraEvent, CameraStateChange, Cell, Settings, View } from './models'
export type { StreamHandle, StreamRuntime } from './streams'
export type { Quality, StreamQuality } from './quality'
