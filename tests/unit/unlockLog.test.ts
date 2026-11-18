// P5.4 (DOOR-5): the unlock audit log in src/main/access/unlockLog.ts — JSON Lines at
// `<userData>/logs/unlock.log`, size rotation to `unlock.log.1`, serialized writes, and a write
// failure that is reported but never rejects (an unlock's answer must not depend on the log).
// P5.6: the same lines also carry the Doors screen's actions (`action`, `doorName`, `minutes`,
// `lockdown`, `evacuation`), with the camera fields `null` for them.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UNLOCK_LOG_FILE,
  UNLOCK_LOG_ROTATED_FILE,
  createUnlockLog,
  formatUnlockLogLine,
  type UnlockAttempt,
  type UnlockLogFs,
} from '../../src/main/access/unlockLog'

/** The four P5.6 detail fields as a cell unlock writes them. Spelled out so `toEqual` sees them. */
const NO_DETAILS = { doorName: null, minutes: null, lockdown: null, evacuation: null } as const

const SUCCESS: UnlockAttempt = {
  action: 'unlock',
  cameraRef: 'cam-bell:package',
  cameraName: 'Front Doorbell',
  doorId: 'door-front',
  ...NO_DETAILS,
  result: 'success',
  errorKind: null,
  message: null,
}

const REFUSED: UnlockAttempt = {
  action: 'unlock',
  cameraRef: 'cam-2',
  cameraName: 'cam-2',
  doorId: null,
  ...NO_DETAILS,
  result: 'failure',
  errorKind: 'not-found',
  message: 'cam-2 is not linked to a door, so nothing was unlocked.',
}

const FIXED = new Date('2026-11-18T09:15:02.123Z')

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vp-unlock-log-'))
  // Not created yet: the first append has to make it.
  dir = join(root, 'userData', 'logs')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown)
}

describe('formatUnlockLogLine', () => {
  it('writes one JSON object per line, in the fixed key order, with UTC time', () => {
    const line = formatUnlockLogLine({ time: FIXED.toISOString(), ...SUCCESS })
    expect(line).toBe(
      '{"time":"2026-11-18T09:15:02.123Z","action":"unlock","cameraRef":"cam-bell:package",' +
        '"cameraName":"Front Doorbell","doorId":"door-front","doorName":null,"minutes":null,' +
        '"lockdown":null,"evacuation":null,"result":"success","errorKind":null,"message":null}\n',
    )
  })

  it('keeps the pre-P5.6 keys in their old order relative to each other', () => {
    const keys = Object.keys(
      JSON.parse(formatUnlockLogLine({ time: FIXED.toISOString(), ...SUCCESS })) as object,
    )
    expect(keys).toEqual([
      'time',
      'action',
      'cameraRef',
      'cameraName',
      'doorId',
      'doorName',
      'minutes',
      'lockdown',
      'evacuation',
      'result',
      'errorKind',
      'message',
    ])
    const old = ['time', 'cameraRef', 'cameraName', 'doorId', 'result', 'errorKind', 'message']
    expect(keys.filter((key) => old.includes(key))).toEqual(old)
  })

  it('writes every key for a caller that leaves the optional ones out (they are null)', () => {
    const line = formatUnlockLogLine({
      time: FIXED.toISOString(),
      action: 'unlock',
      cameraRef: 'cam-1',
      cameraName: 'Porch',
      doorId: 'door-1',
      result: 'success',
      errorKind: null,
      message: null,
    })
    expect(JSON.parse(line)).toEqual({
      time: FIXED.toISOString(),
      action: 'unlock',
      cameraRef: 'cam-1',
      cameraName: 'Porch',
      doorId: 'door-1',
      ...NO_DETAILS,
      result: 'success',
      errorKind: null,
      message: null,
    })
  })

  it('P5.6: a Doors screen action has no camera, and names the door and what was sent', () => {
    const line = formatUnlockLogLine({
      time: FIXED.toISOString(),
      action: 'custom',
      cameraRef: null,
      cameraName: null,
      doorId: 'door-front',
      doorName: 'House - 1F - Front Door',
      minutes: 45,
      result: 'success',
      errorKind: null,
      message: null,
    })
    expect(line).toBe(
      '{"time":"2026-11-18T09:15:02.123Z","action":"custom","cameraRef":null,' +
        '"cameraName":null,"doorId":"door-front","doorName":"House - 1F - Front Door",' +
        '"minutes":45,"lockdown":null,"evacuation":null,"result":"success","errorKind":null,' +
        '"message":null}\n',
    )
  })

  it('P5.6: an emergency change has no door, and carries both flags as asked', () => {
    const line = formatUnlockLogLine({
      time: FIXED.toISOString(),
      action: 'emergency',
      cameraRef: null,
      cameraName: null,
      doorId: null,
      lockdown: false,
      evacuation: true,
      result: 'unknown',
      errorKind: 'timeout',
      message: 'The Access API did not answer in time.',
    })
    expect(JSON.parse(line)).toEqual({
      time: FIXED.toISOString(),
      action: 'emergency',
      cameraRef: null,
      cameraName: null,
      doorId: null,
      doorName: null,
      minutes: null,
      lockdown: false,
      evacuation: true,
      result: 'unknown',
      errorKind: 'timeout',
      message: 'The Access API did not answer in time.',
    })
  })

  it('keeps a message with a newline on one line, and drops fields it does not know', () => {
    const line = formatUnlockLogLine({
      time: FIXED.toISOString(),
      ...REFUSED,
      message: 'first\nsecond',
      // A stray field must not reach the file (the type forbids it; JS callers might not).
      ...({ token: 'NEVER' } as object),
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(line).not.toContain('NEVER')
    expect(JSON.parse(line)).toMatchObject({ message: 'first\nsecond', doorId: null })
  })
})

describe('createUnlockLog', () => {
  it('creates the logs directory and appends one line per attempt', async () => {
    const log = createUnlockLog({ dir, now: () => FIXED })
    expect(log.path).toBe(join(dir, UNLOCK_LOG_FILE))
    await log.append(SUCCESS)
    await log.append(REFUSED)
    expect(lines(log.path)).toEqual([
      { time: '2026-11-18T09:15:02.123Z', ...SUCCESS },
      { time: '2026-11-18T09:15:02.123Z', ...REFUSED },
    ])
  })

  it('appends to an existing file rather than replacing it', async () => {
    await createUnlockLog({ dir, now: () => FIXED }).append(SUCCESS)
    // A new instance, as after an app restart.
    await createUnlockLog({ dir, now: () => FIXED }).append(REFUSED)
    expect(lines(join(dir, UNLOCK_LOG_FILE))).toHaveLength(2)
  })

  it('rotates to unlock.log.1 once the file is over the threshold, replacing an older one', async () => {
    const log = createUnlockLog({ dir, now: () => FIXED, maxBytes: 300 })
    await log.append(SUCCESS) // ~180 bytes: under
    await log.append(SUCCESS) // checked at ~180: still under, now ~360
    expect(existsSync(join(dir, UNLOCK_LOG_ROTATED_FILE))).toBe(false)
    await log.append(REFUSED) // checked at ~360: over, so rotate first
    expect(lines(join(dir, UNLOCK_LOG_ROTATED_FILE))).toHaveLength(2)
    expect(lines(log.path)).toEqual([{ time: FIXED.toISOString(), ...REFUSED }])

    // A second rotation replaces the first `.1`.
    writeFileSync(log.path, 'x'.repeat(400))
    await log.append(SUCCESS)
    expect(readFileSync(join(dir, UNLOCK_LOG_ROTATED_FILE), 'utf8')).toBe('x'.repeat(400))
    expect(lines(log.path)).toHaveLength(1)
  })

  it('does not rotate a file that is exactly at the threshold', async () => {
    const log = createUnlockLog({ dir, now: () => FIXED, maxBytes: 100 })
    await nodeFs.mkdir(dir, { recursive: true })
    writeFileSync(log.path, 'y'.repeat(99) + '\n')
    expect(statSync(log.path).size).toBe(100)
    await log.append(SUCCESS)
    expect(existsSync(join(dir, UNLOCK_LOG_ROTATED_FILE))).toBe(false)
  })

  it('serializes concurrent appends: whole lines, in call order, one rotation', async () => {
    // A slow fs that yields between every step, so unserialized writes would interleave a stat
    // with another append and rotate twice (or lose lines to a rename mid-append).
    const renames: string[] = []
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))
    const slowFs: UnlockLogFs = {
      mkdir: async (path, options) => {
        await tick()
        return nodeFs.mkdir(path, options)
      },
      stat: async (path) => {
        await tick()
        return nodeFs.stat(path)
      },
      rename: async (from, to) => {
        await tick()
        renames.push(to)
        return nodeFs.rename(from, to)
      },
      appendFile: async (path, data, options) => {
        await tick()
        return nodeFs.appendFile(path, data, options)
      },
    }
    // Two and a half lines: the file is over the limit once it holds three, so the fourth append
    // rotates and the last three fit without a second rotation, whatever a line's length is.
    const lineBytes = Buffer.byteLength(
      formatUnlockLogLine({ time: FIXED.toISOString(), ...REFUSED }),
    )
    const log = createUnlockLog({
      dir,
      now: () => FIXED,
      maxBytes: Math.floor(lineBytes * 2.5),
      fs: slowFs,
    })
    const refs = Array.from({ length: 6 }, (_, i) => `cam-${String(i)}`)
    await Promise.all(refs.map((cameraRef) => log.append({ ...REFUSED, cameraRef })))

    const all = [
      ...lines(join(dir, UNLOCK_LOG_ROTATED_FILE)),
      ...lines(log.path),
    ] as UnlockAttempt[]
    expect(all.map((entry) => entry.cameraRef)).toEqual(refs)
    expect(renames).toHaveLength(1)
  })

  it('never rejects: a failed write is reported and the next append still works', async () => {
    const reported: string[] = []
    let failNext = true
    const flakyFs: UnlockLogFs = {
      mkdir: (path, options) => nodeFs.mkdir(path, options),
      stat: (path) => nodeFs.stat(path),
      rename: (from, to) => nodeFs.rename(from, to),
      appendFile: (path, data, options) => {
        if (failNext) {
          failNext = false
          return Promise.reject(Object.assign(new Error('no space left'), { code: 'ENOSPC' }))
        }
        return nodeFs.appendFile(path, data, options)
      },
    }
    const log = createUnlockLog({
      dir,
      now: () => FIXED,
      fs: flakyFs,
      onError: (message) => {
        reported.push(message)
      },
    })
    await expect(log.append(SUCCESS)).resolves.toBeUndefined()
    expect(reported).toEqual([expect.stringMatching(/unlock\.log \(ENOSPC\): no space left/)])
    await log.append(REFUSED)
    expect(lines(log.path)).toEqual([{ time: FIXED.toISOString(), ...REFUSED }])
  })

  it('survives an onError that throws: the append resolves and the next one still writes', async () => {
    let failNext = true
    const flakyFs: UnlockLogFs = {
      mkdir: (path, options) => nodeFs.mkdir(path, options),
      stat: (path) => nodeFs.stat(path),
      rename: (from, to) => nodeFs.rename(from, to),
      appendFile: (path, data, options) => {
        if (failNext) {
          failNext = false
          return Promise.reject(Object.assign(new Error('no space left'), { code: 'ENOSPC' }))
        }
        return nodeFs.appendFile(path, data, options)
      },
    }
    const log = createUnlockLog({
      dir,
      now: () => FIXED,
      fs: flakyFs,
      onError: () => {
        throw new Error('reporter broke')
      },
    })
    await expect(log.append(SUCCESS)).resolves.toBeUndefined()
    await expect(log.append(REFUSED)).resolves.toBeUndefined()
    await expect(log.flushed()).resolves.toBeUndefined()
    expect(lines(log.path)).toEqual([{ time: FIXED.toISOString(), ...REFUSED }])
  })

  it('logs an unknown outcome with its error kind and message', async () => {
    const unknown: UnlockAttempt = {
      action: 'unlock',
      cameraRef: 'cam-bell',
      cameraName: 'Front Doorbell',
      doorId: 'door-front',
      ...NO_DETAILS,
      result: 'unknown',
      errorKind: 'timeout',
      message: 'PUT /doors/door-front/unlock failed: the Access API did not answer in time.',
    }
    const log = createUnlockLog({ dir, now: () => FIXED })
    void log.append(unknown)
    await log.flushed()
    expect(lines(log.path)).toEqual([{ time: FIXED.toISOString(), ...unknown }])
  })

  it('stamps the time when the attempt is appended, not when the queue reaches it', async () => {
    let clock = 0
    const log = createUnlockLog({ dir, now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, clock++)) })
    await Promise.all([log.append(SUCCESS), log.append(REFUSED)])
    expect(lines(log.path)).toEqual([
      expect.objectContaining({ time: '2026-11-18T00:00:00.000Z' }),
      expect.objectContaining({ time: '2026-11-18T00:00:01.000Z' }),
    ])
  })
})
