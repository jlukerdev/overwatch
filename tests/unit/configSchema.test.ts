// P1.1/P3.1: the persisted config schema (src/main/config/schema.ts + src/shared/models.ts) against
// SPEC §6 — the constraints the spec states (cells tile the grid, rotateIntervalSec >= 5, 4x4
// maximum, gap 0..64), the defaults (QUAL-1, DOOR-0, CELL-2/4, VIEW-5's 16:9, VIEW-8's names shown) and the `null` =
// inherit rule (QUAL-2/3). The tiling rules themselves are tested in viewLayout.test.ts.
import { describe, expect, it } from 'vitest'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, defaultConfig } from '../../src/main/config/schema'
import { CellSchema, ViewSchema } from '../../src/shared/models'

/** `cols * rows` empty 1×1 cells, in canonical (row-major) order. */
function cells(cols: number, rows: number): { cameraIds: string[]; col: number; row: number }[] {
  return Array.from({ length: cols * rows }, (_, i) => ({
    cameraIds: [],
    col: i % cols,
    row: Math.floor(i / cols),
  }))
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'v1', name: 'Perimeter', cols: 3, rows: 3, cells: cells(3, 3), ...overrides }
}

/** Where a lone cell sits; CellSchema requires a position (it has no sensible default). */
const AT = { col: 0, row: 0 }

/**
 * The document in SPEC §6, verbatim apart from `accessCertFingerprint` (see the task notes) and the
 * schemaVersion 2 cell placements (P3.1), which put the nine cells of the 3×3 in row-major order.
 */
const specExample = {
  schemaVersion: 2,
  console: {
    host: '192.0.2.10',
    certFingerprint: 'sha256/AAAA',
    accessEnabled: false,
    accessBaseUrl: null,
  },
  doorLinks: { camA: 'door-1' },
  views: [
    {
      id: 'uuid',
      name: 'Perimeter',
      cols: 3,
      rows: 3,
      fit: 'contain',
      gridQuality: null,
      fillQuality: null,
      cells: [
        { col: 0, row: 0, cameraIds: ['camA'], quality: 'medium' },
        {
          col: 1,
          row: 0,
          cameraIds: ['camB', 'camC', 'camD'],
          rotateIntervalSec: 10,
          motionSwitch: true,
          motionTriggers: ['motion', 'smartDetect', 'ring'],
          smartDetectTypes: ['person'],
          motionHoldSec: 15,
        },
        { col: 2, row: 0, cameraIds: [] },
        { col: 0, row: 1, cameraIds: [] },
        { col: 1, row: 1, cameraIds: [] },
        { col: 2, row: 1, cameraIds: [] },
        { col: 0, row: 2, cameraIds: [] },
        { col: 1, row: 2, cameraIds: [] },
        { col: 2, row: 2, cameraIds: [] },
      ],
    },
  ],
  lastViewId: 'uuid',
  streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
  ui: { overlayAutoHideSec: 3 },
}

describe('defaultConfig', () => {
  it('matches the spec defaults', () => {
    expect(defaultConfig()).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      console: {
        host: '',
        certFingerprint: null,
        // DOOR-0: Access is off by default and has no base URL or pin of its own yet.
        accessEnabled: false,
        accessBaseUrl: null,
        accessCertFingerprint: null,
        // CON-4: nothing connects on launch until a connect has worked.
        connectOnLaunch: false,
      },
      doorLinks: {},
      views: [],
      lastViewId: null,
      // QUAL-1.
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      // CELL-4.
      ui: { overlayAutoHideSec: 3 },
      // DOOR-6 (P5.6): P5.5's hard-coded intervals, plus the new details read.
      accessPolling: { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 },
    })
  })

  it('hands out a fresh object every call', () => {
    const first = defaultConfig()
    first.views.push({
      id: 'v1',
      name: 'n',
      cols: 1,
      rows: 1,
      fit: 'contain',
      aspect: { w: 16, h: 9 },
      gap: 0,
      gridQuality: null,
      fillQuality: null,
      showNames: true,
      cells: [
        {
          col: 0,
          row: 0,
          colSpan: 1,
          rowSpan: 1,
          cameraIds: [],
          quality: null,
          motionSwitch: false,
          motionTriggers: [],
          motionHoldSec: 15,
        },
      ],
    })
    expect(defaultConfig().views).toEqual([])
  })

  it('round-trips through the schema', () => {
    expect(ConfigSchema.parse(defaultConfig())).toEqual(defaultConfig())
  })
})

describe('ConfigSchema', () => {
  it('accepts the SPEC §6 document and fills in what it omits', () => {
    const parsed = ConfigSchema.parse(specExample)
    expect(parsed.console.accessCertFingerprint).toBeNull()
    expect(parsed.views[0]?.aspect).toEqual({ w: 16, h: 9 })
    expect(parsed.views[0]?.gap).toBe(0)
    expect(parsed.views[0]?.cells[0]).toEqual({
      col: 0,
      row: 0,
      colSpan: 1,
      rowSpan: 1,
      cameraIds: ['camA'],
      quality: 'medium',
      motionSwitch: false,
      motionTriggers: ['motion', 'smartDetect', 'ring'],
      motionHoldSec: 15,
    })
    expect(parsed.doorLinks).toEqual({ camA: 'door-1' })
    expect(parsed.lastViewId).toBe('uuid')
  })

  it('loads a minimal file: only schemaVersion is required', () => {
    expect(ConfigSchema.parse({ schemaVersion: 2 })).toEqual(defaultConfig())
  })

  it('rejects any schemaVersion but this build’s (migrations deal with those)', () => {
    expect(ConfigSchema.safeParse({ schemaVersion: 1 }).success).toBe(false)
    expect(ConfigSchema.safeParse({ schemaVersion: 3 }).success).toBe(false)
    expect(ConfigSchema.safeParse({}).success).toBe(false)
  })

  it('strips unknown keys instead of rejecting the file (VIEW-6)', () => {
    const parsed = ConfigSchema.parse({ schemaVersion: 2, somethingNew: 1, views: [view()] })
    expect(parsed).not.toHaveProperty('somethingNew')
    expect(parsed.views).toHaveLength(1)
  })

  it('keeps a dangling lastViewId: a deleted View must not invalidate the file', () => {
    const parsed = ConfigSchema.parse({ schemaVersion: 2, views: [], lastViewId: 'gone' })
    expect(parsed.lastViewId).toBe('gone')
    expect(ConfigSchema.safeParse({ schemaVersion: 2, lastViewId: '' }).success).toBe(false)
  })

  it('validates the console block (CON-1/3, DOOR-0) and the Access pin added after P0.4 §4', () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 2,
      console: {
        host: 'console.invalid',
        certFingerprint: 'sha256/AAAA',
        accessEnabled: true,
        accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer',
        accessCertFingerprint: 'sha256/BBBB',
      },
    })
    expect(parsed.console.accessEnabled).toBe(true)
    expect(parsed.console.accessCertFingerprint).toBe('sha256/BBBB')
    // The two pins are independent: pinning is per host:port (P0.4 §4).
    expect(parsed.console.certFingerprint).not.toBe(parsed.console.accessCertFingerprint)
    for (const console_ of [
      { accessBaseUrl: 'not a url' },
      { certFingerprint: '' },
      { accessCertFingerprint: '' },
      { accessEnabled: 'yes' },
      { host: 5 },
    ]) {
      expect(ConfigSchema.safeParse({ schemaVersion: 2, console: console_ }).success).toBe(false)
    }
  })

  it('loads a file written before connectOnLaunch existed as off, with no version bump (CON-4)', () => {
    // The SPEC §6 example predates the field; no migration adds it, the default does.
    expect(specExample.console).not.toHaveProperty('connectOnLaunch')
    expect(ConfigSchema.parse(specExample).console.connectOnLaunch).toBe(false)
    const on = { ...specExample, console: { ...specExample.console, connectOnLaunch: true } }
    expect(ConfigSchema.parse(on).console.connectOnLaunch).toBe(true)
    expect(
      ConfigSchema.safeParse({ schemaVersion: 2, console: { connectOnLaunch: 'yes' } }).success,
    ).toBe(false)
  })

  it('validates doorLinks as a camera id -> door id map (DOOR-2)', () => {
    expect(ConfigSchema.parse({ schemaVersion: 2, doorLinks: { a: 'b' } }).doorLinks).toEqual({
      a: 'b',
    })
    expect(ConfigSchema.safeParse({ schemaVersion: 2, doorLinks: { a: '' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ schemaVersion: 2, doorLinks: { '': 'b' } }).success).toBe(false)
  })

  it('takes the app-wide quality defaults from QUAL-1 and rejects anything else', () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 2,
      streams: { defaultGridQuality: 'medium' },
    })
    expect(parsed.streams).toEqual({ defaultGridQuality: 'medium', defaultFillQuality: 'high' })
    expect(
      ConfigSchema.safeParse({ schemaVersion: 2, streams: { defaultGridQuality: null } }).success,
    ).toBe(false)
    expect(
      ConfigSchema.safeParse({ schemaVersion: 2, streams: { defaultFillQuality: 'package' } })
        .success,
    ).toBe(false)
  })

  describe('accessPolling (DOOR-6, P5.6)', () => {
    const DEFAULTS = { withSocketSec: 5, withoutSocketSec: 2, unlockedSec: 1, detailsSec: 30 }

    it("loads a file written before P5.6 with P5.5's intervals, and needs no schemaVersion bump", () => {
      // No migration step was added for it: the block is defaulted, like `View.showNames`.
      expect(CONFIG_SCHEMA_VERSION).toBe(2)
      expect(ConfigSchema.parse({ schemaVersion: 2 }).accessPolling).toEqual(DEFAULTS)
      expect(ConfigSchema.parse({ schemaVersion: 2, accessPolling: {} }).accessPolling).toEqual(
        DEFAULTS,
      )
    })

    it('keeps saved values and defaults only the missing ones', () => {
      expect(
        ConfigSchema.parse({ schemaVersion: 2, accessPolling: { detailsSec: 120 } }).accessPolling,
      ).toEqual({ ...DEFAULTS, detailsSec: 120 })
      const all = { withSocketSec: 60, withoutSocketSec: 30, unlockedSec: 10, detailsSec: 600 }
      expect(ConfigSchema.parse({ schemaVersion: 2, accessPolling: all }).accessPolling).toEqual(
        all,
      )
      const low = { withSocketSec: 2, withoutSocketSec: 1, unlockedSec: 1, detailsSec: 10 }
      expect(ConfigSchema.parse({ schemaVersion: 2, accessPolling: low }).accessPolling).toEqual(
        low,
      )
    })

    it('never rejects the config over a hand-edited interval: the default replaces it (VIEW-6)', () => {
      // A rejected config is moved aside and replaced by defaults, which costs every View. One bad
      // number must cost that one setting only, and never reach the monitor as written.
      for (const [field, bad] of [
        ['unlockedSec', 0],
        ['unlockedSec', -1],
        ['unlockedSec', 11],
        ['withSocketSec', 1],
        ['withSocketSec', 100000],
        ['withoutSocketSec', 0.5],
        ['detailsSec', 9],
        ['detailsSec', 601],
        ['detailsSec', '30'],
        ['detailsSec', null],
        ['withSocketSec', Number.NaN],
      ] as const) {
        const parsed = ConfigSchema.safeParse({
          schemaVersion: 2,
          accessPolling: {
            withSocketSec: 10,
            withoutSocketSec: 3,
            unlockedSec: 2,
            detailsSec: 60,
            [field]: bad,
          },
        })
        expect(parsed.success, `${field}=${String(bad)}`).toBe(true)
        if (!parsed.success) continue
        // The bad field is its default; the good ones beside it are kept.
        expect(parsed.data.accessPolling).toEqual({
          withSocketSec: 10,
          withoutSocketSec: 3,
          unlockedSec: 2,
          detailsSec: 60,
          [field]: DEFAULTS[field],
        })
      }
    })

    it('falls back to the defaults for a block that is not an object at all', () => {
      for (const bad of [5, 'fast', null, [1, 2, 3], true]) {
        const parsed = ConfigSchema.safeParse({ schemaVersion: 2, accessPolling: bad })
        expect(parsed.success, JSON.stringify(bad)).toBe(true)
        if (parsed.success) expect(parsed.data.accessPolling).toEqual(DEFAULTS)
      }
    })

    it('hands out a fresh defaults object each time', () => {
      const first = ConfigSchema.parse({ schemaVersion: 2, accessPolling: 'nope' }).accessPolling
      first.detailsSec = 999
      expect(
        ConfigSchema.parse({ schemaVersion: 2, accessPolling: 'nope' }).accessPolling.detailsSec,
      ).toBe(30)
    })

    it('strips an unknown interval rather than rejecting it', () => {
      expect(
        ConfigSchema.parse({ schemaVersion: 2, accessPolling: { burstSec: 1 } }).accessPolling,
      ).toEqual(DEFAULTS)
    })
  })

  it('keeps overlayAutoHideSec positive (CELL-4)', () => {
    expect(ConfigSchema.parse({ schemaVersion: 2, ui: { overlayAutoHideSec: 1.5 } }).ui).toEqual({
      overlayAutoHideSec: 1.5,
    })
    for (const v of [0, -1, 'three']) {
      expect(
        ConfigSchema.safeParse({ schemaVersion: 2, ui: { overlayAutoHideSec: v } }).success,
      ).toBe(false)
    }
  })
})

describe('ViewSchema', () => {
  it('requires the cells to tile the grid, naming the offending cell (SPEC §6)', () => {
    expect(ViewSchema.parse(view({ cols: 2, rows: 2, cells: cells(2, 2) })).cells).toHaveLength(4)
    // One cell short: the uncovered slot is reported under `cells`, as there is no cell to blame.
    const short = ViewSchema.safeParse(view({ cells: cells(3, 3).slice(0, 8) }))
    expect(short.success).toBe(false)
    if (!short.success) {
      expect(short.error.issues[0]?.path).toEqual(['cells'])
      expect(short.error.issues[0]?.message).toContain('slot (col 2, row 2) is not covered')
    }
    // A duplicate cell overlaps, and is named by index.
    const extra = ViewSchema.safeParse(
      view({ cols: 2, rows: 2, cells: [...cells(2, 2), { col: 1, row: 1 }] }),
    )
    expect(extra.success).toBe(false)
    if (!extra.success) {
      expect(extra.error.issues[0]?.path).toEqual(['cells', 4])
      expect(extra.error.issues[0]?.message).toBe('cell 4 overlaps cell 3')
    }
  })

  it('accepts spanned cells and returns cells in canonical order', () => {
    const parsed = ViewSchema.parse(
      view({
        cells: [
          // Deliberately out of order: the parse sorts by (row, col) of the top-left slot.
          { col: 2, row: 2 },
          { col: 0, row: 2 },
          { col: 2, row: 0, rowSpan: 2 },
          { col: 1, row: 2 },
          { col: 0, row: 0, colSpan: 2, rowSpan: 2, cameraIds: ['camA'] },
        ],
      }),
    )
    expect(parsed.cells.map((c) => [c.col, c.row, c.colSpan, c.rowSpan])).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 2],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ])
    expect(parsed.cells[0]?.cameraIds).toEqual(['camA'])
  })

  it('reports a tiling problem under views[n].cells[i] inside a whole config', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 2,
      views: [
        view(),
        view({
          id: 'v2',
          cols: 2,
          rows: 2,
          cells: [...cells(2, 2).slice(0, 3), { col: 2, row: 1 }],
        }),
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['views', 1, 'cells', 3])
    }
  })

  it('defaults aspect to 16:9 and gap to 0, and bounds both (VIEW-5)', () => {
    const parsed = ViewSchema.parse(view())
    expect(parsed.aspect).toEqual({ w: 16, h: 9 })
    expect(parsed.gap).toBe(0)
    expect(ViewSchema.parse(view({ aspect: { w: 4, h: 3 }, gap: 64 }))).toMatchObject({
      aspect: { w: 4, h: 3 },
      gap: 64,
    })
    for (const bad of [
      { aspect: { w: 0, h: 9 } },
      { aspect: { w: 16, h: -9 } },
      { aspect: { w: 1.5, h: 1 } },
      { aspect: { w: 16 } },
      { gap: -1 },
      { gap: 65 },
      { gap: 2.5 },
    ]) {
      expect(ViewSchema.safeParse(view(bad)).success).toBe(false)
    }
  })

  it('bounds the layout to 4x4 (VIEW-1)', () => {
    expect(ViewSchema.parse(view({ cols: 4, rows: 4, cells: cells(4, 4) })).cols).toBe(4)
    expect(ViewSchema.parse(view({ cols: 1, rows: 1, cells: cells(1, 1) })).rows).toBe(1)
    for (const dims of [
      { cols: 5, rows: 1, cells: cells(5, 1) },
      { cols: 1, rows: 5, cells: cells(1, 5) },
      { cols: 0, rows: 1, cells: [] },
      { cols: 2.5, rows: 2, cells: cells(2, 2) },
    ]) {
      expect(ViewSchema.safeParse(view(dims)).success).toBe(false)
    }
  })

  it('defaults fit to contain and rejects other fits (VIEW-5)', () => {
    expect(ViewSchema.parse(view()).fit).toBe('contain')
    expect(ViewSchema.parse(view({ fit: 'cover' })).fit).toBe('cover')
    expect(ViewSchema.safeParse(view({ fit: 'fill' })).success).toBe(false)
  })

  it('treats an absent quality override as an explicit null = inherit (QUAL-2/3)', () => {
    const parsed = ViewSchema.parse(view())
    expect(parsed.gridQuality).toBeNull()
    expect(parsed.fillQuality).toBeNull()
    expect(parsed.cells[0]?.quality).toBeNull()
    // An explicit null is accepted and means the same thing.
    expect(ViewSchema.parse(view({ gridQuality: null, fillQuality: 'high' })).fillQuality).toBe(
      'high',
    )
    expect(ViewSchema.safeParse(view({ gridQuality: 'ultra' })).success).toBe(false)
    expect(ViewSchema.safeParse(view({ gridQuality: 'package' })).success).toBe(false)
  })

  it('shows camera names unless a View says otherwise; a file without the field needs no migration (VIEW-8)', () => {
    expect(ViewSchema.parse(view()).showNames).toBe(true)
    expect(ViewSchema.parse(view({ showNames: false })).showNames).toBe(false)
    expect(ViewSchema.safeParse(view({ showNames: 'no' })).success).toBe(false)
  })

  it('needs an id and a name', () => {
    expect(ViewSchema.safeParse(view({ id: '' })).success).toBe(false)
    expect(ViewSchema.safeParse(view({ name: '' })).success).toBe(false)
  })
})

describe('CellSchema', () => {
  it('defaults an empty cell to no cameras and the CELL-2 motion settings', () => {
    expect(CellSchema.parse(AT)).toEqual({
      col: 0,
      row: 0,
      colSpan: 1,
      rowSpan: 1,
      cameraIds: [],
      quality: null,
      motionSwitch: false,
      motionTriggers: ['motion', 'smartDetect', 'ring'],
      motionHoldSec: 15,
    })
  })

  it('leaves rotateIntervalSec absent rather than null, and floors it at 5 s (CELL-2)', () => {
    expect('rotateIntervalSec' in CellSchema.parse(AT)).toBe(false)
    expect(CellSchema.parse({ ...AT, rotateIntervalSec: 5 }).rotateIntervalSec).toBe(5)
    for (const v of [4, 0, -5, 5.5, null]) {
      expect(CellSchema.safeParse({ ...AT, rotateIntervalSec: v }).success).toBe(false)
    }
  })

  it('accepts a camera id or a package channel source (CAM-4)', () => {
    expect(CellSchema.parse({ ...AT, cameraIds: ['camA', 'camB:package'] }).cameraIds).toEqual([
      'camA',
      'camB:package',
    ])
    expect(CellSchema.safeParse({ ...AT, cameraIds: [''] }).success).toBe(false)
    expect(CellSchema.safeParse({ ...AT, cameraIds: 'camA' }).success).toBe(false)
  })

  it('validates motionTriggers and keeps motionHoldSec non-negative (CELL-2)', () => {
    expect(CellSchema.parse({ ...AT, motionTriggers: ['ring'] }).motionTriggers).toEqual(['ring'])
    expect(CellSchema.parse({ ...AT, motionTriggers: [] }).motionTriggers).toEqual([])
    expect(CellSchema.safeParse({ ...AT, motionTriggers: ['smartDetectZone'] }).success).toBe(false)
    expect(CellSchema.parse({ ...AT, motionHoldSec: 0 }).motionHoldSec).toBe(0)
    expect(CellSchema.safeParse({ ...AT, motionHoldSec: -1 }).success).toBe(false)
  })

  it('leaves smartDetectTypes open: a Protect upgrade must not invalidate the file (SPEC R8)', () => {
    expect(
      CellSchema.parse({ ...AT, smartDetectTypes: ['person', 'vehicle'] }).smartDetectTypes,
    ).toEqual(['person', 'vehicle'])
    expect(
      CellSchema.parse({ ...AT, smartDetectTypes: ['somethingNew'] }).smartDetectTypes,
    ).toEqual(['somethingNew'])
    expect('smartDetectTypes' in CellSchema.parse(AT)).toBe(false)
    expect(CellSchema.safeParse({ ...AT, smartDetectTypes: [''] }).success).toBe(false)
  })

  it('needs a whole, non-negative position and spans of at least 1 (P3.1)', () => {
    expect(CellSchema.parse({ col: 3, row: 2, colSpan: 2, rowSpan: 4 })).toMatchObject({
      col: 3,
      row: 2,
      colSpan: 2,
      rowSpan: 4,
    })
    for (const bad of [
      {},
      { col: 0 },
      { row: 0 },
      { col: -1, row: 0 },
      { col: 0.5, row: 0 },
      { ...AT, colSpan: 0 },
      { ...AT, rowSpan: 1.5 },
    ]) {
      expect(CellSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('strips unknown cell keys', () => {
    expect(CellSchema.parse({ ...AT, cameraIds: [], zoom: 2 })).not.toHaveProperty('zoom')
  })
})
