// App-facing subset of the Protect Integration API types (SPEC §5.1).
//
// Everything here is derived from ./generated (openapi-typescript over
// docs/reference/protect-openapi-v7.3.74.json, regenerated with `npm run gen:protect-types`).
// No response shape is copied by hand. The only hand-written parts are the contract-drift
// overrides observed against the real console in the P0.3 spike (docs/spikes/P0.3-protect-api.md
// §6 and §9 item 8); each is marked "DRIFT OVERRIDE" below.
import type { components, paths } from './generated'

type Schemas = components['schemas']

/** The `application/json` body of a 200 response for `method path`. */
type Json200<P extends keyof paths, M extends 'get' | 'post'> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer T } } }
}
  ? T
  : never

/** The `application/json` request body for `method path`. */
type JsonRequestBody<P extends keyof paths, M extends 'post'> = paths[P][M] extends {
  requestBody: { content: { 'application/json': infer T } }
}
  ? T
  : never

/** Flattens intersections so overridden types read as one object in editor tooltips. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

// --- meta ---------------------------------------------------------------------------------------

/** `GET /v1/meta/info` (CON-4 test connection). */
export type ProtectMetaInfo = Json200<'/v1/meta/info', 'get'>

// --- cameras ------------------------------------------------------------------------------------

/** A camera exactly as the contract describes it (`lcdMessage` required). Prefer `ProtectCamera`. */
type ContractCamera = Json200<'/v1/cameras', 'get'>[number]

/**
 * One item of `GET /v1/cameras` (also `GET /v1/cameras/{id}`).
 *
 * DRIFT OVERRIDE: the contract lists `lcdMessage` as required, but cameras without a display
 * omit it entirely (every camera in the P0.3 samples did). It is optional here.
 * See docs/spikes/P0.3-protect-api.md §6 (and §9 item 8).
 */
export type ProtectCamera = Simplify<
  Omit<ContractCamera, 'lcdMessage'> & { lcdMessage?: ContractCamera['lcdMessage'] }
>

/** `camera.state`: `CONNECTED | CONNECTING | DISCONNECTED`. */
export type CameraState = ProtectCamera['state']

/** `camera.featureFlags` (`hasMic`, `hasSpeaker`, `smartDetectTypes`, `supportFullHdSnapshot`, ...). */
export type CameraFeatureFlags = ProtectCamera['featureFlags']

/** Smart-detect object types (`person`, `vehicle`, `package`, `licensePlate`, `face`, `animal`). */
export type SmartDetectObjectType = CameraFeatureFlags['smartDetectTypes'][number]

// --- RTSPS streams (QUAL-8) ---------------------------------------------------------------------

/** Body of `POST /v1/cameras/{id}/rtsps-stream`: `{ qualities: RtspsQuality[] }` (min 1). */
export type RtspsStreamsRequest = JsonRequestBody<'/v1/cameras/{id}/rtsps-stream', 'post'>

/** A stream quality: `high | medium | low | package` (`package` only when `hasPackageCamera`). */
export type RtspsQuality = RtspsStreamsRequest['qualities'][number]

/** `GET /v1/cameras/{id}/rtsps-stream`: one RTSPS URL or `null` per quality. Secret: main only. */
export type RtspsStreams = Json200<'/v1/cameras/{id}/rtsps-stream', 'get'>

/** `POST /v1/cameras/{id}/rtsps-stream`: a URL for each requested quality only. Secret: main only. */
export type RtspsStreamsCreated = Json200<'/v1/cameras/{id}/rtsps-stream', 'post'>

// --- talkback (MVP) -----------------------------------------------------------------------------

/** `POST /v1/cameras/{id}/talkback-session`: `{ url, codec, samplingRate, bitsPerSample }`. */
export type TalkbackSession = Json200<'/v1/cameras/{id}/talkback-session', 'post'>

// --- errors -------------------------------------------------------------------------------------

/**
 * Non-2xx JSON body (`genericError`): `{ error, name, cause? }`.
 *
 * DRIFT OVERRIDE: 429 rate-limit bodies (`name: "TOO_MANY_REQUESTS_ERROR"`) also carry
 * `windowMs` and `limit`, which the contract does not declare. The same JSON is sent as the one
 * text frame of a rate-limited WebSocket upgrade before close code 4500.
 * See docs/spikes/P0.3-protect-api.md §6 (and §5, §7).
 */
export type ProtectErrorBody = Simplify<
  Schemas['genericError'] & {
    /** Rate-limit window in ms (429 only; observed: 1000). */
    windowMs?: number
    /** Requests allowed per window (429 only; observed: 10). */
    limit?: number
  }
>

// --- WebSocket: /v1/subscribe/events (CELL-2) ---------------------------------------------------

/**
 * One message of WS `/v1/subscribe/events`: `{ type: 'add' | 'update', item }`.
 * Per P0.3 §5: `add` omits `end` entirely, `update` carries the full event, and the final
 * `update` (with `end`) may be repeated, so consumers must be idempotent on `(id, end)`.
 */
export type ProtectEventMessage = Json200<'/v1/subscribe/events', 'get'>

/** The event item union (`ProtectEventMessage['item']`), discriminated by `type`. */
export type ProtectEvent = ProtectEventMessage['item']

/** Every `item.type` literal the contract defines. */
export type ProtectEventType = ProtectEvent['type']

/** The event types View Protect acts on (SPEC §5.1 "Event types relevant to View Protect"). */
export type CameraTriggerEventType = Extract<
  ProtectEventType,
  'motion' | 'smartDetectZone' | 'smartDetectLine' | 'smartDetectLoiterZone' | 'ring'
>

/** Events that can drive a cell auto-switch (CELL-2). `device` is the camera id. */
export type CameraTriggerEvent = Extract<ProtectEvent, { type: CameraTriggerEventType }>

// --- WebSocket: /v1/subscribe/devices (CAM-2/3) -------------------------------------------------

/** A device message exactly as the contract describes it. Prefer `DeviceMessage`. */
type ContractDeviceMessage = Json200<'/v1/subscribe/devices', 'get'>

/** Makes `lcdMessage` optional on a camera-shaped item member; every other member is unchanged. */
type RelaxCameraLcdMessage<I> = I extends { modelKey: 'camera'; lcdMessage: unknown }
  ? Simplify<Omit<I, 'lcdMessage'> & { lcdMessage?: I['lcdMessage'] }>
  : I

/** Applies `RelaxCameraLcdMessage` to the `item` of each message variant (distributes over `M`). */
type RelaxDeviceMessage<M> = M extends { item: infer I }
  ? Simplify<Omit<M, 'item'> & { item: RelaxCameraLcdMessage<I> }>
  : M

/**
 * One message of WS `/v1/subscribe/devices`: `{ type: 'add' | 'update' | 'remove', item }`, where
 * `item` is a single device or a bulk item (`id: string | string[]`).
 * Not yet observed on the real console (P0.3 §5: no messages, no initial snapshot), so this is
 * the contract shape apart from the override below; parse leniently (P1.3).
 *
 * DRIFT OVERRIDE: the same `lcdMessage` drift as `ProtectCamera`. Wherever the contract makes a
 * camera item's `lcdMessage` required (the single and bulk `add` variants), it is optional here,
 * so a single `add` camera item is exactly `ProtectCamera`. `update` camera items already have it
 * optional, and `remove` items and non-camera items are the contract types unchanged.
 * See docs/spikes/P0.3-protect-api.md §6 (and §9 item 8).
 */
export type DeviceMessage = RelaxDeviceMessage<ContractDeviceMessage>
