// The single-active-audio controller (P5.1; AUD-1, AUD-2, AUD-3): which one cell may be heard, and
// the app-wide volume it plays at.
//
// **One source at most, named by what is on screen.** The state is `active`: the View, the slot
// (`GridSlot.key`) and the camera id of the one cell the user unmuted, or `null` when everything is
// muted (AUD-1: every cell starts muted). A cell is audible only while all three match what that slot
// shows now ({@link isAudible}), so unmuting a cell *is* muting every other one (AUD-2) — there is
// no list of muted cells to keep in step, and no way for two to be audible at once.
//
// **Audio never follows a cell onto another camera** (user decision, 2026-11-16). If the unmuted
// cell's visible camera changes for any reason — a timed rotation, the user's next / previous, a
// motion or ring trigger switch, the camera leaving the console (its slot turns `missing`), its mic
// being switched off or the camera going offline / connecting (user decision, 2026-11-16) — the cell
// is muted. One rule, {@link isSlotAudible}, says whether a slot is the one heard: `<GridView>` uses
// it in render (so the cell stops playing in the render that changes its camera) and
// {@link audioAfterSlots} uses it after the render to *clear* the source, so a rotation that comes
// back to the same camera later — or the camera coming back online — comes back muted. `<GridView>`
// runs it after every render that rebuilds its slots or changes the filled one. A View switch clears
// it the same way (the source names another View), and `<GridView>` unmounting — leaving the Live
// screen, opening the View editor — mutes everything, so nothing is left audible off screen.
//
// **Filling a cell mutes every other** (user decision, 2026-11-16): while a slot is filled, a source
// that is not that slot is cleared (`filledKey` in {@link audioAfterSlots}). The other cells are
// covered and unreachable then, so only the filled cell can be unmuted while filled.
//
// **Volume** (AUD-3; user decision, 2026-11-16): one level for the whole app, 0…1, **session only**
// — renderer state, never written to the config — starting at 100% on every launch. It is shown as a
// slider only on a filled cell whose camera has audio, and applies to whatever plays (only the
// active source can). Muting does not touch it.
//
// **`M` mutes everything; it is not a toggle** (features/audio/muteShortcut.ts): with nothing
// unmuted it does nothing ({@link muteAllAudio} hands back the same state).
//
// Which cameras have audio at all is features/audio/cameraAudio.ts (AUD-1), store-free so the slot
// builder can use it; a slot arrives here with its answer as `audio`.
//
// Pure reducer-like functions first, tested in the node environment (no jsdom here; CLAUDE.md), then
// a small zustand store that only applies them. A store rather than `<GridView>` state so the
// volume outlives the Live screen for the rest of the session.
import { create } from 'zustand'

// -------------------------------------------------------------------------------------------------
// Pure rules

/** The one cell that may be heard: a slot of a View, with the camera it showed when unmuted. */
export interface AudioSource {
  readonly viewId: string
  readonly slotKey: string
  readonly cameraId: string
}

export interface AudioState {
  /** The unmuted cell, or `null` when everything is muted (AUD-1). */
  readonly active: AudioSource | null
  /** AUD-3: the app-wide level, 0…1, for this session only (header). */
  readonly volume: number
}

/** Volume on launch: 100% (header). */
export const DEFAULT_VOLUME = 1

export const INITIAL_AUDIO_STATE: AudioState = { active: null, volume: DEFAULT_VOLUME }

function sameSource(a: AudioSource, b: AudioSource): boolean {
  return a.viewId === b.viewId && a.slotKey === b.slotKey && a.cameraId === b.cameraId
}

/** Whether `source` — a slot of the View on screen, with the camera it shows now — is the one heard. */
export function isAudible(active: AudioSource | null, source: AudioSource): boolean {
  return active !== null && sameSource(active, source)
}

/** AUD-2: unmute one cell, which mutes every other. The same state if it is already the one. */
export function unmuteAudio(state: AudioState, source: AudioSource): AudioState {
  if (isAudible(state.active, source)) return state
  return { ...state, active: source }
}

/**
 * Mute one cell: only if it is the one heard. A mute from a cell that is not (a stale click after
 * its camera changed, say) leaves the active one alone.
 */
export function muteAudio(state: AudioState, source: AudioSource): AudioState {
  return isAudible(state.active, source) ? { ...state, active: null } : state
}

/** AUD-3's `M`: mute everything. The same state when nothing was unmuted (header: not a toggle). */
export function muteAllAudio(state: AudioState): AudioState {
  return state.active === null ? state : { ...state, active: null }
}

/** A volume into 0…1; anything that is not a finite number is the default. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME
  return Math.min(1, Math.max(0, volume))
}

/** AUD-3: the new app-wide level, clamped. The same state when it does not change. */
export function setAudioVolume(state: AudioState, volume: number): AudioState {
  const next = clampVolume(volume)
  return next === state.volume ? state : { ...state, volume: next }
}

/**
 * The parts of a grid slot the audio rules read (`GridSlot`, features/grid/gridLayout.ts, fits it):
 * a camera slot has the camera it shows and whether it can be heard now (`cameraCanBeHeard`: a mic,
 * on, connected; never a package ref); any other slot has none.
 */
export interface AudioSlot {
  readonly kind: string
  readonly key: string
  readonly cameraId?: string
  readonly audio?: boolean
}

/**
 * The one rule (header): whether `slot`, drawn in View `viewId` with `filledKey` filled (`null` for
 * the grid), is the cell heard — a camera slot that can be heard now, matching the active source's
 * View, slot and camera, and not covered by another filled slot.
 */
export function isSlotAudible(
  active: AudioSource | null,
  viewId: string,
  slot: AudioSlot,
  filledKey: string | null = null,
): boolean {
  return (
    (filledKey === null || filledKey === slot.key) &&
    slot.kind === 'camera' &&
    slot.audio === true &&
    slot.cameraId !== undefined &&
    isAudible(active, { viewId, slotKey: slot.key, cameraId: slot.cameraId })
  )
}

/**
 * Whether `active` is still a cell someone can hear: one of `slots` (View `viewId`, on screen, with
 * `filledKey` filled) is it by {@link isSlotAudible}.
 */
export function isSourceOnScreen(
  active: AudioSource,
  viewId: string,
  slots: readonly AudioSlot[],
  filledKey: string | null = null,
): boolean {
  const slot = slots.find((candidate) => candidate.key === active.slotKey)
  return slot !== undefined && isSlotAudible(active, viewId, slot, filledKey)
}

/**
 * The state once the grid has drawn `slots` of View `viewId`, with `filledKey` filled (`null` for
 * the grid): the active source is dropped — muted — when it no longer matches a slot on screen
 * (another View, the slot gone or missing, a different camera shown, its mic off, the camera offline)
 * or when another slot is filled (header). The same state otherwise, so a caller can skip a no-op.
 */
export function audioAfterSlots(
  state: AudioState,
  viewId: string,
  slots: readonly AudioSlot[],
  filledKey: string | null = null,
): AudioState {
  const active = state.active
  if (active === null) return state
  return isSourceOnScreen(active, viewId, slots, filledKey) ? state : { ...state, active: null }
}

// -------------------------------------------------------------------------------------------------
// The store

export const useAudioStore = create<AudioState>()(() => INITIAL_AUDIO_STATE)

/** Applies one pure step; zustand skips subscribers when the step hands back the same state. */
function apply(step: (state: AudioState) => AudioState): void {
  const previous = useAudioStore.getState()
  const next = step(previous)
  if (next !== previous) useAudioStore.setState(next, true)
}

export const audioActions = {
  unmute: (source: AudioSource): void => {
    apply((state) => unmuteAudio(state, source))
  },
  mute: (source: AudioSource): void => {
    apply((state) => muteAudio(state, source))
  },
  muteAll: (): void => {
    apply(muteAllAudio)
  },
  setVolume: (volume: number): void => {
    apply((state) => setAudioVolume(state, volume))
  },
  /** After the grid has drawn its slots, with the filled one (header). */
  syncSlots: (viewId: string, slots: readonly AudioSlot[], filledKey: string | null): void => {
    apply((state) => audioAfterSlots(state, viewId, slots, filledKey))
  },
}
