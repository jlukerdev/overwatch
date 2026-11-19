// DOOR-6 (P5.5): one "watch the doors" session, with its retry policy. No React and no store here:
// `useDoorWatch` hands in the store's `watchDoors` and the window's timers, and the unit test hands
// in fakes (tests/renderer/doorWatchRetry.test.ts).
//
// A session starts by asking main to watch (`watchDoors(true)`). If that does not answer `ok` — main
// still starting (`not-ready`), an `internal` failure, a bridge that throws — nothing would ask
// again by itself, and every unlock control would stay neutral until the user left the Live screen
// and came back. So while the session is open, a start that failed is asked again: after
// {@link WATCH_RETRY_FIRST_MS}, then every {@link WATCH_RETRY_MS}, with at most one timer pending
// and never two calls out at once. An `ok` answer ends the retries (later changes are main's
// pushes). Stopping the session clears the timer, ignores any answer still on its way, and sends
// the one `watchDoors(false)`, which is never retried: the store has already emptied its map, and
// the next session's start is what matters.
//
// The Doors screen's watch (P5.6, features/doors/useDoorsScreenWatch.ts) is the same kind of
// session — a start that must be retried, a stop that must not — and uses this module as it is,
// handing in the store's `watchDoorsScreen` as `watchDoors`.
//
// This only asks main to read door state. It can never send an unlock (DOOR-4).

/** The wait before the first retry of a failed start. */
export const WATCH_RETRY_FIRST_MS = 2000
/** The wait before every later retry. */
export const WATCH_RETRY_MS = 5000

/** The wait after the `failures`-th failed start in a row (1 = the first). */
export function watchRetryDelay(failures: number): number {
  return failures <= 1 ? WATCH_RETRY_FIRST_MS : WATCH_RETRY_MS
}

export interface DoorWatchDeps<Timer> {
  /** The store's action; only `ok` is read from the answer. */
  readonly watchDoors: (watching: boolean) => Promise<{ readonly ok: boolean }>
  readonly setTimer: (run: () => void, ms: number) => Timer
  readonly clearTimer: (timer: Timer) => void
}

/** Opens a session (header) and returns its stop. Stopping twice does nothing the second time. */
export function startDoorWatch<Timer>({
  watchDoors,
  setTimer,
  clearTimer,
}: DoorWatchDeps<Timer>): () => void {
  let stopped = false
  let failures = 0
  let timer: { readonly handle: Timer } | null = null

  const failed = (): void => {
    if (stopped) return
    failures += 1
    timer = {
      handle: setTimer(() => {
        timer = null
        attempt()
      }, watchRetryDelay(failures)),
    }
  }
  const attempt = (): void => {
    if (stopped) return
    watchDoors(true).then((result) => {
      // An `ok` start needs nothing more; a stopped session ignores whatever comes back.
      if (!result.ok) failed()
    }, failed)
  }
  attempt()

  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimer(timer.handle)
    timer = null
    // Not retried, and its outcome is not read (header).
    watchDoors(false).catch(() => undefined)
  }
}
