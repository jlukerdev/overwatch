// P6.3 (NFR-9): the rotating app log, src/main/logger.ts — line format, rotation, size tracking,
// failures that never throw, live-secret redaction and the console tee. Every value is made up.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_LOG_FILE,
  createAppLogger,
  formatArgs,
  formatLogLine,
  teeConsole,
  type AppLogFs,
  type ConsoleLike,
} from '../../src/main/logger'

const FIXED = new Date('2026-11-19T08:30:00.000Z')
const now = (): Date => FIXED

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vp-app-log-'))
  // Not created yet: the first write has to make it.
  dir = join(root, 'userData', 'logs')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (name = APP_LOG_FILE): string => readFileSync(join(dir, name), 'utf8')

/** The real fs, with some calls replaced. */
function realFs(overrides: Partial<AppLogFs> = {}): AppLogFs {
  return {
    mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
    openSync: (path, flags) => nodeFs.openSync(path, flags),
    fstatSync: (fd) => nodeFs.fstatSync(fd),
    writeSync: (fd, data) => nodeFs.writeSync(fd, data),
    closeSync: (fd) => {
      nodeFs.closeSync(fd)
    },
    renameSync: (from, to) => {
      nodeFs.renameSync(from, to)
    },
    rmSync: (path, options) => {
      nodeFs.rmSync(path, options)
    },
    ...overrides,
  }
}

describe('formatLogLine', () => {
  it('writes <ISO time> <LEVEL> <message>', () => {
    expect(formatLogLine(FIXED, 'INFO', '[app] hello')).toBe(
      '2026-11-19T08:30:00.000Z INFO [app] hello\n',
    )
  })

  it('indents continuation lines and drops a trailing newline', () => {
    expect(formatLogLine(FIXED, 'ERROR', 'Error: boom\r\n    at a\n    at b\n')).toBe(
      '2026-11-19T08:30:00.000Z ERROR Error: boom\n      at a\n      at b\n',
    )
  })
})

describe('formatArgs', () => {
  it('formats like console does, with an Error stack', () => {
    expect(formatArgs(['a %s', 'b', { c: 1 }])).toBe('a b { c: 1 }')
    const err = new Error('boom')
    expect(formatArgs(['failed:', err])).toContain('Error: boom\n    at ')
  })
})

describe('createAppLogger', () => {
  it('creates the folder and appends lines with every level', () => {
    const log = createAppLogger({ dir, now })
    log.write('INFO', 'one')
    log.write('WARN', 'two')
    log.write('ERROR', 'three')
    log.write('DEBUG', 'four')
    expect(log.path).toBe(join(dir, APP_LOG_FILE))
    expect(read()).toBe(
      [
        '2026-11-19T08:30:00.000Z INFO one',
        '2026-11-19T08:30:00.000Z WARN two',
        '2026-11-19T08:30:00.000Z ERROR three',
        '2026-11-19T08:30:00.000Z DEBUG four',
        '',
      ].join('\n'),
    )
  })

  it('rotates app.log → .1 → .2 → .3 and drops the oldest', () => {
    // Each line is 35 bytes ("<24-char time> INFO lineN\n" = 24+1+4+1+5); 80 bytes fits two.
    const log = createAppLogger({ dir, now, maxBytes: 80 })
    for (let i = 1; i <= 9; i++) log.write('INFO', `line${String(i)}`)
    expect(read()).toContain('line9')
    expect(read()).not.toContain('line8')
    expect(read('app.log.1')).toContain('line7')
    expect(read('app.log.1')).toContain('line8')
    expect(read('app.log.2')).toContain('line5')
    expect(read('app.log.3')).toContain('line3')
    expect(existsSync(join(dir, 'app.log.4'))).toBe(false)
    // line1/line2 were in the oldest file and are gone.
    const all = ['app.log', 'app.log.1', 'app.log.2', 'app.log.3'].map((n) => read(n)).join('')
    expect(all).not.toContain('line1\n')
    expect(all).not.toContain('line2\n')
  })

  it('counts an existing file at open (one fstat per open) and tracks the size in memory', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, APP_LOG_FILE), 'x'.repeat(70))
    const fstat = vi.fn((fd: number) => nodeFs.fstatSync(fd))
    const open = vi.fn((path: string, flags: 'a') => nodeFs.openSync(path, flags))
    const log = createAppLogger({
      dir,
      now,
      maxBytes: 100,
      fs: realFs({ fstatSync: fstat, openSync: open }),
    })
    log.write('INFO', 'line1') // 70 + 35 > 100: rotates first
    expect(read('app.log.1')).toBe('x'.repeat(70))
    expect(read()).toBe('2026-11-19T08:30:00.000Z INFO line1\n')
    log.write('INFO', 'line2') // 35 + 35 = 70: fits
    log.write('INFO', 'line3') // 70 + 35 > 100: rotates again
    expect(read()).toBe('2026-11-19T08:30:00.000Z INFO line3\n')
    // Three opens (start, two rotations), one fstat each, none per line.
    expect(open).toHaveBeenCalledTimes(3)
    expect(fstat).toHaveBeenCalledTimes(3)
    log.write('INFO', 'line4') // 35 + 35 = 70: fits, no stat
    expect(fstat).toHaveBeenCalledTimes(3)
    log.close()
  })

  it('keeps one descriptor open and reopens it after close()', () => {
    const open = vi.fn((path: string, flags: 'a') => nodeFs.openSync(path, flags))
    const log = createAppLogger({ dir, now, fs: realFs({ openSync: open }) })
    log.write('INFO', 'a')
    log.write('INFO', 'b')
    expect(open).toHaveBeenCalledTimes(1)
    log.close()
    log.close()
    log.write('INFO', 'c')
    expect(open).toHaveBeenCalledTimes(2)
    expect(read()).toContain('INFO c\n')
    log.close()
  })

  it('never throws on a failing fs, reports once per outage and recovers', () => {
    let broken = true
    const fs = realFs({
      writeSync: (fd, data) => {
        if (broken) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return nodeFs.writeSync(fd, data)
      },
    })
    const reportError = vi.fn()
    const log = createAppLogger({ dir, now, fs, reportError })
    expect(() => {
      log.write('INFO', 'a')
      log.write('INFO', 'b')
      log.write('INFO', 'c')
    }).not.toThrow()
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError.mock.calls[0]?.[0]).toContain('ENOSPC')
    broken = false
    log.write('INFO', 'd')
    expect(read()).toBe('2026-11-19T08:30:00.000Z INFO d\n')
    broken = true
    log.write('INFO', 'e')
    expect(reportError).toHaveBeenCalledTimes(2)
    log.close()
  })

  it('on a failed rotation keeps appending, keeps the history and backs off', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.log.1'), 'old1')
    writeFileSync(join(dir, 'app.log.2'), 'old2')
    writeFileSync(join(dir, 'app.log.3'), 'old3')
    let busy = true
    const rename = vi.fn((from: string, to: string) => {
      if (busy && from === join(dir, APP_LOG_FILE))
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      nodeFs.renameSync(from, to)
    })
    const reportError = vi.fn()
    // 80 bytes: two 35-byte lines fit, the third would rotate.
    const log = createAppLogger({
      dir,
      now,
      maxBytes: 80,
      fs: realFs({ renameSync: rename }),
      reportError,
    })
    for (let i = 1; i <= 4; i++) log.write('INFO', `line${String(i)}`)
    // Nothing dropped, nothing shifted: the history is untouched.
    expect(read()).toBe(
      [1, 2, 3, 4].map((i) => `2026-11-19T08:30:00.000Z INFO line${String(i)}\n`).join(''),
    )
    expect(read('app.log.1')).toBe('old1')
    expect(read('app.log.2')).toBe('old2')
    expect(read('app.log.3')).toBe('old3')
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError.mock.calls[0]?.[0]).toContain('EBUSY')
    // Backed off: tried once at line3, not again at line4.
    expect(rename).toHaveBeenCalledTimes(1)
    // Once the file has grown another maxBytes (70 + 80 = 150) it tries again, and now it works.
    busy = false
    log.write('INFO', 'line5') // 140 + 35 > 150
    expect(read()).toBe('2026-11-19T08:30:00.000Z INFO line5\n')
    expect(read('app.log.1')).toContain('line4')
    expect(read('app.log.2')).toBe('old1')
    expect(read('app.log.3')).toBe('old2')
    expect(existsSync(join(dir, 'app.log.rotating'))).toBe(false)
    log.close()
  })

  it('survives a reporter that throws and a rotation that fails', () => {
    const fs = realFs({
      fstatSync: () => ({ size: 1000 }),
      renameSync: () => {
        throw new Error('locked')
      },
    })
    const log = createAppLogger({
      dir,
      now,
      fs,
      maxBytes: 100,
      reportError: () => {
        throw new Error('stderr closed')
      },
    })
    expect(() => {
      log.write('INFO', 'a')
    }).not.toThrow()
    log.close()
  })

  it('redacts live secrets read at write time, including one set after creation', () => {
    const secrets: string[] = []
    const log = createAppLogger({ dir, now, secrets: () => secrets })
    log.write('INFO', 'key fake-api-key-1 before')
    secrets.push('fake-api-key-1')
    // `write` hands back the redacted text, for the terminal.
    expect(log.write('INFO', 'key fake-api-key-1 after')).toBe('key <redacted> after')
    log.write('WARN', 'GET https://h.invalid/?token=zzz pk=:abc:')
    expect(read()).toBe(
      [
        '2026-11-19T08:30:00.000Z INFO key fake-api-key-1 before',
        '2026-11-19T08:30:00.000Z INFO key <redacted> after',
        '2026-11-19T08:30:00.000Z WARN GET https://h.invalid/?token=<redacted> pk=:<redacted>:',
        '',
      ].join('\n'),
    )
  })

  it('still redacts the patterns when the secrets provider throws', () => {
    const log = createAppLogger({
      dir,
      now,
      secrets: () => {
        throw new ReferenceError('not initialised')
      },
    })
    log.write('INFO', 'Authorization: Bearer abcdefghijkl')
    expect(read()).toBe('2026-11-19T08:30:00.000Z INFO Authorization: Bearer <redacted>\n')
  })
})

describe('teeConsole', () => {
  function fakeConsole(): ConsoleLike & { calls: [string, unknown[]][] } {
    const calls: [string, unknown[]][] = []
    const make =
      (name: string) =>
      (...args: unknown[]): void => {
        calls.push([name, args])
      }
    return {
      calls,
      debug: make('debug'),
      log: make('log'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
    }
  }

  it('writes each call at its level and passes the redacted text to the original', () => {
    const target = fakeConsole()
    const originalLog = target.log
    const log = createAppLogger({ dir, now, secrets: () => ['fake-token-xyz'] })
    const tee = teeConsole(target, log)
    target.log('[access] token %s', 'fake-token-xyz')
    target.warn('[x]', { url: 'rtsps://h.invalid:7441/alias' })
    target.error('[y] failed')
    target.info('[z] info')
    target.debug('[w] debug')
    expect(target.calls).toEqual([
      ['log', ['[access] token <redacted>']],
      ['warn', ["[x] { url: '<redacted>' }"]],
      ['error', ['[y] failed']],
      ['info', ['[z] info']],
      ['debug', ['[w] debug']],
    ])
    expect(read()).toBe(
      [
        '2026-11-19T08:30:00.000Z INFO [access] token <redacted>',
        "2026-11-19T08:30:00.000Z WARN [x] { url: '<redacted>' }",
        '2026-11-19T08:30:00.000Z ERROR [y] failed',
        '2026-11-19T08:30:00.000Z INFO [z] info',
        '2026-11-19T08:30:00.000Z DEBUG [w] debug',
        '',
      ].join('\n'),
    )
    tee.original.error('direct')
    expect(target.calls.at(-1)).toEqual(['error', ['direct']])
    tee.restore()
    expect(target.log).toBe(originalLog)
    log.close()
  })
})
