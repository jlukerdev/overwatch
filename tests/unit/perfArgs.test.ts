// P2.5 perf launcher arguments (scripts/perf/args.ts).
import { describe, expect, it } from 'vitest'
import { parsePerfArgs, runDirName } from '../../scripts/perf/args'

describe('parsePerfArgs', () => {
  it('needs a quality and applies the defaults', () => {
    expect(parsePerfArgs(['--quality', 'low'])).toEqual({
      quality: 'low',
      durationS: 1800,
      warmupS: 60,
      intervalS: 5,
      label: null,
      verbose: false,
    })
    expect(() => parsePerfArgs([])).toThrow(/--quality is required/)
  })

  it('reads every flag', () => {
    expect(
      parsePerfArgs([
        '--quality',
        'high',
        '--duration',
        '60',
        '--warmup',
        '15',
        '--interval',
        '2',
        '--label',
        'plugged in',
        '--verbose',
      ]),
    ).toEqual({
      quality: 'high',
      durationS: 60,
      warmupS: 15,
      intervalS: 2,
      label: 'plugged in',
      verbose: true,
    })
  })

  it.each([
    [['--quality', 'ultra'], /high, medium, low/],
    [['--quality', 'low', '--duration', 'x'], /whole number/],
    [['--quality', 'low', '--interval', '0'], /at least 1/],
    [['--quality', 'low', '--duration', '3'], /at least --interval/],
    [['--quality', 'low', '--label'], /needs text/],
    [['--quality', 'low', '--nope'], /unknown argument/],
  ])('rejects %o', (argv, problem) => {
    expect(() => parsePerfArgs(argv)).toThrow(problem)
  })
})

describe('runDirName', () => {
  it('is sortable and has no colons', () => {
    expect(runDirName(new Date('2026-11-14T10:05:00.123Z'), 'medium')).toBe(
      '2026-11-14T10-05-00Z-medium',
    )
  })
})
