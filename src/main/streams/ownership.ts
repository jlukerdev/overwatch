// "Is the thing listening on our loopback port really our go2rtc child?" — the pure half of SPEC
// §5.3 "Listener ownership" (P2.1).
//
// Why this check exists at all: finding a free port and go2rtc binding it are **not atomic**.
// `freeLoopbackPort()` binds port 0, reads the number and closes its probe socket; between that
// close and go2rtc's bind, any other local process can take the port. go2rtc then logs a listen
// error and **keeps running without a listener**, so the app would happily hand the renderer a port
// owned by someone else — who would receive the `Authorization` header and the camera video.
//
// Three facts decide it, and all three are needed:
//   1. authenticated `GET /api` → 200    (something that speaks go2rtc is there)
//   2. unauthenticated `GET /api` → 401  (it enforces *our* credentials; `local_auth: true` is what
//                                         makes this true for a loopback client)
//   3. the listening PID equals the child's PID (the real guard: an impostor that answers 200 to
//      everything fails 2, and one that copies go2rtc's 401 behaviour still fails 3)
//
// Ported from the reviewed P0.5 spike, `scripts/spikes/video-spike/lib.ts`, essentially as-is:
// `src/main` may not import from `scripts/`, so the code is **copied** and this comment keeps the
// duplication visible and intentional. No I/O here — `go2rtcManager` runs `lsof`/`netstat` and
// feeds the output in — so every branch is unit-tested in plain Node.

/** PIDs from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` (`p<pid>` lines; other fields ignored). */
export function parseLsofPids(text: string): number[] {
  const pids = text
    .split('\n')
    .flatMap((l) => (/^p(\d+)\s*$/.exec(l.trim()) ? [Number(l.trim().slice(1))] : []))
  return [...new Set(pids)]
}

/**
 * PIDs listening on `127.0.0.1:<port>` — or on `0.0.0.0` / `[::]` / `[::1]`, which also own the
 * loopback port — from Windows `netstat -ano -p TCP` output.
 */
export function parseNetstatListenPids(text: string, port: number): number[] {
  const pids: number[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    const [, addr = '', p = '', pid = ''] = m
    if (Number(p) !== port) continue
    if (['127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(addr)) pids.push(Number(pid))
  }
  return [...new Set(pids)]
}

export interface OwnershipFacts {
  /** PID of the go2rtc child we spawned. */
  childPid: number
  /** Status of `GET /api` with our credentials (null: no answer). */
  authStatus: number | null
  /** Status of `GET /api` without credentials (null: no answer). */
  unauthStatus: number | null
  /** PIDs listening on the port, or null if they could not be read (tool missing or failed). */
  listenerPids: readonly number[] | null
  /** macOS/Linux: true (`lsof`, mandatory). Windows: false (`netstat` is best effort). */
  pidCheckRequired: boolean
}

/**
 * The ownership verdict. `reason` is always safe to log: it carries a PID, a status code and a
 * port at most — never a credential and never a URL.
 */
export function decideOwnership(f: OwnershipFacts): { ok: boolean; reason: string } {
  if (f.authStatus !== 200)
    return { ok: false, reason: `authenticated GET /api -> ${String(f.authStatus ?? 'no answer')}` }
  if (f.unauthStatus !== 401)
    return {
      ok: false,
      reason: `unauthenticated GET /api -> ${String(f.unauthStatus ?? 'no answer')} (expected 401)`,
    }
  if (f.listenerPids === null) {
    return f.pidCheckRequired
      ? { ok: false, reason: 'listener PID could not be read (required on this platform)' }
      : { ok: true, reason: 'auth checks passed; listener PID not available (best effort)' }
  }
  if (f.listenerPids.length === 0) return { ok: false, reason: 'no listener PID found' }
  const others = f.listenerPids.filter((p) => p !== f.childPid)
  if (others.length > 0)
    return { ok: false, reason: `port is also/instead held by PID ${others.join(', ')}` }
  return { ok: true, reason: `listener PID ${String(f.childPid)} is our go2rtc child` }
}
