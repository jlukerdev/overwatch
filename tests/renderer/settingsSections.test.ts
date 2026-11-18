// P5.3 cleanup (user request 2026-11-17): the Settings section sidebar's two decisions — which
// groups the page has, in page order, and which link is marked as the one in view.
import { describe, expect, it } from 'vitest'
import {
  activeSection,
  CONSOLE_SECTION,
  KEYSTORE_SECTION,
  sectionTitleId,
  settingsSections,
  STREAMS_SECTION,
} from '../../src/renderer/src/features/settings/settingsSections'

// A third group for `activeSection`, which works on any list: the page had three until P5.6 moved
// the door links to the Doors screen, and "the short last group" is still the case worth testing.
const LAST_SECTION = { id: 'settings-last', label: 'Last' }

const ids = (options: { keystoreAvailable: boolean }): string[] =>
  settingsSections(options).map((section) => section.label)

describe('settingsSections', () => {
  it('lists Console and Streams; the door links moved to the Doors screen (P5.6)', () => {
    expect(ids({ keystoreAvailable: true })).toEqual(['Console', 'Streams'])
  })

  it('puts the keystore warning first while there is no keystore (CON-2)', () => {
    expect(ids({ keystoreAvailable: false })).toEqual(['Keystore', 'Console', 'Streams'])
  })

  it('gives each heading an id derived from its section', () => {
    expect(sectionTitleId(CONSOLE_SECTION)).toBe('settings-console-title')
    const all = [KEYSTORE_SECTION, CONSOLE_SECTION, STREAMS_SECTION]
    expect(new Set(all.map((section) => section.id)).size).toBe(all.length)
  })
})

describe('activeSection', () => {
  const sections = [CONSOLE_SECTION, STREAMS_SECTION, LAST_SECTION]
  const tops = (consoleTop: number, streamsTop: number, doorsTop: number): Map<string, number> =>
    new Map([
      [CONSOLE_SECTION.id, consoleTop],
      [STREAMS_SECTION.id, streamsTop],
      [LAST_SECTION.id, doorsTop],
    ])
  // A 400px container over 2000px of content; the reading line is at 100px.
  const scrolled = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 400 })

  it('is the first section before anything has scrolled past the reading line', () => {
    expect(activeSection(sections, tops(16, 900, 1500), scrolled(0))).toBe(CONSOLE_SECTION.id)
  })

  it('is the last section whose top is at or above the reading line', () => {
    expect(activeSection(sections, tops(-600, 100, 400), scrolled(600))).toBe(STREAMS_SECTION.id)
    expect(activeSection(sections, tops(-600, 101, 400), scrolled(600))).toBe(CONSOLE_SECTION.id)
    expect(activeSection(sections, tops(-900, -300, 50), scrolled(900))).toBe(LAST_SECTION.id)
  })

  it('falls back to the first section when none has reached the line', () => {
    expect(activeSection(sections, tops(200, 900, 1500), scrolled(0))).toBe(CONSOLE_SECTION.id)
    expect(activeSection(sections, new Map(), scrolled(0))).toBe(CONSOLE_SECTION.id)
  })

  it('is the last section at the bottom, even one too short to reach the line', () => {
    expect(activeSection(sections, tops(-1400, -700, 250), scrolled(1600))).toBe(LAST_SECTION.id)
  })

  it('applies the bottom rule only when the content scrolls and has been scrolled', () => {
    // Fits on screen: at the "bottom" from the start, but the first section stays current.
    const fits = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 }
    expect(activeSection(sections, tops(16, 150, 300), fits)).toBe(CONSOLE_SECTION.id)
    // Scrolls, but not scrolled yet.
    const unscrolled = { scrollTop: 0, scrollHeight: 401, clientHeight: 400 }
    expect(activeSection(sections, tops(16, 150, 300), unscrolled)).toBe(CONSOLE_SECTION.id)
  })

  it('keeps a clicked section current while its scroll is locked', () => {
    expect(
      activeSection(sections, tops(-1400, -700, 250), scrolled(1600), STREAMS_SECTION.id),
    ).toBe(STREAMS_SECTION.id)
    // A lock on a section the page no longer has (Access switched off) is ignored.
    expect(
      activeSection(
        [CONSOLE_SECTION, STREAMS_SECTION],
        tops(16, 900, 0),
        scrolled(0),
        LAST_SECTION.id,
      ),
    ).toBe(CONSOLE_SECTION.id)
    expect(activeSection([], new Map(), scrolled(0))).toBeNull()
  })
})
