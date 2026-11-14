// P2.1: the listener-ownership decision (src/main/streams/ownership.ts) — SPEC §5.3.
//
// This is the check that stands between the free-port race and handing another local process the
// go2rtc credentials and the camera video, so every branch of `decideOwnership` is asserted, not
// just the happy one: an impostor that answers 200 to everything, one that copies go2rtc's 401,
// an unreadable PID list on each platform, and an empty one.
import { describe, expect, it } from 'vitest'
import {
  decideOwnership,
  parseLsofPids,
  parseNetstatListenPids,
  type OwnershipFacts,
} from '../../src/main/streams/ownership'

describe('parseLsofPids', () => {
  it('reads the p<pid> lines of lsof -Fp and ignores the rest', () => {
    const out = ['p4242', 'f12', 'pMALFORMED', 'p4242', 'p99', ''].join('\n')
    expect(parseLsofPids(out)).toEqual([4242, 99])
  })

  it('returns nothing for empty output (nothing is listening)', () => {
    expect(parseLsofPids('')).toEqual([])
    expect(parseLsofPids('\n  \n')).toEqual([])
  })
})

describe('parseNetstatListenPids', () => {
  const out = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:41234        0.0.0.0:0              LISTENING       4242',
    '  TCP    0.0.0.0:41234          0.0.0.0:0              LISTENING       4242',
    '  TCP    [::1]:41234            [::]:0                 LISTENING       7777',
    '  TCP    192.168.1.5:41234      0.0.0.0:0              LISTENING       8888',
    '  TCP    127.0.0.1:41235        0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:41234        127.0.0.1:52000        ESTABLISHED     5555',
    '  UDP    127.0.0.1:41234        *:*                                    6666',
  ].join('\r\n')

  it('keeps only LISTENING TCP rows on the port, for addresses that own the loopback port', () => {
    expect(parseNetstatListenPids(out, 41234)).toEqual([4242, 7777])
  })

  it('ignores another port and unparseable output', () => {
    expect(parseNetstatListenPids(out, 41235)).toEqual([9999])
    expect(parseNetstatListenPids('', 41234)).toEqual([])
    expect(parseNetstatListenPids('garbage', 41234)).toEqual([])
  })
})

describe('decideOwnership', () => {
  const ours: OwnershipFacts = {
    childPid: 4242,
    authStatus: 200,
    unauthStatus: 401,
    listenerPids: [4242],
    pidCheckRequired: true,
  }

  it('accepts authenticated 200 + unauthenticated 401 + our own PID', () => {
    const verdict = decideOwnership(ours)
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toContain('4242')
  })

  it('rejects anything but 200 for the authenticated probe', () => {
    for (const authStatus of [401, 404, 500, null]) {
      const verdict = decideOwnership({ ...ours, authStatus })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('authenticated GET /api')
    }
  })

  it('rejects a listener that does not enforce our credentials', () => {
    // The impostor that answers 200 to everything, including without credentials.
    for (const unauthStatus of [200, 403, 500, null]) {
      const verdict = decideOwnership({ ...ours, unauthStatus })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('expected 401')
    }
  })

  it('rejects a PID that is not our child, even when both auth checks pass', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: [9999] })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('9999')
  })

  it('rejects a port shared with another PID', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: [4242, 9999] })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('9999')
  })

  it('rejects an empty PID list: something answered, but nothing is listening for us', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: [] })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('no listener PID found')
  })

  it('fails an unreadable PID list where the check is mandatory (macOS/Linux, lsof)', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: null, pidCheckRequired: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('required on this platform')
  })

  it('passes an unreadable PID list where it is best effort (Windows, netstat)', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: null, pidCheckRequired: false })
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toContain('best effort')
  })

  it('still fails a wrong PID on Windows, where the list could be read', () => {
    const verdict = decideOwnership({ ...ours, listenerPids: [9999], pidCheckRequired: false })
    expect(verdict.ok).toBe(false)
  })

  it('never puts anything but statuses and PIDs in the reason', () => {
    const reasons = [
      decideOwnership(ours).reason,
      decideOwnership({ ...ours, authStatus: 500 }).reason,
      decideOwnership({ ...ours, unauthStatus: 200 }).reason,
    ]
    for (const reason of reasons) {
      expect(reason).not.toMatch(/rtsp/i)
      expect(reason).not.toMatch(/Basic/)
    }
  })
})
