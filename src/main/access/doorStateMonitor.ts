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
// **Two watchers since P5.6.** The Live screen wants the *linked* doors' state (`onStates`,
// unchanged); the Doors screen wants *every* door the console lists, plus each door's lock rule and
// the emergency status (`screen.onState`). Both are served by the same reads: there is still one
// `GET /doors` loop and one socket, whoever is watching. While the Doors screen is open
// (`screen.open()`):
//
//  - every door of the answer is tracked, so the unlocked burst follows any of them;
//  - the last list that was read is kept (`knownDoor`) — it is what the connection manager checks
//    a Doors screen action's door id against, so it is dropped the moment it may belong to another
//    console or token: on `stop()`, on a halt, on `forgetScreen()` and when the screen closes;
//  - the details reads run (./doorDetailsMonitor.ts): one full round once the first read has
//    worked, then every `detailsMs`, and at once when the list gains or loses a door and when the
//    door reads work again after failing. In between, only what moved is read: the rule of a door
//    whose relay changed (it probably did too) with the emergency status (it may be why), and
//    whatever the caller names (`refreshDetails`, after the app's own action).
//
// The four intervals a user may change (P5.6) come through `intervals()`, read at every scheduling
// decision, and `rearm()` re-arms the pending timers after a save, so a shorter interval applies
// now rather than after the old one has run out. Everything else below stays a constant.
//
// Pure logic: no Electron, no socket and no HTTP in this file. The door read, the notifications
// opener, the clock and the timers are injected, so the unit tests drive every cadence on a fake
// clock (tests/unit/doorStateMonitor.test.ts).
import { emptyDoorsScreenState, type DoorsScreenState, type IpcError } from '@shared/ipc'
import type { Door, DoorEmergency, DoorRule, DoorStates } from '@shared/models'
import { AccessApiError, isAccessApiUnavailable } from './client'
import {
  createDoorDetailsMonitor,
  type DoorDetailsMonitor,
  type DoorDetailsScope,
} from './doorDetailsMonitor'
import type { AccessNotificationsState } from './notifications'
import type { AccessNotification } from './types'

/**
 * Baseline poll: while the notifications socket is `open`, and once it has been down for longer
 * than `NO_SOCKET_FAST_POLL_MS`. The default of `DoorMonitorIntervals.withSocketMs` (P5.6: a
 * setting, `accessPolling.withSocketSec`).
 */
export const POLL_WITH_SOCKET_MS = 5_000
/**
 * Baseline poll while the socket has only just stopped being open (or has not opened yet): pushes
 * are being missed, so reads are closer together until it is back. The default of
 * `DoorMonitorIntervals.withoutSocketMs` (`accessPolling.withoutSocketSec`).
 */
export const POLL_WITHOUT_SOCKET_MS = 2_000
/**
 * How long the socket may be continuously not open before the faster poll gives up. A socket that
 * cannot open at all would otherwise mean a read every 2 s for ever; after this the monitor polls
 * at `POLL_WITH_SOCKET_MS` and says once that it is running on polling only.
 */
export const NO_SOCKET_FAST_POLL_MS = 60_000
/**
 * Poll interval during a burst: after a trigger, and while a watched door reads `unlock`. The
 * default of `DoorMonitorIntervals.unlockedMs` (`accessPolling.unlockedSec`).
 */
export const BURST_POLL_MS = 1_000
/**
 * How often the Doors screen's lock rules and emergency status are re-read (P5.6). The default of
 * `DoorMonitorIntervals.detailsMs` (`accessPolling.detailsSec`).
 */
export const DETAILS_POLL_MS = 30_000

/**
 * The intervals a user may change (P5.6), in milliseconds. The connection manager supplies them
 * from the saved `accessPolling` settings, already validated to their ranges
 * (`ACCESS_POLLING_BOUNDS`); this module trusts them.
 */
export interface DoorMonitorIntervals {
  readonly withSocketMs: number
  readonly withoutSocketMs: number
  readonly unlockedMs: number
  readonly detailsMs: number
}

/** P5.5's values: what the monitor uses when no `intervals` getter is given. */
export const DEFAULT_DOOR_MONITOR_INTERVALS: DoorMonitorIntervals = {
  withSocketMs: POLL_WITH_SOCKET_MS,
  withoutSocketMs: POLL_WITHOUT_SOCKET_MS,
  unlockedMs: BURST_POLL_MS,
  detailsMs: DETAILS_POLL_MS,
}
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
/**
 * Cap of the poll interval while reads are failing (doubles per consecutive failure). A baseline
 * the user set above this is not shortened by it: a failing console is never read more often than
 * a healthy one.
 */
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

/** What the monitor needs to serve the Doors screen as well (P5.6). */
export interface DoorScreenOptions {
  /** Whether the Doors screen is open, read at every use. Tell the monitor with `screenChanged()`. */
  readonly open: () => boolean
  /** One `GET /doors/settings/emergency`, for the details rounds. */
  readonly readEmergency: () => Promise<DoorEmergency>
  /** One `GET /doors/{id}/lock_rule`, for the details rounds. */
  readonly readLockRule: (doorId: string) => Promise<DoorRule>
  /**
   * The whole screen state, whenever it changes **while the screen is open**. Never called with an
   * unchanged state, and never while the screen is closed.
   */
  readonly onState: (state: DoorsScreenState) => void
  /**
   * A failed door read as the renderer may see it (`toIpcError` in the connection manager). The
   * default keeps only the message, for tests that do not care.
   */
  readonly toError?: (error: unknown) => IpcError
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
  /** P5.6: the user-set intervals, read at every scheduling decision. Default: P5.5's constants. */
  readonly intervals?: () => DoorMonitorIntervals
  /** P5.6: the Doors screen. Without it the monitor serves the Live screen only, as in P5.5. */
  readonly screen?: DoorScreenOptions
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
  /**
   * P5.6: `intervals()` has just changed. Re-arms the pending door-read and details timers from
   * the new values, so a shorter interval applies now. Sends nothing by itself; a no-op while not
   * running.
   */
  rearm(): void
  /**
   * P5.6: `screen.open()` has just changed. Opening reads the doors at once (the list is kept only
   * while the screen is open, so there is none yet) and the details rounds start with that read;
   * closing stops the details rounds and forgets the list. A no-op for the reads while not running.
   */
  screenChanged(): void
  /**
   * P5.6: a details round now (coalesced): the app's own door action or emergency change was
   * answered. `scope` says what it touched — one door's rule, or everything (the default); see
   * `DoorDetailsScope`. A no-op while not running, while the screen is closed or before a read has
   * worked.
   */
  refreshDetails(reason: string, scope?: DoorDetailsScope): void
  /**
   * P5.6: the token or an accepted certificate has just changed, so what was read for the Doors
   * screen may belong to another console or account: the door list, the rules and the emergency
   * status are dropped at once and read again. A door read or a details round that was already in
   * flight was sent with the old token or certificate, so its answer is not taken for the screen
   * either: the list stays unknown until a read started after this call answers. The Live screen's
   * `states` are left alone (they are re-read by the same read). A no-op while not running.
   */
  forgetScreen(reason: string): void
  readonly running: boolean
  /** A copy of what is known right now. */
  readonly states: DoorStates
  /** P5.6: the Doors screen's state right now; everything unknown while the screen is closed. */
  readonly screen: DoorsScreenState
  /**
   * P5.6: a door from the list last read **in this run, while the Doors screen was open**, or
   * `null`. This is the only place a Doors screen action's door id is accepted from (DOOR-3/4).
   */
  knownDoor(id: string): Door | null
  /**
   * P5.6: the door reads have failed `FAILURES_BEFORE_UNKNOWN` times in a row, so every state is
   * unknown and the kept list is only names (`DoorsScreenState.stale`). The connection manager
   * refuses a door action while this is `true` (DOOR-4). `false` while not running.
   */
  readonly stale: boolean
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
  const intervals =
    options.intervals ?? ((): DoorMonitorIntervals => DEFAULT_DOOR_MONITOR_INTERVALS)
  const screenOptions = options.screen ?? null
  const screenOpen = (): boolean => screenOptions?.open() === true
  const toScreenError =
    screenOptions?.toError ??
    ((error: unknown): IpcError => ({
      kind: 'internal',
      message: error instanceof Error ? error.message : 'The door list could not be read.',
      endpoint: null,
      retryable: false,
    }))

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
  /**
   * When each watched door was first seen `unlock` without a `lock` since. Watched: the linked
   * doors, or every door while the Doors screen is open.
   */
  const unlockedSince = new Map<string, number>()
  let failures = 0
  /**
   * P5.6: the last `GET /doors` answer of this run, kept only while the Doors screen is open.
   * `null` until a read works, and again whenever it may no longer be the current console's.
   */
  let screenDoors: readonly Door[] | null = null
  /**
   * Bumped by `forgetScreen()`. A door read captures it when it starts; one that answers under a
   * later value was sent before the token or certificate changed, and must not become the list
   * door actions are checked against (DOOR-3/4). The details rounds need no counter of their own:
   * dropping the list stops the details monitor, which drops the answers of a round in flight.
   */
  let screenGeneration = 0
  /**
   * The last failed door read, while reads are failing. Kept through a halt (the screen has to say
   * why nothing is listed) and through the `start()` that follows one, until a read answers;
   * cleared by a read that works and by `stop()`.
   */
  let screenError: IpcError | null = null
  /** `JSON` of the screen state last built, so an unchanged one is never sent again. */
  let screenKey = JSON.stringify(emptyDoorsScreenState())

  const details: DoorDetailsMonitor | null =
    screenOptions === null
      ? null
      : createDoorDetailsMonitor({
          readEmergency: screenOptions.readEmergency,
          readLockRule: screenOptions.readLockRule,
          doorIds: () => (screenDoors ?? []).map((door) => door.id),
          intervalMs: () => intervals().detailsMs,
          // While the door reads fail these would fail too; a round is asked for on recovery.
          ready: () => failures === 0,
          onChange: () => {
            publishScreen()
          },
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.timers === undefined ? {} : { timers: options.timers }),
          log,
        })

  /** Two failed reads in a row: what is known is too old to show, or to act on. */
  function stale(): boolean {
    return running && failures >= FAILURES_BEFORE_UNKNOWN
  }

  function buildScreen(): DoorsScreenState {
    if (!screenOpen()) return emptyDoorsScreenState()
    const rules: Record<string, DoorRule> = {}
    if (details !== null) {
      for (const door of screenDoors ?? []) {
        const rule = details.rules.get(door.id)
        if (rule !== undefined) rules[door.id] = { type: rule.type, endedTime: rule.endedTime }
      }
    }
    return {
      doors: screenDoors === null ? null : screenDoors.map((door) => ({ ...door })),
      stale: stale(),
      rules,
      emergency: details?.emergency ?? null,
      error: screenErrorShown(),
    }
  }

  /**
   * The failed read the screen is told about (user decision 2026-11-18): at once while there is no
   * list — nothing can be shown, so the reason is all there is — and otherwise only together with
   * `stale`, from the second failure in a row. One lost poll with a list on screen is not news.
   */
  function screenErrorShown(): IpcError | null {
    if (screenError === null) return null
    return screenDoors === null || stale() ? { ...screenError } : null
  }

  /** Sends the screen state if it changed and the screen is open. Cheap: a handful of doors. */
  function publishScreen(): void {
    if (screenOptions === null) return
    const next = buildScreen()
    const key = JSON.stringify(next)
    if (key === screenKey) return
    screenKey = key
    // A closed screen is told nothing; the key still follows, so reopening compares against "empty".
    if (screenOpen()) screenOptions.onState(next)
  }

  /** Drops what was read for the Doors screen (not the last error: that is still why). */
  function dropScreenData(): void {
    screenDoors = null
    details?.stop()
  }

  function publish(next: DoorStates): void {
    if (sameStates(states, next)) return
    states = next
    options.onStates({ ...next })
  }

  function baseline(at: number): number {
    if (socketOpen || socketDownSince === null) return intervals().withSocketMs
    if (at - socketDownSince < NO_SOCKET_FAST_POLL_MS) return intervals().withoutSocketMs
    // Only once the socket has actually been tried: before that, reads are what is failing.
    if (!pollingOnlySaid && socketAsked) {
      pollingOnlySaid = true
      log(
        'door monitor: no live notifications; door state is running on polling only. The Access ' +
          'API token needs the view:device permission for push updates',
      )
    }
    return intervals().withSocketMs
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
    if (failures > 0) {
      // Never below the baseline: the cap is under the largest baseline a user may set, and
      // without the `max` a console that is not answering would be read more often than one that
      // is.
      const base = baseline(at)
      return Math.max(base, Math.min(base * 2 ** failures, FAILURE_BACKOFF_MAX_MS))
    }
    // A burst only ever reads sooner: a user who sets the unlocked interval above a baseline (the
    // ranges overlap) gets the baseline, not a slower poll for a door that is standing open.
    const base = baseline(at)
    return burstActive(at) ? Math.min(intervals().unlockedMs, base) : base
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
    // The door list goes with the run: an id is only good for the console it was read from.
    dropScreenData()
    publish({})
    publishScreen()
  }

  /**
   * P5.6: takes a fresh door list for the Doors screen and decides whether the details are due.
   * `recovered`: this is the first read to work after one or more failed.
   */
  function applyScreenDoors(doors: readonly Door[], recovered: boolean): void {
    if (details === null) return
    if (!screenOpen()) {
      // Normally done by `screenChanged()`; this covers a caller that forgot to say.
      dropScreenData()
      return
    }
    const before = screenDoors
    screenDoors = doors.map((door) => ({ ...door }))
    if (!details.running) {
      // The first read that worked since the screen opened (or since the list was dropped).
      details.start()
      return
    }
    // Both keyed by door id, so an id the console lists twice counts once on each side (comparing
    // against `doors.length` would call every such read a changed list).
    const previous = new Map((before ?? []).map((door) => [door.id, door.relay]))
    const current = new Map(doors.map((door) => [door.id, door.relay]))
    const listChanged =
      previous.size !== current.size || [...current.keys()].some((id) => !previous.has(id))
    if (listChanged) {
      // A new door has no rule yet, and a list that changed is reason enough to look at it all.
      details.request('the door list changed')
      return
    }
    if (recovered) {
      // Everything was forgotten while the reads failed (`details.forget()`).
      details.request('the door reads work again')
      return
    }
    // A relay that moved: that door's rule is probably not what was read last. Only those doors
    // are asked about, in one (coalesced) round however many moved — plus the emergency status,
    // one request: a lockdown or an evacuation started elsewhere is exactly a relay that moved,
    // and its banner must not wait for the next timed round.
    const moved = [...current].filter(([id, relay]) => previous.get(id) !== relay).map(([id]) => id)
    if (moved.length > 0) {
      details.request("a door's lock state changed", { doorIds: moved, emergency: true })
    }
  }

  /**
   * `forScreen`: the read may become the Doors screen's list (`false` for one that was in flight
   * across a `forgetScreen()`; the Live states still take it, as they always did).
   */
  function applyDoors(doors: readonly Door[], recovered: boolean, forScreen: boolean): void {
    const linked = options.linkedDoorIds()
    const everyDoor = screenOpen()
    const at = now()
    const next: DoorStates = {}
    /** The doors whose `unlock` keeps the burst alive: the linked ones, or all of them (P5.6). */
    const watchedUnlocked = new Set<string>()
    for (const door of doors) {
      const isLinked = linked.has(door.id)
      if (isLinked) next[door.id] = { relay: door.relay, position: door.position }
      if ((isLinked || everyDoor) && door.relay === 'unlock') watchedUnlocked.add(door.id)
    }
    for (const id of [...unlockedSince.keys()]) {
      if (!watchedUnlocked.has(id)) unlockedSince.delete(id)
    }
    for (const id of watchedUnlocked) {
      if (!unlockedSince.has(id)) unlockedSince.set(id, at)
    }
    if (forScreen) applyScreenDoors(doors, recovered)
    publish(next)
    publishScreen()
  }

  function read(): void {
    if (!running || inFlight) return
    cancelTimer()
    const mine = run
    const generation = screenGeneration
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
        const recovered = failures > 0
        failures = 0
        screenError = null
        // `forgetScreen()` asked for a read of its own (`trigger`), which follows this one.
        applyDoors(doors, recovered, generation === screenGeneration)
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
        // Recorded whether or not the Doors screen is open, and from the first failure although it
        // is shown from the second (`screenErrorShown`): a screen that opens while the reads are
        // failing has no list, and has to be able to say why at once.
        screenError = toScreenError(error)
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
          // The rules and the emergency status are as old as the relays now: unknown too, and read
          // again when the door reads work (`applyScreenDoors`). The list itself is kept, flagged
          // `stale`, so the screen still names its doors.
          details?.forget()
          publish({})
        }
        publishScreen()
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
    // `screenError` is deliberately kept: a restart after a halt (the 60 s retry of a rejected
    // token) must not blank the reason for the length of one request and then show it again.
    screenDoors = null
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
    if (!running) {
      // A monitor that halted keeps its last error for the screen; an explicit stop ends that too.
      if (screenError !== null) {
        screenError = null
        publishScreen()
      }
      return
    }
    log('door monitor: stopped')
    screenError = null
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
      // While the Doors screen is open every door is watched, linked or not.
      else if (!screenOpen()) unlockedSince.delete(id)
    }
    publish(kept)
    trigger(false)
  }

  function rearm(): void {
    if (!running) return
    schedule()
    details?.rearm()
  }

  function screenChanged(): void {
    if (running) {
      if (screenOpen()) {
        // No list is kept while the screen is closed, so there is nothing to show yet: read now.
        // The details rounds start when that read answers (`applyScreenDoors`).
        log('door monitor: the Doors screen opened; every door is watched')
        trigger(false)
      } else {
        log('door monitor: the Doors screen closed')
        dropScreenData()
        // Back to the linked doors only: an unlinked door standing open no longer holds the burst.
        const linked = options.linkedDoorIds()
        for (const id of [...unlockedSince.keys()]) {
          if (!linked.has(id)) unlockedSince.delete(id)
        }
        schedule()
      }
    }
    publishScreen()
  }

  function refreshDetails(reason: string, scope: DoorDetailsScope = 'all'): void {
    if (!running || !screenOpen()) return
    details?.request(reason, scope)
  }

  function forgetScreen(reason: string): void {
    if (!running) return
    log(`door monitor: the door list was dropped (${reason})`)
    // Before anything else: a read in flight was sent with what has just been replaced.
    screenGeneration += 1
    dropScreenData()
    publishScreen()
    trigger(false)
  }

  return {
    start,
    stop,
    poke,
    rearm,
    screenChanged,
    refreshDetails,
    forgetScreen,
    get running() {
      return running
    },
    get states() {
      return { ...states }
    },
    get screen() {
      return buildScreen()
    },
    knownDoor(id) {
      if (!running || !screenOpen()) return null
      const door = screenDoors?.find((entry) => entry.id === id)
      return door === undefined ? null : { ...door }
    },
    get stale() {
      return stale()
    },
  }
}
