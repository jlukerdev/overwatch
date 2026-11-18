// Fake doors served by the Access mock (P0.4, extended in P5.5). The door object and the lock-rule
// and emergency shapes follow the official reference (docs/reference/access-endpoints-v4.2.16.md,
// §7.7–§7.13), which is documented but not yet run against hardware (OS-1).
//
// THE MOCK'S OWN CHOICES. The reference says what each endpoint takes and returns, not how unlock,
// lock rules and emergency mode interact, nor what `door_lock_relay_status` reads meanwhile. This
// store has to pick something coherent, because the app polls the relay to draw the lock state:
//
//   relay reads, first match wins:
//     1. emergency lockdown            -> lock   (every door)
//     2. emergency evacuation          -> unlock (every door)
//     3. rule keep_lock                -> lock
//     4. a momentary unlock is running -> unlock (PUT /unlock, or the mock-only "card tap")
//     5. rule keep_unlock, custom or schedule -> unlock
//     6. otherwise                     -> lock   (no rule, or lock_early)
//
//   - unlock: momentary, `unlockMs` long, then back to whatever 1–6 give. Refused during lockdown
//     and under keep_lock (the caller answers CODE_OPERATION_FORBIDDEN).
//   - keep_unlock / keep_lock: until reset, lock_now or another rule. `ended_time` is a far-future
//     constant. keep_lock also cancels a running momentary unlock.
//   - custom: unlock for `interval` minutes, `ended_time` = now + interval, then no rule.
//   - reset: ends keep_lock / keep_unlock / custom. It does not touch schedule or lock_early (the
//     reference says reset is not for schedules) nor a running momentary unlock.
//   - schedule (P5.6): the reference has no API to create an unlock schedule (it is configured in
//     the Access app), so the mock has a mock-only control for "this door is inside its unlock
//     schedule for the next N minutes" (`startSchedule`, `POST /__mock/doors/{id}/schedule`). It
//     reads as: relay unlock, rule `{ type: 'schedule', ended_time: now + N minutes }`, gone at
//     that time. Any rule set through the API replaces it (the mock keeps one rule per door).
//   - lock_early: relay lock, rule `{ type: 'lock_early', ended_time }`, gone at that time.
//     `ended_time` is the end of the schedule it cut short when the door was inside one, and the
//     next UTC midnight otherwise.
//   - lock_now: ends everything (rule and momentary unlock).
//   - no rule: `{ type: '', ended_time: 0 }`. UNDOCUMENTED, a guess (the reference does not say
//     what GET lock_rule answers for a door without a rule).
//   - emergency overrides, it does not erase: rules and timers keep running underneath, and the
//     doors "return to their own state" when both flags are false again.
//
// OS-1 is what replaces these guesses. Node runs this file directly: erasable syntax only.
import type {
  AccessDoor,
  AccessEmergencyStatus,
  AccessLockRule,
  AccessLockRuleRequest,
  DoorLockRelayStatus,
} from '../../src/main/access/types.ts'

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

/** How long a momentary unlock holds the relay at `unlock` (the real one is the door's setting). */
export const DEFAULT_UNLOCK_MS = 5000

/** `ended_time` of keep_lock / keep_unlock: the far-future value of the kind the reference shows. */
export const FAR_FUTURE_ENDED_TIME = 3602128562

/** What GET lock_rule answers for a door with no rule. UNDOCUMENTED: the mock's guess. */
export const NO_LOCK_RULE: Readonly<AccessLockRule> = { type: '', ended_time: 0 }

/** Longest delay node's setTimeout takes; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1
const DAY_S = 86_400

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

/** Who caused a momentary unlock: the API (`PUT …/unlock`) or the mock-only "card tap" route. */
export type UnlockSource = 'remote' | 'local'

/** Why an unlock was refused, or `ok`. */
export type UnlockOutcome = 'ok' | 'lockdown' | 'keep_lock'

/**
 * What the store tells its listeners. `unlock` is the only one with a documented WebSocket
 * counterpart (and only for `source: 'remote'`); `relay` fires whenever a door's relay reading
 * changes, timers included, and is for logging and tests: the reference documents no such push.
 */
export type DoorChange =
  | { kind: 'unlock'; doorId: string; source: UnlockSource }
  | { kind: 'relay'; doorId: string; relay: DoorLockRelayStatus }
  | { kind: 'position'; doorId: string; position: 'open' | 'close' }
  | { kind: 'rule'; doorId: string; rule: AccessLockRule }
  | { kind: 'emergency'; status: AccessEmergencyStatus }

export interface DoorStore {
  list(): AccessDoor[]
  get(id: string): AccessDoor | undefined
  /**
   * Momentary unlock: relay `unlock` for `unlockMs` (a second one restarts the window), unless
   * refused. Does not check `is_bind_hub`; the request handler does. Throws for an unknown id.
   */
  unlock(id: string, source?: UnlockSource): UnlockOutcome
  /** Ends the momentary unlock and any rule, as `lock_now` does. */
  lock(id: string): void
  setPosition(id: string, position: 'open' | 'close'): void
  setLockRule(id: string, request: AccessLockRuleRequest): void
  /**
   * Mock-only (P5.6): puts the door inside an unlock schedule that ends in `minutes`. Relay
   * `unlock`, rule `schedule`. Replaces any rule the door had. Throws for an unknown id.
   */
  startSchedule(id: string, minutes: number): void
  lockRule(id: string): AccessLockRule
  emergency(): AccessEmergencyStatus
  setEmergency(status: AccessEmergencyStatus): void
  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(listener: (change: DoorChange) => void): () => void
  /** Cancels every pending timer. */
  dispose(): void
}

export interface DoorStoreOptions {
  /** A door seeded with relay `unlock` starts under a `keep_unlock` rule. */
  doors?: readonly AccessDoor[]
  unlockMs?: number
  timers?: TimerApi
  /** Clock in Unix milliseconds, for `ended_time`. */
  now?: () => number
}

type Rule =
  | { type: 'keep_lock' | 'keep_unlock' }
  | { type: 'custom' | 'lock_early' | 'schedule'; endedTime: number }

interface DoorState {
  door: AccessDoor
  rule: Rule | undefined
  ruleTimer: unknown
  pulseTimer: unknown
  /** The relay reading last reported, to tell a change from a no-op. */
  seen: DoorLockRelayStatus
}

export function createDoorStore(options: DoorStoreOptions = {}): DoorStore {
  const unlockMs = options.unlockMs ?? DEFAULT_UNLOCK_MS
  const timers = options.timers ?? realTimers
  const now = options.now ?? Date.now
  const emergency: AccessEmergencyStatus = { lockdown: false, evacuation: false }
  const listeners = new Set<(change: DoorChange) => void>()
  const states = new Map<string, DoorState>(
    (options.doors ?? SEED_DOORS).map((d) => [
      d.id,
      {
        door: { ...d },
        rule: d.door_lock_relay_status === 'unlock' ? { type: 'keep_unlock' } : undefined,
        ruleTimer: undefined,
        pulseTimer: undefined,
        seen: d.door_lock_relay_status,
      },
    ]),
  )

  function emit(change: DoorChange): void {
    for (const l of [...listeners]) l(change)
  }

  function relayOf(s: DoorState): DoorLockRelayStatus {
    if (emergency.lockdown) return 'lock'
    if (emergency.evacuation) return 'unlock'
    if (s.rule?.type === 'keep_lock') return 'lock'
    if (s.pulseTimer !== undefined) return 'unlock'
    return s.rule?.type === 'keep_unlock' ||
      s.rule?.type === 'custom' ||
      s.rule?.type === 'schedule'
      ? 'unlock'
      : 'lock'
  }

  /** Reports every door whose relay reading changed since the last call. */
  function sync(): void {
    for (const s of states.values()) {
      const relay = relayOf(s)
      if (relay === s.seen) continue
      s.seen = relay
      emit({ kind: 'relay', doorId: s.door.id, relay })
    }
  }

  function view(s: DoorState): AccessDoor {
    return { ...s.door, door_lock_relay_status: relayOf(s) }
  }

  function need(id: string): DoorState {
    const s = states.get(id)
    if (s === undefined) throw new Error(`No door ${id}`)
    return s
  }

  function ruleOf(s: DoorState): AccessLockRule {
    if (s.rule === undefined) return { ...NO_LOCK_RULE }
    return {
      type: s.rule.type,
      ended_time: 'endedTime' in s.rule ? s.rule.endedTime : FAR_FUTURE_ENDED_TIME,
    }
  }

  function clearPulse(s: DoorState): void {
    if (s.pulseTimer !== undefined) timers.clearTimeout(s.pulseTimer)
    s.pulseTimer = undefined
  }

  function setRule(s: DoorState, rule: Rule | undefined): void {
    if (s.ruleTimer !== undefined) timers.clearTimeout(s.ruleTimer)
    s.ruleTimer = undefined
    s.rule = rule
    if (rule !== undefined && 'endedTime' in rule) scheduleExpiry(s, rule.endedTime * 1000)
  }

  /** Ends the rule at `endMs` on the clock; a delay too long for one timer is taken in steps. */
  function scheduleExpiry(s: DoorState, endMs: number): void {
    const delay = endMs - now()
    s.ruleTimer =
      delay > MAX_TIMER_MS
        ? timers.setTimeout(() => {
            scheduleExpiry(s, endMs)
          }, MAX_TIMER_MS)
        : timers.setTimeout(
            () => {
              s.ruleTimer = undefined
              s.rule = undefined
              emit({ kind: 'rule', doorId: s.door.id, rule: ruleOf(s) })
              sync()
            },
            Math.max(0, delay),
          )
  }

  return {
    list: () => [...states.values()].map(view),
    get: (id) => {
      const s = states.get(id)
      return s === undefined ? undefined : view(s)
    },
    unlock(id, source = 'remote') {
      const s = need(id)
      if (emergency.lockdown) return 'lockdown'
      if (s.rule?.type === 'keep_lock') return 'keep_lock'
      clearPulse(s)
      s.pulseTimer = timers.setTimeout(() => {
        s.pulseTimer = undefined
        sync()
      }, unlockMs)
      emit({ kind: 'unlock', doorId: id, source })
      sync()
      return 'ok'
    },
    lock(id) {
      const s = need(id)
      const hadRule = s.rule !== undefined
      clearPulse(s)
      setRule(s, undefined)
      if (hadRule) emit({ kind: 'rule', doorId: id, rule: ruleOf(s) })
      sync()
    },
    setPosition(id, position) {
      const s = need(id)
      if (s.door.door_position_status === position) return
      s.door.door_position_status = position
      emit({ kind: 'position', doorId: id, position })
    },
    setLockRule(id, request) {
      const s = need(id)
      const nowS = Math.floor(now() / 1000)
      switch (request.type) {
        case 'keep_lock':
          clearPulse(s)
          setRule(s, { type: 'keep_lock' })
          break
        case 'keep_unlock':
          setRule(s, { type: 'keep_unlock' })
          break
        case 'custom':
          setRule(s, { type: 'custom', endedTime: nowS + (request.interval ?? 0) * 60 })
          break
        case 'reset':
          // Not for schedules (§7.10): a door inside one, or one whose schedule was ended early,
          // is left as it is.
          if (s.rule !== undefined && s.rule.type !== 'lock_early' && s.rule.type !== 'schedule')
            setRule(s, undefined)
          break
        case 'lock_early':
          clearPulse(s)
          setRule(s, {
            type: 'lock_early',
            // "End today's scheduled unlock now": until the schedule would have ended, when the
            // door is inside one; the mock's stand-in (next UTC midnight) otherwise.
            endedTime:
              s.rule?.type === 'schedule'
                ? s.rule.endedTime
                : (Math.floor(nowS / DAY_S) + 1) * DAY_S,
          })
          break
        case 'lock_now':
          clearPulse(s)
          setRule(s, undefined)
          break
      }
      emit({ kind: 'rule', doorId: id, rule: ruleOf(s) })
      sync()
    },
    startSchedule(id, minutes) {
      const s = need(id)
      setRule(s, { type: 'schedule', endedTime: Math.floor(now() / 1000) + minutes * 60 })
      emit({ kind: 'rule', doorId: id, rule: ruleOf(s) })
      sync()
    },
    lockRule: (id) => ruleOf(need(id)),
    emergency: () => ({ ...emergency }),
    setEmergency(status) {
      if (status.lockdown && status.evacuation)
        throw new Error('lockdown and evacuation cannot both be on')
      emergency.lockdown = status.lockdown
      emergency.evacuation = status.evacuation
      emit({ kind: 'emergency', status: { ...emergency } })
      sync()
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      for (const s of states.values()) {
        clearPulse(s)
        if (s.ruleTimer !== undefined) timers.clearTimeout(s.ruleTimer)
        s.ruleTimer = undefined
      }
    },
  }
}
