// UniFi Access developer API types and zod schemas (SPEC §5.2, DOOR-1/3). P1.4's client uses these.
//
// OFFICIAL REFERENCE, PARTLY CHECKED ON A CONSOLE (OS-1). The shapes are Ubiquiti's, from the
// UniFi Access API documentation the console offers for download; the parts the app uses are
// extracted in docs/reference/access-endpoints-v4.2.16.md (full PDF next to it; § numbers below are
// the PDF's). `npm run spike:access` has been run against a real console (Access API reference
// v4.2.16 base): GET /doors, the GET /doors/{id} error (`CODE_NOT_EXISTS`, answered with HTTP 200),
// the 401 `CODE_UNAUTHORIZED`, GET lock_rule, GET emergency and the notifications WebSocket open
// were seen there (tests/fixtures/access/, `_source: "console"`). Unlock, the lock-rule PUT and the
// emergency PUT have not been. Correct this file, the mock (scripts/mock-access/) and the fixtures
// wherever a console differs.
//
// The leniencies below are deliberate and stay: the reference contradicts itself on `is_bind_hub`
// (String in the table, boolean in every sample) and on a missing position sensor (`null` in the
// text, `""` in the §7.7 sample, and a real console sends `"none"`), and it never says `msg` is
// always present.
//
// Node runs scripts that import this file directly (type stripping): erasable syntax only.
import { z } from 'zod'

/** Port and base path of the developer API on the console (§2.6: `https://<console>:12445`). */
export const ACCESS_DEFAULT_PORT = 12445
export const ACCESS_API_PATH = '/api/v1/developer'

/** `code` of every successful response (§2.8). */
export const ACCESS_SUCCESS_CODE = 'SUCCESS'

/**
 * The documented error `code` values (§2.4) a door call can plausibly answer with; the user,
 * policy, credential and webhook codes are in the PDF and not listed. The reference does NOT say
 * which HTTP status goes with which code, so a client must treat any `code` other than `SUCCESS`
 * as an error whatever the HTTP status (a real console answers `CODE_NOT_EXISTS` with HTTP 200).
 * `client.ts` maps each of these to an error kind.
 */
export const ACCESS_ERROR_CODES = [
  'CODE_PARAMS_INVALID',
  'CODE_AUTH_FAILED',
  'CODE_ACCESS_TOKEN_INVALID',
  'CODE_UNAUTHORIZED',
  'CODE_RESOURCE_NOT_FOUND',
  'CODE_OPERATION_FORBIDDEN',
  'CODE_NOT_EXISTS',
  'CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED',
  'CODE_SYSTEM_ERROR',
  'CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND',
  'CODE_DEVICE_DEVICE_NOT_FOUND',
  'CODE_DEVICE_DEVICE_OFFLINE',
  'CODE_DEVICE_DEVICE_BUSY',
  'CODE_DEVICE_API_NOT_SUPPORTED',
  'CODE_DEVICE_DEVICE_VERSION_TOO_OLD',
] as const
export type AccessKnownErrorCode = (typeof ACCESS_ERROR_CODES)[number]

/**
 * Envelope `msg` (§2.8). Every sample in the reference has it, but nothing says it is always
 * present, so it is optional (lenient) while `code` stays required (OS-1). The spike reports
 * when it is absent (`shapeNotes` in scripts/spikes/lib/access.ts).
 */
const EnvelopeMsgSchema = z.string().optional()

/** Wraps a `data` schema in the success envelope `{ code: 'SUCCESS', msg?, data }`. */
export function accessSuccessEnvelope<T extends z.ZodType>(
  data: T,
): z.ZodObject<{
  code: z.ZodLiteral<'SUCCESS'>
  msg: z.ZodOptional<z.ZodString>
  data: T
}> {
  return z.object({ code: z.literal(ACCESS_SUCCESS_CODE), msg: EnvelopeMsgSchema, data })
}

/** Error envelope: any `code` but `SUCCESS`. `data` is usually absent or null. */
export const AccessErrorEnvelopeSchema = z.object({
  code: z
    .string()
    .refine((c) => c !== ACCESS_SUCCESS_CODE, { message: 'code must not be SUCCESS' }),
  msg: EnvelopeMsgSchema,
  data: z.unknown().optional(),
})
export type AccessErrorEnvelope = z.infer<typeof AccessErrorEnvelopeSchema>

/** Lock relay state. Unlock drives it to `unlock` for a few seconds, then back to `lock`. */
export const DoorLockRelayStatusSchema = z.enum(['lock', 'unlock'])
export type DoorLockRelayStatus = z.infer<typeof DoorLockRelayStatusSchema>

/**
 * Door position sensor (DPS), read as `'open'`, `'close'` or `null` (no sensor / unknown). The
 * reference says "a null value means that no device is connected", its own §7.7 sample sends `''`,
 * and a real console sends `"none"` for a door with no sensor. All of those, a missing field and
 * any other value read as `null`: the field is informational, and one odd value on it must never
 * hide a door (a strict enum here once emptied the Doors list on a real console).
 */
export const DoorPositionStatusSchema = z
  .unknown()
  // `.optional()` before the transform keeps a missing field acceptable inside an object (zod 4).
  .optional()
  .transform((v): 'open' | 'close' | null => (v === 'open' || v === 'close' ? v : null))
export type DoorPositionStatus = z.output<typeof DoorPositionStatusSchema>

/**
 * `is_bind_hub`: boolean, or the string `'true'`/`'false'` normalized to boolean. Lenient on
 * purpose: the reference's table says String and every one of its samples sends a boolean (OS-1).
 * Any other value (e.g. `'yes'`, `1`) is still rejected.
 */
export const IsBindHubSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
])

/**
 * A door as returned by `GET /doors` (§7.8) and `GET /doors/{id}` (§7.7). Unknown extra fields are
 * stripped, not rejected; `spike:access` reports them separately. A real console also sends an
 * undocumented `extras` object (`door_thumbnail`, `door_thumbnail_last_update`) that the app does
 * not use, so it is stripped too.
 */
export const AccessDoorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  full_name: z.string(),
  floor_id: z.string(),
  /** `door` in every sample; no enum is documented. */
  type: z.string(),
  /**
   * "It can only be used for remote opening if it's bound." The reference's table says String,
   * its samples boolean, so both `true`/`false` and `'true'`/`'false'` are accepted and normalized
   * to a boolean (lenient, OS-1). The spike reports which form the console sends (`shapeNotes`).
   */
  is_bind_hub: IsBindHubSchema,
  door_lock_relay_status: DoorLockRelayStatusSchema,
  door_position_status: DoorPositionStatusSchema,
})
export type AccessDoor = z.infer<typeof AccessDoorSchema>

export const AccessDoorListResponseSchema = accessSuccessEnvelope(z.array(AccessDoorSchema))
export type AccessDoorListResponse = z.infer<typeof AccessDoorListResponseSchema>

export const AccessDoorResponseSchema = accessSuccessEnvelope(AccessDoorSchema)
export type AccessDoorResponse = z.infer<typeof AccessDoorResponseSchema>

/**
 * Optional body of `PUT /doors/{id}/unlock` (§7.9). With no actor the system uses the API token's
 * name as the actor. `actor_id` and `actor_name` are each "required if the other is given";
 * `extra` is passthrough data echoed in webhook notifications.
 */
export const AccessUnlockRequestSchema = z
  .strictObject({
    actor_id: z.string().min(1).optional(),
    actor_name: z.string().min(1).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => (b.actor_id === undefined) === (b.actor_name === undefined), {
    message: 'actor_id and actor_name must be given together',
  })
export type AccessUnlockRequest = z.infer<typeof AccessUnlockRequestSchema>

/** Success response of the unlock call: `data` is the string `success` in the §7.9 sample. */
export const AccessUnlockResponseSchema = accessSuccessEnvelope(z.string())
export type AccessUnlockResponse = z.infer<typeof AccessUnlockResponseSchema>

// -------------------------------------------------------------------------------------------------
// P5.5: the rest of the door endpoints and the notifications WebSocket, from the official reference
// (docs/reference/access-endpoints-v4.2.16.md, PDF §7.9–§7.13 and §11.1). The GETs and the
// WebSocket open have been seen on a console (see the top of this file); the PUTs have not (OS-1).

/** Path of the notifications WebSocket below the API root (§11.1, scope `view:device`). */
export const ACCESS_NOTIFICATIONS_PATH = '/devices/notifications'

/** `type` values `PUT /doors/{id}/lock_rule` accepts (§7.10). */
export const ACCESS_LOCK_RULE_SET_TYPES = [
  'keep_lock',
  'keep_unlock',
  'custom',
  'reset',
  'lock_early',
  'lock_now',
] as const
export const AccessLockRuleSetTypeSchema = z.enum(ACCESS_LOCK_RULE_SET_TYPES)
export type AccessLockRuleSetType = z.infer<typeof AccessLockRuleSetTypeSchema>

/**
 * Body of `PUT /doors/{id}/lock_rule` (§7.10). `interval` is in **minutes** and belongs to `custom`
 * only: required there, refused elsewhere, so a stray interval cannot ride along on a `keep_unlock`.
 */
export const AccessLockRuleRequestSchema = z
  .strictObject({
    type: AccessLockRuleSetTypeSchema,
    interval: z.int().positive().optional(),
  })
  .refine((b) => (b.type === 'custom') === (b.interval !== undefined), {
    message: 'interval (minutes) is required for type custom and not allowed otherwise',
  })
export type AccessLockRuleRequest = z.infer<typeof AccessLockRuleRequestSchema>

/** `type` values `GET /doors/{id}/lock_rule` documents (§7.11). Not enforced: see the schema. */
export const ACCESS_LOCK_RULE_TYPES = [
  'schedule',
  'keep_lock',
  'keep_unlock',
  'custom',
  'lock_early',
] as const

/**
 * `data` of `GET /doors/{id}/lock_rule` (§7.11). Lenient on purpose: what the console answers for a
 * door with **no** rule is not documented (a real console answers `{ type: "", ended_time: 0 }`),
 * so `type` is any string (possibly empty) and `ended_time` (Unix seconds) may be missing or 0.
 */
export const AccessLockRuleSchema = z.object({
  type: z.string().default(''),
  ended_time: z.number().optional(),
})
export type AccessLockRule = z.infer<typeof AccessLockRuleSchema>
/** `data: null` (or no `data`) for a door with no rule reads as "no rule", not as a bad response. */
export const AccessLockRuleResponseSchema = accessSuccessEnvelope(
  AccessLockRuleSchema.nullish().transform((rule): AccessLockRule => rule ?? { type: '' }),
)

/**
 * Emergency status of **all** doors (§7.12/§7.13). Both fields are optional in the document's
 * tables and present in every sample; a missing one reads as `false`.
 */
export const AccessEmergencyStatusSchema = z.object({
  lockdown: z.boolean().default(false),
  evacuation: z.boolean().default(false),
})
export type AccessEmergencyStatus = z.infer<typeof AccessEmergencyStatusSchema>
export const AccessEmergencyStatusResponseSchema = accessSuccessEnvelope(
  AccessEmergencyStatusSchema,
)
/** Body of `PUT /doors/settings/emergency`: both flags, always sent explicitly. */
export const AccessEmergencyRequestSchema = z.strictObject({
  lockdown: z.boolean(),
  evacuation: z.boolean(),
})
export type AccessEmergencyRequest = z.infer<typeof AccessEmergencyRequestSchema>

/** `data: "success"` of the lock-rule and emergency PUTs, as for unlock. */
export const AccessOkResponseSchema = accessSuccessEnvelope(z.unknown().optional())

/** Event names the reference documents on the notifications WebSocket (§11.1). */
export const ACCESS_EVENT_DOORBELL = 'access.remote_view'
export const ACCESS_EVENT_DOORBELL_CHANGE = 'access.remote_view.change'
export const ACCESS_EVENT_REMOTE_UNLOCK = 'access.data.device.remote_unlock'

/**
 * One frame of the notifications WebSocket (§11.1): `{ event, receiver_id, event_object_id,
 * save_to_history, data }`. Only `event` is required here. The reference shows three events and
 * does not say the list is complete, so an unknown event must parse, not throw.
 */
export const AccessNotificationSchema = z.object({
  event: z.string().min(1),
  // Nothing reads it, so its type is not enforced: a `null` or a number here must not drop a frame
  // whose only job is to say "read the doors now" (DOOR-6).
  event_object_id: z.unknown().optional(),
  data: z.unknown().optional(),
})
export type AccessNotification = z.infer<typeof AccessNotificationSchema>

/** `data` of `access.data.device.remote_unlock`: `unique_id` is the **door id** (§11.1). */
export const AccessRemoteUnlockDataSchema = z.object({
  unique_id: z.string().min(1),
  name: z.string().optional(),
  location_type: z.string().optional(),
})
export type AccessRemoteUnlockData = z.infer<typeof AccessRemoteUnlockDataSchema>
