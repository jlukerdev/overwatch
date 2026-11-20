// MODE-4: per-mode Views (src/main/config/modeViews.ts) — which list a mode reads and writes, and
// what the renderer is shown. Pure functions over a parsed config, so no store and no IPC here; the
// handlers' routing on top of them is in ipcHandlers.test.ts.
import { ViewSchema, type View } from '@shared/models'
import { describe, expect, it } from 'vitest'
import {
  activeViews,
  settingsForRenderer,
  viewsOf,
  withActiveViews,
  withViewsOf,
} from '../../src/main/config/modeViews'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, type Config } from '../../src/main/config/schema'

function view(id: string): View {
  return ViewSchema.parse({
    id,
    name: `View ${id}`,
    cols: 1,
    rows: 1,
    cells: [{ col: 0, row: 0 }],
  })
}

const STREAM = { id: 'rtsp-00000000-0000-4000-8000-000000000001', name: 'Garage' }

/** Protect's pair at the top level, RTSP's in the block, one stream configured. */
function config(mode: 'protect' | 'rtsp'): Config {
  return ConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode,
    views: [view('p1'), view('p2')],
    lastViewId: 'p2',
    rtsp: { streams: [STREAM], views: [view('r1')], lastViewId: 'r1' },
  })
}

const ids = (views: readonly View[]): string[] => views.map((v) => v.id)

describe('reading a mode`s Views', () => {
  it('reads the top-level pair in Protect mode and the rtsp block in RTSP mode', () => {
    expect(ids(activeViews(config('protect')).views)).toEqual(['p1', 'p2'])
    expect(activeViews(config('protect')).lastViewId).toBe('p2')
    expect(ids(activeViews(config('rtsp')).views)).toEqual(['r1'])
    expect(activeViews(config('rtsp')).lastViewId).toBe('r1')
  })

  it('reads either mode`s pair whatever mode is active', () => {
    expect(ids(viewsOf(config('rtsp'), 'protect').views)).toEqual(['p1', 'p2'])
    expect(ids(viewsOf(config('protect'), 'rtsp').views)).toEqual(['r1'])
  })

  it('loads an install from before modes existed as Protect, with its Views where they were', () => {
    const old = ConfigSchema.parse({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      views: [view('p1')],
      lastViewId: 'p1',
    })
    expect(old.mode).toBe('protect')
    expect(ids(activeViews(old).views)).toEqual(['p1'])
    expect(viewsOf(old, 'rtsp')).toEqual({ views: [], lastViewId: null })
  })
})

describe('writing a mode`s Views', () => {
  it('writes into the active mode`s pair only (Protect)', () => {
    const next = withActiveViews(config('protect'), { views: [view('p3')], lastViewId: 'p3' })
    expect(ids(next.views)).toEqual(['p3'])
    expect(next.lastViewId).toBe('p3')
    expect(ids(next.rtsp.views)).toEqual(['r1'])
    expect(next.rtsp.lastViewId).toBe('r1')
  })

  it('writes into the active mode`s pair only (RTSP), keeping the block`s streams', () => {
    const next = withActiveViews(config('rtsp'), { views: [view('r2')], lastViewId: 'r2' })
    expect(ids(next.rtsp.views)).toEqual(['r2'])
    expect(next.rtsp.lastViewId).toBe('r2')
    expect(next.rtsp.streams).toEqual([STREAM])
    expect(ids(next.views)).toEqual(['p1', 'p2'])
    expect(next.lastViewId).toBe('p2')
  })

  it('writes only the fields given: a last View alone keeps the list', () => {
    const next = withActiveViews(config('rtsp'), { lastViewId: null })
    expect(next.rtsp.lastViewId).toBeNull()
    expect(ids(next.rtsp.views)).toEqual(['r1'])
  })

  it('writes the named mode`s pair, whatever mode is active, and mutates nothing', () => {
    const before = config('protect')
    const snapshot = structuredClone(before)
    const next = withViewsOf(before, 'rtsp', { views: [] })
    expect(next.rtsp.views).toEqual([])
    expect(next.mode).toBe('protect')
    expect(before).toEqual(snapshot)
  })

  it('keeps each mode`s list and last View across a switch and back', () => {
    let current = withActiveViews(config('protect'), { lastViewId: 'p1' })
    current = { ...current, mode: 'rtsp' }
    current = withActiveViews(current, { views: [view('r1'), view('r9')], lastViewId: 'r9' })
    current = { ...current, mode: 'protect' }
    expect(activeViews(current)).toMatchObject({ lastViewId: 'p1' })
    expect(ids(activeViews(current).views)).toEqual(['p1', 'p2'])
    current = { ...current, mode: 'rtsp' }
    expect(activeViews(current)).toMatchObject({ lastViewId: 'r9' })
    expect(ids(activeViews(current).views)).toEqual(['r1', 'r9'])
  })
})

describe('settingsForRenderer', () => {
  it('shows the active mode`s Views under the top-level names, and no other list', () => {
    for (const mode of ['protect', 'rtsp'] as const) {
      const shown = settingsForRenderer(config(mode))
      const other = mode === 'protect' ? ['r1'] : ['p1', 'p2']
      expect(shown.views).toEqual(activeViews(config(mode)).views)
      expect(shown.lastViewId).toBe(activeViews(config(mode)).lastViewId)
      // The rtsp block crosses without Views: not the inactive list, and not the active one twice.
      expect(shown.rtsp.views).toEqual([])
      expect(shown.rtsp.lastViewId).toBeNull()
      const text = JSON.stringify(shown)
      for (const id of other) expect(text).not.toContain(`"${id}"`)
    }
  })

  it('sends the streams as they are (names and ids, no URL) and the mode', () => {
    const shown = settingsForRenderer(config('rtsp'))
    expect(shown.rtsp.streams).toEqual([STREAM])
    expect(shown.mode).toBe('rtsp')
  })

  it('does not change what main stores', () => {
    const stored = config('rtsp')
    const snapshot = structuredClone(stored)
    settingsForRenderer(stored)
    expect(stored).toEqual(snapshot)
  })
})
