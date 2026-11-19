// P2.3: the live player's whole lifecycle (QUAL-6, FILL-2, CAM-3, NFR-7, R7, gate G2).
//
// `LivePlayer.tsx` is a shell: it turns props and DOM events into the events below and carries out
// the commands that come back. This project has no jsdom and no testing-library (vitest.config.mts),
// and there is no `MediaSource`, no `WebSocket` and no go2rtc here — so the component itself cannot
// be rendered in a test at all, which is the reason every rule about *when* to ask for a stream,
// *when* to swap, *when* to retry and *what the viewer is told* lives in `playerMachine.ts`.
//
// What these tests protect:
//  - `ensureStream` on mount and on every quality change, with the quality that was asked for.
//  - QUAL-6/FILL-2: the old stream stays attached and visible until the new one's first frame, and
//    no placeholder is ever shown over a layer that is on screen.
//  - gate G2: a new go2rtc epoch re-asks and reattaches (the old port is dead), and a `down` runtime
//    detaches everything and stops retrying until it is back.
//  - every placeholder state and its trigger, including R7's codec-unsupported and stream-failed.
//  - R7 verdicts scoped to the quality that failed, with the fallback to the stream on screen.
//  - a go2rtc handshake error and a layer that never paints both retry on the backoff.
//  - the reconnect backoff on a closed socket and the stall detector forcing a reattach.
//  - NFR-7 (P6.2): a `recover` retries a waiting player now, leaves a healthy one alone and drops a
//    frozen frame rather than restarting its count.
//  - teardown: everything closes on unmount and a late reply changes nothing.
//  - that the only stream information the component ever handles is a `StreamHandle`: the attach
//    command carries `handle.wsUrl` verbatim, never a URL built from parts.
import type { IpcError, IpcResult } from '@shared/ipc'
import type { Camera } from '@shared/models'
import type { StreamQuality } from '@shared/quality'
import { go2rtcWsUrl, streamHandle, streamName, type StreamHandle } from '@shared/streams'
import { describe, expect, it } from 'vitest'
import {
  cameraAvailability,
  initialPlayerState,
  MAX_STALE_FRAME_FAILURES,
  needsEnsure,
  placeholderText,
  playerStep,
  visibleLayerId,
  type PlayerCommand,
  type PlayerEvent,
  targetQuality,
  type PlayerState,
  type PlayerStep,
} from '../../src/renderer/src/player/playerMachine'
import { reconnectDelayMs } from '../../src/renderer/src/player/playerTiming'

const CAMERA_ID = 'abcdef0123456789abcdef01'
const PORT = 51234
const NEW_PORT = 51999

function handle(input: {
  quality: StreamQuality
  port?: number
  epoch?: number
  cameraId?: string
}): StreamHandle {
  return streamHandle({
    cameraId: input.cameraId ?? CAMERA_ID,
    quality: input.quality,
    port: input.port ?? PORT,
    epoch: input.epoch ?? 1,
  })
}

const error = (kind: IpcError['kind'], message: string): IpcError => ({
  kind,
  message,
  endpoint: null,
  retryable: true,
})

const failed = (kind: IpcError['kind'], message: string): IpcResult<StreamHandle> => ({
  ok: false,
  error: error(kind, message),
})

/** Steps the machine, keeping the step so a test can read both the state and the commands. */
const next = (step: PlayerStep, event: PlayerEvent): PlayerStep => playerStep(step.state, event)

const start = (quality: StreamQuality): PlayerStep => ({
  state: initialPlayerState({ cameraId: CAMERA_ID, quality }),
  commands: [],
})

const types = (step: PlayerStep): string[] => step.commands.map((command) => command.type)

const only = <T extends PlayerCommand['type']>(
  step: PlayerStep,
  type: T,
): Extract<PlayerCommand, { type: T }>[] =>
  step.commands.filter(
    (command): command is Extract<PlayerCommand, { type: T }> => command.type === type,
  )

const oneEnsure = (step: PlayerStep): Extract<PlayerCommand, { type: 'ensure' }> => {
  const ensures = only(step, 'ensure')
  expect(ensures).toHaveLength(1)
  const ensure = ensures[0]
  if (ensure === undefined) throw new Error('no ensure command')
  return ensure
}

const attachedId = (step: PlayerStep): number => {
  const attaches = only(step, 'attach')
  expect(attaches).toHaveLength(1)
  const attach = attaches[0]
  if (attach === undefined) throw new Error('no attach command')
  return attach.id
}

const detachedIds = (step: PlayerStep): number[] => only(step, 'detach').map((c) => c.id)
const closedIds = (step: PlayerStep): number[] => only(step, 'closeSocket').map((c) => c.id)

/** Mount → ensure → attach → first frame: a player live on `quality`, like every later test needs. */
function live(quality: StreamQuality, epoch = 1, port = PORT): PlayerStep {
  const mounted = next(start(quality), { type: 'sync', quality, camera: 'online' })
  const ensure = oneEnsure(mounted)
  const answered = next(mounted, {
    type: 'ensured',
    requestId: ensure.requestId,
    result: { ok: true, value: handle({ quality, epoch, port }) },
  })
  const id = attachedId(answered)
  const playing = next(answered, { type: 'firstFrame', id })
  expect(visibleLayerId(playing.state)).toBe(id)
  expect(playing.state.placeholder).toBeNull()
  return playing
}

const camera = (state: string): Camera => ({
  id: CAMERA_ID,
  name: 'Carport',
  model: 'G4 Instant',
  state,
  hasMic: true,
  micEnabled: true,
  hasSpeaker: false,
  smartDetectTypes: [],
  supportsFullHdSnapshot: false,
  hasPackageCamera: false,
})

// -------------------------------------------------------------------------------------------------

describe('ensureStream (QUAL-8)', () => {
  it('asks for the camera and quality it was mounted with, immediately', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const ensure = oneEnsure(mounted)
    expect(ensure.cameraId).toBe(CAMERA_ID)
    expect(ensure.quality).toBe('low')
    // No wait for the first attempt: a wall of ten cells must not sleep before it starts.
    expect(ensure.delayMs).toBe(0)
  })

  it('asks again, for the new quality, when the quality prop changes (QUAL-6)', () => {
    const playing = live('low')
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const ensure = oneEnsure(swapping)
    expect(ensure.quality).toBe('high')
    expect(ensure.delayMs).toBe(0)
  })

  it('does not ask twice while a call is in flight', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const again = next(mounted, { type: 'sync', quality: 'low', camera: 'online' })
    expect(types(again)).toEqual([])
  })

  it('does not ask again once the requested quality is live', () => {
    const playing = live('medium')
    const idle = next(playing, { type: 'sync', quality: 'medium', camera: 'online' })
    expect(types(idle)).toEqual([])
    expect(needsEnsure(idle.state)).toBe(false)
  })

  it('attaches to handle.wsUrl verbatim, never to a URL of its own making', () => {
    const playing = live('high')
    const attached = playing.state.current
    expect(attached).not.toBeNull()
    const expected = go2rtcWsUrl(PORT, streamName(CAMERA_ID, 'high'))
    expect(attached?.handle.wsUrl).toBe(expected)
  })

  it('refuses a handle for another camera or another quality', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const ensure = oneEnsure(mounted)
    const wrong = next(mounted, {
      type: 'ensured',
      requestId: ensure.requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    expect(types(wrong)).toEqual(['ensure'])
    expect(wrong.state.incoming).toBeNull()
  })

  it('ignores a reply from a call it is no longer waiting for', () => {
    const playing = live('low')
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const ensure = oneEnsure(swapping)
    const stale = next(swapping, {
      type: 'ensured',
      requestId: ensure.requestId - 1,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    expect(types(stale)).toEqual([])
  })
})

describe('the seamless swap (QUAL-6, FILL-2)', () => {
  it('keeps the old stream attached and visible until the new one renders a frame', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state)

    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    // Nothing is torn down and nothing is hidden just because the prop changed.
    expect(types(swapping)).toEqual(['ensure'])
    expect(visibleLayerId(swapping.state)).toBe(oldId)
    expect(swapping.state.placeholder).toBeNull()

    const attaching = next(swapping, {
      type: 'ensured',
      requestId: oneEnsure(swapping).requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    const newId = attachedId(attaching)
    // Two layers now: the old one still on screen, the new one attached but not yet promoted.
    expect(visibleLayerId(attaching.state)).toBe(oldId)
    expect(attaching.state.incoming?.id).toBe(newId)
    expect(attaching.state.placeholder).toBeNull()
    expect(detachedIds(attaching)).toEqual([])

    const swapped = next(attaching, { type: 'firstFrame', id: newId })
    // The frame is the trigger: promote and retire in the same step, so there is no gap.
    expect(visibleLayerId(swapped.state)).toBe(newId)
    expect(detachedIds(swapped)).toEqual([oldId])
    expect(swapped.state.incoming).toBeNull()
    expect(swapped.state.current?.handle.quality).toBe('high')
    expect(swapped.state.placeholder).toBeNull()
  })

  it('abandons a half-finished swap when the prop changes back', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state)
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = next(swapping, {
      type: 'ensured',
      requestId: oneEnsure(swapping).requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    const pendingId = attachedId(attaching)

    const back = next(attaching, { type: 'sync', quality: 'low', camera: 'online' })
    // The unproven layer goes; the one the viewer is watching does not.
    expect(detachedIds(back)).toEqual([pendingId])
    expect(visibleLayerId(back.state)).toBe(oldId)
    expect(back.state.placeholder).toBeNull()
    // `low` is already on screen, so there is nothing to ask for.
    expect(only(back, 'ensure')).toHaveLength(0)
  })

  it('keeps the old stream when the swap fails', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state)
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const refused = next(swapping, {
      type: 'ensured',
      requestId: oneEnsure(swapping).requestId,
      result: failed('server', 'The console could not start that stream.'),
    })
    expect(visibleLayerId(refused.state)).toBe(oldId)
    // No placeholder over live video, and it keeps trying for the quality that was asked for.
    expect(refused.state.placeholder).toBeNull()
    expect(oneEnsure(refused).quality).toBe('high')
  })

  it('shows Connecting… only while there is nothing on screen at all', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    expect(mounted.state.placeholder).toEqual({ kind: 'connecting' })
    const attaching = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    expect(attaching.state.placeholder).toEqual({ kind: 'connecting' })
    const playing = next(attaching, { type: 'firstFrame', id: attachedId(attaching) })
    expect(playing.state.placeholder).toBeNull()
  })
})

describe('reconnect (NFR-7)', () => {
  it('re-asks for a handle when the socket closes, and keeps the last frame on screen', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state)
    const dropped = next(playing, { type: 'socketClosed', id: id ?? 0 })

    // The socket is closed, the element is not: a placeholder here would be a flash for the ~0.3 s
    // a reconnect takes (P0.5 first-frame figures).
    expect(closedIds(dropped)).toEqual([id])
    expect(detachedIds(dropped)).toEqual([])
    expect(visibleLayerId(dropped.state)).toBe(id)
    expect(dropped.state.placeholder).toBeNull()
    // A fresh `ensureStream`, not a re-open of the same URL: the port may already belong to someone
    // else (src/shared/streams.ts on `epoch`).
    expect(oneEnsure(dropped).quality).toBe('low')
  })

  it('backs off while the failures continue, and resets on a frame', () => {
    let step = live('low')
    const id = visibleLayerId(step.state) ?? 0
    step = next(step, { type: 'socketClosed', id })
    expect(oneEnsure(step).delayMs).toBe(reconnectDelayMs(1))

    const delays: number[] = []
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      const ensure = oneEnsure(step)
      step = next(step, {
        type: 'ensured',
        requestId: ensure.requestId,
        result: failed('gateway-down', 'The video service is not running.'),
      })
      delays.push(oneEnsure(step).delayMs)
    }
    expect(delays).toEqual([2, 3, 4, 5, 6, 7, 8].map(reconnectDelayMs))

    // A handle at last, and a frame: the next failure starts from zero again.
    const attaching = next(step, {
      type: 'ensured',
      requestId: oneEnsure(step).requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    const newId = attachedId(attaching)
    const recovered = next(attaching, { type: 'firstFrame', id: newId })
    expect(recovered.state.failures).toBe(0)
    const droppedAgain = next(recovered, { type: 'socketClosed', id: newId })
    expect(oneEnsure(droppedAgain).delayMs).toBe(reconnectDelayMs(1))
  })

  it('stops holding a frozen frame once it has become a lie, and says why', () => {
    let step = live('low')
    const id = visibleLayerId(step.state) ?? 0
    step = next(step, { type: 'socketClosed', id })

    // The still frame is kept while a replacement is plausible…
    for (let failure = 1; failure < MAX_STALE_FRAME_FAILURES; failure += 1) {
      expect(visibleLayerId(step.state)).toBe(id)
      expect(step.state.placeholder).toBeNull()
      step = next(step, {
        type: 'ensured',
        requestId: oneEnsure(step).requestId,
        result: failed('gateway-down', 'The video service is not running.'),
      })
    }
    // …and dropped once it is not, so the cell shows the reason instead of a frozen picture.
    expect(detachedIds(step)).toEqual([id])
    expect(visibleLayerId(step.state)).toBeNull()
    expect(step.state.placeholder).toEqual({ kind: 'gateway-down' })
    expect(only(step, 'ensure')).toHaveLength(1)
  })

  it('drops a layer that never rendered, rather than keeping a blank element', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    const id = attachedId(attaching)
    const dropped = next(attaching, { type: 'socketClosed', id })
    expect(detachedIds(dropped)).toEqual([id])
    expect(dropped.state.incoming).toBeNull()
    expect(oneEnsure(dropped).delayMs).toBe(reconnectDelayMs(1))
  })

  it('ignores a close from a layer that is already gone', () => {
    const playing = live('low')
    const unknown = next(playing, { type: 'socketClosed', id: 999 })
    expect(types(unknown)).toEqual([])
  })
})

describe('stall detection', () => {
  it('forces a reattach instead of sitting on a frozen frame', () => {
    const playing = live('high')
    const id = visibleLayerId(playing.state) ?? 0
    const frozen = next(playing, { type: 'stalled', id })

    // The socket is still open when a stream freezes (the P0.5 `DEMUXER_UNDERFLOW`), so it has to be
    // closed explicitly — and the element stays, holding its last frame, until the new one renders.
    expect(closedIds(frozen)).toEqual([id])
    expect(visibleLayerId(frozen.state)).toBe(id)
    expect(frozen.state.current?.stale).toBe(true)
    expect(frozen.state.placeholder).toBeNull()
    const ensure = oneEnsure(frozen)
    expect(ensure.quality).toBe('high')

    const attaching = next(frozen, {
      type: 'ensured',
      requestId: ensure.requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    const newId = attachedId(attaching)
    const swapped = next(attaching, { type: 'firstFrame', id: newId })
    expect(detachedIds(swapped)).toEqual([id])
    expect(visibleLayerId(swapped.state)).toBe(newId)
  })

  it('treats a frame on the visible layer as proof it is alive again', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const frozen = next(playing, { type: 'stalled', id })
    const moving = next(frozen, { type: 'firstFrame', id })
    expect(moving.state.current?.stale).toBe(false)
    expect(moving.state.failures).toBe(0)
  })
})

describe('the go2rtc runtime (gate G2)', () => {
  it('re-asks and reattaches when go2rtc comes back on a new port', () => {
    const playing = live('low', 1, PORT)
    const oldId = visibleLayerId(playing.state) ?? 0

    const restarted = next(playing, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 2 },
    })
    // The handle it holds is from epoch 1: its port is dead, so its socket is closed — but its last
    // frame stays while the replacement connects.
    expect(closedIds(restarted)).toEqual([oldId])
    expect(detachedIds(restarted)).toEqual([])
    expect(visibleLayerId(restarted.state)).toBe(oldId)
    expect(restarted.state.placeholder).toBeNull()
    const ensure = oneEnsure(restarted)
    expect(ensure.delayMs).toBe(0)

    const attaching = next(restarted, {
      type: 'ensured',
      requestId: ensure.requestId,
      result: { ok: true, value: handle({ quality: 'low', port: NEW_PORT, epoch: 2 }) },
    })
    const newId = attachedId(attaching)
    expect(attaching.state.incoming?.handle.port).toBe(NEW_PORT)
    const swapped = next(attaching, { type: 'firstFrame', id: newId })
    expect(detachedIds(swapped)).toEqual([oldId])
    expect(visibleLayerId(swapped.state)).toBe(newId)
  })

  it('does nothing when told about the runtime it is already on', () => {
    const playing = live('low', 1, PORT)
    const same = next(playing, { type: 'runtime', runtime: { state: 'up', port: PORT, epoch: 1 } })
    expect(types(same)).toEqual([])
    expect(same.state.placeholder).toBeNull()
  })

  it('a repeat of the runtime it holds keeps the backoff and the call that is out', () => {
    const runtime = { state: 'up', port: PORT, epoch: 1 } as const
    // Mounted, then told the runtime: the first push is news, so it is that push that asks.
    const synced = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const mounted = next(synced, { type: 'runtime', runtime })
    const refused = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: failed('server', 'The console could not start that stream.'),
    })
    const scheduled = oneEnsure(refused)
    expect(scheduled.delayMs).toBe(reconnectDelayMs(1))

    const repeat = next(refused, { type: 'runtime', runtime })
    // No duplicate `ensureStream`, no reset to an immediate retry, the message stays.
    expect(types(repeat)).toEqual([])
    expect(repeat.state.failures).toBe(1)
    expect(repeat.state.pending?.requestId).toBe(scheduled.requestId)
    expect(repeat.state.lastError).toEqual(refused.state.lastError)
    expect(repeat.state.placeholder).toEqual(refused.state.placeholder)

    // …and the reply to that call is still the one that counts.
    const recovered = next(repeat, {
      type: 'ensured',
      requestId: scheduled.requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    expect(only(recovered, 'attach')).toHaveLength(1)
  })

  it('a repeat of the runtime it holds keeps "Stream could not start"', () => {
    const runtime = { state: 'up', port: PORT, epoch: 1 } as const
    const synced = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(next(synced, { type: 'runtime', runtime }))
    const refused = next(attaching, { type: 'streamError', id: attachedId(attaching) })
    const repeat = next(refused, { type: 'runtime', runtime })
    expect(types(repeat)).toEqual([])
    expect(repeat.state.streamFailed).toBe(true)
    expect(repeat.state.failures).toBe(refused.state.failures)
    expect(repeat.state.placeholder).toEqual({ kind: 'stream-failed' })
  })

  it('refuses a handle from an epoch that has already been superseded', () => {
    const playing = live('low', 1, PORT)
    const restarted = next(playing, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 2 },
    })
    const stale = next(restarted, {
      type: 'ensured',
      requestId: oneEnsure(restarted).requestId,
      // A reply that was already in flight when go2rtc restarted.
      result: { ok: true, value: handle({ quality: 'low', port: PORT, epoch: 1 }) },
    })
    expect(only(stale, 'attach')).toHaveLength(0)
    expect(oneEnsure(stale).delayMs).toBe(reconnectDelayMs(1))
  })

  it('detaches everything and stops asking while the gateway is down', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state) ?? 0
    const down = next(playing, { type: 'runtime', runtime: { state: 'down' } })

    expect(detachedIds(down)).toEqual([oldId])
    expect(types(down)).toContain('cancelEnsure')
    expect(only(down, 'ensure')).toHaveLength(0)
    expect(visibleLayerId(down.state)).toBeNull()
    expect(down.state.placeholder).toEqual({ kind: 'gateway-down' })

    // Nothing attaches and nothing is asked for while it holds, however many props change.
    const nudged = next(down, { type: 'sync', quality: 'high', camera: 'online' })
    // Nothing to cancel and nothing to close either: the `down` event already did both.
    expect(types(nudged)).toEqual([])
    expect(nudged.state.placeholder).toEqual({ kind: 'gateway-down' })
    expect(needsEnsure(nudged.state)).toBe(false)

    // …and it recovers by itself when main says the gateway is back (G2).
    const back = next(nudged, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 3 },
    })
    const ensure = oneEnsure(back)
    expect(ensure.quality).toBe('high')
    expect(ensure.delayMs).toBe(0)
  })

  it('drops an unproven layer on a restart rather than keeping a blank one', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    const id = attachedId(attaching)
    const restarted = next(attaching, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 2 },
    })
    expect(detachedIds(restarted)).toEqual([id])
    expect(restarted.state.placeholder).toEqual({ kind: 'connecting' })
  })
})

describe('the placeholder states', () => {
  it('shows CAM-3 Offline and stops asking when the camera is not CONNECTED', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const offline = next(playing, { type: 'sync', quality: 'low', camera: 'offline' })
    expect(detachedIds(offline)).toEqual([id])
    expect(only(offline, 'ensure')).toHaveLength(0)
    expect(offline.state.placeholder).toEqual({ kind: 'camera-offline' })
    // CAM-3: it resumes on its own when the camera comes back.
    const back = next(offline, { type: 'sync', quality: 'low', camera: 'online' })
    expect(oneEnsure(back).delayMs).toBe(0)
  })

  it('tells Connecting… apart from Offline for a camera on its way back (CAM-3)', () => {
    const connecting = next(start('low'), { type: 'sync', quality: 'low', camera: 'connecting' })
    expect(connecting.state.placeholder).toEqual({ kind: 'camera-connecting' })
    expect(only(connecting, 'ensure')).toHaveLength(0)
  })

  it('shows the gateway state, not a camera or Settings problem, for gateway-down', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const down = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: failed('gateway-down', 'The video service is not running.'),
    })
    expect(down.state.placeholder).toEqual({ kind: 'gateway-down' })
    // Always retryable: main restarts go2rtc and announces the new runtime.
    expect(oneEnsure(down).delayMs).toBe(reconnectDelayMs(1))
  })

  it("shows main's own sentence for any other ensureStream failure", () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const refused = next(mounted, {
      type: 'ensured',
      requestId: oneEnsure(mounted).requestId,
      result: failed('auth', 'The Protect API key was refused.'),
    })
    expect(refused.state.placeholder).toEqual({
      kind: 'stream-error',
      error: error('auth', 'The Protect API key was refused.'),
    })
    // Still retried: the user fixes it in Settings and the wall comes back without a restart.
    expect(only(refused, 'ensure')).toHaveLength(1)
  })

  it('shows codec-unsupported instead of a black cell, and stops retrying (R7)', () => {
    const playing = live('high')
    const id = visibleLayerId(playing.state) ?? 0
    const mime = 'video/mp4; codecs="hvc1.1.6.L153.B0, mp4a.40.2"'
    const refused = next(playing, { type: 'codecUnsupported', id, mime })

    // Nothing is coming, so holding a still frame would be a lie: the element goes.
    expect(detachedIds(refused)).toEqual([id])
    expect(refused.state.pending).toBeNull()
    expect(only(refused, 'ensure')).toHaveLength(0)
    expect(refused.state.placeholder).toEqual({ kind: 'codec-unsupported', mime })
    // Retrying cannot change a camera's encoder…
    const nudged = next(refused, { type: 'sync', quality: 'high', camera: 'online' })
    expect(only(nudged, 'ensure')).toHaveLength(0)
    // …but another quality might be H.264 (R1: Enhanced Encoding is per camera). The verdict stays
    // with the quality it is about.
    const other = next(nudged, { type: 'sync', quality: 'low', camera: 'online' })
    expect(oneEnsure(other).quality).toBe('low')
    expect(other.state.codecUnsupported).toEqual({ high: mime })
  })

  it('keeps the playing stream when it is the swap that cannot be decoded (R7)', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state) ?? 0
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = next(swapping, {
      type: 'ensured',
      requestId: oneEnsure(swapping).requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    const newId = attachedId(attaching)
    const refused = next(attaching, {
      type: 'codecUnsupported',
      id: newId,
      mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"',
    })
    // The viewer loses the quality change, not the picture.
    expect(detachedIds(refused)).toEqual([newId])
    expect(visibleLayerId(refused.state)).toBe(oldId)
    expect(refused.state.placeholder).toBeNull()
  })

  it('reads differently for every state, so no two say "unavailable"', () => {
    const texts = [
      placeholderText({ kind: 'camera-offline' }),
      placeholderText({ kind: 'camera-connecting' }),
      placeholderText({ kind: 'connecting' }),
      placeholderText({ kind: 'gateway-down' }),
      placeholderText({ kind: 'codec-unsupported', mime: 'video/mp4' }),
      placeholderText({ kind: 'stream-error', error: error('auth', 'The key was refused.') }),
      placeholderText({ kind: 'stream-failed' }),
    ]
    expect(new Set(texts).size).toBe(texts.length)
    for (const text of texts) expect(text.length).toBeGreaterThan(0)
  })
})

const HEVC = 'video/mp4; codecs="hvc1.1.6.L153.B0, mp4a.40.2"'

/** Answers the step's one ensure with a handle for the quality it asked for. */
function answer(step: PlayerStep, input: { epoch?: number; port?: number } = {}): PlayerStep {
  const ensure = oneEnsure(step)
  return next(step, {
    type: 'ensured',
    requestId: ensure.requestId,
    result: { ok: true, value: handle({ quality: ensure.quality, ...input }) },
  })
}

/** `low` live, then the prop moves to `high` and the `high` layer reports R7 codec-unsupported. */
function lowLiveHighRefused(): { step: PlayerStep; lowId: number } {
  const playing = live('low')
  const lowId = visibleLayerId(playing.state) ?? 0
  const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
  const attaching = answer(swapping)
  const highId = attachedId(attaching)
  const refused = next(attaching, { type: 'codecUnsupported', id: highId, mime: HEVC })
  expect(detachedIds(refused)).toEqual([highId])
  return { step: refused, lowId }
}

describe('R7 verdicts are per quality (carried from P2.3)', () => {
  it('reconnects the low stream on screen when it drops after a refused high swap', () => {
    const { step: refused, lowId } = lowLiveHighRefused()
    // The swap is lost, the picture is not, and nothing tries `high` again on its own.
    expect(visibleLayerId(refused.state)).toBe(lowId)
    expect(refused.state.placeholder).toBeNull()
    expect(refused.state.codecUnsupported).toEqual({ high: HEVC })
    expect(only(refused, 'ensure')).toHaveLength(0)
    expect(targetQuality(refused.state)).toBe('low')
    expect(needsEnsure(refused.state)).toBe(false)

    // The defect: `low`'s socket closes later. It used to be frozen for good with no message.
    const dropped = next(refused, { type: 'socketClosed', id: lowId })
    expect(closedIds(dropped)).toEqual([lowId])
    expect(visibleLayerId(dropped.state)).toBe(lowId)
    expect(dropped.state.placeholder).toBeNull()
    // The stream the viewer was watching is what is asked for — not the undecodable prop quality.
    expect(oneEnsure(dropped).quality).toBe('low')

    const attaching = answer(dropped)
    const newLowId = attachedId(attaching)
    const recovered = next(attaching, { type: 'firstFrame', id: newLowId })
    expect(detachedIds(recovered)).toEqual([lowId])
    expect(visibleLayerId(recovered.state)).toBe(newLowId)
    expect(recovered.state.current?.handle.quality).toBe('low')
    expect(recovered.state.placeholder).toBeNull()
  })

  it('does not loop back into the undecodable quality once the fallback is live again', () => {
    const { step: refused, lowId } = lowLiveHighRefused()
    let step = next(refused, { type: 'socketClosed', id: lowId })
    step = answer(step)
    step = next(step, { type: 'firstFrame', id: attachedId(step) })
    // Live on `low` with the prop still `high`: nothing more to ask for, by every path.
    expect(only(step, 'ensure')).toHaveLength(0)
    expect(needsEnsure(step.state)).toBe(false)
    expect(step.state.codecUnsupported).toEqual({ high: HEVC })
    const resync = next(step, { type: 'sync', quality: 'high', camera: 'online' })
    expect(types(resync)).toEqual([])
  })

  it('does not re-try the undecodable quality on a repeat of the runtime it already holds', () => {
    // Told about the runtime first, so the verdict is recorded against a known gateway.
    const playing = live('low')
    const lowId = visibleLayerId(playing.state) ?? 0
    const told = next(playing, { type: 'runtime', runtime: { state: 'up', port: PORT, epoch: 1 } })
    expect(types(told)).toEqual([])
    const attaching = answer(next(told, { type: 'sync', quality: 'high', camera: 'online' }))
    const refused = next(attaching, {
      type: 'codecUnsupported',
      id: attachedId(attaching),
      mime: HEVC,
    })
    // main pushes the runtime once per renderer load: a repeat is not news.
    const repeat = next(refused, {
      type: 'runtime',
      runtime: { state: 'up', port: PORT, epoch: 1 },
    })
    expect(types(repeat)).toEqual([])
    expect(repeat.state.codecUnsupported).toEqual({ high: HEVC })
    expect(visibleLayerId(repeat.state)).toBe(lowId)
  })

  it('keeps recovering the fallback after its still frame has been given up', () => {
    const { step: refused, lowId } = lowLiveHighRefused()
    let step = next(refused, { type: 'socketClosed', id: lowId })
    for (let failure = 1; failure < MAX_STALE_FRAME_FAILURES; failure += 1) {
      expect(oneEnsure(step).quality).toBe('low')
      step = next(step, {
        type: 'ensured',
        requestId: oneEnsure(step).requestId,
        result: failed('gateway-down', 'The video service is not running.'),
      })
    }
    // The frozen `low` is gone, but `low` is still what was last on screen, so it is still the
    // target — and the cell says what is actually wrong, not "Codec not supported".
    expect(visibleLayerId(step.state)).toBeNull()
    expect(step.state.placeholder).toEqual({ kind: 'gateway-down' })
    expect(oneEnsure(step).quality).toBe('low')
    step = answer(step)
    const id = attachedId(step)
    // While the fallback connects the cell says so; the asked-for quality's verdict is not news.
    expect(step.state.placeholder).toEqual({ kind: 'connecting' })
    step = next(step, { type: 'firstFrame', id })
    expect(visibleLayerId(step.state)).toBe(id)
    expect(needsEnsure(step.state)).toBe(false)
  })

  it('says codec-unsupported for the asked quality when nothing decodable has been seen', () => {
    const mounted = next(start('high'), { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = answer(mounted)
    const refused = next(attaching, {
      type: 'codecUnsupported',
      id: attachedId(attaching),
      mime: HEVC,
    })
    expect(targetQuality(refused.state)).toBeNull()
    expect(needsEnsure(refused.state)).toBe(false)
    expect(only(refused, 'ensure')).toHaveLength(0)
    expect(refused.state.placeholder).toEqual({ kind: 'codec-unsupported', mime: HEVC })
    // A late socket event from the dropped layer changes nothing either.
    const late = next(refused, { type: 'socketClosed', id: attachedId(attaching) })
    expect(types(late)).toEqual([])
  })

  it('also says codec-unsupported when the fallback itself turns out undecodable', () => {
    const { step: refused, lowId } = lowLiveHighRefused()
    // Enhanced Encoding switched on for this camera: now `low` will not decode either.
    const lowRefused = next(refused, { type: 'codecUnsupported', id: lowId, mime: HEVC })
    expect(detachedIds(lowRefused)).toEqual([lowId])
    expect(lowRefused.state.codecUnsupported).toEqual({ high: HEVC, low: HEVC })
    expect(only(lowRefused, 'ensure')).toHaveLength(0)
    expect(lowRefused.state.placeholder).toEqual({ kind: 'codec-unsupported', mime: HEVC })
  })

  it('a quality prop change clears the verdict for the quality asked for only', () => {
    const { step: refused } = lowLiveHighRefused()
    // Another quality: `high` is still known to be undecodable and stays that way.
    const medium = next(refused, { type: 'sync', quality: 'medium', camera: 'online' })
    expect(oneEnsure(medium).quality).toBe('medium')
    expect(medium.state.codecUnsupported).toEqual({ high: HEVC })
    // Back to `high`: asking for it again is the viewer's one-attempt retry (rule 5).
    const high = next(medium, { type: 'sync', quality: 'high', camera: 'online' })
    expect(high.state.codecUnsupported).toEqual({})
    // The `medium` call still out is for the wrong quality now, so it is dropped, not waited out.
    expect(types(high)).toContain('cancelEnsure')
    expect(oneEnsure(high).quality).toBe('high')
    // Refused again: back to `low`, the layer still on screen, with no further asking.
    const attaching = answer(high)
    const again = next(attaching, {
      type: 'codecUnsupported',
      id: attachedId(attaching),
      mime: HEVC,
    })
    expect(again.state.current?.handle.quality).toBe('low')
    expect(again.state.placeholder).toBeNull()
    expect(only(again, 'ensure')).toHaveLength(0)
  })

  it('a new go2rtc runtime clears every verdict and retries the asked quality', () => {
    const { step: refused, lowId } = lowLiveHighRefused()
    const restarted = next(refused, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 2 },
    })
    expect(restarted.state.codecUnsupported).toEqual({})
    // The `low` on screen is from the dead epoch: it holds its frame while `high` is tried again.
    expect(closedIds(restarted)).toEqual([lowId])
    expect(visibleLayerId(restarted.state)).toBe(lowId)
    expect(oneEnsure(restarted).quality).toBe('high')
  })

  it('a verdict drops a call still out for the refused quality', () => {
    // Live on `low`, retrying `high`. The state with a second `high` call out alongside the `high`
    // incoming is built by hand (it needs an interleaving the shell makes rare), because the rule
    // matters when it does happen: that call would only attach the refused quality again.
    const { step: refused } = lowLiveHighRefused()
    const retry = next(next(refused, { type: 'sync', quality: 'medium', camera: 'online' }), {
      type: 'sync',
      quality: 'high',
      camera: 'online',
    })
    const attaching = answer(retry)
    const highId = attachedId(attaching)
    const withPending: PlayerState = {
      ...attaching.state,
      pending: { requestId: 9999, quality: 'high', delayMs: 0 },
    }
    const refusedAgain = playerStep(withPending, {
      type: 'codecUnsupported',
      id: highId,
      mime: HEVC,
    })
    expect(types(refusedAgain)).toContain('cancelEnsure')
    expect(refusedAgain.state.pending).toBeNull()
    // `low` is live on screen and is the target: nothing more to ask for.
    expect(only(refusedAgain, 'ensure')).toHaveLength(0)
    // The reply of the dropped call is ignored.
    const late = playerStep(refusedAgain.state, {
      type: 'ensured',
      requestId: 9999,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    expect(types(late)).toEqual([])
  })

  it('a quality change does not wait out a backoff scheduled for the old quality', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const dropped = next(playing, { type: 'socketClosed', id })
    expect(oneEnsure(dropped).delayMs).toBe(reconnectDelayMs(1))
    const changed = next(dropped, { type: 'sync', quality: 'high', camera: 'online' })
    expect(types(changed)).toContain('cancelEnsure')
    const ensure = oneEnsure(changed)
    expect(ensure.quality).toBe('high')
    expect(ensure.delayMs).toBe(0)
  })
})

describe('a layer that never paints (carried from P2.3; NFR-7)', () => {
  it("retries on the backoff when go2rtc refuses the handshake, and says so without go2rtc's text", () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(mounted)
    const id = attachedId(attaching)
    const refused = next(attaching, { type: 'streamError', id })
    expect(detachedIds(refused)).toEqual([id])
    expect(refused.state.incoming).toBeNull()
    expect(refused.state.placeholder).toEqual({ kind: 'stream-failed' })
    expect(placeholderText({ kind: 'stream-failed' })).toBe('Stream could not start')
    const ensure = oneEnsure(refused)
    expect(ensure.quality).toBe('low')
    expect(ensure.delayMs).toBe(reconnectDelayMs(1))

    // The message holds while the retry connects, and goes with the first frame.
    const retrying = answer(refused)
    expect(retrying.state.placeholder).toEqual({ kind: 'stream-failed' })
    const playing = next(retrying, { type: 'firstFrame', id: attachedId(retrying) })
    expect(playing.state.placeholder).toBeNull()
    expect(playing.state.streamFailed).toBe(false)
    expect(playing.state.failures).toBe(0)
  })

  it('backs off across repeated refusals', () => {
    let step = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const delays: number[] = []
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      step = answer(step)
      step = next(step, { type: 'streamError', id: attachedId(step) })
      delays.push(oneEnsure(step).delayMs)
    }
    expect(delays).toEqual([1, 2, 3, 4, 5].map(reconnectDelayMs))
  })

  it('keeps the stream on screen when it is the swap that go2rtc refuses', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state) ?? 0
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = answer(swapping)
    const newId = attachedId(attaching)
    const refused = next(attaching, { type: 'streamError', id: newId })
    expect(detachedIds(refused)).toEqual([newId])
    expect(visibleLayerId(refused.state)).toBe(oldId)
    expect(refused.state.placeholder).toBeNull()
    expect(oneEnsure(refused).quality).toBe('high')
  })

  it('treats an error on the visible layer as a lost socket that keeps its last frame', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const refused = next(playing, { type: 'streamError', id })
    expect(closedIds(refused)).toEqual([id])
    expect(detachedIds(refused)).toEqual([])
    expect(refused.state.current?.stale).toBe(true)
    expect(refused.state.placeholder).toBeNull()
    expect(oneEnsure(refused).quality).toBe('low')
    // It played, so it did not fail to *start*.
    expect(refused.state.streamFailed).toBe(false)
  })

  it('never says "Stream could not start" about a stream that was playing', () => {
    const playing = live('low')
    let step = next(playing, { type: 'streamError', id: visibleLayerId(playing.state) ?? 0 })
    // Replacements keep losing their sockets until the held frame is given up (rule 3).
    while (step.state.current !== null) {
      step = answer(step)
      step = next(step, { type: 'socketClosed', id: attachedId(step) })
    }
    expect(step.state.failures).toBeGreaterThanOrEqual(MAX_STALE_FRAME_FAILURES)
    expect(step.state.placeholder).toEqual({ kind: 'connecting' })
  })

  it('gives up on a layer that has not painted within the window and retries', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(mounted)
    const id = attachedId(attaching)
    expect(attaching.state.placeholder).toEqual({ kind: 'connecting' })
    const overdue = next(attaching, { type: 'firstFrameTimeout', id })
    expect(detachedIds(overdue)).toEqual([id])
    expect(overdue.state.placeholder).toEqual({ kind: 'stream-failed' })
    expect(oneEnsure(overdue).delayMs).toBe(reconnectDelayMs(1))
  })

  it('times out a swap without costing the stream on screen', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state) ?? 0
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = answer(swapping)
    const newId = attachedId(attaching)
    const overdue = next(attaching, { type: 'firstFrameTimeout', id: newId })
    expect(detachedIds(overdue)).toEqual([newId])
    expect(closedIds(overdue)).toEqual([])
    expect(visibleLayerId(overdue.state)).toBe(oldId)
    expect(overdue.state.placeholder).toBeNull()
    expect(oneEnsure(overdue).quality).toBe('high')
  })

  it('never times out the visible layer, live or stale and holding its last frame', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    expect(types(next(playing, { type: 'firstFrameTimeout', id }))).toEqual([])
    // Stale, with a replacement call out: rule 3 keeps it on purpose.
    const dropped = next(playing, { type: 'socketClosed', id })
    const timedOut = next(dropped, { type: 'firstFrameTimeout', id })
    expect(types(timedOut)).toEqual([])
    expect(timedOut.state.current?.stale).toBe(true)
    expect(timedOut.state.failures).toBe(dropped.state.failures)
    // An id nobody holds (already detached) is nothing.
    expect(types(next(playing, { type: 'firstFrameTimeout', id: 999 }))).toEqual([])
  })

  it('lets a later ensureStream failure say more than "Stream could not start"', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(mounted)
    const refused = next(attaching, { type: 'streamError', id: attachedId(attaching) })
    const down = next(refused, {
      type: 'ensured',
      requestId: oneEnsure(refused).requestId,
      result: failed('gateway-down', 'The video service is not running.'),
    })
    expect(down.state.placeholder).toEqual({ kind: 'gateway-down' })
  })

  it('clears "Stream could not start" on a quality change and on a new runtime', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(mounted)
    const refused = next(attaching, { type: 'streamError', id: attachedId(attaching) })
    const changed = next(refused, { type: 'sync', quality: 'medium', camera: 'online' })
    expect(changed.state.placeholder).toEqual({ kind: 'connecting' })
    const restarted = next(refused, {
      type: 'runtime',
      runtime: { state: 'up', port: NEW_PORT, epoch: 2 },
    })
    expect(restarted.state.placeholder).toEqual({ kind: 'connecting' })
  })
})

describe('recover after sleep or a network change (NFR-7, P6.2)', () => {
  /** Mounted, then `failures` refused `ensureStream`s: a retry is being waited out on the backoff. */
  function backingOff(failures: number): PlayerStep {
    let step = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    for (let attempt = 0; attempt < failures; attempt += 1) {
      step = next(step, {
        type: 'ensured',
        requestId: oneEnsure(step).requestId,
        result: failed('network', 'The console could not be reached.'),
      })
    }
    return step
  }

  it('forgets the backoff and retries now instead of waiting it out', () => {
    const waiting = backingOff(6)
    const scheduled = oneEnsure(waiting)
    expect(scheduled.delayMs).toBe(reconnectDelayMs(6))

    const recovered = next(waiting, { type: 'recover' })
    expect(types(recovered)).toEqual(['cancelEnsure', 'ensure'])
    const now = oneEnsure(recovered)
    expect(now.delayMs).toBe(0)
    expect(now.quality).toBe('low')
    expect(recovered.state.failures).toBe(0)
    // Still the most recent news until the retry answers.
    expect(recovered.state.placeholder).toEqual(waiting.state.placeholder)

    // The replaced call's reply, had its timer already fired, changes nothing.
    const late = next(recovered, {
      type: 'ensured',
      requestId: scheduled.requestId,
      result: { ok: true, value: handle({ quality: 'low' }) },
    })
    expect(types(late)).toEqual([])

    // A failure after the wake starts the curve from the beginning again.
    const refused = next(recovered, {
      type: 'ensured',
      requestId: now.requestId,
      result: failed('network', 'The console could not be reached.'),
    })
    expect(oneEnsure(refused).delayMs).toBe(reconnectDelayMs(1))
  })

  it('leaves a call that is already out alone', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const recovered = next(mounted, { type: 'recover' })
    expect(types(recovered)).toEqual([])
    expect(recovered.state.pending).toEqual(mounted.state.pending)
  })

  it('leaves a healthy player alone: its stall detector says if the sleep broke it', () => {
    const playing = live('low')
    const recovered = next(playing, { type: 'recover' })
    expect(types(recovered)).toEqual([])
    expect(recovered.state.current).toEqual(playing.state.current)
    expect(recovered.state.placeholder).toBeNull()
  })

  it('leaves a layer that is connecting alone', () => {
    const mounted = next(start('low'), { type: 'sync', quality: 'low', camera: 'online' })
    const attaching = answer(mounted)
    const recovered = next(attaching, { type: 'recover' })
    expect(types(recovered)).toEqual([])
    expect(recovered.state.incoming).toEqual(attaching.state.incoming)
  })

  it('drops a frozen frame instead of restarting its count, and asks now', () => {
    let step = live('low')
    const id = visibleLayerId(step.state) ?? 0
    step = next(step, { type: 'socketClosed', id })
    step = next(step, {
      type: 'ensured',
      requestId: oneEnsure(step).requestId,
      result: failed('network', 'The console could not be reached.'),
    })
    // A still frame on screen, a retry waiting out the backoff.
    expect(visibleLayerId(step.state)).toBe(id)
    expect(oneEnsure(step).delayMs).toBeGreaterThan(0)

    const recovered = next(step, { type: 'recover' })
    // A picture from before the sleep is not live video: it goes, and the cell says why.
    expect(detachedIds(recovered)).toEqual([id])
    expect(visibleLayerId(recovered.state)).toBeNull()
    expect(recovered.state.placeholder).not.toBeNull()
    expect(oneEnsure(recovered).delayMs).toBe(0)
    expect(recovered.state.failures).toBe(0)
  })

  it('drops a frozen frame even while its replacement call is already out', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const dropped = next(playing, { type: 'socketClosed', id })
    // The first reconnect after a close goes at the backoff's first step.
    const firstRetry = oneEnsure(dropped)
    const recovered = next(dropped, { type: 'recover' })
    expect(detachedIds(recovered)).toEqual([id])
    // A retry waiting out a delay is replaced; one issued at 0 would have been left alone.
    expect(oneEnsure(recovered).requestId).not.toBe(firstRetry.requestId)
    expect(oneEnsure(recovered).delayMs).toBe(0)
  })

  it('does nothing while the camera is offline or the gateway is down', () => {
    const offline = next(live('low'), { type: 'sync', quality: 'low', camera: 'offline' })
    const offlineRecovered = next(offline, { type: 'recover' })
    expect(types(offlineRecovered)).toEqual([])
    expect(offlineRecovered.state.placeholder).toEqual({ kind: 'camera-offline' })

    const down = next(live('low'), { type: 'runtime', runtime: { state: 'down' } })
    const downRecovered = next(down, { type: 'recover' })
    expect(types(downRecovered)).toEqual([])
    expect(downRecovered.state.placeholder).toEqual({ kind: 'gateway-down' })
  })

  it('keeps every codec verdict: sleeping does not change an encoder (R7)', () => {
    const mounted = next(start('high'), { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = answer(mounted)
    const refused = next(attaching, {
      type: 'codecUnsupported',
      id: attachedId(attaching),
      mime: HEVC,
    })
    expect(targetQuality(refused.state)).toBeNull()

    const recovered = next(refused, { type: 'recover' })
    expect(only(recovered, 'ensure')).toHaveLength(0)
    expect(recovered.state.codecUnsupported).toEqual(refused.state.codecUnsupported)
    expect(recovered.state.placeholder?.kind).toBe('codec-unsupported')
  })

  it('does nothing after it has stopped', () => {
    const stopped = next(backingOff(3), { type: 'stop' })
    const recovered = next(stopped, { type: 'recover' })
    expect(types(recovered)).toEqual([])
  })
})

describe('teardown (gate G2: no growth over 30 minutes)', () => {
  it('closes both layers and cancels the scheduled call on unmount', () => {
    const playing = live('low')
    const oldId = visibleLayerId(playing.state) ?? 0
    const swapping = next(playing, { type: 'sync', quality: 'high', camera: 'online' })
    const attaching = next(swapping, {
      type: 'ensured',
      requestId: oneEnsure(swapping).requestId,
      result: { ok: true, value: handle({ quality: 'high' }) },
    })
    const newId = attachedId(attaching)

    const stopped = next(attaching, { type: 'stop' })
    expect(detachedIds(stopped).sort((a, b) => a - b)).toEqual([oldId, newId].sort((a, b) => a - b))
    expect(types(stopped)).toContain('cancelEnsure')
    expect(stopped.state.placeholder).toBeNull()
  })

  it('does nothing at all after it has stopped', () => {
    const playing = live('low')
    const id = visibleLayerId(playing.state) ?? 0
    const stopped = next(playing, { type: 'stop' })
    // A reply from a call that was in flight at unmount is the event guaranteed to arrive late, and
    // acting on it is how a remounting grid leaks a socket per remount.
    const late: PlayerEvent[] = [
      { type: 'ensured', requestId: 1, result: { ok: true, value: handle({ quality: 'low' }) } },
      { type: 'runtime', runtime: { state: 'up', port: NEW_PORT, epoch: 2 } },
      { type: 'sync', quality: 'high', camera: 'online' },
      { type: 'socketClosed', id },
      { type: 'stalled', id },
      { type: 'firstFrame', id },
      { type: 'streamError', id },
      { type: 'firstFrameTimeout', id },
      { type: 'codecUnsupported', id, mime: 'video/mp4' },
    ]
    let step: PlayerStep = stopped
    for (const event of late) {
      step = next(step, event)
      expect(step.commands).toEqual([])
    }
    expect(step.state.current).toBeNull()
    expect(step.state.incoming).toBeNull()
  })
})

describe('cameraAvailability (CAM-3)', () => {
  it('is online only for CONNECTED', () => {
    expect(cameraAvailability(camera('CONNECTED'))).toBe('online')
  })

  it('is connecting for CONNECTING and for a camera the inventory has not pushed yet (CAM-2)', () => {
    expect(cameraAvailability(camera('CONNECTING'))).toBe('connecting')
    expect(cameraAvailability(undefined)).toBe('connecting')
  })

  it('is offline for DISCONNECTED and for a state Protect has not documented (R8/R11)', () => {
    expect(cameraAvailability(camera('DISCONNECTED'))).toBe('offline')
    expect(cameraAvailability(camera('REBOOTING'))).toBe('offline')
    expect(cameraAvailability(camera(''))).toBe('offline')
  })
})

describe('the state the component renders from', () => {
  it('never has a placeholder while a layer is on screen', () => {
    // The invariant behind "no flash of placeholder": every state reachable below is checked.
    const sequences: PlayerEvent[][] = [
      [
        { type: 'sync', quality: 'low', camera: 'online' },
        { type: 'sync', quality: 'high', camera: 'online' },
        { type: 'sync', quality: 'low', camera: 'online' },
      ],
      [
        { type: 'sync', quality: 'low', camera: 'online' },
        { type: 'runtime', runtime: { state: 'up', port: PORT, epoch: 1 } },
        { type: 'runtime', runtime: { state: 'up', port: NEW_PORT, epoch: 2 } },
      ],
      [
        { type: 'sync', quality: 'low', camera: 'online' },
        { type: 'recover' },
        { type: 'sync', quality: 'high', camera: 'online' },
        { type: 'recover' },
      ],
    ]
    for (const events of sequences) {
      let step = start('low')
      for (const event of events) {
        step = next(step, event)
        assertNoPlaceholderOverVideo(step.state)
        // Answer every ensure with a handle and a frame, so the sequence runs with video on screen.
        for (const command of step.commands) {
          if (command.type !== 'ensure') continue
          step = next(step, {
            type: 'ensured',
            requestId: command.requestId,
            result: {
              ok: true,
              value: handle({
                quality: command.quality,
                port: step.state.runtime?.state === 'up' ? step.state.runtime.port : PORT,
                epoch: step.state.runtime?.state === 'up' ? step.state.runtime.epoch : 1,
              }),
            },
          })
          assertNoPlaceholderOverVideo(step.state)
          const attaches = only(step, 'attach')
          const attach = attaches[0]
          if (attach === undefined) continue
          step = next(step, { type: 'firstFrame', id: attach.id })
          assertNoPlaceholderOverVideo(step.state)
        }
      }
    }
  })
})

function assertNoPlaceholderOverVideo(state: PlayerState): void {
  if (visibleLayerId(state) !== null) expect(state.placeholder).toBeNull()
}
