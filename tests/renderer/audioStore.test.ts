// P5.1: the single-active-audio controller (src/renderer/src/state/audioStore.ts; AUD-1, AUD-2,
// AUD-3, user decisions 2026-11-16).
//
// What these tests protect:
//  - AUD-1: everything starts muted at 100% volume (which cameras have audio is cameraAudio.test.ts).
//  - AUD-2: unmuting one cell mutes every other — one source at most — and a mute from a cell that
//    is not the heard one changes nothing.
//  - audio never follows a cell onto another camera: once the grid draws the heard slot with another
//    camera, missing, gone, its mic off, offline, or another View, the source is dropped, so a rotation back
//    to the same camera stays muted.
//  - filling a cell mutes every other; the filled cell itself stays heard.
//  - AUD-3: `M`'s mute-all mutes everything and is not a toggle (a no-op with nothing unmuted), and
//    the volume is clamped to 0…1 and untouched by muting.
//  - the store applies the same rules.
import { afterEach, describe, expect, it } from 'vitest'
import {
  audioActions,
  audioAfterSlots,
  clampVolume,
  DEFAULT_VOLUME,
  INITIAL_AUDIO_STATE,
  isAudible,
  isSlotAudible,
  isSourceOnScreen,
  muteAllAudio,
  muteAudio,
  setAudioVolume,
  unmuteAudio,
  useAudioStore,
  type AudioSlot,
  type AudioSource,
  type AudioState,
} from '../../src/renderer/src/state/audioStore'

const A: AudioSource = { viewId: 'v', slotKey: 'cam:a#0', cameraId: 'a' }
const B: AudioSource = { viewId: 'v', slotKey: 'cam:b#0', cameraId: 'b' }

const SLOTS: AudioSlot[] = [
  { kind: 'camera', key: 'cam:a#0', cameraId: 'a', audio: true },
  { kind: 'camera', key: 'cam:b#0', cameraId: 'b', audio: true },
  { kind: 'empty', key: 'empty:2' },
]

const SLOT_A: AudioSlot = { kind: 'camera', key: 'cam:a#0', cameraId: 'a', audio: true }

function heard(source: AudioSource | null, volume = DEFAULT_VOLUME): AudioState {
  return { active: source, volume }
}

describe('initial state and mic gating (AUD-1)', () => {
  it('starts with nothing audible at 100%', () => {
    expect(INITIAL_AUDIO_STATE).toEqual({ active: null, volume: 1 })
    expect(isAudible(INITIAL_AUDIO_STATE.active, A)).toBe(false)
  })
})

describe('unmute / mute (AUD-2)', () => {
  it('unmuting one cell makes it the only one heard', () => {
    const state = unmuteAudio(INITIAL_AUDIO_STATE, A)
    expect(isAudible(state.active, A)).toBe(true)
    expect(isAudible(state.active, B)).toBe(false)
  })

  it('unmuting a second cell mutes the first', () => {
    const state = unmuteAudio(unmuteAudio(INITIAL_AUDIO_STATE, A), B)
    expect(isAudible(state.active, A)).toBe(false)
    expect(isAudible(state.active, B)).toBe(true)
  })

  it('matches the View, the slot and the camera, all three', () => {
    const state = unmuteAudio(INITIAL_AUDIO_STATE, A)
    expect(isAudible(state.active, { ...A, viewId: 'w' })).toBe(false)
    expect(isAudible(state.active, { ...A, slotKey: 'cam:a#1' })).toBe(false)
    expect(isAudible(state.active, { ...A, cameraId: 'z' })).toBe(false)
  })

  it('unmuting the cell already heard is a no-op', () => {
    const state = heard(A)
    expect(unmuteAudio(state, { ...A })).toBe(state)
  })

  it('muting the heard cell mutes it, and keeps the volume', () => {
    expect(muteAudio(heard(A, 0.4), A)).toEqual(heard(null, 0.4))
  })

  it('a mute from another cell (or another camera) leaves the heard one alone', () => {
    const state = heard(A)
    expect(muteAudio(state, B)).toBe(state)
    expect(muteAudio(state, { ...A, cameraId: 'z' })).toBe(state)
  })
})

describe('camera change mutes (user decision 2026-11-16)', () => {
  it('keeps the source while its slot still shows that camera with audio', () => {
    const state = heard(A)
    expect(isSourceOnScreen(A, 'v', SLOTS)).toBe(true)
    expect(audioAfterSlots(state, 'v', SLOTS)).toBe(state)
  })

  it('drops it when the slot shows another camera (rotation, step, trigger)', () => {
    const rotated: AudioSlot[] = [{ kind: 'camera', key: 'cam:a#0', cameraId: 'c', audio: true }]
    expect(audioAfterSlots(heard(A), 'v', rotated).active).toBeNull()
  })

  it('stays muted when the rotation comes back to the same camera', () => {
    const rotated: AudioSlot[] = [{ kind: 'camera', key: 'cam:a#0', cameraId: 'c', audio: true }]
    const afterAway = audioAfterSlots(heard(A), 'v', rotated)
    const back = audioAfterSlots(afterAway, 'v', SLOTS)
    expect(isAudible(back.active, A)).toBe(false)
  })

  it('drops it when the camera goes missing, the slot goes away or its mic is switched off', () => {
    const missing: AudioSlot[] = [{ kind: 'missing', key: 'cam:a#0' }]
    const micOff: AudioSlot[] = [{ kind: 'camera', key: 'cam:a#0', cameraId: 'a', audio: false }]
    expect(audioAfterSlots(heard(A), 'v', missing).active).toBeNull()
    expect(audioAfterSlots(heard(A), 'v', []).active).toBeNull()
    expect(audioAfterSlots(heard(A), 'v', micOff).active).toBeNull()
  })

  it('drops it on a View switch', () => {
    expect(audioAfterSlots(heard(A), 'other', SLOTS).active).toBeNull()
  })

  it('is a no-op with nothing heard', () => {
    expect(audioAfterSlots(INITIAL_AUDIO_STATE, 'v', [])).toBe(INITIAL_AUDIO_STATE)
  })

  it('drops it when the camera goes offline or is reconnecting (slot audio off)', () => {
    // gridLayout turns `audio` off for a camera that is not CONNECTED (cameraCanBeHeard).
    const offline: AudioSlot[] = [{ kind: 'camera', key: 'cam:a#0', cameraId: 'a', audio: false }]
    expect(audioAfterSlots(heard(A), 'v', offline).active).toBeNull()
  })

  it('keeps the volume when it drops the source', () => {
    expect(audioAfterSlots(heard(A, 0.3), 'other', SLOTS)).toEqual(heard(null, 0.3))
  })
})

describe('filling a cell mutes every other (user decision 2026-11-16)', () => {
  it('drops the source when another slot is filled', () => {
    expect(isSlotAudible(A, 'v', SLOT_A, 'cam:b#0')).toBe(false)
    expect(isSourceOnScreen(A, 'v', SLOTS, 'cam:b#0')).toBe(false)
    expect(audioAfterSlots(heard(A), 'v', SLOTS, 'cam:b#0').active).toBeNull()
  })

  it('keeps the filled slot itself heard', () => {
    const state = heard(A)
    expect(isSlotAudible(A, 'v', SLOT_A, 'cam:a#0')).toBe(true)
    expect(audioAfterSlots(state, 'v', SLOTS, 'cam:a#0')).toBe(state)
  })

  it('stays muted after leaving fill', () => {
    const covered = audioAfterSlots(heard(A), 'v', SLOTS, 'cam:b#0')
    expect(isSlotAudible(covered.active, 'v', SLOT_A, null)).toBe(false)
  })
})

describe('mute all (AUD-3, `M`)', () => {
  it('mutes whatever is heard', () => {
    expect(muteAllAudio(heard(B, 0.5))).toEqual(heard(null, 0.5))
  })

  it('is not a toggle: with nothing heard it hands back the same state', () => {
    expect(muteAllAudio(INITIAL_AUDIO_STATE)).toBe(INITIAL_AUDIO_STATE)
  })
})

describe('volume (AUD-3)', () => {
  it('clamps into 0…1', () => {
    expect(clampVolume(0.25)).toBe(0.25)
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(2)).toBe(1)
    expect(clampVolume(0)).toBe(0)
    expect(clampVolume(1)).toBe(1)
  })

  it('treats a non-finite level as the default', () => {
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_VOLUME)
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VOLUME)
  })

  it('sets the level without touching who is heard, and skips a no-op', () => {
    const state = heard(A)
    expect(setAudioVolume(state, 0.6)).toEqual(heard(A, 0.6))
    expect(setAudioVolume(state, 1)).toBe(state)
    expect(setAudioVolume(state, 5)).toBe(state)
  })
})

describe('the store', () => {
  afterEach(() => {
    useAudioStore.setState(INITIAL_AUDIO_STATE, true)
  })

  it('applies the rules', () => {
    audioActions.unmute(A)
    audioActions.unmute(B)
    expect(useAudioStore.getState().active).toEqual(B)
    audioActions.setVolume(0.2)
    audioActions.mute(A)
    expect(useAudioStore.getState()).toEqual(heard(B, 0.2))
    audioActions.syncSlots(
      'v',
      [{ kind: 'camera', key: 'cam:b#0', cameraId: 'x', audio: true }],
      null,
    )
    expect(useAudioStore.getState()).toEqual(heard(null, 0.2))
  })

  it('does not notify subscribers for a no-op', () => {
    let calls = 0
    const off = useAudioStore.subscribe(() => {
      calls += 1
    })
    audioActions.muteAll()
    audioActions.setVolume(1)
    off()
    expect(calls).toBe(0)
  })

  it('mute all clears it', () => {
    audioActions.unmute(A)
    audioActions.muteAll()
    expect(useAudioStore.getState().active).toBeNull()
  })
})
