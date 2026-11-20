// P5.6: the Doors screen's slice of the app store (src/renderer/src/state/appStore.ts):
// `watchDoorsScreen`, the `doorsScreen` push, and the calls that change a door.
//
// What these tests protect: the screen never keeps a state from a watch that has ended; a late
// answer never overwrites a newer push or a newer call; a failed open leaves everything unknown;
// and the two calls that change a physical door are passed through exactly once each, by nothing
// but their own action (DOOR-3/4). The watch-retry policy is doorWatchRetry.test.ts's.
import {
  emptyDoorsScreenState,
  type AppState,
  type DoorsScreenState,
  type IpcResult,
  type ViewProtectApi,
} from '@shared/ipc'
import { DoorSchema, SettingsSchema } from '@shared/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/src/state/appStore'

const FRONT = DoorSchema.parse({
  id: 'd-front',
  name: 'Front',
  fullName: 'Front Door',
  floorId: 'floor-1',
  type: 'door',
  boundToHub: true,
  relay: 'lock',
  position: 'close',
})

const state = (overrides: Partial<DoorsScreenState> = {}): DoorsScreenState => ({
  ...emptyDoorsScreenState(),
  doors: [FRONT],
  emergency: { lockdown: false, evacuation: false },
  ...overrides,
})
const LOCKED = state()
const UNLOCKED = state({ doors: [{ ...FRONT, relay: 'unlock' }] })
const EMPTY = emptyDoorsScreenState()

const ok = <T>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value })
const refused: IpcResult<never> = {
  ok: false,
  error: { kind: 'not-ready', message: 'Starting.', endpoint: null, retryable: true },
}

interface Fake {
  pushDoorsScreen: (state: DoorsScreenState) => void
}

/** Only what these tests touch; anything else on the bridge would be a bug and throws. */
function fakeBridge(overrides: Partial<ViewProtectApi>): Fake {
  const listeners = new Set<(state: DoorsScreenState) => void>()
  const none = () => () => undefined
  const api: Partial<ViewProtectApi> = {
    onConnection: none,
    onCameras: none,
    onCameraState: none,
    onDoorStates: none,
    onDoorsScreen: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', {
    value: { viewProtect: api },
    configurable: true,
    writable: true,
  })
  return {
    pushDoorsScreen: (pushed) => {
      for (const listener of listeners) listener(pushed)
    },
  }
}

/** A `watchDoorsScreen` whose answers the test hands out itself, in whatever order it likes. */
function deferredWatch(): {
  watchDoorsScreen: ReturnType<typeof vi.fn<ViewProtectApi['watchDoorsScreen']>>
  answer: (call: number, result: IpcResult<DoorsScreenState>) => void
} {
  const resolvers: ((result: IpcResult<DoorsScreenState>) => void)[] = []
  const watchDoorsScreen = vi.fn<ViewProtectApi['watchDoorsScreen']>(
    () =>
      new Promise<IpcResult<DoorsScreenState>>((resolve) => {
        resolvers.push(resolve)
      }),
  )
  return {
    watchDoorsScreen,
    answer: (call, result) => {
      resolvers[call]?.(result)
    },
  }
}

const shown = (): DoorsScreenState => useAppStore.getState().doorsScreen

// The store's bookkeeping outlives a test: leave every test with the screen closed.
beforeEach(async () => {
  fakeBridge({ watchDoorsScreen: () => ok(EMPTY) })
  await useAppStore.getState().watchDoorsScreen(false)
})

describe('watchDoorsScreen', () => {
  it('starts with everything unknown', () => {
    expect(shown()).toEqual(EMPTY)
  })

  it('opens with one call and takes the answer as the first state', async () => {
    const watchDoorsScreen = vi.fn<ViewProtectApi['watchDoorsScreen']>(() => ok(LOCKED))
    fakeBridge({ watchDoorsScreen })

    const result = await useAppStore.getState().watchDoorsScreen(true)

    expect(result.ok).toBe(true)
    expect(watchDoorsScreen).toHaveBeenCalledExactlyOnceWith({ open: true })
    expect(shown()).toEqual(LOCKED)
  })

  it('replaces the whole state with each push while open', async () => {
    const bridge = fakeBridge({ watchDoorsScreen: () => ok(LOCKED) })
    const unsubscribe = useAppStore.getState().subscribe()
    await useAppStore.getState().watchDoorsScreen(true)

    bridge.pushDoorsScreen(UNLOCKED)
    expect(shown()).toEqual(UNLOCKED)

    const halted = state({ doors: null, emergency: null, error: refused.error })
    bridge.pushDoorsScreen(halted)
    expect(shown()).toEqual(halted)
    unsubscribe()
  })

  it('keeps a push that overtook the open call: the late answer does not undo it', async () => {
    const { watchDoorsScreen, answer } = deferredWatch()
    const bridge = fakeBridge({ watchDoorsScreen })
    const unsubscribe = useAppStore.getState().subscribe()

    const opening = useAppStore.getState().watchDoorsScreen(true)
    bridge.pushDoorsScreen(UNLOCKED)
    answer(0, { ok: true, value: LOCKED })
    await opening

    expect(shown()).toEqual(UNLOCKED)
    unsubscribe()
  })

  it('empties the state when the screen closes, before main has answered', async () => {
    const { watchDoorsScreen, answer } = deferredWatch()
    fakeBridge({ watchDoorsScreen })
    useAppStore.setState({ doorsScreen: UNLOCKED })

    const closing = useAppStore.getState().watchDoorsScreen(false)
    expect(shown()).toEqual(EMPTY)

    // Whatever main answers to a close, nothing is known.
    answer(0, { ok: true, value: UNLOCKED })
    await closing
    expect(watchDoorsScreen).toHaveBeenCalledExactlyOnceWith({ open: false })
    expect(shown()).toEqual(EMPTY)
  })

  it('drops a push that arrives while closed, so no stale door comes back', async () => {
    const bridge = fakeBridge({ watchDoorsScreen: () => ok(LOCKED) })
    const unsubscribe = useAppStore.getState().subscribe()
    await useAppStore.getState().watchDoorsScreen(true)
    await useAppStore.getState().watchDoorsScreen(false)

    // Sent by main before it handled the close.
    bridge.pushDoorsScreen(UNLOCKED)

    expect(shown()).toEqual(EMPTY)
    unsubscribe()
  })

  it('leaves everything unknown when the open is refused, and hands the failure back', async () => {
    fakeBridge({ watchDoorsScreen: () => Promise.resolve(refused) })
    useAppStore.setState({ doorsScreen: UNLOCKED })

    const result = await useAppStore.getState().watchDoorsScreen(true)

    // `ok: false` is what the screen's retry session reads (doorWatchRetry.ts).
    expect(result.ok).toBe(false)
    expect(shown()).toEqual(EMPTY)
  })

  it('treats a bridge that throws as a failed call, not an unhandled rejection', async () => {
    fakeBridge({ watchDoorsScreen: () => Promise.reject(new Error('no such channel')) })

    const result = await useAppStore.getState().watchDoorsScreen(true)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).not.toContain('no such channel')
    expect(shown()).toEqual(EMPTY)
  })

  it('ignores an open answered after a later close (out of order)', async () => {
    const { watchDoorsScreen, answer } = deferredWatch()
    fakeBridge({ watchDoorsScreen })

    const opening = useAppStore.getState().watchDoorsScreen(true)
    const closing = useAppStore.getState().watchDoorsScreen(false)
    answer(1, { ok: true, value: EMPTY })
    await closing
    answer(0, { ok: true, value: UNLOCKED })
    await opening

    expect(shown()).toEqual(EMPTY)
  })

  it("Refresh — close, then open — ends on the new open's answer, in either answer order", async () => {
    const { watchDoorsScreen, answer } = deferredWatch()
    fakeBridge({ watchDoorsScreen })
    useAppStore.setState({ doorsScreen: LOCKED })

    const closing = useAppStore.getState().watchDoorsScreen(false)
    const opening = useAppStore.getState().watchDoorsScreen(true)
    // Loading in between: the old list is not shown as if it were fresh.
    expect(shown()).toEqual(EMPTY)
    answer(1, { ok: true, value: UNLOCKED })
    await opening
    answer(0, { ok: true, value: EMPTY })
    await closing

    expect(watchDoorsScreen.mock.calls.map(([input]) => input.open)).toEqual([false, true])
    expect(shown()).toEqual(UNLOCKED)
  })
})

describe('the calls that change a door (DOOR-3/4)', () => {
  it('passes a door action through once and folds nothing in', async () => {
    const value = {
      doorId: 'd-front',
      doorName: 'Front Door',
      action: 'unlock' as const,
      sent: 'unlock' as const,
      minutes: null,
      outcome: 'done' as const,
      reason: null,
    }
    const doorAction = vi.fn<ViewProtectApi['doorAction']>(() => ok(value))
    fakeBridge({ doorAction, watchDoorsScreen: () => ok(LOCKED) })
    await useAppStore.getState().watchDoorsScreen(true)

    const result = await useAppStore.getState().doorAction({ doorId: 'd-front', action: 'unlock' })

    expect(result).toEqual({ ok: true, value })
    expect(doorAction).toHaveBeenCalledExactlyOnceWith({ doorId: 'd-front', action: 'unlock' })
    // The door's new state is main's next push, never a guess from the answer.
    expect(shown()).toEqual(LOCKED)
  })

  it('does not repeat a door action that failed', async () => {
    const doorAction = vi.fn<ViewProtectApi['doorAction']>(() => Promise.resolve(refused))
    fakeBridge({ doorAction })

    const result = await useAppStore.getState().doorAction({ doorId: 'd-front', action: 'lock' })

    expect(result.ok).toBe(false)
    expect(doorAction).toHaveBeenCalledTimes(1)
  })

  it('passes an emergency change through once, with both flags', async () => {
    const setDoorEmergency = vi.fn<ViewProtectApi['setDoorEmergency']>((input) =>
      ok({ ...input, outcome: 'done' as const, reason: null }),
    )
    fakeBridge({ setDoorEmergency })

    await useAppStore.getState().setDoorEmergency({ lockdown: true, evacuation: false })

    expect(setDoorEmergency).toHaveBeenCalledExactlyOnceWith({ lockdown: true, evacuation: false })
  })

  it('never acts on a door from a watch or a push: those only read', async () => {
    const doorAction = vi.fn<ViewProtectApi['doorAction']>()
    const setDoorEmergency = vi.fn<ViewProtectApi['setDoorEmergency']>()
    const bridge = fakeBridge({ doorAction, setDoorEmergency, watchDoorsScreen: () => ok(LOCKED) })
    const unsubscribe = useAppStore.getState().subscribe()

    await useAppStore.getState().watchDoorsScreen(true)
    bridge.pushDoorsScreen(UNLOCKED)
    bridge.pushDoorsScreen(state({ emergency: { lockdown: true, evacuation: false } }))
    await useAppStore.getState().watchDoorsScreen(false)

    expect(doorAction).not.toHaveBeenCalled()
    expect(setDoorEmergency).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('setAccessPolling (DOOR-6)', () => {
  it('folds the saved intervals back in', async () => {
    const polling = { withSocketSec: 10, withoutSocketSec: 3, unlockedSec: 2, detailsSec: 60 }
    const saved: AppState = {
      version: '0.1.0',
      settings: SettingsSchema.parse({ accessPolling: polling }),
      keystoreAvailable: true,
      secretsStored: { protectApiKey: false, accessToken: false, rtspUrls: {} },
      connection: null as unknown as AppState['connection'],
      cameras: [],
    }
    const setAccessPolling = vi.fn<ViewProtectApi['setAccessPolling']>(() => ok(saved))
    fakeBridge({ setAccessPolling })

    const result = await useAppStore.getState().setAccessPolling(polling)

    expect(result.ok).toBe(true)
    expect(setAccessPolling).toHaveBeenCalledExactlyOnceWith(polling)
    expect(useAppStore.getState().settings?.accessPolling).toEqual(polling)
  })
})
