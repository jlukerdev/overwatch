// UniFi Access developer API types and zod schemas (SPEC §5.2, DOOR-1/3). P1.4's client uses these.
//
// COMMUNITY-SOURCED / UNVERIFIED (OS-1). Ubiquiti's developer portal does not document Access.
// These shapes come from community sources (see docs/spikes/P0.4-access-mock.md §2): the
// community OpenAPI at unifi-access-api-openapi.pages.dev and the py-unifi-access client used by
// hass-unifi-access. No Access hardware is on the development network, so nothing here has been
// checked against a real console. `npm run spike:access` against the site console (OS-1) is the
// check. Correct this file, the mock (scripts/mock-access/) and the fixtures wherever it differs.
//
// Node runs scripts that import this file directly (type stripping): erasable syntax only.
import { z } from 'zod'

/** Default port and path of the developer API on the console (unverified, OS-1). */
export const ACCESS_DEFAULT_PORT = 12445
export const ACCESS_API_PATH = '/api/v1/developer'

/** `code` of every successful response (unverified, OS-1). */
export const ACCESS_SUCCESS_CODE = 'SUCCESS'

/**
 * Error `code` values named by the community OpenAPI usage guide (unverified, OS-1). The HTTP
 * status that goes with each is NOT documented anywhere; a client must treat any `code` other
 * than `SUCCESS` as an error whatever the HTTP status.
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
] as const
export type AccessKnownErrorCode = (typeof ACCESS_ERROR_CODES)[number]

/**
 * Envelope `msg`. UNVERIFIED (OS-1): every community example has it, but no source says it is
 * always present, so it is optional (lenient) while `code` stays required. The spike reports
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
 * Door position sensor. The community docs say null when no sensor is connected, but their
 * single-door example returns `''`, so both are accepted (unverified, OS-1).
 */
export const DoorPositionStatusSchema = z
  .union([z.enum(['open', 'close']), z.literal('')])
  .nullable()
export type DoorPositionStatus = z.infer<typeof DoorPositionStatusSchema>

/**
 * `is_bind_hub`: boolean, or the string `'true'`/`'false'` normalized to boolean. UNVERIFIED (OS-1),
 * lenient on purpose; any other value (e.g. `'yes'`, `1`) is still rejected.
 */
export const IsBindHubSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
])

/**
 * A door as returned by `GET /doors` and `GET /doors/{id}`. Unknown extra fields are stripped,
 * not rejected; `spike:access` reports them separately.
 */
export const AccessDoorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  full_name: z.string(),
  floor_id: z.string(),
  /** `door` in every community example; no enum is documented. */
  type: z.string(),
  /**
   * Remote unlock only works when true. UNVERIFIED (OS-1): the community table says String, its
   * example boolean, so both `true`/`false` and `'true'`/`'false'` are accepted and normalized to
   * a boolean (lenient). The spike reports which form the console sends (`shapeNotes`).
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
 * Optional body of `PUT /doors/{id}/unlock`. With no body the console logs the API token's name
 * as the actor. `actor_id` and `actor_name` must be given together (unverified, OS-1).
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

/** Success response of the unlock call: `data` is the string `success` in the community example. */
export const AccessUnlockResponseSchema = accessSuccessEnvelope(z.string())
export type AccessUnlockResponse = z.infer<typeof AccessUnlockResponseSchema>
