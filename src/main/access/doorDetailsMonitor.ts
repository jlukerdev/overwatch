// The Doors screen's "details" reads (P5.6): each door's lock rule (`GET /doors/{id}/lock_rule`)
// and the emergency status of all doors (`GET /doors/settings/emergency`). Driven by the door-state
// monitor (./doorStateMonitor.ts), which starts it once the Doors screen is open and a door read
// has worked, and stops it with itself.
//
// **Read-only, always** (DOOR-3/4). Nothing here writes to the console: the two requests above are
// GETs, and the PUTs that change a rule or the emergency status are sent by the connection manager
// alone, once, because the user confirmed a dialog.
//
// Why it is separate from the door reads, and so much slower:
//
//  1. **It costs a request per door.** The reference has no "all rules" endpoint, so a round is
//     one emergency read plus one rule read for every door. `GET /doors` is one request whatever
//     the door count, which is why that one can run every second and this one cannot.
//  2. **Strictly one request at a time.** A round reads the emergency status and then each door in
//     turn, never in parallel, and at most one round is in flight: the console's rate limit is
//     undocumented (SPEC §5.2), and a wall of doors must not become a burst of requests. A round
//     asked for while one is running is coalesced into exactly one more, whatever the number of
//     requests.
//  2a. **A requested round reads only what its reason touched** (`DoorDetailsScope`). One door's
//     action or relay change is that door's rule, not a request per door on the wall; only the
//     timer, a list that changed, a recovery and an emergency change read everything. Requests
//     that are coalesced merge their scopes, and "everything" wins. The timed rounds keep their
//     own cadence: a scoped round does not postpone the next full one.
//  3. **A failure here is "unknown", nothing more.** Both endpoints need Access 1.24.6; on an older
//     console every read fails for ever. That must look like a door whose rule is not known, not
//     like a broken connection: failures never reach the Access status (CON-5), are never retried
//     faster than the round cadence, and are logged when reading starts or stops working, not once
//     per request.
//  4. **A round that meets a dead endpoint stops asking.** When a read fails for a reason that is
//     about the endpoint rather than the one resource (no answer, a rejected token, a certificate)
//     the rest of that round is skipped and counted as unknown, instead of waiting out a timeout
//     per door.
//
// Pure logic: the two readers, the door ids, the interval, the clock and the timers are injected,
// so the unit tests drive every round on a fake clock (tests/unit/doorDetailsMonitor.test.ts).
import type { DoorEmergency, DoorRule } from '@shared/models'
import { AccessApiError, isAccessApiUnavailable, type AccessErrorKind } from './client'

/**
 * Failures that are about **one resource**: the console answered, and refused or did not have this
 * door's rule (or has no such endpoint at all, an older console). The next read in the round is
 * still worth making. Every other failure ends the round (rule 4).
 */
const RESOURCE_LEVEL_KINDS: ReadonlySet<AccessErrorKind> = new Set([
  'forbidden',
  'not-found',
  'bad-request',
  'invalid-response',
])

/** True when the rest of the round would fail the same way (rule 4). */
export function detailsReadEndsRound(error: unknown): boolean {
  if (!(error instanceof AccessApiError)) return true
  if (isAccessApiUnavailable(error)) return true
  return !RESOURCE_LEVEL_KINDS.has(error.kind)
}

/**
 * What a requested round reads (rule 2a). `'all'`: the emergency status and every listed door's
 * rule — what a timed round reads. Otherwise only the named doors' rules (ids that are not listed
 * are skipped, never asked for), plus the emergency status when `emergency` is set.
 */
export type DoorDetailsScope =
  'all' | { readonly doorIds: readonly string[]; readonly emergency: boolean }

/** The union of two scopes (rule 2a): `'all'` wins, door ids are merged, `emergency` is or-ed. */
export function mergeDetailsScopes(
  a: DoorDetailsScope | null,
  b: DoorDetailsScope,
): DoorDetailsScope {
  if (a === null) return b
  if (a === 'all' || b === 'all') return 'all'
  return {
    doorIds: [...new Set([...a.doorIds, ...b.doorIds])],
    emergency: a.emergency || b.emergency,
  }
}

export interface DoorDetailsTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface DoorDetailsOptions {
  /** One `GET /doors/settings/emergency`. Rejects (or throws) on failure. */
  readonly readEmergency: () => Promise<DoorEmergency>
  /** One `GET /doors/{id}/lock_rule`. Rejects (or throws) on failure. */
  readonly readLockRule: (doorId: string) => Promise<DoorRule>
  /** The doors to read rules for, read once per round (after the emergency read). */
  readonly doorIds: () => readonly string[]
  /**
   * The wait between the end of one full round and the next timed one, read at every (re)arming.
   */
  readonly intervalMs: () => number
  /**
   * Whether a **timed** round is worth starting: `false` while the door reads themselves are
   * failing, when these would fail too. The round is skipped, not queued; the next one is a full
   * interval later. A requested round (`request`) is not held back by this. Default: always.
   */
  readonly ready?: () => boolean
  /** Something in `rules` or `emergency` changed. Never called for an unchanged value. */
  readonly onChange: () => void
  readonly now?: () => number
  readonly timers?: DoorDetailsTimers
  /** Safe lines only, and never one per read (rule 3). Default: no-op. */
  readonly log?: (line: string) => void
}

export interface DoorDetailsMonitor {
  /** Idempotent. Starts a round at once; later ones follow every `intervalMs()`. */
  start(): void
  /**
   * Idempotent. Cancels the timer and forgets everything that was read; a read in flight is not
   * cancelled, but its answer is dropped. Does not call `onChange`: the caller is the one stopping.
   */
  stop(): void
  /**
   * Forgets everything that was read without stopping: the caller knows it may no longer be true
   * (the door reads have been failing). Does not call `onChange`.
   */
  forget(): void
  /**
   * A round now: the app's own action was answered, or a door's relay changed. It reads `scope`
   * only (default: everything). Coalesced — while a round is running, any number of requests cause
   * exactly one more after it, reading the union of their scopes. A no-op while stopped.
   */
  request(reason: string, scope?: DoorDetailsScope): void
  /**
   * `intervalMs()` may have changed: the pending timer is re-armed from the last full round's end.
   */
  rearm(): void
  readonly running: boolean
  /** Door id → rule. A door that is missing is unknown. A live view, not a copy. */
  readonly rules: ReadonlyMap<string, DoorRule>
  readonly emergency: DoorEmergency | null
}

function sameRule(a: DoorRule | undefined, b: DoorRule): boolean {
  return a?.type === b.type && a.endedTime === b.endedTime
}

function describeKind(error: unknown): string {
  return error instanceof AccessApiError ? error.kind : 'error'
}

export function createDoorDetailsMonitor(options: DoorDetailsOptions): DoorDetailsMonitor {
  const now = options.now ?? Date.now
  const timers: DoorDetailsTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
  const log = options.log ?? ((): void => undefined)
  const ready = options.ready ?? ((): boolean => true)

  let running = false
  /** Bumped by every `start()` and `stop()`: a round from an earlier run applies nothing. */
  let run = 0
  let inFlight = false
  /**
   * What was asked for while a round was running (rule 2: one more round, however many requests;
   * rule 2a: their scopes merged). `null`: nothing.
   */
  let again: DoorDetailsScope | null = null
  let timer: unknown = null
  /**
   * When the last **full** round ended (or was skipped): what the timed rounds count from, so that
   * scoped rounds — a busy door — can never keep pushing the full one back.
   */
  let lastFullRoundEndedAt: number | null = null
  const rules = new Map<string, DoorRule>()
  let emergency: DoorEmergency | null = null
  /** Whether the last round could read each kind, for the transition lines; `null`: no round yet. */
  let emergencyReadable: boolean | null = null
  let rulesReadable: boolean | null = null

  function cancelTimer(): void {
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    if (!running || inFlight) return
    cancelTimer()
    const at = now()
    const delay = Math.max(0, (lastFullRoundEndedAt ?? at) + options.intervalMs() - at)
    timer = timers.setTimeout(() => {
      timer = null
      if (!ready()) {
        // Skipped, not queued: the caller asks for a round itself once the door reads work again.
        lastFullRoundEndedAt = now()
        schedule()
        return
      }
      void round('all')
    }, delay)
  }

  function setEmergency(next: DoorEmergency | null): void {
    const same =
      emergency === null || next === null
        ? emergency === next
        : emergency.lockdown === next.lockdown && emergency.evacuation === next.evacuation
    if (same) return
    emergency = next === null ? null : { lockdown: next.lockdown, evacuation: next.evacuation }
    options.onChange()
  }

  function setRule(doorId: string, next: DoorRule | null): void {
    if (next === null) {
      if (rules.delete(doorId)) options.onChange()
      return
    }
    if (sameRule(rules.get(doorId), next)) return
    rules.set(doorId, { type: next.type, endedTime: next.endedTime })
    options.onChange()
  }

  /** Rule 3: one line when a kind of read starts failing, one when it works again. */
  function noteEmergency(error: unknown): void {
    const readable = error === null
    if (readable === emergencyReadable) return
    // The first round working is not news.
    if (!readable) {
      log(
        `door details: the emergency status cannot be read (${describeKind(error)}); it is shown ` +
          'as unknown. It needs Access 1.24.6 or later and a token with the view:space permission',
      )
    } else if (emergencyReadable === false) {
      log('door details: the emergency status can be read again')
    }
    emergencyReadable = readable
  }

  function noteRules(failed: number, total: number, error: unknown): void {
    const readable = failed === 0
    if (readable === rulesReadable) return
    if (!readable) {
      log(
        `door details: the lock rule of ${String(failed)} of ${String(total)} door(s) cannot be ` +
          `read (${describeKind(error)}); shown as unknown. It needs Access 1.24.6 or later and ` +
          'a token with the view:space permission',
      )
    } else if (rulesReadable === false) {
      log('door details: the lock rules can be read again')
    }
    rulesReadable = readable
  }

  /**
   * One round (rule 2): the emergency status, then each door's rule, one request after the other —
   * or only the part of that `scope` names (rule 2a). Every result is applied as it arrives, so
   * the screen fills in door by door rather than after the last one. Never rejects.
   */
  async function round(scope: DoorDetailsScope): Promise<void> {
    if (!running || inFlight) return
    cancelTimer()
    const mine = run
    inFlight = true
    const full = scope === 'all'
    /** Rule 4: set by a failure that makes the rest of the round pointless. */
    let ended = false

    let emergencyError: unknown = null
    const emergencyRead = full || scope.emergency
    if (emergencyRead) {
      try {
        const status = await options.readEmergency()
        if (mine !== run) return
        setEmergency(status)
      } catch (err) {
        if (mine !== run) return
        emergencyError = err ?? new Error('unknown error')
        setEmergency(null)
        ended = detailsReadEndsRound(err)
      }
    }

    const listedIds = currentDoorIds()
    // A scoped round never asks about a door that is not (or no longer) listed.
    const wanted = full ? null : new Set(scope.doorIds)
    const ids = wanted === null ? listedIds : listedIds.filter((id) => wanted.has(id))
    let failed = 0
    let ruleError: unknown = null
    for (const id of ids) {
      if (ended) {
        // Not asked (rule 4): unknown, like a read that failed.
        failed += 1
        setRule(id, null)
        continue
      }
      try {
        const rule = await options.readLockRule(id)
        if (mine !== run) return
        setRule(id, rule)
      } catch (err) {
        if (mine !== run) return
        failed += 1
        ruleError ??= err ?? new Error('unknown error')
        setRule(id, null)
        ended = detailsReadEndsRound(err)
      }
    }
    // A door that has left the list keeps no rule.
    const listed = new Set(listedIds)
    for (const id of [...rules.keys()]) {
      if (!listed.has(id)) setRule(id, null)
    }

    inFlight = false
    if (emergencyRead) noteEmergency(emergencyError)
    if (full) {
      lastFullRoundEndedAt = now()
      // A round ended early by the emergency read blames that read, not the rules. Only a full
      // round says whether "the rules" can be read: one door's answer must not flip the line that
      // is about all of them.
      noteRules(failed, ids.length, ruleError ?? emergencyError)
    }
    const next = takeAgain()
    if (next !== null) {
      void round(next)
      return
    }
    // From the last full round's end: overdue (a scoped round ran across it) means now.
    schedule()
  }

  /**
   * The doors of this round, each id once (a console that lists a door twice is asked once). A
   * getter that throws means "none", not a failed round.
   */
  function currentDoorIds(): readonly string[] {
    try {
      return [...new Set(options.doorIds())]
    } catch {
      return []
    }
  }

  /** Reads and clears the "one more round" scope (set by `request` while a round was running). */
  function takeAgain(): DoorDetailsScope | null {
    const was = again
    again = null
    return was
  }

  function forget(): void {
    rules.clear()
    emergency = null
  }

  return {
    start() {
      if (running) return
      running = true
      run += 1
      inFlight = false
      again = null
      lastFullRoundEndedAt = null
      emergencyReadable = null
      rulesReadable = null
      forget()
      void round('all')
    },
    stop() {
      if (!running) return
      running = false
      run += 1
      cancelTimer()
      inFlight = false
      again = null
      forget()
    },
    forget,
    request(reason, scope = 'all') {
      if (!running) return
      if (inFlight) {
        again = mergeDetailsScopes(again, scope)
        return
      }
      log(`door details: read requested (${reason})`)
      void round(scope)
    },
    rearm() {
      schedule()
    },
    get running() {
      return running
    },
    get rules() {
      return rules
    },
    get emergency() {
      return emergency === null ? null : { ...emergency }
    },
  }
}
