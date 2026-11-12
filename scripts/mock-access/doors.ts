// Fake doors served by the Access mock (P0.4). Shapes follow the COMMUNITY-SOURCED, UNVERIFIED
// door object in src/main/access/types.ts (OS-1 checks them on the real console).
// Node runs this file directly (type stripping): erasable syntax only.
import type { AccessDoor } from '../../src/main/access/types.ts'

const FLOOR_1 = 'c1a7d0e2-0000-4000-8000-00000000f001'
const FLOOR_2 = 'c1a7d0e2-0000-4000-8000-00000000f002'

/**
 * The seed set. Ids are fixed fake UUIDs so fixtures and tests are stable across runs.
 * `Storage Room` is deliberately not bound to a hub (`is_bind_hub: false`, no position sensor):
 * unlocking it is refused, which exercises the client's error path.
 */
export const SEED_DOORS: readonly AccessDoor[] = [
  {
    id: 'd00e0001-0000-4000-8000-000000000001',
    name: 'Front Door',
    full_name: 'Mock Console - 1F - Front Door',
    floor_id: FLOOR_1,
    type: 'door',
    is_bind_hub: true,
    door_lock_relay_status: 'lock',
    door_position_status: 'close',
  },
  {
    id: 'd00e0002-0000-4000-8000-000000000002',
    name: 'Garage Side Door',
    full_name: 'Mock Console - 1F - Garage Side Door',
    floor_id: FLOOR_1,
    type: 'door',
    is_bind_hub: true,
    door_lock_relay_status: 'lock',
    door_position_status: 'open',
  },
  {
    id: 'd00e0003-0000-4000-8000-000000000003',
    name: 'Office',
    full_name: 'Mock Console - 2F - Office',
    floor_id: FLOOR_2,
    type: 'door',
    is_bind_hub: true,
    door_lock_relay_status: 'lock',
    door_position_status: 'close',
  },
  {
    id: 'd00e0004-0000-4000-8000-000000000004',
    name: 'Storage Room',
    full_name: 'Mock Console - 2F - Storage Room',
    floor_id: FLOOR_2,
    type: 'door',
    is_bind_hub: false,
    door_lock_relay_status: 'lock',
    door_position_status: null,
  },
]

/** How long an unlocked relay stays at `unlock` before reverting to `lock` (community: "a few seconds"). */
export const DEFAULT_UNLOCK_MS = 5000

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // A pending relay revert must not keep the mock (or a test) process alive.
    t.unref()
    return t
  },
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>)
  },
}

export interface DoorStore {
  list(): AccessDoor[]
  get(id: string): AccessDoor | undefined
  /** Sets the relay to `unlock` and schedules the revert to `lock` (an unlock during an unlock restarts the timer). */
  unlock(id: string): void
  /** Cancels pending relay reverts. */
  dispose(): void
}

export interface DoorStoreOptions {
  doors?: readonly AccessDoor[]
  unlockMs?: number
  timers?: TimerApi
}

export function createDoorStore(options: DoorStoreOptions = {}): DoorStore {
  const unlockMs = options.unlockMs ?? DEFAULT_UNLOCK_MS
  const timers = options.timers ?? realTimers
  const doors = new Map((options.doors ?? SEED_DOORS).map((d) => [d.id, { ...d }]))
  const pending = new Map<string, unknown>()

  return {
    list: () => [...doors.values()].map((d) => ({ ...d })),
    get: (id) => {
      const d = doors.get(id)
      return d === undefined ? undefined : { ...d }
    },
    unlock(id) {
      const door = doors.get(id)
      if (door === undefined) throw new Error(`No door ${id}`)
      const prev = pending.get(id)
      if (prev !== undefined) timers.clearTimeout(prev)
      door.door_lock_relay_status = 'unlock'
      pending.set(
        id,
        timers.setTimeout(() => {
          door.door_lock_relay_status = 'lock'
          pending.delete(id)
        }, unlockMs),
      )
    },
    dispose() {
      for (const h of pending.values()) timers.clearTimeout(h)
      pending.clear()
    },
  }
}
