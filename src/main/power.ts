// Power and recovery (P6.2): the display-sleep blocker while a View is on screen (NFR-8), and the
// two signals that tell the rest of main to stop waiting out its backoffs (NFR-7): the machine woke
// from sleep, or its network changed.
//
// **The blocker (NFR-8).** A wall of cameras is useless behind a screen saver, but an app that keeps
// the display on while it shows Settings is a bad citizen. So the renderer says whether a View is on
// screen (`setViewVisible`: the Live screen shows a View and the document is visible), and main holds
// exactly **one** `prevent-display-sleep` blocker while the last answer was `true`. The renderer can
// also vanish without saying `false` — a reload, a crash, the window closing — so `release()` is
// called from each of those in `src/main/index.ts` (the same events that end the door watch), and
// from `dispose()` at quit. `prevent-display-sleep` keeps the display on, which also keeps the system
// awake; nothing here asks for more (`prevent-app-suspension` alone would let the screen go dark).
// The perf harness has a blocker of its own (`./perf/perfMode.ts`); the two never touch each other.
//
// **Recovery (NFR-7).** After a sleep every socket may be dead without TCP having noticed (keepalive
// takes a minute or more), and every backoff that grew while the network was gone is now just a
// delay. Two triggers, one callback (`recover(reason)`, wired to the connection manager, go2rtc and
// the renderer in `src/main/index.ts`):
//
//  1. `resume` from `powerMonitor`: reason `resume`. `suspend` is only logged.
//  2. A network change. Electron's main process has no event for it, so `os.networkInterfaces()` is
//     polled every `NETWORK_POLL_MS`. The fingerprint (`networkFingerprint`) is the sorted set of
//     the non-internal, non-link-local **IPv4 addresses**, plus the **names** of the interfaces that
//     have a non-link-local IPv6 address — never the IPv6 addresses themselves: privacy
//     (temporary) IPv6 addresses rotate about daily, and each rotation would otherwise be a full
//     recover that spends Protect rate-limit permits (R9) for nothing. An IPv6-only network
//     appearing or going away still changes the set of names, so it still counts. Link-local
//     addresses (169.254/16, fe80::/10) are left out for the same reason as the rotation: they come
//     and go with interfaces that reach no console (macOS's awdl0, utun). Rules:
//     - the first poll only sets the baseline;
//     - a new fingerprint must read the same on **one more** poll before it counts (it settles: DHCP
//       and a second interface coming up are usually a few seconds apart);
//     - a settled change to a **non-empty** set is reason `network`; a settled change to empty
//       (offline) does nothing but is remembered, so the network coming back — even to the same
//       addresses — counts as a change.
//
// **Coalescing.** A wake usually brings a network change a few seconds later (Wi-Fi reassociates
// after the resume event), so no recover follows another within `RECOVER_COALESCE_MS`. One that
// arrives inside that window is **deferred** to the end of it, not dropped: the first recover may
// have run before the network was up, and the second is the one that finds it working. However
// many arrive in the window, one deferred recover runs, with the latest reason.
//
// **Nothing secret, nothing identifying in the log.** Addresses never reach a log line: only that the
// set changed, how many there are, and whether it is empty.
//
// No Electron import: the blocker, the power monitor, the interface reader, the clock and the timers
// are injected, so tests/unit/power.test.ts drives every rule on a fake clock in plain Node.
import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { PowerState, RecoverReason } from '@shared/ipc'

/** How often the network interfaces are read (NFR-7). */
export const NETWORK_POLL_MS = 3_000

/** No recover runs within this long of the previous one; a later one is deferred to its end. */
export const RECOVER_COALESCE_MS = 5_000

/** The slice of Electron's `powerSaveBlocker` used here; the real one satisfies it as is. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** The slice of Electron's `powerMonitor` used here; the real one satisfies it as is. */
export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown
}

export interface PowerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** `os.networkInterfaces()`'s shape, loosened to what the fingerprint reads. */
export type NetworkInterfacesReader = () => Record<
  string,
  readonly Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined
>

export interface PowerOptions {
  readonly blocker: PowerSaveBlockerLike
  /** `null` turns the resume trigger off (a test of the network rules alone). */
  readonly monitor: PowerMonitorLike | null
  /** NFR-7: everything should stop waiting and reconnect now. Must not throw (it is guarded). */
  readonly recover: (reason: RecoverReason) => void
  /** Default `os.networkInterfaces`. */
  readonly networkInterfaces?: NetworkInterfacesReader
  /** Default {@link NETWORK_POLL_MS}; 0 turns the network trigger off. */
  readonly networkPollMs?: number
  /** Default {@link RECOVER_COALESCE_MS}. */
  readonly coalesceMs?: number
  /**
   * A **monotonic** clock in ms, for the coalescing window only. Default `performance.now()`: a
   * wall clock steps (NTP, the user, a wake that resyncs it), and a step must never stretch or
   * skip the window.
   */
  readonly now?: () => number
  readonly timers?: PowerTimers
  /** Safe lines only: never an address. Default: no-op. */
  readonly log?: (line: string) => void
}

export interface Power {
  /**
   * NFR-8: the renderer says whether a View is on screen. `true` holds one display-sleep blocker
   * (a second `true` holds the same one); `false` releases it. Answers what main is now doing.
   */
  setViewVisible(visible: boolean): PowerState
  /**
   * Releases the blocker, if held, whatever the renderer last said: the window closed, the renderer
   * process is gone or the page navigated (it says `true` again once a View is back on screen).
   * Idempotent. `reason` is for the log line.
   */
  release(reason: string): void
  readonly preventingDisplaySleep: boolean
  /** At quit: releases the blocker, stops the poll and any deferred recover, unhooks the monitor. */
  dispose(): void
}

/** IPv4 169.254.0.0/16 and IPv6 fe80::/10: present on interfaces that reach no console. */
function isLinkLocal(family: string, address: string): boolean {
  if (family === 'IPv4') return address.startsWith('169.254.')
  return /^fe[89ab][0-9a-f]:/i.test(address)
}

/**
 * The network's identity for change detection (see the header): every non-internal, non-link-local
 * IPv4 address as `IPv4/<address>`, and every interface with a non-internal, non-link-local IPv6
 * address as `IPv6@<interface name>` (the name only: the address rotates), de-duplicated, sorted and
 * joined. `''` means offline. Node has reported `family` as a number (`4`/`6`) in some versions, so
 * both forms are read.
 */
export function networkFingerprint(interfaces: ReturnType<NetworkInterfacesReader>): string {
  const seen = new Set<string>()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const raw: unknown = entry.family
      const family =
        raw === 4 || raw === 'IPv4' ? 'IPv4' : raw === 6 || raw === 'IPv6' ? 'IPv6' : ''
      if (family === '' || isLinkLocal(family, entry.address)) continue
      seen.add(family === 'IPv4' ? `IPv4/${entry.address}` : `IPv6@${name}`)
    }
  }
  return [...seen].sort().join(',')
}

/** How many entries a fingerprint holds, for a log line that names none of them. */
function entryCount(fingerprint: string): number {
  return fingerprint === '' ? 0 : fingerprint.split(',').length
}

const DEFAULT_TIMERS: PowerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

export function createPower(options: PowerOptions): Power {
  const { blocker, monitor } = options
  const readInterfaces: NetworkInterfacesReader = options.networkInterfaces ?? osNetworkInterfaces
  const pollMs = options.networkPollMs ?? NETWORK_POLL_MS
  const coalesceMs = options.coalesceMs ?? RECOVER_COALESCE_MS
  const now = options.now ?? ((): number => performance.now())
  const timers = options.timers ?? DEFAULT_TIMERS
  const log = options.log ?? ((): void => undefined)

  let disposed = false

  // --- the blocker (NFR-8) -------------------------------------------------------------------------

  /** The one blocker this module holds, or `null`. */
  let blockerId: number | null = null

  function holding(): boolean {
    if (blockerId === null) return false
    try {
      return blocker.isStarted(blockerId)
    } catch {
      return false
    }
  }

  function setViewVisible(visible: boolean): PowerState {
    if (!visible) {
      release('no View is on screen')
      return { preventingDisplaySleep: false }
    }
    if (disposed) return { preventingDisplaySleep: false }
    if (holding()) return { preventingDisplaySleep: true }
    try {
      blockerId = blocker.start('prevent-display-sleep')
      log('keeping the display awake (a View is on screen)')
    } catch (err) {
      blockerId = null
      log(`could not keep the display awake: ${err instanceof Error ? err.name : 'unknown error'}`)
    }
    return { preventingDisplaySleep: holding() }
  }

  function release(reason: string): void {
    const id = blockerId
    if (id === null) return
    blockerId = null
    try {
      if (blocker.isStarted(id)) blocker.stop(id)
    } catch {
      // Nothing more to do: the blocker dies with the process anyway.
    }
    log(`the display may sleep again (${reason})`)
  }

  // --- recovery (NFR-7) ----------------------------------------------------------------------------

  let lastRecoverAt: number | null = null
  let deferred: { handle: unknown; reason: RecoverReason } | null = null

  function runRecover(reason: RecoverReason): void {
    lastRecoverAt = now()
    log(`recovering now (${reason === 'resume' ? 'woke from sleep' : 'the network changed'})`)
    try {
      options.recover(reason)
    } catch (err) {
      log(`recover failed: ${err instanceof Error ? err.name : 'unknown error'}`)
    }
  }

  function requestRecover(reason: RecoverReason): void {
    if (disposed) return
    if (deferred !== null) {
      // One deferred recover for the whole window; the latest reason is the one that is current.
      deferred.reason = reason
      return
    }
    // Clamped at 0, so even a clock that went backwards defers by at most the window itself.
    const since = lastRecoverAt === null ? Infinity : Math.max(0, now() - lastRecoverAt)
    if (since >= coalesceMs) {
      runRecover(reason)
      return
    }
    const wait = coalesceMs - since
    log(`recover (${reason}) deferred ${String(wait)} ms: one ran moments ago`)
    const entry: { handle: unknown; reason: RecoverReason } = { handle: null, reason }
    entry.handle = timers.setTimeout(() => {
      if (deferred !== entry) return
      deferred = null
      if (!disposed) runRecover(entry.reason)
    }, wait)
    deferred = entry
  }

  const onSuspend = (): void => {
    log('the machine is going to sleep')
  }
  const onResume = (): void => {
    log('the machine woke from sleep')
    requestRecover('resume')
  }
  monitor?.on('suspend', onSuspend)
  monitor?.on('resume', onResume)

  /** The settled fingerprint; `null` until the first poll has set the baseline. */
  let accepted: string | null = null
  /** A new fingerprint seen once, waiting for one more poll to agree. */
  let candidate: string | null = null

  function pollNetwork(): void {
    if (disposed) return
    let fingerprint: string
    try {
      fingerprint = networkFingerprint(readInterfaces())
    } catch {
      // A read that fails says nothing about the network; try again next poll.
      return
    }
    if (accepted === null) {
      accepted = fingerprint
      return
    }
    if (fingerprint === accepted) {
      // Changed and changed back within a poll: a flap, not a change.
      candidate = null
      return
    }
    if (fingerprint !== candidate) {
      candidate = fingerprint
      return
    }
    // The same new set two polls running: it has settled.
    candidate = null
    accepted = fingerprint
    if (fingerprint === '') {
      log('the network went away (no addresses); waiting for it to come back')
      return
    }
    log(`the network changed (${String(entryCount(fingerprint))} address(es) or IPv6 interface(s))`)
    requestRecover('network')
  }

  let pollHandle: unknown = null
  if (pollMs > 0) {
    pollNetwork()
    pollHandle = timers.setInterval(pollNetwork, pollMs)
  }

  function dispose(): void {
    if (disposed) return
    release('quitting')
    disposed = true
    if (pollHandle !== null) timers.clearInterval(pollHandle)
    pollHandle = null
    if (deferred !== null) timers.clearTimeout(deferred.handle)
    deferred = null
    monitor?.removeListener('suspend', onSuspend)
    monitor?.removeListener('resume', onResume)
  }

  return {
    setViewVisible,
    release,
    get preventingDisplaySleep() {
      return holding()
    },
    dispose,
  }
}
