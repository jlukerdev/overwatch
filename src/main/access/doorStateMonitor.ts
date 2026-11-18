// The door-state monitor (DOOR-6, P5.5): keeps the linked doors' real lock state current for the
// Live screen's unlock buttons, including unlocks and relocks made elsewhere (a card tap, the
// Access app, a schedule).
//
// **Read-only, always.** This module never unlocks a door and never writes anything to the console
// (DOOR-3/4): its one request is `GET /doors`, and the only thing it does with the notifications
// WebSocket is listen. An unlock is still exactly one `PUT`, sent by the connection manager because
// the user held the control, and nothing here can cause one.
//
// Why it polls although there is a push channel (docs/reference/access-endpoints-v4.2.16.md):
//
//  1. **`GET /doors` is the only source of truth.** The notifications socket documents a
//     `remote_unlock` event and doorbell events, but no relock event and no payload carrying
//     `door_lock_relay_status`, and it does not say whether a card or PIN unlock is pushed at all.
//     So a frame is never a state: it is a reason to read sooner.
//  2. **Polling never depends on the socket.** The baseline poll runs whatever the socket does; a
//     frame, the socket opening or a `poke()` only pull the next read forward. While the socket is
//     briefly down the baseline tightens to cover for it; a socket that never opens (a token
//     without `view:device`, a console without the socket) gets the ordinary baseline.
//  3. **The socket opens after the first read that works**, not at `start()`: a token or a
//     certificate the console rejects is found by that one `GET /doors`, which halts the monitor
//     before any upgrade is attempted with it.
//  4. **Every frame is a hint**, not only the documented events: the reference does not say its
//     event list is complete. Frames are coalesced so that no frame rate can cause more than one
//     read per `TRIGGER_COALESCE_MS` plus the one in flight.
//
// Pure logic: no Electron, no socket and no HTTP in this file. The door read, the notifications
// opener, the clock and the timers are injected, so the unit tests drive every cadence on a fake
// clock (tests/unit/doorStateMonitor.test.ts).
import type { Door, DoorStates } from '@shared/models'
import { AccessApiError, isAccessApiUnavailable } from './client'
import type { AccessNotificationsState } from './notifications'
import type { AccessNotification } from './types'

/**
 * Baseline poll: while the notifications socket is `open`, and once it has been down for longer
 * than `NO_SOCKET_FAST_POLL_MS`.
 */
export const POLL_WITH_SOCKET_MS = 5_000
/**
 * Baseline poll while the socket has only just stopped being open (or has not opened yet): pushes
 * are being missed, so reads are closer together until it is back.
 */
export const POLL_WITHOUT_SOCKET_MS = 2_000
/**
 * How long the socket may be continuously not open before the faster poll gives up. A socket that
 * cannot open at all would otherwise mean a read every 2 s for ever; after this the monitor polls
 * at `POLL_WITH_SOCKET_MS` and says once that it is running on polling only.
 */
export const NO_SOCKET_FAST_POLL_MS = 60_000
/** Poll interval during a burst: after a trigger, and while a linked door reads `unlock`. */
export const BURST_POLL_MS = 1_000
/**
 * How long a trigger keeps the burst alive when no linked door reads `unlock`: the unlock that
 * caused the trigger may not be visible in the first read yet.
 */
export const BURST_AFTER_TRIGGER_MS = 3_000
/**
 * How long one door's continuous `unlock` keeps the burst alive. A door unlocked for longer is held
 * open by a lock rule or an unlock schedule, and polling it every second would never end; it falls
 * back to the baseline until it relocks or something else triggers a read.
 */
export const BURST_UNLOCKED_MAX_MS = 30_000
/** Triggers closer together than this share one read (at most one read start per window). */
export const TRIGGER_COALESCE_MS = 250
/** Consecutive failed reads after which the states become unknown (the first one keeps them). */
export const FAILURES_BEFORE_UNKNOWN = 2
/** Cap of the poll interval while reads are failing (doubles per consecutive failure). */
export const FAILURE_BACKOFF_MAX_MS = 30_000
/**
 * Why the monitor stopped by itself: a failure no retry of its own can fix. The token is wrong
 * (`auth`), the certificate is not accepted (`pin`), Access is off (`disabled`), or the console
 * refuses the whole API (`api-unavailable`, `isAccessApiUnavailable`). Polling and the socket both
 * stop until the next `start()`.
 */
export type DoorMonitorHaltReason = 'auth' | 'pin' | 'disabled' | 'api-unavailable'

/** The halt a failed read calls for, or `null` when polling should go on. */
export function doorReadHaltReason(error: unknown): DoorMonitorHaltReason | null {
  if (isAccessApiUnavailable(error)) return 'api-unavailable'
  if (!(error instanceof AccessApiError)) return null
  switch (error.kind) {
    case 'auth':
    case 'pin':
    case 'disabled':
      return error.kind
    default:
      return null
  }
}

export type DoorReadResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly error: unknown
      /** Consecutive failed reads, this one included. */
      readonly failures: number
      /** True when this failure halts the monitor (`doorReadHaltReason`). */
      readonly fatal: boolean
    }

export interface DoorNotificationHandlers {
  onNotification(notification: AccessNotification): void
  onStateChange(state: AccessNotificationsState): void
}

export interface DoorStateMonitorTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface DoorStateMonitorOptions {
  /** One `GET /doors`. Rejects with `AccessApiError` (or anything) on failure. */
  readonly readDoors: () => Promise<readonly Door[]>
  /**
   * Opens (and starts) the notifications socket; `null` when it cannot be opened, e.g. the endpoint
   * does not resolve. Called at most once per `start()`, after the first read that works. Polling
   * runs either way.
   */
  readonly openNotifications: (handlers: DoorNotificationHandlers) => { stop(): void } | null
  /** The door ids to report: the values of the saved `doorLinks`, read at every use. */
  readonly linkedDoorIds: () => ReadonlySet<string>
  /** The whole map, whenever what is known changes. Never called with an unchanged map. */
  readonly onStates: (states: DoorStates) => void
  /** Each read's outcome, so the caller can move the Access status (CON-5) on transitions. */
  readonly onReadResult?: (result: DoorReadResult) => void
  /** The monitor has just stopped by itself (it is no longer running when this is called). */
  readonly onHalt?: (reason: DoorMonitorHaltReason) => void
  readonly now?: () => number
  readonly timers?: DoorStateMonitorTimers
  /** Safe lines only: no token, no URL. Never one line per read. Default: no-op. */
  readonly log?: (line: string) => void
}

export interface DoorStateMonitor {
  /** Idempotent. Reads at once; the notifications socket opens once a read has worked. */
  start(): void
  /** Idempotent. Cancels the timer, stops the socket and emits `{}` once if anything was known. */
  stop(): void
  /**
   * A reason to read now: the app's own unlock was answered, or the caller knows the links changed.
   * Drops any door that is no longer linked at once. A no-op while not running.
   */
  poke(reason: string): void
  readonly running: boolean
  /** A copy of what is known right now. */
  readonly states: DoorStates
}

function sameStates(a: DoorStates, b: DoorStates): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((id) => {
    const left = a[id]
    const right = b[id]
    if (left === undefined || right === undefined) return false
    return left.relay === right.relay && left.position === right.position
  })
}

export function createDoorStateMonitor(options: DoorStateMonitorOptions): DoorStateMonitor {
  const now = options.now ?? Date.now
  const timers: DoorStateMonitorTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
  const log = options.log ?? ((): void => undefined)

  let running = false
  /**
   * Bumped by every `start()` and `stop()`. A read or a socket callback that belongs to an earlier
   * run compares its captured value and does nothing: no emit, no status, no rescheduling.
   */
  let run = 0
  let states: DoorStates = {}
  let socket: { stop(): void } | null = null
  let socketOpen = false
  /** `openNotifications` has been called in this run (once only, even if it answered `null`). */
  let socketAsked = false
  /** Since when the socket has been continuously not open; `null` while it is open. */
  let socketDownSince: number | null = null
  /** The "polling only" line has been logged for this outage. */
  let pollingOnlySaid = false
  let timer: unknown = null
  let inFlight = false
  /** A trigger is waiting for its read (coalesced: one flag, however many triggers). */
  let triggered = false
  let lastReadStartedAt: number | null = null
  let lastReadEndedAt: number | null = null
  let burstUntil = 0
  /** When each linked door was first seen `unlock` without a `lock` since. */
  const unlockedSince = new Map<string, number>()
  let failures = 0

  function publish(next: DoorStates): void {
    if (sameStates(states, next)) return
    states = next
    options.onStates({ ...next })
  }

  function baseline(at: number): number {
    if (socketOpen || socketDownSince === null) return POLL_WITH_SOCKET_MS
    if (at - socketDownSince < NO_SOCKET_FAST_POLL_MS) return POLL_WITHOUT_SOCKET_MS
    // Only once the socket has actually been tried: before that, reads are what is failing.
    if (!pollingOnlySaid && socketAsked) {
      pollingOnlySaid = true
      log(
        'door monitor: no live notifications; door state is running on polling only. The Access ' +
          'API token needs the view:device permission for push updates',
      )
    }
    return POLL_WITH_SOCKET_MS
  }

  function burstActive(at: number): boolean {
    if (at < burstUntil) return true
    for (const since of unlockedSince.values()) {
      if (at - since < BURST_UNLOCKED_MAX_MS) return true
    }
    return false
  }

  /** The wait between the end of one read and the start of the next, with no trigger pending. */
  function pollInterval(at: number): number {
    if (failures > 0) return Math.min(baseline(at) * 2 ** failures, FAILURE_BACKOFF_MAX_MS)
    return burstActive(at) ? BURST_POLL_MS : baseline(at)
  }

  function cancelTimer(): void {
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  /** (Re)arms the one timer for the next read. Safe to call whenever an input to the delay moved. */
  function schedule(): void {
    if (!running || inFlight) return
    cancelTimer()
    const at = now()
    const due = triggered
      ? (lastReadStartedAt ?? at - TRIGGER_COALESCE_MS) + TRIGGER_COALESCE_MS
      : (lastReadEndedAt ?? at) + pollInterval(at)
    const delay = Math.max(0, due - at)
    if (delay === 0 && triggered) {
      read()
      return
    }
    timer = timers.setTimeout(() => {
      timer = null
      read()
    }, delay)
  }

  /** A failure no retry can fix: everything stops until the next `start()`. */
  function halt(reason: DoorMonitorHaltReason): void {
    log(`door monitor: stopped after a ${reason} failure; it starts again once that is fixed`)
    teardown()
    options.onHalt?.(reason)
  }

  function teardown(): void {
    running = false
    run += 1
    cancelTimer()
    inFlight = false
    triggered = false
    socketOpen = false
    unlockedSince.clear()
    const open = socket
    socket = null
    open?.stop()
    publish({})
  }

  function applyDoors(doors: readonly Door[]): void {
    const linked = options.linkedDoorIds()
    const at = now()
    const next: DoorStates = {}
    for (const door of doors) {
      if (!linked.has(door.id)) continue
      next[door.id] = { relay: door.relay, position: door.position }
    }
    for (const id of [...unlockedSince.keys()]) {
      if (next[id]?.relay !== 'unlock') unlockedSince.delete(id)
    }
    for (const [id, state] of Object.entries(next)) {
      if (state.relay === 'unlock' && !unlockedSince.has(id)) unlockedSince.set(id, at)
    }
    publish(next)
  }

  function read(): void {
    if (!running || inFlight) return
    cancelTimer()
    const mine = run
    inFlight = true
    triggered = false
    lastReadStartedAt = now()
    let pending: Promise<readonly Door[]>
    try {
      pending = options.readDoors()
    } catch (err) {
      // A reader that throws instead of rejecting (an address that does not resolve) is a failure
      // like any other.
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    pending.then(
      (doors) => {
        if (mine !== run) return
        inFlight = false
        lastReadEndedAt = now()
        failures = 0
        applyDoors(doors)
        options.onReadResult?.({ ok: true })
        if (mine !== run) return
        // The console has just accepted the token and the certificate: now the socket may use them.
        openSocket()
        schedule()
      },
      (error: unknown) => {
        if (mine !== run) return
        inFlight = false
        lastReadEndedAt = now()
        failures += 1
        const haltReason = doorReadHaltReason(error)
        options.onReadResult?.({ ok: false, error, failures, fatal: haltReason !== null })
        // The callback may have stopped or restarted the monitor.
        if (mine !== run) return
        if (haltReason !== null) {
          halt(haltReason)
          return
        }
        if (failures >= FAILURES_BEFORE_UNKNOWN) {
          if (failures === FAILURES_BEFORE_UNKNOWN) {
            log(
              'door monitor: door reads keep failing; the lock states are unknown until one works',
            )
          }
          unlockedSince.clear()
          publish({})
        }
        schedule()
      },
    )
  }

  /**
   * A reason to read sooner. Starts (or extends) the burst and asks for one read, no sooner than
   * `TRIGGER_COALESCE_MS` after the previous read started; a read in flight is followed by exactly
   * one more. `hintOnly` is a notification frame: while reads are failing it does not cut the
   * backoff short, so a chatty socket cannot make the app hammer a console that is not answering.
   */
  function trigger(hintOnly: boolean): void {
    if (!running) return
    burstUntil = now() + BURST_AFTER_TRIGGER_MS
    if (hintOnly && failures > 0) return
    triggered = true
    schedule()
  }

  function start(): void {
    if (running) return
    running = true
    run += 1
    states = {}
    failures = 0
    triggered = false
    inFlight = false
    socketOpen = false
    socketAsked = false
    socketDownSince = now()
    pollingOnlySaid = false
    burstUntil = 0
    lastReadStartedAt = null
    lastReadEndedAt = null
    unlockedSince.clear()
    log('door monitor: started')
    read()
  }

  /** Opens the notifications socket for this run, once. Called after a read has worked. */
  function openSocket(): void {
    if (!running || socketAsked) return
    socketAsked = true
    const mine = run
    let opened: { stop(): void } | null = null
    try {
      opened = options.openNotifications({
        onNotification: () => {
          if (mine === run) trigger(true)
        },
        onStateChange: (next) => {
          if (mine !== run) return
          const open = next === 'open'
          if (open === socketOpen) return
          socketOpen = open
          if (open) {
            socketDownSince = null
            pollingOnlySaid = false
            // Something may have been missed while it was down, so read now.
            trigger(false)
          } else {
            // The baseline tightens for a while, so the pending timer is re-armed.
            socketDownSince = now()
            schedule()
          }
        },
      })
    } catch {
      log('door monitor: the notifications socket could not be opened; polling only')
    }
    if (mine !== run) {
      // Stopped from inside the opener's own callbacks: this socket belongs to nobody.
      opened?.stop()
      return
    }
    socket = opened
    if (opened === null) log('door monitor: no notifications socket; polling only')
  }

  function stop(): void {
    if (!running) return
    log('door monitor: stopped')
    teardown()
  }

  function poke(reason: string): void {
    if (!running) return
    log(`door monitor: read requested (${reason})`)
    // A door unlinked a moment ago must not linger until the read answers (or fails).
    const linked = options.linkedDoorIds()
    const kept: DoorStates = {}
    for (const [id, state] of Object.entries(states)) {
      if (linked.has(id)) kept[id] = state
      else unlockedSince.delete(id)
    }
    publish(kept)
    trigger(false)
  }

  return {
    start,
    stop,
    poke,
    get running() {
      return running
    },
    get states() {
      return { ...states }
    },
  }
}
