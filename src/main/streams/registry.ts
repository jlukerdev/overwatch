// P2.2 — the stream registry: the one place that turns "a cell wants camera X at quality Y" into a
// registered go2rtc stream, and the owner of QUAL-8's **RTSPS URLs are created on demand**.
//
// `ensureStream(cameraId, quality)` is the whole surface the IPC handler needs. What it does, and
// why each step is there:
//
//  1. **The camera is checked against main's cached inventory** (`GET /v1/cameras` is the authority,
//     CAM-1/R11). An id the console has never reported is a `not-found` error, not a go2rtc stream:
//     registering one would hand go2rtc a source for a camera nothing can play, and a renderer that
//     can name any id could otherwise make main POST streams onto the console at will. `package`
//     additionally requires that camera's `hasPackageCamera` (CAM-4) — the channel only exists on a
//     doorbell, and the console answers a POST for it with a 400 on anything else.
//  2. **The Protect RTSPS URL is cached per camera/quality for the session.** SPEC §5.1 measured the
//     URLs identical across repeated GETs within a run and across a POST, so a 10-cell View costs
//     one GET per camera/quality instead of one per attach (R9's 10 req/s, NFR-6's 5 s). The same
//     row says P0.3 never compared URLs *between* runs, so the cache is **session-scoped and never
//     persisted**: an app restart or a console reboot re-reads. {@link StreamRegistry.invalidate}
//     drops it for QUAL-8's "refresh on camera changes".
//  3. **GET first, POST only the one missing quality, never DELETE.** Protect streams may be shared
//     with other integrations — 4 of the 9 development cameras already had a `medium` stream made by
//     something else (SPEC R2) — so this module only ever creates. The POST returns **only** the
//     qualities it was asked for (SPEC §5.1), and a POST that comes back without the requested one
//     fails loudly instead of being retried: `POST rtsps-stream` creates state, and the client
//     deliberately never auto-retries a rate-limited one (R9, `protect/client.ts`).
//  4. **The source must point at the pinned console host** (R4). `rtspx://` is go2rtc's TLS RTSP
//     scheme with certificate verification *off*, and host equality plus loopback binding is the
//     entire mitigation, so a source for any other host is refused here — before it is ever offered
//     to the manager, which refuses it again. A *cached* source that fails the check is evicted and
//     re-read instead: it only means the user changed the console's address, and the URL for the
//     new one is one GET away (QUAL-8).
//  5. **go2rtc is started lazily and the stream registered live.** `manager.start()` is idempotent
//     and `addStream` records the desired set and replays it into every (re)start, so an
//     already-registered stream costs nothing while no consumer is attached (ARCHITECTURE §2 rule 3).
//
// **Concurrent calls for the same stream are coalesced.** Ten cells on one camera at startup must
// produce one GET, not ten: one in-flight promise per stream name (R9, NFR-6).
//
// **No RTSPS URL leaves this module** (CON-2, NFR-9, SPEC §6.1). The URL and its 16-character alias
// — which *is* the credential for that camera's stream — live in the cache and in the manager's
// generated config and nowhere else. Returned handles carry a name, a port and an epoch; the log
// lines carry a stream name at most; and no error message built here quotes a URL.
//
// **RTSP streams mode (RTSP-3, RTSP-5) is its own branch**, chosen per call from the live mode, and
// makes no Protect call at all (MODE-4):
//
//  R1. **The id must be a stream in the live config** (`rtsp.streams`), else `not-found`, not
//      retryable: an RTSP stream is never "not read yet", so a missing one has been deleted. The
//      `package` channel is a `bad-request` — only a Protect doorbell has one (CAM-4).
//  R2. **The URL comes from main's own decrypted secrets** (`rtspUrls`), never from the renderer,
//      which names a stream id and a quality only (RTSP-5). The quality served is
//      `fallbackQuality(asked, has a URL)` (RTSP-3): the asked one, else the closest stored one,
//      the lower on a tie. No URL at all is `not-configured`.
//  R3. **The URL is validated again** with RTSP-2's `validateRtspUrl` before it is used (a
//      hand-edited or damaged secrets file is not trusted); an invalid one is a `bad-request`.
//      `rtsps://` becomes go2rtc's `rtspx://`, `rtsp://` is passed as is (`toRtspGo2rtcSource`).
//  R4. **It is registered as `streamName(id, served)`**, and the handle names the *served* quality,
//      so the badge shows what really plays. Concurrent calls are coalesced on that served name.
//  R5. **The registry keeps the validated source of every RTSP stream it registered** and the
//      manager asks for it (`rtspSource`): in RTSP mode go2rtc accepts a source only if it is
//      exactly the one recorded here, in place of Protect's pinned-host check (RTSP-5).
//  R6. **A changed or deleted stream is dropped** (`rtspStreamChanged`): every go2rtc registration
//      of that stream is removed, its recorded sources forgotten, and an ensure for it already in
//      flight does not register afterwards (a per-stream generation, like `unregisterAll`'s).
//
// RTSP sources are never cached as a GET-saving measure (reading secrets costs nothing) and
// `invalidate` never touches them: the inventory push that calls it is not a URL change.
// Every RTSP message is a fixed sentence (`RTSP_STREAM_MESSAGES`): none carries a URL (CON-2).
//
// No Electron and no network of its own: the manager, the Protect client, the inventory, the pinned
// host, the RTSP streams and URLs and the log are all injected, so every rule above is unit-tested in plain Node against fakes
// (`tests/unit/streamRegistry.test.ts`). `src/main/index.ts` wires the real ones.
import type { IpcErrorKind } from '@shared/ipc'
import { fallbackQuality, type Quality, type StreamQuality } from '@shared/quality'
import { validateRtspUrl, type RtspStreamUrls } from '@shared/rtsp'
import { parseStreamName, streamHandle, streamName, type StreamHandle } from '@shared/streams'
import type { Camera } from '@shared/models'
import type { ProtectClient } from '../protect/client'
import { sourceHostIs, toGo2rtcSource } from './go2rtcConfig'
import type { Go2rtcManager } from './go2rtcManager'
import { RTSP_STREAM_MESSAGES, toRtspGo2rtcSource } from './rtspStreams'

/**
 * The kinds this module fails with, deliberately a subset of the contract's own: the IPC handler
 * maps them straight through (`src/main/ipc/handlers.ts`) instead of re-deciding what a registry
 * failure means, and a kind that is not in the contract cannot be invented here.
 */
export type StreamRegistryErrorKind = Extract<
  IpcErrorKind,
  'not-found' | 'bad-request' | 'not-configured' | 'invalid-response' | 'gateway-down'
>

/**
 * A refusal or failure of `ensureStream` that main can report as it is.
 *
 * Every message is written for a person and is safe to log: a camera id, a quality and a `host:port`
 * at most, **never** an RTSPS URL (CON-2, NFR-9). Protect's own failures are *not* wrapped in this —
 * they stay `ProtectApiError` so `toIpcError` keeps their kind, their `retryable` and their
 * endpoint.
 */
export class StreamRegistryError extends Error {
  readonly kind: StreamRegistryErrorKind
  /** True only when repeating the identical call could plausibly work (CON-5's retry affordance). */
  readonly retryable: boolean

  constructor(message: string, options: { kind: StreamRegistryErrorKind; retryable?: boolean }) {
    super(message)
    this.name = 'StreamRegistryError'
    this.kind = options.kind
    this.retryable = options.retryable ?? false
  }
}

export interface StreamRegistryOptions {
  /**
   * The go2rtc sidecar (P2.1). `start()` is called on every `ensureStream` because it is idempotent
   * and because go2rtc starts **lazily**: a user who only opens Settings never spawns one.
   */
  readonly manager: Pick<
    Go2rtcManager,
    'start' | 'runtime' | 'addStream' | 'removeStream' | 'streams'
  >
  /**
   * The Protect client for the console **as configured right now**, read per call rather than
   * captured: `src/main/index.ts` rebuilds it when the address changes.
   */
  readonly protect: () => Pick<ProtectClient, 'rtspsStreams' | 'createRtspsStreams'>
  /**
   * Main's cached inventory (`ConnectionManager.cachedCameras`). Read per call, so a camera that
   * has just appeared on the devices feed is streamable without anything being rebuilt (CAM-2).
   */
  readonly cameras: () => readonly Camera[]
  /**
   * The pinned console host (CON-3), `null` while none is configured. Read per call, because the
   * user can change the address mid-session — which is also why the host is re-checked against an
   * already cached source, and why a cached source that fails the check is re-read rather than
   * refused (R4).
   */
  readonly consoleHost: () => string | null
  /**
   * MODE-4: whether the app is in UniFi Protect mode, read per call. While it answers `false` (RTSP
   * streams mode) `ensureStream` takes the RTSP branch (RTSP-3) and makes no Protect call of any
   * kind. Default: always Protect.
   */
  readonly protectMode?: () => boolean
  /**
   * RTSP-3: the configured streams (`config.rtsp.streams`), read per call so a stream saved or
   * deleted a moment ago counts at once. Default: none.
   */
  readonly rtspStreams?: () => readonly { readonly id: string; readonly name: string }[]
  /**
   * RTSP-2/5: the decrypted stream URLs main holds (`credentials.rtspUrls`), read per call.
   * **Secret** (CON-2): read, validated, transformed and handed to the manager, never logged or
   * returned. Default: none.
   */
  readonly rtspUrls?: () => Readonly<Record<string, RtspStreamUrls>> | undefined
  /** Safe lines only — no URL, no alias, no credential (CON-2, NFR-9). Default: no-op. */
  readonly log?: (line: string) => void
}

export interface StreamRegistry {
  /**
   * QUAL-8: the go2rtc stream for one camera at one quality, created on demand and ready to attach
   * a player to. Idempotent and cheap to repeat — which is what the renderer does after every
   * `streamRuntime` event, because the handle carries the port and epoch of the runtime that is up
   * *now*. Concurrent calls for the same pair share one in-flight request.
   *
   * Rejects with a {@link StreamRegistryError} or a `ProtectApiError`; never with anything carrying
   * an RTSPS URL.
   */
  ensureStream(cameraId: string, quality: StreamQuality): Promise<StreamHandle>
  /**
   * Drops cached RTSPS URLs — one camera's, or all of them — so the next `ensureStream` re-reads
   * them from the console (QUAL-8's "refresh on camera changes"; wired to the camera-inventory
   * event in `src/main/index.ts`).
   *
   * It deliberately **does not** touch go2rtc: the registered streams stay registered and a playing
   * cell keeps playing. A cached URL is only an optimisation over a GET, so dropping it costs one
   * request later and never a frame now. In-flight requests are left alone too — they are already
   * past their read, and cancelling them would turn a refresh into a visible failure.
   */
  invalidate(cameraId?: string): void
  /**
   * MODE-4: a mode switch, in either direction (one mode's sources would fail the manager's check
   * for the other, R4 / RTSP-5). **Unregisters every stream from go2rtc** (`removeStream` for
   * each name in the desired set, so a running go2rtc drops it and no later restart replays it),
   * forgets every cached URL, every recorded RTSP source and every in-flight request, and makes a request that was already past
   * its read when this was called fail instead of registering its stream afterwards. Players attached
   * to a removed stream lose it; that is the point of the switch. go2rtc itself keeps running.
   * Never rejects: a stream go2rtc would not drop is logged (the desired set still forgets it).
   */
  unregisterAll(): Promise<void>
  /**
   * RTSP-5: the go2rtc source the registry validated and registered under this stream name, or
   * `null` for any name it did not. The manager's RTSP-mode check: a source is accepted only if it
   * is exactly this. **Secret** (CON-2): for the manager only.
   */
  rtspSource(name: string): string | null
  /**
   * RTSP-3: one RTSP stream's URLs changed, or the stream was deleted. Removes every go2rtc
   * registration of that stream (any quality), forgets its recorded sources and in-flight requests,
   * and makes a request for it that is already past its checks fail instead of registering
   * afterwards. A playing cell loses the stream and re-asks, which reads the new URL. Never
   * rejects.
   */
  rtspStreamChanged(streamId: string): Promise<void>
  /**
   * App shutdown: forget every cached URL and every in-flight request, so nothing holds an alias
   * after the window is gone. The sidecar is **not** stopped here — `manager.stop()` owns that, and
   * `will-quit` calls it alongside this (`src/main/index.ts`).
   */
  shutdown(): void
}

/** What the renderer asked for, in log lines and messages: safe (an id and a quality). */
function describe(cameraId: string, quality: StreamQuality): string {
  return `${cameraId} at ${quality}`
}

export function createStreamRegistry(options: StreamRegistryOptions): StreamRegistry {
  const { manager } = options
  const log = options.log ?? ((): void => undefined)

  /**
   * Stream name → go2rtc source (`rtspx://…`). **Secret** (CON-2, NFR-9): the alias in it is the
   * camera stream's credential, so this map is never logged, never persisted and never returned.
   * The transformed source rather than the raw RTSPS URL, because that is the only form anything
   * downstream wants and one shape is one fewer thing to get wrong.
   */
  const sources = new Map<string, string>()

  /** Stream name → the single in-flight `ensureStream`, so a 10-cell View makes one GET per pair. */
  const inFlight = new Map<string, Promise<StreamHandle>>()

  /**
   * Bumped by every {@link StreamRegistry.unregisterAll}. An `ensureOnce` that started under an
   * earlier generation refuses rather than registering its stream after everything was removed.
   */
  let generation = 0

  /**
   * RTSP-5: stream name → the go2rtc source this registry validated and registered (R5). Mirrors
   * the RTSP entries of the manager's desired set, so a go2rtc restart replays only sources the
   * manager will accept. **Secret** (CON-2), like {@link sources}.
   */
  const rtspSources = new Map<string, string>()

  /** RTSP stream id → generation, bumped by {@link StreamRegistry.rtspStreamChanged} (R6). */
  const rtspGenerations = new Map<string, number>()

  /**
   * RTSP stream name → the token of the request that last registered it. A request that turns out
   * stale removes the registration only while it still owns it: a newer request for the same name
   * may have registered an identical source (only another quality's URL changed), and that one
   * must stay.
   */
  const rtspOwners = new Map<string, object>()

  const protectMode = options.protectMode ?? ((): boolean => true)
  const rtspStreams = options.rtspStreams ?? ((): readonly { id: string; name: string }[] => [])
  const rtspUrls =
    options.rtspUrls ?? ((): Readonly<Record<string, RtspStreamUrls>> | undefined => undefined)

  /** MODE-4: the mode was switched while this request was waiting, so it must not register. */
  function requireGeneration(started: number): void {
    if (started === generation) return
    throw new StreamRegistryError(
      'The app mode changed while the stream was being opened, so it was not opened.',
      { kind: 'bad-request' },
    )
  }

  /**
   * Refuses the pair unless main's cached inventory (CAM-1) has that camera and that camera can
   * actually produce that quality (CAM-4). Returns nothing: the camera record itself is not needed
   * beyond these two questions.
   */
  function requireStreamable(cameraId: string, quality: StreamQuality): void {
    const camera = options.cameras().find((c) => c.id === cameraId)
    if (camera === undefined) {
      throw new StreamRegistryError(
        `No camera with id ${cameraId} is in OverWatch's camera list, so there is no stream to ` +
          'open. Reconnect to the console to re-read the cameras.',
        // Retryable: the inventory may simply not have been read yet (CAM-1).
        { kind: 'not-found', retryable: true },
      )
    }
    if (quality === 'package' && !camera.hasPackageCamera) {
      throw new StreamRegistryError(
        `Camera ${cameraId} has no package camera, so it has no package channel to stream (CAM-4).`,
        { kind: 'bad-request' },
      )
    }
  }

  /**
   * The go2rtc source for one pair, GET first and POST only the missing quality (QUAL-8).
   *
   * The returned string is a secret. It is handed to the manager and put in {@link sources}, and
   * that is the end of it.
   */
  async function readSource(cameraId: string, quality: StreamQuality): Promise<string> {
    const client = options.protect()
    const existing = await client.rtspsStreams(cameraId)
    let url = existing[quality] ?? null
    if (url === null) {
      // Only the one quality that is missing: the POST creates state, leaves the other qualities
      // untouched, and is never retried automatically (R9, SPEC §5.1).
      log(`creating the Protect ${quality} stream for camera ${cameraId} (QUAL-8)`)
      const created = await client.createRtspsStreams(cameraId, [quality])
      url = created[quality] ?? null
      if (url === null) {
        // 200 with the requested quality absent. Repeating the POST blindly would create state the
        // console has already said it will not report back, so this is reported instead.
        throw new StreamRegistryError(
          `The console accepted the request to create the ${quality} stream for camera ` +
            `${cameraId} but did not return a URL for it, so there is nothing to play.`,
          { kind: 'invalid-response' },
        )
      }
    }
    return toGo2rtcSource(url)
  }

  /** The pinned console host (CON-3), or `not-configured` when the user has not set one (CON-1). */
  function requireConsoleHost(): string {
    const host = options.consoleHost()
    if (host === null) {
      throw new StreamRegistryError(
        'No console address is configured, so OverWatch cannot open a stream. Enter the ' +
          "console's address in Settings (CON-1).",
        { kind: 'not-configured' },
      )
    }
    return host
  }

  /**
   * R4: the unpinned `rtspx://` scheme may only ever point at the pinned console host. This is the
   * check for a **freshly read** source, and a failure here really is a console problem — the
   * console just handed out a URL for somewhere else. A *cached* source that fails the same check
   * only means the pinned address changed under it, and {@link ensureOnce} evicts it and re-reads
   * instead of reporting this.
   */
  function requirePinnedHost(source: string, cameraId: string, quality: StreamQuality): void {
    const host = requireConsoleHost()
    if (!sourceHostIs(source, host)) {
      // The URL itself is never quoted: it is a credential (CON-2, NFR-9).
      throw new StreamRegistryError(
        `The stream URL the console returned for ${describe(cameraId, quality)} does not point at ` +
          `the pinned console host (${host}), so OverWatch will not open it (R4).`,
        { kind: 'invalid-response' },
      )
    }
  }

  /** The verified runtime, or `gateway-down` — the one kind that is about the gateway, not Protect. */
  async function requireRuntime(): Promise<{ port: number; epoch: number }> {
    try {
      // Idempotent, and this is the lazy start: nothing spawns go2rtc until a stream is wanted.
      return await manager.start()
    } catch (err) {
      log(`go2rtc could not be started: ${err instanceof Error ? err.message : String(err)}`)
      throw new StreamRegistryError(
        'The local video gateway (go2rtc) is not running, so there is no video yet. OverWatch ' +
          'keeps trying to start it.',
        { kind: 'gateway-down', retryable: true },
      )
    }
  }

  async function ensureOnce(cameraId: string, quality: StreamQuality): Promise<StreamHandle> {
    const started = generation
    requireStreamable(cameraId, quality)
    const name = streamName(cameraId, quality)

    const host = requireConsoleHost()
    let source = sources.get(name)
    if (source !== undefined && !sourceHostIs(source, host)) {
      // The pinned address changed while the app ran (R4). The cache is only an optimisation over
      // a GET, so the stale entry is dropped and the URL re-read — one GET, per QUAL-8 — rather
      // than failing the pair for ever with a message that blames the console.
      sources.delete(name)
      source = undefined
      log(
        `dropped the cached stream URL for ${describe(cameraId, quality)}: it is not on the ` +
          `pinned console host (${host}) any more, re-reading it (R4, QUAL-8)`,
      )
    }
    if (source === undefined) {
      source = await readSource(cameraId, quality)
      requireGeneration(started)
      requirePinnedHost(source, cameraId, quality)
      // Cached only once it is known good, and only for this session (SPEC §5.1).
      sources.set(name, source)
    }

    const runtime = await requireRuntime()
    // After the last await before `addStream`: a switch to RTSP mode during the GET or the go2rtc
    // start has already unregistered everything, and this stream must not come back after it.
    requireGeneration(started)
    try {
      // Records the stream in the desired set and, since go2rtc is up, registers it live. Replayed
      // into every later (re)start by the manager, so a restart needs nothing from here.
      await manager.addStream(name, source)
    } catch (err) {
      // go2rtc is up but would not take the stream. The name comes from `streamName` and the host
      // was just checked, so the manager's own validations cannot be what failed: whatever this is,
      // it is the gateway, and the renderer's answer is to show the placeholder and re-ask.
      log(`go2rtc rejected stream ${name}: ${err instanceof Error ? err.message : String(err)}`)
      throw new StreamRegistryError(
        'The local video gateway (go2rtc) did not accept the stream, so there is no video yet. ' +
          'OverWatch will try again.',
        { kind: 'gateway-down', retryable: true },
      )
    }
    log(`stream ${name} ready on epoch ${String(runtime.epoch)}`)
    // Port and epoch of the runtime that is up *now*: a handle from an earlier epoch is dead.
    return streamHandle({ cameraId, quality, port: runtime.port, epoch: runtime.epoch })
  }

  // --- RTSP streams mode (RTSP-3, RTSP-5) -----------------------------------------------------

  /** What an RTSP request resolved to before anything is awaited: R1–R3. */
  interface RtspPlan {
    readonly streamId: string
    readonly served: Quality
    readonly name: string
    /** The validated go2rtc source. **Secret** (CON-2). */
    readonly source: string
  }

  /**
   * R1–R3, synchronous: refuses, or names the served quality and its validated source. Every
   * refusal is a fixed sentence with no URL in it (CON-2).
   */
  function planRtsp(streamId: string, quality: StreamQuality): RtspPlan {
    if (quality === 'package') {
      throw new StreamRegistryError(RTSP_STREAM_MESSAGES.playPackage, { kind: 'bad-request' })
    }
    if (!rtspStreams().some((stream) => stream.id === streamId)) {
      // Not retryable: unlike a Protect inventory, the stream list is never "not read yet".
      throw new StreamRegistryError(RTSP_STREAM_MESSAGES.playNotFound, { kind: 'not-found' })
    }
    // The id has just matched a configured `rtsp-<uuid>`, so it cannot name a prototype key.
    const urls: RtspStreamUrls = rtspUrls()?.[streamId] ?? {}
    const served = fallbackQuality(quality, (q) => (urls[q] ?? '') !== '')
    const url = served === null ? undefined : urls[served]
    if (served === null || url === undefined) {
      throw new StreamRegistryError(RTSP_STREAM_MESSAGES.playNoUrl, { kind: 'not-configured' })
    }
    // RTSP-5: only a URL that passes RTSP-2's rules is ever handed to go2rtc. The check's own
    // reason is not passed on: it is safe, but the fixed sentence says what to do about it.
    if (!validateRtspUrl(url).ok) {
      throw new StreamRegistryError(RTSP_STREAM_MESSAGES.playInvalidUrl, { kind: 'bad-request' })
    }
    return { streamId, served, name: streamName(streamId, served), source: toRtspGo2rtcSource(url) }
  }

  /** R6: the stream changed (or the mode switched) while this request was waiting. */
  function rtspStale(plan: RtspPlan, started: number, streamStarted: number): boolean {
    return started !== generation || (rtspGenerations.get(plan.streamId) ?? 0) !== streamStarted
  }

  function requireRtspCurrent(plan: RtspPlan, started: number, streamStarted: number): void {
    requireGeneration(started)
    if (rtspStale(plan, started, streamStarted)) {
      // Retryable: the player asks again and gets the stream's new URL (or its refusal).
      throw new StreamRegistryError(RTSP_STREAM_MESSAGES.playChanged, {
        kind: 'bad-request',
        retryable: true,
      })
    }
  }

  /** Keeps {@link rtspSources} equal to what the manager's desired set now holds for `name`. */
  function syncRtspSource(name: string): void {
    const held = manager.streams()[name]
    if (held === undefined) rtspSources.delete(name)
    else rtspSources.set(name, held)
  }

  async function ensureRtspOnce(plan: RtspPlan): Promise<StreamHandle> {
    const started = generation
    const streamStarted = rtspGenerations.get(plan.streamId) ?? 0
    const runtime = await requireRuntime()
    // After the go2rtc start: a mode switch or a change to this stream during it has already
    // removed this stream's registrations, and it must not come back with a stale URL (R6).
    requireRtspCurrent(plan, started, streamStarted)
    // Recorded before `addStream`, which asks the manager's RTSP-5 check for exactly this (R5).
    rtspSources.set(plan.name, plan.source)
    const owner = {}
    rtspOwners.set(plan.name, owner)
    try {
      await manager.addStream(plan.name, plan.source)
    } catch (err) {
      // The manager rolled its desired set back; the record follows it, so a restart's replay
      // never meets a source the manager would refuse.
      syncRtspSource(plan.name)
      // The manager's message names the stream at most, never the source (CON-2).
      log(
        `go2rtc rejected stream ${plan.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw new StreamRegistryError(
        'The local video gateway (go2rtc) did not accept the stream, so there is no video yet. ' +
          'OverWatch will try again.',
        { kind: 'gateway-down', retryable: true },
      )
    }
    if (rtspStale(plan, started, streamStarted)) {
      // Changed while go2rtc was registering it: the removal may have run before this landed, so
      // it is removed again here rather than left playing the old URL (R6).
      // Only a registration this request added and no newer request has claimed since.
      if (rtspOwners.get(plan.name) === owner && manager.streams()[plan.name] === plan.source) {
        rtspOwners.delete(plan.name)
        // The name leaves the manager's desired set synchronously inside `removeStream`, and its
        // record goes at the same moment, before anything is awaited: a newer request that
        // registers meanwhile keeps its own record.
        const removal = removeQuietly(plan.name)
        rtspSources.delete(plan.name)
        await removal
      }
      requireRtspCurrent(plan, started, streamStarted)
    }
    log(`stream ${plan.name} ready on epoch ${String(runtime.epoch)} (RTSP)`)
    return streamHandle({
      cameraId: plan.streamId,
      quality: plan.served,
      port: runtime.port,
      epoch: runtime.epoch,
    })
  }

  /** `removeStream`, answering whether go2rtc dropped it and never rejecting. */
  async function removeQuietly(name: string): Promise<boolean> {
    try {
      return await manager.removeStream(name)
    } catch {
      return false
    }
  }

  /** Shares one in-flight promise per stream name (R9, NFR-6), dropping only its own entry. */
  function coalesce(name: string, run: () => Promise<StreamHandle>): Promise<StreamHandle> {
    const pending = inFlight.get(name)
    if (pending !== undefined) return pending
    const promise = run().finally(() => {
      // Only its own entry: `unregisterAll` may have dropped it and a newer request taken its place.
      if (inFlight.get(name) === promise) inFlight.delete(name)
    })
    inFlight.set(name, promise)
    return promise
  }

  return {
    ensureStream(cameraId, quality) {
      if (!protectMode()) {
        let plan: RtspPlan
        try {
          plan = planRtsp(cameraId, quality)
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)))
        }
        // Coalesced on the *served* name (R4): asking for `high` and `medium` of a stream that only
        // has `medium` is one registration, not two racing ones.
        return coalesce(plan.name, () => ensureRtspOnce(plan))
      }
      const name = streamName(cameraId, quality)
      // R9/NFR-6: ten cells on one camera at startup share this one promise.
      return coalesce(name, () => ensureOnce(cameraId, quality))
    },

    invalidate(cameraId) {
      if (cameraId === undefined) {
        if (sources.size > 0) log(`dropped ${String(sources.size)} cached stream URLs (QUAL-8)`)
        sources.clear()
        return
      }
      for (const name of [...sources.keys()]) {
        if (parseStreamName(name)?.cameraId === cameraId) sources.delete(name)
      }
      log(`dropped the cached stream URLs for camera ${cameraId} (QUAL-8)`)
    },

    async unregisterAll() {
      generation += 1
      sources.clear()
      rtspSources.clear()
      inFlight.clear()
      const names = Object.keys(manager.streams())
      // `removeStream` never rejects; it answers whether the running go2rtc dropped the stream. A
      // rejection is still counted, so an injected manager that throws cannot make this reject.
      const results = await Promise.allSettled(names.map((name) => manager.removeStream(name)))
      const failed = results.filter(
        (result) => result.status === 'rejected' || !result.value,
      ).length
      log(
        `unregistered ${String(names.length)} stream(s) from go2rtc (MODE-4)` +
          (failed === 0 ? '' : `; ${String(failed)} could not be removed from the running go2rtc`),
      )
    },

    rtspSource(name) {
      return rtspSources.get(name) ?? null
    },

    async rtspStreamChanged(streamId) {
      rtspGenerations.set(streamId, (rtspGenerations.get(streamId) ?? 0) + 1)
      const ofStream = (name: string): boolean => parseStreamName(name)?.cameraId === streamId
      for (const name of [...inFlight.keys()]) if (ofStream(name)) inFlight.delete(name)
      const names = Object.keys(manager.streams()).filter(ofStream)
      // Each name leaves the manager's desired set synchronously inside `removeStream`, so the
      // records go at that same moment, before anything is awaited: a newer ensure that registers
      // during the DELETEs keeps its own record, and the desired set never holds a source this
      // registry no longer vouches for (RTSP-5).
      const removals = Promise.all(names.map((name) => removeQuietly(name)))
      for (const name of [...rtspSources.keys()]) if (ofStream(name)) rtspSources.delete(name)
      const results = await removals
      const failed = results.filter((dropped) => !dropped).length
      log(
        `unregistered ${String(names.length)} stream(s) of a changed RTSP stream (RTSP-3)` +
          (failed === 0 ? '' : `; ${String(failed)} could not be removed from the running go2rtc`),
      )
    },

    shutdown() {
      sources.clear()
      rtspSources.clear()
      inFlight.clear()
    },
  }
}
