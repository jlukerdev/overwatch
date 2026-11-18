// `<LivePlayer cameraId quality muted volume? fit? />` — one camera, one quality, live (P2.3; QUAL-6, FILL-2,
// CAM-3, NFR-5/7, R1/R7, gate G2).
//
// The shell around `playerMachine.ts`. It does three jobs and holds no rules of its own: turn props
// and DOM events into {@link PlayerEvent}s, carry out the {@link PlayerCommand}s that come back, and
// render the placeholder the machine asks for. Everything that can be *wrong* about a live player —
// when to ask for a stream, when to swap, when to retry, what the viewer is told — is in the machine
// or in `mseBuffer.ts` / `playerTiming.ts`, because this project has no jsdom and no
// testing-library (vitest.config.mts, CLAUDE.md): a rule that lives in a `useEffect` is a rule no
// test can reach.
//
// **`quality` is a prop, never a constant** (the QUAL preamble in src/shared/quality.ts). There is no
// quality literal anywhere in this file, and the component has no default for it: the caller
// resolves it with `resolveGridQuality` / `resolveFillQuality` (P3) and a change of that prop is the
// seamless swap of QUAL-6.
//
// **The player sees a handle and nothing else** (SPEC §5.3 "Renderer isolation", CON-2, NFR-9). The
// one input to the element is `handle.wsUrl`, passed through verbatim: no RTSPS URL, no go2rtc
// credential, no port and no stream name are read, built or stored here. Main injects
// `Authorization` into that exact loopback URL in `onBeforeSendHeaders`, so a URL assembled here
// would silently lose its credentials — and a renderer that can compose stream URLs can compose one
// for a camera no View asked for.
//
// **Two layers, one visible.** The container holds the current element and, during a swap, the
// incoming one underneath it with `--pending` (attached, decoding, hidden and muted). The machine
// promotes it on its first frame and drops the old one in the same step, which is what QUAL-6's
// "keeps playing until the new one renders its first frame" means in DOM terms.
//
// **Audio** (P5.1; AUD-1/2/3). `muted` and `volume` are the caller's — the single-active-audio rule
// is state/audioStore.ts, applied by `<GridView>` / `<Cell>` — and both are element properties set by
// the controller, never effect dependencies of the stream: a mute or a volume drag never reconnects.
// Whatever `muted` says, only the visible layer can be heard: an incoming (`--pending`) layer is
// always muted (`applyLayerRoles`).
import { useEffect, useRef, useState, type JSX } from 'react'
import type { IpcError } from '@shared/ipc'
import type { Fit } from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import { useAppStore } from '../state/appStore'
import { createMsePlayer, type MsePlayer } from './MsePlayer'
import {
  cameraAvailability,
  initialPlayerState,
  placeholderDetail,
  placeholderText,
  playerStep,
  type PlayerCommand,
  type PlayerEvent,
  type PlayerPlaceholder,
  type PlayerState,
} from './playerMachine'
import {
  openPaintWindow,
  paintWindowStep,
  stallStep,
  STALL_POLL_MS,
  type PaintWindow,
  type StallState,
} from './playerTiming'
import './player.css'

export interface LivePlayerProps {
  readonly cameraId: string
  /** The **effective** quality, resolved by the caller (QUAL-2/3/5). Changing it swaps seamlessly. */
  readonly quality: StreamQuality
  /** The single-active-audio policy is the caller's (AUD-1/2, header); this is just the element's state. */
  readonly muted: boolean
  /** AUD-3: 0…1, already clamped (state/audioStore.ts). Default 1. Never rebuilds the player. */
  readonly volume?: number
  /**
   * VIEW-5: how a picture whose shape is not the box's sits in it — letterboxed (`contain`, the
   * default: never hide part of a camera unless asked) or cropped to fill (`cover`). Pure CSS on the
   * `<video>`s (player.css), so changing it never touches the stream.
   */
  readonly fit?: Fit
}

export function LivePlayer({
  cameraId,
  quality,
  muted,
  volume = 1,
  fit = 'contain',
}: LivePlayerProps): JSX.Element {
  // CAM-3 comes from the inventory's `state`, never from whether a stream started: `camerasStore`
  // already decides what each Protect state means, including the undocumented ones (SPEC R8/R11).
  const camera = useAppStore((state) => state.cameras.find((entry) => entry.id === cameraId))
  const availability = cameraAvailability(camera)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<PlayerController | null>(null)
  const [placeholder, setPlaceholder] = useState<PlayerPlaceholder | null>(() => ({
    kind: 'connecting',
  }))

  // Props for the controller's construction only. A ref rather than effect dependencies: the
  // controller owns DOM elements and a WebSocket, so it must be built once per camera and not torn
  // down because `muted` or `volume` changed (every rebuild is a reconnect the viewer sees).
  const propsRef = useRef({ quality, muted, volume, availability })
  useEffect(() => {
    propsRef.current = { quality, muted, volume, availability }
  }, [quality, muted, volume, availability])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined
    const controller = createPlayerController({
      container,
      cameraId,
      quality: propsRef.current.quality,
      muted: propsRef.current.muted,
      volume: propsRef.current.volume,
      onPlaceholder: setPlaceholder,
    })
    controllerRef.current = controller

    // Gate G2's "streams recover by themselves after go2rtc is killed": a restart takes a new port,
    // so the handle this player holds is dead and only this push says so (src/shared/streams.ts).
    const offRuntime = window.viewProtect.onStreamRuntime((runtime) => {
      controller.dispatch({ type: 'runtime', runtime })
    })
    // One timer for this player's layers, for the two failures a socket cannot report because it
    // stays open while nothing decodes: a frozen picture (playerTiming.STALL_GRACE_MS) and a layer
    // that never paints at all (playerTiming.FIRST_FRAME_TIMEOUT_MS).
    const stallTimer = setInterval(() => {
      controller.pollStalls()
    }, STALL_POLL_MS)

    return () => {
      clearInterval(stallTimer)
      offRuntime()
      // Closes both layers' sockets, detaches MSE, revokes the object URLs and drops the elements.
      // A player that leaked a socket per remount would fail G2's 30-minute no-growth half.
      controller.dispose()
      controllerRef.current = null
    }
  }, [cameraId])

  // Mount, a quality change (QUAL-6) and a camera going offline or coming back (CAM-2/3) are one
  // event: the machine compares what is attached with what is asked for and decides.
  useEffect(() => {
    controllerRef.current?.dispatch({ type: 'sync', quality, camera: availability })
  }, [cameraId, quality, availability])

  // One update for both, so an unmute never plays a moment at the old level: the volume is on the
  // element before, or with, `muted` turning off.
  useEffect(() => {
    controllerRef.current?.setAudio(muted, volume)
  }, [muted, volume])

  return (
    <div className={fit === 'cover' ? 'livePlayer livePlayer--cover' : 'livePlayer'}>
      <div className="livePlayer__layers" ref={containerRef} />
      {placeholder === null ? null : (
        <div className="livePlayer__placeholder" title={placeholderDetail(placeholder)}>
          {placeholderText(placeholder)}
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// The command executor
//
// Imperative on purpose. React renders the placeholder; the two player elements are created,
// appended, muted, hidden and destroyed by hand, because they own a WebSocket, a `MediaSource` and a
// decoder whose lifetimes must follow the machine's commands exactly — not React's reconciliation of
// a keyed list, which is free to unmount and remount an element (i.e. drop and reopen a stream) when
// the surrounding tree changes. The only thing that crosses into React state is the placeholder.

interface PlayerController {
  dispatch: (event: PlayerEvent) => void
  pollStalls: () => void
  /** The visible layer's audio: volume applied first, then `muted` (header). */
  setAudio: (muted: boolean, volume: number) => void
  dispose: () => void
}

/**
 * One attached layer: its element, its stall bookkeeping and its paint window.
 *
 * There is no "timeout already reported" flag: the machine answers the first `firstFrameTimeout`
 * for an unproven `incoming` by detaching it, which removes it from `layers` inside that same
 * dispatch, so it is never sampled again. Every other layer the machine keeps has painted (only a
 * first frame promotes a layer to `current`), and a painted layer is never overdue.
 */
interface ControllerLayer {
  readonly element: MsePlayer
  stall: StallState | null
  /** Visible time since attach, for `paintWindowStep` (hidden time does not count). */
  paint: PaintWindow
}

/** Class that hides a layer that has not rendered its first frame yet. See player.css. */
const PENDING_LAYER_CLASS = 'livePlayer__layer--pending'

function createPlayerController(input: {
  readonly container: HTMLDivElement
  readonly cameraId: string
  readonly quality: StreamQuality
  readonly muted: boolean
  readonly volume: number
  readonly onPlaceholder: (placeholder: PlayerPlaceholder | null) => void
}): PlayerController {
  let state: PlayerState = initialPlayerState({
    cameraId: input.cameraId,
    quality: input.quality,
  })
  let muted = input.muted
  let volume = input.volume
  let disposed = false
  const layers = new Map<number, ControllerLayer>()
  /** At most one `ensureStream` is ever scheduled (see the `ensure` command), so one slot. */
  let ensureTimer: ReturnType<typeof setTimeout> | null = null

  const dispatch = (event: PlayerEvent): void => {
    // A reply from a call that was already in flight at unmount, or a close event from an element
    // being torn down. Dropping them here is what keeps the executor from attaching an element to a
    // container React has already removed.
    if (disposed) return
    const previous = state.placeholder
    const step = playerStep(state, event)
    state = step.state
    for (const command of step.commands) execute(command)
    applyLayerRoles()
    if (!samePlaceholder(previous, state.placeholder)) input.onPlaceholder(state.placeholder)
  }

  const execute = (command: PlayerCommand): void => {
    switch (command.type) {
      case 'ensure':
        clearEnsureTimer()
        if (command.delayMs <= 0) {
          askForStream(command.requestId, command.quality)
        } else {
          ensureTimer = setTimeout(() => {
            ensureTimer = null
            askForStream(command.requestId, command.quality)
          }, command.delayMs)
        }
        return
      case 'cancelEnsure':
        clearEnsureTimer()
        return
      case 'attach':
        attach(command.id, command.wsUrl)
        return
      case 'closeSocket':
        layers.get(command.id)?.element.stopStream()
        return
      case 'detach': {
        const layer = layers.get(command.id)
        layers.delete(command.id)
        layer?.element.teardown()
        return
      }
    }
  }

  const askForStream = (requestId: number, quality: StreamQuality): void => {
    const ask = async (): Promise<void> => {
      // The whole of the renderer's stream vocabulary: a camera id and a quality out, a handle in.
      const result = await window.viewProtect.ensureStream({ cameraId: input.cameraId, quality })
      dispatch({ type: 'ensured', requestId, result })
    }
    void ask().catch((error: unknown) => {
      // Rule 2 of the IPC contract says failure is a value, and the preload already turns a rejected
      // `invoke` into one. This is the belt: a throw must become a retryable placeholder, not an
      // unhandled rejection that leaves the cell stuck on "Connecting…" forever.
      dispatch({ type: 'ensured', requestId, result: { ok: false, error: bridgeFailure(error) } })
    })
  }

  const attach = (id: number, wsUrl: string): void => {
    const element = createMsePlayer()
    element.classList.add('livePlayer__layer', PENDING_LAYER_CLASS)
    element.setHooks({
      onFirstFrame: () => {
        dispatch({ type: 'firstFrame', id })
      },
      onSocketClosed: () => {
        dispatch({ type: 'socketClosed', id })
      },
      onCodecUnsupported: (mime) => {
        dispatch({ type: 'codecUnsupported', id, mime })
      },
      onStreamError: () => {
        dispatch({ type: 'streamError', id })
      },
    })
    layers.set(id, {
      element,
      stall: null,
      paint: openPaintWindow(performance.now(), document.hidden),
    })
    // In the DOM first: the element connects the moment `start` assigns `src`, and upstream's
    // `onconnect()` refuses while the element is disconnected.
    input.container.append(element)
    element.start(wsUrl)
  }

  /** Mirrors the machine's two slots onto the elements: visible and audible, or hidden and muted. */
  const applyLayerRoles = (): void => {
    const visibleId = state.current?.id ?? null
    for (const [id, layer] of layers) {
      const visible = id === visibleId
      layer.element.classList.toggle(PENDING_LAYER_CLASS, !visible)
      // A layer that is not the one on screen is always muted, whatever `muted` says: a swap would
      // otherwise play two copies of the same camera's audio for as long as it takes to render a
      // frame. The single-active-audio policy across cells is the caller's (AUD-2, header). The
      // volume is the same on every layer, so a promoted layer is already at it, and it is set
      // before `muted` so an unmute starts at the right level.
      layer.element.setVolume(volume)
      layer.element.setMuted(visible ? muted : true)
    }
  }

  const clearEnsureTimer = (): void => {
    if (ensureTimer === null) return
    clearTimeout(ensureTimer)
    ensureTimer = null
  }

  // The initial placeholder, published once at creation. `dispatch` only notifies on a *change*
  // from the controller's own previous value, so without this the state a fresh controller starts
  // in — "Connecting…" — never reaches React, while `dispose()` does push `null` into the same
  // state. The cell would then be blank rather than connecting: on every StrictMode double-mount in
  // dev, and in production whenever `cameraId` changes and a new controller replaces the old one
  // (a grid cell reused for another camera, P2.4).
  input.onPlaceholder(state.placeholder)

  return {
    dispatch,
    pollStalls: () => {
      const atMs = performance.now()
      const hidden = document.hidden
      for (const [id, layer] of layers) {
        const sample = layer.element.sample()
        const step = stallStep(layer.stall, { ...sample, atMs })
        layer.stall = step.state
        // Forces a reattach rather than sitting on a frozen frame: the machine closes this layer's
        // socket, keeps its last frame on screen and asks for a fresh handle (NFR-7).
        if (step.stalled) dispatch({ type: 'stalled', id })
        // A layer that has painted is never overdue, so a stale `current` holding its last frame
        // with its socket closed is left alone here (and the machine ignores anything but an
        // unproven `incoming` regardless). Only visible time counts: the first-frame callback does
        // not run while the window is hidden (playerTiming.PaintWindow).
        const paint = paintWindowStep(layer.paint, { nowMs: atMs, hidden, painted: sample.painted })
        layer.paint = paint.state
        if (paint.overdue) dispatch({ type: 'firstFrameTimeout', id })
      }
    },
    setAudio: (nextMuted: boolean, nextVolume: number) => {
      muted = nextMuted
      volume = nextVolume
      applyLayerRoles()
    },
    dispose: () => {
      // `stop` detaches both layers and cancels the scheduled call; `disposed` then silences every
      // callback that was already in flight.
      dispatch({ type: 'stop' })
      disposed = true
      clearEnsureTimer()
      // Belt and braces: anything the machine did not know about still gets closed.
      for (const layer of layers.values()) layer.element.teardown()
      layers.clear()
    },
  }
}

/** A throw out of the bridge, as the value the placeholder can show (see `askForStream`). */
function bridgeFailure(error: unknown): IpcError {
  // Logged in full for whoever has devtools open; the message shown is ours, because main's
  // messages are the ones written for a person and this failure never reached main.
  console.error('[LivePlayer] ensureStream threw', error)
  return {
    kind: 'internal',
    message: 'The app could not ask for this stream.',
    endpoint: null,
    retryable: true,
  }
}

/** Value equality, so an unchanged placeholder does not re-render the cell on every event. */
function samePlaceholder(a: PlayerPlaceholder | null, b: PlayerPlaceholder | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'codec-unsupported' && b.kind === 'codec-unsupported') return a.mime === b.mime
  if (a.kind === 'stream-error' && b.kind === 'stream-error') {
    return a.error.kind === b.error.kind && a.error.message === b.error.message
  }
  return true
}
