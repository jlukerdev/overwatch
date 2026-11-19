// P6.2 (NFR-8): whether a View is on screen, and how the renderer tells main
// (src/renderer/src/features/power/viewVisibility.ts).
//
// What these tests protect: the display is kept awake only while the wall is drawn **and** the
// document is visible; main hears the first value at once, then only changes (every send is an
// IPC, and `visibilitychange` repeats itself); the wall going away always ends with `false`; and a
// failed send is logged, never shown, and sent again on the next update — but an older send's
// failure never makes the reporter forget a newer value.
import { describe, expect, it } from 'vitest'
import {
  createViewVisibleReporter,
  viewOnScreen,
} from '../../src/renderer/src/features/power/viewVisibility'

describe('viewOnScreen (NFR-8)', () => {
  it('is true only while the wall is drawn and the document is visible', () => {
    expect(viewOnScreen({ wallShown: true, visibilityState: 'visible' })).toBe(true)
    expect(viewOnScreen({ wallShown: true, visibilityState: 'hidden' })).toBe(false)
    expect(viewOnScreen({ wallShown: false, visibilityState: 'visible' })).toBe(false)
    expect(viewOnScreen({ wallShown: false, visibilityState: 'hidden' })).toBe(false)
  })
})

type Answer = { ok: boolean } | 'throw'

/** A `send` whose answers the test settles by hand, in any order. */
function harness() {
  const sent: boolean[] = []
  const settle: ((answer: Answer) => void)[] = []
  const warnings: string[] = []
  const reporter = createViewVisibleReporter({
    send: (visible) => {
      sent.push(visible)
      return new Promise((resolve, reject) => {
        settle.push((answer) => {
          if (answer === 'throw') reject(new Error('bridge'))
          else resolve(answer)
        })
      })
    },
    warn: (message) => {
      warnings.push(message)
    },
  })
  /** Settles send number `index` (0-based) and lets its handlers run. */
  const answer = async (index: number, value: Answer): Promise<void> => {
    settle[index]?.(value)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { reporter, sent, warnings, answer }
}

describe('createViewVisibleReporter (NFR-8)', () => {
  it('sends the first value at once, then only changes', () => {
    const { reporter, sent } = harness()
    reporter.update(true)
    reporter.update(true)
    reporter.update(false)
    reporter.update(false)
    reporter.update(true)
    expect(sent).toEqual([true, false, true])
  })

  it('sends false when the wall goes away, once, and nothing after', () => {
    const { reporter, sent } = harness()
    reporter.update(true)
    reporter.dispose()
    reporter.dispose()
    reporter.update(true)
    expect(sent).toEqual([true, false])
  })

  it('does not repeat false on dispose when false is what main already holds', () => {
    const { reporter, sent } = harness()
    reporter.update(false)
    reporter.dispose()
    expect(sent).toEqual([false])
  })

  it('logs a refused send and sends the same value again on the next update', async () => {
    const { reporter, sent, warnings, answer } = harness()
    reporter.update(true)
    await answer(0, { ok: false })
    expect(warnings).toHaveLength(1)
    reporter.update(true)
    expect(sent).toEqual([true, true])
    await answer(1, { ok: true })
    reporter.update(true)
    expect(sent).toEqual([true, true])
  })

  it('treats a bridge that throws like a refusal', async () => {
    const { reporter, sent, warnings, answer } = harness()
    reporter.update(true)
    await answer(0, 'throw')
    expect(warnings).toHaveLength(1)
    reporter.update(true)
    expect(sent).toEqual([true, true])
  })

  it('an older send failing does not make it forget a newer value', async () => {
    const { reporter, sent, answer } = harness()
    reporter.update(true)
    reporter.update(false)
    await answer(0, { ok: false })
    await answer(1, { ok: true })
    // `false` went through and is still what main holds: no repeat.
    reporter.update(false)
    expect(sent).toEqual([true, false])
  })

  it('sends false on dispose after a failed false, so main is told at the end', async () => {
    const { reporter, sent, answer } = harness()
    reporter.update(true)
    reporter.update(false)
    await answer(1, { ok: false })
    reporter.dispose()
    expect(sent).toEqual([true, false, false])
  })
})
