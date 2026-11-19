// One cancellable backoff wait, shared by the self-healing sockets (the Protect feeds,
// `../protect/subscriptions.ts`, and the Access notifications socket, `../access/notifications.ts`).
//
// A reconnect loop waits out its backoff with an injected `sleep(ms, signal)`. Two things may end
// that wait early, and both need the same care:
//
//  - **stop** (the `parent` signal): the loop is over, nothing more may happen;
//  - **wake** (`wake()`, P6.2 / NFR-7): the machine woke or its network changed, so the loop should
//    reconnect now rather than after a backoff that grew while the network was gone.
//
// Either one aborts the wait's own `signal`, so a sleep that honours it can clear its timer (no
// timer is left pending behind a wake). `done` resolves in all three cases — the sleep ran out, a
// wake, a stop — and **only** rejects when the injected sleep rejects on its own: a sleep that
// rejects *because* its signal was aborted is the normal end of an early wake or stop, not an
// internal error, so that rejection is swallowed. `done` is settled by the wake before the signal
// is aborted, so whichever way the sleep reacts to the abort cannot win the race either.
//
// No timers of its own, no clock: everything is the caller's injected `sleep`.

export type BackoffSleep = (ms: number, signal: AbortSignal) => Promise<void>

export interface BackoffWait {
  /** Settles when the wait is over: resolves on time, on `wake()` or on the parent's abort. */
  readonly done: Promise<void>
  /** Ends the wait now. Idempotent; a no-op once the wait is over. */
  wake(): void
}

export function startBackoffWait(
  sleep: BackoffSleep,
  ms: number,
  parent?: AbortSignal,
): BackoffWait {
  const own = new AbortController()
  let resolveEarly = (): void => undefined
  const early = new Promise<void>((resolve) => {
    resolveEarly = resolve
  })
  const end = (): void => {
    // Resolved first, aborted second: `done` is decided before the sleep sees the abort.
    resolveEarly()
    own.abort()
  }
  if (parent?.aborted === true) end()
  else parent?.addEventListener('abort', end, { once: true })

  let slept: Promise<void>
  try {
    slept = sleep(ms, own.signal)
  } catch (err) {
    slept = Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  const quietOnAbort = slept.catch((err: unknown) => {
    // An abort-driven rejection is the normal end of a wake or a stop.
    if (own.signal.aborted) return
    throw err
  })
  const done = Promise.race([quietOnAbort, early]).finally(() => {
    parent?.removeEventListener('abort', end)
  })
  return { done, wake: end }
}

/**
 * The default backoff sleep: a timer that the signal clears. Used by both sockets when no `sleep`
 * is injected.
 */
export function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
