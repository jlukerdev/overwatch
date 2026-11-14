// The live player's lifecycle, as a pure state machine (P2.3; QUAL-6, FILL-2, CAM-3, NFR-7, R7, G2).
//
// `LivePlayer.tsx` is a shell around this file: it turns props and DOM events into {@link PlayerEvent}s,
// hands them here, and carries out the {@link PlayerCommand}s that come back (call `ensureStream`,
// attach a player element, close a socket, drop an element). Nothing in this module touches the DOM,
// the bridge or a timer, which is why all of it is tested — the project has no jsdom and no
// testing-library (vitest.config.mts, CLAUDE.md), so a lifecycle rule that lived in a `useEffect`
// would be a rule no test could reach, and this is a lifecycle with six ways to go wrong:
//
//  1. **The seamless swap (QUAL-6, same mechanism as FILL-2).** There are two layers, `current` and
//     `incoming`. `current` is what the viewer sees; `incoming` is attached, hidden and muted. The
//     swap happens on `incoming`'s *first frame* and not a moment earlier: that single rule is what
//     makes a quality change show neither a black frame nor a flash of placeholder. A corollary used
//     everywhere below: **`placeholder` is non-null only when there is no layer on screen** — the
//     machine cannot express "placeholder over live video", so it cannot flash one.
//  2. **A reconnect is a re-`ensureStream`, not a re-open of the same URL.** A socket closing and
//     go2rtc having moved are indistinguishable from the renderer (a dead port looks like a blip),
//     and a stale handle's port may by then belong to another local process (src/shared/streams.ts
//     on `epoch`). `ensureStream` is idempotent and cheap to repeat (src/shared/ipc.ts), so every
//     recovery path takes the same cheap step and gets a fresh port, a fresh epoch and a
//     `gateway-down` error for free. That is gate G2's "streams recover by themselves".
//  3. **A dead `current` keeps its last frame.** When its socket closes or it freezes, the layer is
//     marked `stale` and left on screen while the replacement connects. Rule 1 then applies: the
//     frozen frame is replaced on the new layer's first frame. A placeholder here would be a flash
//     for the ~0.3–0.65 s a reconnect takes (P0.5 first-frame figures). It is bounded, though:
//     after {@link MAX_STALE_FRAME_FAILURES} the still frame is dropped and the placeholder says
//     what is wrong, because a picture that stopped minutes ago is a lie, not a stream.
//  4. **Camera offline and gateway down are not errors (CAM-3, `gateway-down`).** They detach
//     everything and show their own placeholder; nothing retries while they hold, because retrying
//     a camera the console says is `DISCONNECTED` spends a rate-limit permit to be told so (SPEC R9).
//  5. **An undecodable codec is a verdict on one quality, not on the player (R7).** A codec is a
//     property of one go2rtc stream (`<cameraId>_<quality>`), and Enhanced Encoding is per camera,
//     so a `high` that will not decode says nothing about a `low` that does. Verdicts are kept per
//     quality ({@link PlayerState.codecUnsupported}) and the next `ensureStream` goes to the
//     {@link targetQuality}: the `quality` prop when it has no verdict, otherwise the quality that
//     was last on screen (the stream the viewer was watching — so a dead `low` behind a refused
//     `high` swap is reconnected, not frozen), otherwise nothing, and the cell says "Codec not
//     supported". Retrying a refused quality cannot change a camera's encoder, so it is not retried
//     until something can have changed the answer: a go2rtc restart clears every verdict, and a
//     quality prop change clears the verdict **for the quality now asked for only** — toggling away
//     and back is the viewer's one-attempt retry, and the other verdicts stay, because they are
//     still true and are what keeps a fallback from looping back into the undecodable quality.
//  6. **A layer gets a bounded window to paint (NFR-7, G2).** A go2rtc handshake `error` reply and a
//     layer that has not painted within `playerTiming.FIRST_FRAME_TIMEOUT_MS` of visible time since
//     attach are both a lost layer — the same path as a closed socket — because neither closes the socket, so without
//     them a cell can sit on "Connecting…" forever. The viewer is told "Stream could not start"
//     (never go2rtc's own text, which can name the source URL: CON-2, NFR-9) while it retries — but
//     only for a layer that never played: a visible layer that errors after playing is an ordinary
//     lost socket (rule 3), not a stream that could not start.
import type { Camera, IpcError, IpcResult } from '@shared/ipc'
import type { StreamQuality } from '@shared/quality'
import { isHandleCurrent, type StreamHandle, type StreamRuntime } from '@shared/streams'
import { cameraPresentation } from '../state/camerasStore'
import { reconnectDelayMs } from './playerTiming'

/**
 * What the inventory says about this cell's camera (CAM-3). Not a `Camera`: the machine has no
 * business knowing Protect's state strings, and `camerasStore.cameraPresentation` already decides
 * which of these three a `state` means — including for the states Protect has not documented
 * (SPEC R8/R11).
 */
export type CameraAvailability = 'online' | 'connecting' | 'offline'

/**
 * CAM-3, as the machine's three-valued answer, so the component holds no rule about Protect's
 * `state` strings — `cameraPresentation` already decides what each one means, including the ones
 * Protect has not documented (SPEC R8/R11), and it does so for the camera list too, so a cell and
 * its row can never disagree about whether a camera is off.
 *
 * A camera that is not in the inventory **yet** is `connecting`, not `offline`: main pushes the list
 * on connect (CAM-2), and a cell that mounted first would otherwise accuse a healthy camera of
 * being off for a second.
 */
export function cameraAvailability(camera: Camera | undefined): CameraAvailability {
  if (camera === undefined) return 'connecting'
  const presentation = cameraPresentation(camera)
  if (presentation.online) return 'online'
  return presentation.placeholder === 'connecting' ? 'connecting' : 'offline'
}

/**
 * Why there is nothing on screen. Each case is its own short, honest sentence
 * ({@link placeholderText}) rather than one generic "unavailable": they are different things for
 * the person looking at the wall — their camera is off, our gateway is restarting, their console
 * refused us, the gateway could not start the stream, or this camera's encoding cannot be played
 * here (SPEC §5.3, CAM-3, R7).
 */
export type PlayerPlaceholder =
  /** CAM-3: `state` is neither `CONNECTED` nor `CONNECTING`. Nothing to connect to. */
  | { readonly kind: 'camera-offline' }
  /** CAM-3: the console says the camera is coming back. It resumes on its own. */
  | { readonly kind: 'camera-connecting' }
  /** Attached or asking, no first frame yet. The normal first ~0.3–0.65 s (P0.5). */
  | { readonly kind: 'connecting' }
  /** The local go2rtc gateway is not up (`gateway-down`, or a `down` runtime push). Always retrying. */
  | { readonly kind: 'gateway-down' }
  /** SPEC R7: go2rtc offered a mime this build of Chromium cannot decode. `mime` is for the title. */
  | { readonly kind: 'codec-unsupported'; readonly mime: string }
  /** Anything else `ensureStream` answered. Carries main's own one-sentence message. */
  | { readonly kind: 'stream-error'; readonly error: IpcError }
  /**
   * A handle was attached but go2rtc refused the handshake, or no frame arrived within
   * `FIRST_FRAME_TIMEOUT_MS` (rule 6). Deliberately carries **no text from go2rtc**: its error
   * strings can contain the source URL, and the renderer must never show one (CON-2, NFR-9).
   */
  | { readonly kind: 'stream-failed' }

/** One line for the cell. Short enough for a 3×3 cell, specific enough to act on. */
export function placeholderText(placeholder: PlayerPlaceholder): string {
  switch (placeholder.kind) {
    case 'camera-offline':
      return 'Camera offline'
    case 'camera-connecting':
      return 'Camera connecting…'
    case 'connecting':
      return 'Connecting…'
    case 'gateway-down':
      return 'Video service restarting…'
    case 'codec-unsupported':
      return 'Codec not supported'
    case 'stream-error':
      return placeholder.error.message
    case 'stream-failed':
      return 'Stream could not start'
  }
}

/** The mime, the camera id or nothing: what a `title` attribute may add without leaking anything. */
export function placeholderDetail(placeholder: PlayerPlaceholder): string | undefined {
  if (placeholder.kind === 'codec-unsupported') return placeholder.mime
  return undefined
}

/** One attached player element, identified by a number the component uses as its React key. */
export interface PlayerLayer {
  readonly id: number
  /** The handle this layer plays. The only stream information the renderer ever holds. */
  readonly handle: StreamHandle
  /** Set by the first frame. A layer is only ever promoted to `current` once this is true. */
  readonly live: boolean
  /**
   * Its socket is gone (closed, frozen, or from a dead go2rtc epoch), so what is on screen is a
   * still frame. Kept visible until a replacement renders — see rule 3 in the header.
   */
  readonly stale: boolean
}

/** An `ensureStream` call that has been issued or scheduled. At most one at a time. */
export interface PendingEnsure {
  readonly requestId: number
  /** The quality that call asked for, which may already be out of date when it answers. */
  readonly quality: StreamQuality
}

export interface PlayerState {
  readonly cameraId: string
  /** The `quality` **prop** as last seen. Never a constant: see the preamble of src/shared/quality.ts. */
  readonly quality: StreamQuality
  readonly camera: CameraAvailability
  /** `null` until the first `streamRuntime` push: unknown, so worth asking (see {@link needsEnsure}). */
  readonly runtime: StreamRuntime | null
  /** The layer on screen, live or holding its last frame. */
  readonly current: PlayerLayer | null
  /** The candidate: a quality swap, a reconnect or an epoch recovery. Hidden and muted until live. */
  readonly incoming: PlayerLayer | null
  readonly pending: PendingEnsure | null
  /** Consecutive failures, for the backoff. Reset by a first frame and by a new go2rtc runtime. */
  readonly failures: number
  readonly placeholder: PlayerPlaceholder | null
  /** The last `ensureStream` failure, for the placeholder's message. */
  readonly lastError: IpcError | null
  /**
   * SPEC R7, per quality: the mime go2rtc offered for that quality's stream that this build cannot
   * decode. A quality with a verdict is never asked for again until the verdict is cleared (rule 5).
   */
  readonly codecUnsupported: CodecVerdicts
  /**
   * The quality of the last layer that painted a frame — "the stream the viewer was watching", which
   * is where {@link targetQuality} falls back to when the prop's quality cannot be decoded. Survives
   * that layer being dropped, so a fallback can still be reconnected after its frame was given up.
   */
  readonly lastLiveQuality: StreamQuality | null
  /**
   * The last layer failed to start (go2rtc `error` reply or no first frame in time, rule 6). Shown as
   * `stream-failed` while nothing is on screen; cleared by a frame, a quality change, a new runtime,
   * or an `ensureStream` failure (whose own message then says more).
   */
  readonly streamFailed: boolean
  readonly stopped: boolean
  /** Source of layer ids and request ids. One counter, so no id is ever reused for either. */
  readonly nextId: number
}

/** SPEC R7 verdicts, keyed by the quality whose stream offered the mime. */
export type CodecVerdicts = Readonly<Partial<Record<StreamQuality, string>>>

export type PlayerEvent =
  /** Mount, a prop change, or the camera's `state` changed (CAM-2/3). The only way props get in. */
  | { readonly type: 'sync'; readonly quality: StreamQuality; readonly camera: CameraAvailability }
  /** `IPC_EVENTS.streamRuntime`: go2rtc came up (possibly on a new port) or went down. */
  | { readonly type: 'runtime'; readonly runtime: StreamRuntime }
  | {
      readonly type: 'ensured'
      readonly requestId: number
      readonly result: IpcResult<StreamHandle>
    }
  /** This layer has painted a frame. The swap trigger (QUAL-6). */
  | { readonly type: 'firstFrame'; readonly id: number }
  | { readonly type: 'socketClosed'; readonly id: number }
  /** `currentTime` stopped advancing while the socket looked fine (`playerTiming.stallStep`). */
  | { readonly type: 'stalled'; readonly id: number }
  /** SPEC R7: `MediaSource.isTypeSupported` said no to the mime go2rtc answered with. */
  | { readonly type: 'codecUnsupported'; readonly id: number; readonly mime: string }
  /**
   * go2rtc answered the handshake with `{ type: 'error' }` (rule 6). No text: see `stream-failed`.
   * Handled as a lost layer, because the socket stays open and nothing else would ever retry it.
   */
  | { readonly type: 'streamError'; readonly id: number }
  /** No first frame within `FIRST_FRAME_TIMEOUT_MS` of visible time since attach (`paintWindowStep`). */
  | { readonly type: 'firstFrameTimeout'; readonly id: number }
  /** Unmount. Everything closes; nothing is scheduled again. */
  | { readonly type: 'stop' }

export type PlayerCommand =
  /**
   * Call `window.viewProtect.ensureStream({ cameraId, quality })` in `delayMs`, and answer with an
   * `ensured` event carrying this `requestId`. Replaces any ensure already scheduled — there is only
   * ever one, so the executor needs exactly one timer slot.
   */
  | {
      readonly type: 'ensure'
      readonly requestId: number
      readonly cameraId: string
      readonly quality: StreamQuality
      readonly delayMs: number
    }
  /** Drop a scheduled ensure without replacing it. */
  | { readonly type: 'cancelEnsure' }
  /** Create a player element for this layer and point it at `wsUrl` **verbatim** (§5.3). */
  | { readonly type: 'attach'; readonly id: number; readonly wsUrl: string }
  /** Stop this layer's socket and MSE but leave its element on screen, holding its last frame. */
  | { readonly type: 'closeSocket'; readonly id: number }
  /** Tear this layer down completely: socket, MSE, object URL, element. */
  | { readonly type: 'detach'; readonly id: number }

export interface PlayerStep {
  readonly state: PlayerState
  readonly commands: readonly PlayerCommand[]
}

/**
 * The state a freshly mounted player starts in: nothing attached, nothing asked, "Connecting…" on
 * screen. The component's mount effect dispatches the first `sync`, so the camera's availability and
 * the first `ensureStream` take exactly the same path as every later change.
 */
export function initialPlayerState(input: {
  readonly cameraId: string
  readonly quality: StreamQuality
}): PlayerState {
  return {
    cameraId: input.cameraId,
    quality: input.quality,
    camera: 'online',
    runtime: null,
    current: null,
    incoming: null,
    pending: null,
    failures: 0,
    placeholder: { kind: 'connecting' },
    lastError: null,
    codecUnsupported: {},
    lastLiveQuality: null,
    streamFailed: false,
    stopped: false,
    nextId: 1,
  }
}

/** The layer whose element the viewer sees, if any. The component shows the placeholder otherwise. */
export function visibleLayerId(state: PlayerState): number | null {
  return state.current?.id ?? null
}

export function playerStep(state: PlayerState, event: PlayerEvent): PlayerStep {
  // After `stop` nothing may schedule, attach or ask again: a late `ensured` from a call that was
  // already in flight is the one event guaranteed to arrive after unmount, and acting on it is how a
  // remount-per-second grid leaks a WebSocket per remount (gate G2's no-growth half).
  if (state.stopped) return settled(state)

  switch (event.type) {
    case 'sync':
      return onSync(state, event.quality, event.camera)
    case 'runtime':
      return onRuntime(state, event.runtime)
    case 'ensured':
      return onEnsured(state, event.requestId, event.result)
    case 'firstFrame':
      return onFirstFrame(state, event.id)
    case 'socketClosed':
    case 'stalled':
      return onLayerLost(state, event.id, false)
    case 'streamError':
      return onLayerLost(state, event.id, true)
    case 'firstFrameTimeout':
      return onFirstFrameTimeout(state, event.id)
    case 'codecUnsupported':
      return onCodecUnsupported(state, event.id, event.mime)
    case 'stop':
      return onStop(state)
  }
}

// -------------------------------------------------------------------------------------------------
// The one question every path asks

/**
 * The quality the next `ensureStream` is for (rule 5), or `null` when nothing decodable is known.
 *
 *  - the `quality` prop, unless it has an R7 verdict;
 *  - otherwise {@link PlayerState.lastLiveQuality} — the stream the viewer was watching — unless it
 *    has a verdict too. This is what lets a refused `high` swap leave `low` on screen **and** keep it
 *    recoverable: when that `low` later loses its socket, it is `low` that is asked for again;
 *  - otherwise `null`: there is nothing to ask for, and the cell says "Codec not supported".
 */
export function targetQuality(state: PlayerState): StreamQuality | null {
  if (state.codecUnsupported[state.quality] === undefined) return state.quality
  const fallback = state.lastLiveQuality
  if (fallback !== null && state.codecUnsupported[fallback] === undefined) return fallback
  return null
}

/**
 * Should an `ensureStream` go out now?
 *
 * Every recovery path funnels through this predicate instead of deciding for itself, which is what
 * keeps "retry" from meaning six slightly different things. It is false while there is nothing to
 * play towards (stopped, camera not online, gateway down, no decodable {@link targetQuality} —
 * rules 4 and 5), false while a call is already in flight or scheduled, and otherwise true exactly
 * when what is attached is not the target: no layer at all, a `stale` one (rule 3), or one playing
 * another quality (QUAL-6). Comparing with the *target* rather than the prop is what stops a
 * recovered fallback from looping back into the quality that cannot be decoded.
 */
export function needsEnsure(state: PlayerState): boolean {
  if (state.stopped || state.camera !== 'online') return false
  if (state.runtime?.state === 'down') return false
  const target = targetQuality(state)
  if (target === null) return false
  if (state.pending !== null) return false
  if (state.incoming !== null) return state.incoming.handle.quality !== target
  if (state.current === null) return true
  return state.current.stale || state.current.handle.quality !== target
}

// -------------------------------------------------------------------------------------------------
// Event handlers

function onSync(
  state: PlayerState,
  quality: StreamQuality,
  camera: CameraAvailability,
): PlayerStep {
  const qualityChanged = quality !== state.quality
  let next: PlayerState = { ...state, quality, camera }
  if (qualityChanged) {
    next = {
      ...next,
      // Rule 5: asking for a quality again is the viewer's retry of it, so its own verdict goes (a
      // camera's Enhanced Encoding can have been switched off meanwhile, and nothing else would
      // tell us). The others stay: they are still true, and dropping them would send a fallback
      // straight back into a stream that cannot be decoded.
      codecUnsupported: withoutVerdict(next.codecUnsupported, quality),
      lastError: null,
      streamFailed: false,
      failures: 0,
    }
  }

  // CAM-3: the camera itself is the reason there is no video, so stop asking for it and show why.
  if (camera !== 'online') return teardown(next)

  let commands: PlayerCommand[] = []
  if (qualityChanged) {
    // A swap that is still connecting when the prop changes again (low → high → low) is abandoned
    // here, not left to resolve into the wrong quality. `current` is untouched: it is on screen.
    const target = targetQuality(next)
    if (next.incoming !== null && next.incoming.handle.quality !== target) {
      commands.push({ type: 'detach', id: next.incoming.id })
      next = { ...next, incoming: null }
    }
    ;({ state: next, commands } = dropOffTargetEnsure(next, commands))
  }
  return maybeEnsure(next, commands)
}

function onRuntime(state: PlayerState, runtime: StreamRuntime): PlayerStep {
  // A repeat of the runtime already held (main pushes one per renderer load) is not news: nothing it
  // describes has changed, so it must not reset the backoff, drop the call that is out (that would
  // send a duplicate `ensureStream` straight away) or clear an R7 verdict (that would re-try an
  // undecodable swap on every push). Stored, and nothing else.
  if (sameRuntime(state.runtime, runtime)) return settled({ ...state, runtime })

  const next: PlayerState = { ...state, runtime }

  // `down`: go2rtc crashed, is restarting, or was killed (gate G2). Every handle from the previous
  // runtime is void and there is nothing to attach to, so close everything and wait to be told it is
  // back — rather than retrying into a port nothing is listening on.
  if (runtime.state === 'down') return teardown({ ...next, lastError: null })

  const commands: PlayerCommand[] = []
  let recovered: PlayerState = {
    ...next,
    // The failures that led here were against a gateway that may no longer exist.
    failures: 0,
    lastError: null,
    // A new runtime can change every R7 answer: a restarted go2rtc reconnects every producer, and a
    // camera whose Enhanced Encoding was switched meanwhile now offers another codec.
    codecUnsupported: {},
    streamFailed: false,
  }

  // go2rtc takes a **new port on every restart**, so a handle from an older epoch is dead
  // (src/shared/streams.ts, `isHandleCurrent`). An unproven `incoming` is dropped outright; a
  // `current` keeps its last frame and is marked stale, so `needsEnsure` asks for a replacement and
  // rule 1 swaps it in on the new layer's first frame.
  if (recovered.incoming !== null && !isHandleCurrent(recovered.incoming.handle, runtime)) {
    commands.push({ type: 'detach', id: recovered.incoming.id })
    recovered = { ...recovered, incoming: null }
  }
  if (recovered.current !== null && !isHandleCurrent(recovered.current.handle, runtime)) {
    commands.push({ type: 'closeSocket', id: recovered.current.id })
    recovered = { ...recovered, current: { ...recovered.current, stale: true } }
  }
  // A call in flight was answered — or is about to be — by the previous runtime, so its handle would
  // carry the dead port. Dropping it here lets `maybeEnsure` issue a fresh one immediately.
  if (recovered.pending !== null) recovered = { ...recovered, pending: null }

  return maybeEnsure(recovered, commands)
}

function onEnsured(
  state: PlayerState,
  requestId: number,
  result: IpcResult<StreamHandle>,
): PlayerStep {
  // Not the call we are waiting for: a reply from before a quality change, a camera going offline or
  // a go2rtc restart. Attaching it would put the wrong quality — or a dead port — on screen.
  const pending = state.pending
  if (pending === null) return settled(state)
  if (pending.requestId !== requestId) return settled(state)
  const asked = pending.quality
  const cleared: PlayerState = { ...state, pending: null }

  if (!result.ok) {
    // Retried whatever the kind, including the ones main marks non-retryable (a bad API key, an
    // unpinned console): the user fixes those in Settings, and NFR-7/G2 ask for the wall to come
    // back **without a manual restart** when they do. The backoff is what makes that affordable —
    // 10 cells settle to one call each per 15 s. This failure is now the most specific news, so it
    // replaces a "Stream could not start" from an earlier attempt.
    return maybeEnsure(
      {
        ...cleared,
        failures: state.failures + 1,
        lastError: result.error,
        streamFailed: false,
      },
      [],
    )
  }

  const handle = result.value
  // A handle for another camera or another quality is a contract violation, not a stream: the schema
  // in src/shared/streams.ts ties `name` and `wsUrl` to these two fields, so attaching one anyway
  // would be attaching a player to whatever main actually registered. Count it and ask again.
  if (handle.cameraId !== state.cameraId || handle.quality !== asked) {
    return maybeEnsure({ ...cleared, failures: state.failures + 1 }, [])
  }
  // The runtime moved while this call was in flight: this port is already gone (gate G2).
  if (state.runtime !== null && !isHandleCurrent(handle, state.runtime)) {
    return maybeEnsure({ ...cleared, failures: state.failures + 1 }, [])
  }

  const id = cleared.nextId
  const commands: PlayerCommand[] = []
  // Can only happen if a reply raced a new attach; never leave an element nobody tracks behind.
  if (cleared.incoming !== null) commands.push({ type: 'detach', id: cleared.incoming.id })
  commands.push({ type: 'attach', id, wsUrl: handle.wsUrl })
  return settled(
    {
      ...cleared,
      nextId: id + 1,
      incoming: { id, handle, live: false, stale: false },
      lastError: null,
    },
    commands,
  )
}

/**
 * QUAL-6 and FILL-2, in one function: the new layer has painted, so it becomes the visible one and
 * the old one is torn down **in the same step**. Until this event the old stream was playing and
 * visible, which is the whole requirement.
 */
function onFirstFrame(state: PlayerState, id: number): PlayerStep {
  if (state.incoming !== null && state.incoming.id === id) {
    const commands: PlayerCommand[] = []
    if (state.current !== null) commands.push({ type: 'detach', id: state.current.id })
    return settled(
      {
        ...state,
        current: { ...state.incoming, live: true, stale: false },
        incoming: null,
        failures: 0,
        lastError: null,
        streamFailed: false,
        // It decoded, so any verdict on its quality is wrong now (R7), and it is what the viewer is
        // watching — the fallback if the prop's quality turns out to be undecodable.
        codecUnsupported: withoutVerdict(state.codecUnsupported, state.incoming.handle.quality),
        lastLiveQuality: state.incoming.handle.quality,
      },
      commands,
    )
  }
  // A frame on the visible layer: nothing to swap, but it proves the picture is moving again, so a
  // layer that was marked stale by a false-positive stall is live again and the backoff resets.
  if (state.current !== null && state.current.id === id) {
    return settled({
      ...state,
      current: { ...state.current, live: true, stale: false },
      failures: 0,
      streamFailed: false,
    })
  }
  return settled(state)
}

/**
 * A socket closed, the picture froze (NFR-7, and the net under the P0.5 buffer-trim stall), go2rtc
 * refused the handshake or a layer never painted (rule 6). `failedToStart` is the last two: the
 * recovery is the same, only what the viewer is told while nothing is on screen differs — and only
 * for a layer that never went live. A go2rtc error on the `current` layer that has been playing is
 * a stream that *did* start, so it is reported like any other lost socket (rule 3).
 */
function onLayerLost(state: PlayerState, id: number, failedToStart: boolean): PlayerStep {
  const commands: PlayerCommand[] = []
  const report = (layer: PlayerLayer): PlayerState =>
    failedToStart && !layer.live ? { ...state, streamFailed: true, lastError: null } : state

  if (state.incoming !== null && state.incoming.id === id) {
    // Nothing of it was ever seen, so there is nothing to keep: drop it and ask again. `current`, if
    // there is one, stays on screen throughout — a failed swap must not cost the viewer the stream
    // they were already watching (QUAL-6).
    commands.push({ type: 'detach', id })
    return maybeEnsure(
      { ...report(state.incoming), incoming: null, failures: state.failures + 1 },
      commands,
    )
  }

  if (state.current !== null && state.current.id === id) {
    // Rule 3: close the socket (a stalled one is still open and still buffering) but keep the
    // element and its last frame, and let `needsEnsure` ask for the replacement that will swap in.
    commands.push({ type: 'closeSocket', id })
    return maybeEnsure(
      {
        ...report(state.current),
        current: { ...state.current, stale: true },
        failures: state.failures + 1,
      },
      commands,
    )
  }

  // A layer that is already gone — a close event arriving after its own detach. Nothing to do.
  return settled(state)
}

/**
 * Rule 6's paint window ran out. Only an unproven `incoming` can be overdue: `current` was promoted
 * by a frame, and a stale `current` holding its last frame with its socket closed is waiting on
 * purpose (rule 3) — it must never be "lost" a second time for it.
 */
function onFirstFrameTimeout(state: PlayerState, id: number): PlayerStep {
  if (state.incoming?.id !== id || state.incoming.live) return settled(state)
  return onLayerLost(state, id, true)
}

/**
 * SPEC R7: go2rtc will send a mime this build cannot decode for this layer's quality. Retrying
 * cannot change a camera's encoder, so that quality gets a verdict (rule 5) and the machine moves
 * on to the {@link targetQuality}: back to the stream the viewer was watching if it can, otherwise
 * "Codec not supported" instead of a black cell.
 */
function onCodecUnsupported(state: PlayerState, id: number, mime: string): PlayerStep {
  const layer =
    state.incoming?.id === id ? state.incoming : state.current?.id === id ? state.current : null
  if (layer === null) return settled(state)

  let next: PlayerState = {
    ...state,
    codecUnsupported: { ...state.codecUnsupported, [layer.handle.quality]: mime },
  }
  let commands: PlayerCommand[] = [{ type: 'detach', id }]
  if (layer === state.incoming) {
    // A swap to an undecodable stream keeps the stream that *is* playing: the viewer loses the
    // quality change, not the picture.
    next = { ...next, incoming: null }
  } else {
    // Unlike a reconnect, no replacement of *this* quality is coming, so holding its still frame
    // would be a lie.
    next = { ...next, current: null }
  }
  // A call already out for the quality just refused would only attach it again.
  ;({ state: next, commands } = dropOffTargetEnsure(next, commands))
  return maybeEnsure(next, commands)
}

function onStop(state: PlayerState): PlayerStep {
  const { state: closed, commands } = teardown({ ...state, stopped: true })
  return { state: { ...closed, placeholder: null }, commands }
}

// -------------------------------------------------------------------------------------------------
// Shared transitions

/** Issues an `ensureStream` when {@link needsEnsure} says so, and settles the placeholder either way. */
function maybeEnsure(before: PlayerState, input: PlayerCommand[]): PlayerStep {
  const { state, commands } = giveUpOnStaleFrame(before, input)
  if (!needsEnsure(state)) return settled(state, commands)
  const requestId = state.nextId
  // Non-null: `needsEnsure` is false without a target.
  const quality = targetQuality(state) ?? state.quality
  return settled({ ...state, nextId: requestId + 1, pending: { requestId, quality } }, [
    ...commands,
    {
      type: 'ensure',
      requestId,
      cameraId: state.cameraId,
      quality,
      // 0 on the first attempt, then backoff — the whole retry policy, in one number (NFR-7).
      delayMs: reconnectDelayMs(state.failures),
    },
  ])
}

/**
 * How many consecutive failures a frozen `current` layer may be kept on screen for.
 *
 * Keeping the last frame is what makes a reconnect invisible (rule 3), but it must not become a lie:
 * after four attempts — 0 ms, 500 ms, 1 s and 2 s of backoff, so about three and a half seconds of a
 * picture that is not moving — the honest thing is to drop it and say what is wrong, which is what
 * CAM-3 and the `gateway-down` placeholder are for. Long enough that no ordinary go2rtc restart ever
 * reaches it (P2.1 restarts in well under a second), short enough that nobody watches a still frame
 * of a camera that is in fact gone.
 */
export const MAX_STALE_FRAME_FAILURES = 4

/**
 * Drops a frozen `current` once {@link MAX_STALE_FRAME_FAILURES} is reached, so the placeholder can
 * take over. Runs on every retry path, because every one of them goes through {@link maybeEnsure}.
 */
function giveUpOnStaleFrame(
  state: PlayerState,
  commands: PlayerCommand[],
): { state: PlayerState; commands: PlayerCommand[] } {
  const current = state.current
  if (current === null) return { state, commands }
  if (!current.stale || state.failures < MAX_STALE_FRAME_FAILURES) return { state, commands }
  return {
    state: { ...state, current: null },
    commands: [...commands, { type: 'detach', id: current.id }],
  }
}

/**
 * Drops an issued or scheduled `ensureStream` that is no longer for the {@link targetQuality} — a
 * prop change, or a codec verdict on the quality it asked for — so the right call goes out now
 * instead of after the wrong one has answered (and possibly after a 15 s backoff). The reply of a
 * call already in flight is then ignored by its `requestId`.
 */
function dropOffTargetEnsure(
  state: PlayerState,
  commands: PlayerCommand[],
): { state: PlayerState; commands: PlayerCommand[] } {
  if (state.pending === null || state.pending.quality === targetQuality(state)) {
    return { state, commands }
  }
  return { state: { ...state, pending: null }, commands: [...commands, { type: 'cancelEnsure' }] }
}

/** `verdicts` without the one for `quality` (rule 5). */
function withoutVerdict(verdicts: CodecVerdicts, quality: StreamQuality): CodecVerdicts {
  if (verdicts[quality] === undefined) return verdicts
  // The omitted key is bound only so the rest can exist; the lint config has no `ignoreRestSiblings`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [quality]: _omitted, ...rest } = verdicts
  return rest
}

/** Same gateway: both down, or both up on the same port and epoch. `null` (not told yet) is new. */
function sameRuntime(a: StreamRuntime | null, b: StreamRuntime): boolean {
  if (a === null) return false
  if (a.state === 'down' || b.state === 'down') return a.state === b.state
  return a.port === b.port && a.epoch === b.epoch
}

/**
 * Closes everything and asks for nothing: camera offline (CAM-3), gateway down, or unmount. Keeps
 * `failures` at zero so whatever comes back starts with an immediate attempt rather than a 15 s wait.
 */
function teardown(state: PlayerState): PlayerStep {
  const commands: PlayerCommand[] = [{ type: 'cancelEnsure' }]
  if (state.current !== null) commands.push({ type: 'detach', id: state.current.id })
  if (state.incoming !== null) commands.push({ type: 'detach', id: state.incoming.id })
  return settled({ ...state, current: null, incoming: null, pending: null, failures: 0 }, commands)
}

/** Recomputes the placeholder from the state. The only place it is ever set. */
function settled(state: PlayerState, commands: readonly PlayerCommand[] = []): PlayerStep {
  return { state: { ...state, placeholder: placeholderOf(state) }, commands }
}

/**
 * Which placeholder the cell shows, in precedence order — and `null` whenever a layer is on screen,
 * which is the invariant that makes a flash of placeholder unrepresentable (rule 1 in the header).
 */
function placeholderOf(state: PlayerState): PlayerPlaceholder | null {
  if (state.stopped) return null
  // CAM-3 wins over everything: the camera being off is the most specific true statement available,
  // and both of these paths have already detached their layers.
  if (state.camera === 'offline') return { kind: 'camera-offline' }
  if (state.camera === 'connecting') return { kind: 'camera-connecting' }
  if (state.runtime?.state === 'down') return { kind: 'gateway-down' }
  if (state.current !== null) return null
  // R7: nothing decodable to ask for. Named after the quality that was asked for — a fallback that is
  // still connecting is not this case, it is `connecting` (rule 5).
  if (targetQuality(state) === null) {
    return { kind: 'codec-unsupported', mime: state.codecUnsupported[state.quality] ?? '' }
  }
  if (state.lastError !== null) {
    // `gateway-down` is deliberately not a `stream-error`: the camera is fine, nothing in Settings
    // fixes it, and main is already restarting go2rtc (src/shared/ipc.ts on the kind).
    if (state.lastError.kind === 'gateway-down') return { kind: 'gateway-down' }
    return { kind: 'stream-error', error: state.lastError }
  }
  if (state.streamFailed) return { kind: 'stream-failed' }
  return { kind: 'connecting' }
}
