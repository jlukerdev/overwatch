// RTSP-4's "has audio" (AUD-1 in RTSP streams mode): which cells' streams turned out to carry an
// audio track. Pure and store-free, like ./cameraAudio, so `<GridView>` keeps the state and the
// slot builder (features/grid/gridLayout.ts) reads it.
//
// An RTSP stream has no mic flags: whether it has sound is only known once go2rtc answers the MSE
// handshake with its mime (`mseBuffer.mimeHasAudio`). Each `<LivePlayer>` reports, for its camera,
// whether the layer it shows carries audio, once per change (never per frame). The answer is kept
// **per slot and camera** — the cell that played it, and the stream it played there — so:
//  - a rotation or a step onto another camera starts without a toggle until that camera's player
//    answers (a pre-warmed player has already answered under its own camera, so the step lands on
//    its toggle at once);
//  - a quality swap (fill, a picker) keeps the toggle, and the cell stays heard, while both streams
//    carry audio: the visible layer's answer only changes when the new layer is promoted;
//  - a reconnect of the same stream (wake, network change, the video service restarting) keeps the
//    last answer ({@link nextPlayerAudio}), so the cell is not muted by it;
//  - a player that goes (its camera rotated away, the cell left) reports `false` on its way out,
//    so nothing claims sound for a stream that is not playing.
// The set holds the keys whose answer is "has audio"; every other key is "no audio (yet)".

/**
 * A player's next audio answer (RTSP-4), from the one it last gave and its visible layer's:
 * `visible` is that layer's answer, or `null` while no layer is visible — a reconnect after a wake
 * or a network change, the video service restarting, a stale frame given up on. Then the last answer
 * stands: a brief reconnect of the same stream must not read as "no audio", which would mute an
 * unmuted cell for good (AUD-2), something Protect mode's mic flags never do. A promoted layer's
 * own answer always counts, so a swap to a stream without audio does turn it off; the player's
 * teardown reports `false` on its own.
 */
export function nextPlayerAudio(previous: boolean, visible: boolean | null): boolean {
  return visible ?? previous
}

/** The set's key for a slot (`GridSlot.key`) and the camera it plays there. */
export function streamAudioKey(slotKey: string, cameraId: string): string {
  // A NUL cannot appear in a slot key or a camera id, so two pairs never share a key.
  return `${slotKey}\u0000${cameraId}`
}

/** No stream has reported audio yet. */
export const NO_STREAM_AUDIO: ReadonlySet<string> = new Set()

/**
 * The set once the player of `cameraId` in slot `slotKey` reports `hasAudio`. The **same set** when
 * nothing changes, so a caller's state update is a no-op and nothing re-renders.
 */
export function streamAudioStep(
  state: ReadonlySet<string>,
  slotKey: string,
  cameraId: string,
  hasAudio: boolean,
): ReadonlySet<string> {
  const key = streamAudioKey(slotKey, cameraId)
  if (state.has(key) === hasAudio) return state
  const next = new Set(state)
  if (hasAudio) next.add(key)
  else next.delete(key)
  return next
}

/** Whether the stream that slot `slotKey` plays for `cameraId` has reported an audio track. */
export function streamHasAudio(
  state: ReadonlySet<string>,
  slotKey: string,
  cameraId: string,
): boolean {
  return state.has(streamAudioKey(slotKey, cameraId))
}
