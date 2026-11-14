// What the renderer is allowed to know about a stream (P2.2). Zod schemas plus the types inferred
// from them, like the rest of `src/shared`: no Node and no Electron imports, because the renderer
// bundle takes this file as is.
//
// This file exists for one rule. **The renderer never sees an RTSPS URL and never sees go2rtc's API
// credentials** (CON-2, NFR-9, CLAUDE.md, SPEC §5.3 "Renderer isolation"). Main holds the Protect
// RTSPS URL, rewrites it to `rtspx://` for the pinned console host only, registers it in go2rtc as
// `<cameraId>_<quality>` (ARCHITECTURE §2 rule 3) and injects `Authorization: Basic …` into the
// loopback WebSocket in `onBeforeSendHeaders`. All that is left for the renderer is a stream *name*,
// a loopback *port* and the `ws://127.0.0.1:…` URL built from them — which is exactly
// {@link StreamHandle}. Anything richer than that would be a credential or an upstream URL in the
// renderer's heap, where a compromised page or a devtools paste could read it.
//
// Two shapes:
//   StreamHandle  — the answer to `ensureStream(cameraId, quality)` (src/shared/ipc.ts). One camera
//                   at one quality, ready to attach a player to.
//   StreamRuntime — the main→renderer push for "go2rtc restarted on a different port" or "go2rtc is
//                   down". It is what makes a handle *stale*, which is why `epoch` is on both.
import { z } from 'zod'
import { STREAM_QUALITIES, StreamQualitySchema, type StreamQuality } from './quality'

/**
 * go2rtc binds here and nowhere else (CLAUDE.md, SPEC §5.3). A constant rather than a literal in
 * three places, and the one value the ws URL below may ever contain: a handle pointing anywhere else
 * would mean the renderer is talking to something that is not our gateway.
 */
export const LOOPBACK_HOST = '127.0.0.1'

/** go2rtc's MSE-over-WebSocket endpoint. The only go2rtc path the renderer ever opens. */
export const GO2RTC_WS_PATH = '/api/ws'

/**
 * Separator in `<cameraId>_<quality>` (ARCHITECTURE §2 rule 3). Protect camera ids are 24 hex
 * characters, so `_` cannot occur inside one and the name parses back unambiguously —
 * {@link STREAM_NAME_RE} enforces that by refusing a `_` in the camera-id part rather than trusting
 * it. A name that cannot be split back is a name main could register for the wrong camera.
 */
export const STREAM_NAME_SEPARATOR = '_'

/**
 * Strict stream-name shape: a camera id of URL-safe characters (no `_`), then the separator, then
 * one of {@link STREAM_QUALITIES} — generated from that list, so adding a stream source cannot
 * leave the validator behind.
 *
 * The charset is deliberately narrow. The name travels as the `src` query parameter of the ws URL
 * and is a key in go2rtc's generated YAML config, so anything needing escaping (or a `/`, or a
 * `..`) has no business in one.
 *
 * It is also a **strict subset of what main accepts**: `isSafeStreamName` in
 * src/main/streams/go2rtcConfig.ts allows `[A-Za-z0-9_-]{1,64}` and *throws* when the generated
 * config would carry anything else. Everything this schema admits therefore passes that check —
 * hence no `.` here and the 64-character cap in {@link MAX_STREAM_NAME_LENGTH}. A name the renderer
 * could be handed but go2rtc would refuse to be configured with is a stream that fails at launch
 * instead of at validation, which is the harder failure to read.
 */
export const STREAM_NAME_RE = new RegExp(
  `^[A-Za-z0-9-]+${STREAM_NAME_SEPARATOR}(?:${STREAM_QUALITIES.join('|')})$`,
)

/** The cap `isSafeStreamName` in main enforces on the whole name (src/main/streams/go2rtcConfig.ts). */
export const MAX_STREAM_NAME_LENGTH = 64

export const StreamNameSchema = z
  .string()
  .max(MAX_STREAM_NAME_LENGTH)
  .regex(STREAM_NAME_RE, 'expected <cameraId>_<quality> with a URL-safe camera id')

/** The go2rtc stream name for a camera/quality pair (ARCHITECTURE §2 rule 3). */
export function streamName(cameraId: string, quality: StreamQuality): string {
  return `${cameraId}${STREAM_NAME_SEPARATOR}${quality}`
}

/** Whether a string is a well-formed stream name. The validator, for main and for tests. */
export function isStreamName(value: string): boolean {
  return value.length <= MAX_STREAM_NAME_LENGTH && STREAM_NAME_RE.test(value)
}

/**
 * Splits a well-formed name back into its parts, `null` for anything else. The registry uses it to
 * answer "which camera does this go2rtc stream belong to" without keeping a second index, and its
 * round trip with {@link streamName} is what the `_`-free camera id above buys.
 */
export function parseStreamName(
  value: string,
): { cameraId: string; quality: StreamQuality } | null {
  if (!isStreamName(value)) return null
  const cut = value.lastIndexOf(STREAM_NAME_SEPARATOR)
  const quality = StreamQualitySchema.safeParse(value.slice(cut + 1))
  if (!quality.success) return null
  return { cameraId: value.slice(0, cut), quality: quality.data }
}

/** A TCP port. go2rtc takes a free one on every launch, so no value is predictable. */
export const StreamPortSchema = z.int().min(1).max(65535)

/**
 * go2rtc's restart counter: 1 for the first healthy start, +1 for every one after a crash or a
 * deliberate restart (P2.1). It exists because **the port changes with it**, so a
 * {@link StreamHandle} obtained before a restart points at a port nothing is listening on — or,
 * worse, at a port some other local process has since taken. The player compares the epoch it holds
 * with the latest {@link StreamRuntime} and calls `ensureStream` again when they differ, instead of
 * trying to tell "my socket closed" apart from "the gateway moved" by guessing (NFR-7, gate G2's
 * "streams recover by themselves after go2rtc is killed").
 */
export const StreamEpochSchema = z.int().min(1)

/**
 * The ws URL for a stream, as main builds it. **The renderer never assembles this from parts** — it
 * attaches its player to `handle.wsUrl` verbatim. Two reasons: main's
 * `session.webRequest.onBeforeSendHeaders` filter (SPEC §5.3) only injects go2rtc's `Authorization`
 * and the rewritten `Origin` for `ws://127.0.0.1:<port>/*`, so a renderer-built URL that differs by
 * a character silently loses its credentials; and a renderer that can compose stream URLs can
 * compose one for a camera no View of its own ever asked for.
 *
 * `encodeURIComponent` is a no-op for a name that passes {@link STREAM_NAME_RE} and is here so that
 * it stays a no-op if that charset is ever widened.
 */
export function go2rtcWsUrl(port: number, name: string): string {
  return `ws://${LOOPBACK_HOST}:${String(port)}${GO2RTC_WS_PATH}?src=${encodeURIComponent(name)}`
}

/**
 * Everything the renderer needs to play one camera at one quality, and nothing else.
 *
 * `cameraId` and `quality` are echoed back rather than left to the caller to remember: a player
 * holds the handle it is playing, and a handle that cannot say what it is playing turns every
 * "has the effective quality changed" check (QUAL-6, FILL-2) into bookkeeping somewhere else.
 * `quality` is a `StreamQuality`, not a `Quality`, so a doorbell's package channel fits (CAM-4,
 * QUAL-8) — it is a stream source the user never picks from the quality picker.
 *
 * The `.check()` below ties the fields together: `name` must be exactly `<cameraId>_<quality>` and
 * `wsUrl` exactly what {@link go2rtcWsUrl} builds from `port` and `name`. A handle whose parts
 * disagree is how a player ends up attached to another camera's stream, and both ends of the bridge
 * parse with this schema (src/shared/ipc.ts), so neither can produce or accept one.
 */
export const StreamHandleSchema = z
  .object({
    cameraId: z.string().min(1),
    quality: StreamQualitySchema,
    /** The go2rtc stream name (ARCHITECTURE §2 rule 3). Not a URL and not a Protect alias. */
    name: StreamNameSchema,
    /** go2rtc's loopback API port for the current {@link StreamEpochSchema epoch}. */
    port: StreamPortSchema,
    /** `ws://127.0.0.1:<port>/api/ws?src=<name>`, built in main. Attach to it as it is. */
    wsUrl: z.string(),
    epoch: StreamEpochSchema,
  })
  // Runs only once the fields above are valid, so the three are real strings/numbers here.
  .check((ctx) => {
    const { cameraId, quality, name, port, wsUrl } = ctx.value
    const expectedName = streamName(cameraId, quality)
    if (name !== expectedName) {
      ctx.issues.push({
        code: 'custom',
        input: name,
        path: ['name'],
        message: `name must be ${expectedName} for this cameraId/quality`,
      })
      return
    }
    const expectedUrl = go2rtcWsUrl(port, name)
    if (wsUrl !== expectedUrl) {
      ctx.issues.push({
        code: 'custom',
        input: wsUrl,
        path: ['wsUrl'],
        message: 'wsUrl must be the loopback go2rtc URL for this port and name',
      })
    }
  })
export type StreamHandle = z.infer<typeof StreamHandleSchema>

/** Builds a valid handle. Main's only way of making one, and the one the schema above accepts. */
export function streamHandle(input: {
  cameraId: string
  quality: StreamQuality
  port: number
  epoch: number
}): StreamHandle {
  const name = streamName(input.cameraId, input.quality)
  return {
    cameraId: input.cameraId,
    quality: input.quality,
    name,
    port: input.port,
    wsUrl: go2rtcWsUrl(input.port, name),
    epoch: input.epoch,
  }
}

/**
 * The state of the go2rtc gateway as the renderer is told about it, pushed on every change
 * (`IPC_EVENTS.streamRuntime` in src/shared/ipc.ts).
 *
 * A discriminated union and not `{ port: number | null }`: "down" and "up on a new port" ask for
 * different things from the player — show the offline placeholder and wait, versus re-ask
 * `ensureStream` for every attached cell — and a nullable port makes the renderer infer which one
 * happened from what it previously held. With `state` it reads the answer instead of deducing it.
 *
 * `down` carries no port, no epoch and no reason. No port or epoch because there is no runtime to
 * describe, and every handle from the previous one is void anyway; no reason because why go2rtc
 * stopped is main's log (and its restart logic, P2.1), not something a cell can act on — a failure
 * the *user* must act on arrives as the `error` of a call, per rule 2 of the IPC contract.
 */
export const StreamRuntimeSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('up'),
    port: StreamPortSchema,
    epoch: StreamEpochSchema,
  }),
  z.object({ state: z.literal('down') }),
])
export type StreamRuntime = z.infer<typeof StreamRuntimeSchema>

/** The "no runtime" value, so main and the renderer never spell the down payload differently. */
export const STREAM_RUNTIME_DOWN: StreamRuntime = { state: 'down' }

/**
 * Whether a handle is still usable, i.e. whether it belongs to the runtime now up. The player's
 * whole staleness rule, in one place: after a restart the port is new, so the old handle's socket
 * would either refuse or — if another process grabbed the port — not be go2rtc at all.
 */
export function isHandleCurrent(handle: StreamHandle, runtime: StreamRuntime): boolean {
  return runtime.state === 'up' && runtime.epoch === handle.epoch && runtime.port === handle.port
}
