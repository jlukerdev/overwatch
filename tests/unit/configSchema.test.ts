// P1.1: the persisted config schema (src/main/config/schema.ts + src/shared/models.ts) against SPEC §6 — the constraints
// the spec states (cells.length === cols * rows, rotateIntervalSec >= 5, 4x4 maximum), the defaults
// (QUAL-1, DOOR-0, CELL-2/4) and the `null` = inherit rule (QUAL-2/3).
import { describe, expect, it } from 'vitest'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, defaultConfig } from '../../src/main/config/schema'
import { CellSchema, ViewSchema } from '../../src/shared/models'

/** `cols * rows` empty cells, row-major (SPEC §6). */
function cells(count: number): { cameraIds: string[] }[] {
  return Array.from({ length: count }, () => ({ cameraIds: [] }))
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'v1', name: 'Perimeter', cols: 3, rows: 3, cells: cells(9), ...overrides }
}

/** The document in SPEC §6, verbatim apart from `accessCertFingerprint` (see the task notes). */
const specExample = {
  schemaVersion: 1,
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
        { cameraIds: ['camA'], quality: 'medium' },
        {
          cameraIds: ['camB', 'camC', 'camD'],
          rotateIntervalSec: 10,
          motionSwitch: true,
          motionTriggers: ['motion', 'smartDetect', 'ring'],
          smartDetectTypes: ['person'],
          motionHoldSec: 15,
        },
        { cameraIds: [] },
        { cameraIds: [] },
        { cameraIds: [] },
        { cameraIds: [] },
        { cameraIds: [] },
        { cameraIds: [] },
        { cameraIds: [] },
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
      },
      doorLinks: {},
      views: [],
      lastViewId: null,
      // QUAL-1.
      streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
      // CELL-4.
      ui: { overlayAutoHideSec: 3 },
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
      gridQuality: null,
      fillQuality: null,
      cells: [
        {
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
    expect(parsed.views[0]?.cells[0]).toEqual({
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
    expect(ConfigSchema.parse({ schemaVersion: 1 })).toEqual(defaultConfig())
  })

  it('rejects any schemaVersion but this build’s (migrations deal with those)', () => {
    expect(ConfigSchema.safeParse({ schemaVersion: 0 }).success).toBe(false)
    expect(ConfigSchema.safeParse({ schemaVersion: 2 }).success).toBe(false)
    expect(ConfigSchema.safeParse({}).success).toBe(false)
  })

  it('strips unknown keys instead of rejecting the file (VIEW-6)', () => {
    const parsed = ConfigSchema.parse({ schemaVersion: 1, somethingNew: 1, views: [view()] })
    expect(parsed).not.toHaveProperty('somethingNew')
    expect(parsed.views).toHaveLength(1)
  })

  it('keeps a dangling lastViewId: a deleted View must not invalidate the file', () => {
    const parsed = ConfigSchema.parse({ schemaVersion: 1, views: [], lastViewId: 'gone' })
    expect(parsed.lastViewId).toBe('gone')
    expect(ConfigSchema.safeParse({ schemaVersion: 1, lastViewId: '' }).success).toBe(false)
  })

  it('validates the console block (CON-1/3, DOOR-0) and the Access pin added after P0.4 §4', () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 1,
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
      expect(ConfigSchema.safeParse({ schemaVersion: 1, console: console_ }).success).toBe(false)
    }
  })

  it('validates doorLinks as a camera id -> door id map (DOOR-2)', () => {
    expect(ConfigSchema.parse({ schemaVersion: 1, doorLinks: { a: 'b' } }).doorLinks).toEqual({
      a: 'b',
    })
    expect(ConfigSchema.safeParse({ schemaVersion: 1, doorLinks: { a: '' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ schemaVersion: 1, doorLinks: { '': 'b' } }).success).toBe(false)
  })

  it('takes the app-wide quality defaults from QUAL-1 and rejects anything else', () => {
    const parsed = ConfigSchema.parse({
      schemaVersion: 1,
      streams: { defaultGridQuality: 'medium' },
    })
    expect(parsed.streams).toEqual({ defaultGridQuality: 'medium', defaultFillQuality: 'high' })
    expect(
      ConfigSchema.safeParse({ schemaVersion: 1, streams: { defaultGridQuality: null } }).success,
    ).toBe(false)
    expect(
      ConfigSchema.safeParse({ schemaVersion: 1, streams: { defaultFillQuality: 'package' } })
        .success,
    ).toBe(false)
  })

  it('keeps overlayAutoHideSec positive (CELL-4)', () => {
    expect(ConfigSchema.parse({ schemaVersion: 1, ui: { overlayAutoHideSec: 1.5 } }).ui).toEqual({
      overlayAutoHideSec: 1.5,
    })
    for (const v of [0, -1, 'three']) {
      expect(
        ConfigSchema.safeParse({ schemaVersion: 1, ui: { overlayAutoHideSec: v } }).success,
      ).toBe(false)
    }
  })
})

describe('ViewSchema', () => {
  it('requires cells.length === cols * rows, row-major (SPEC §6)', () => {
    expect(ViewSchema.parse(view({ cols: 2, rows: 2, cells: cells(4) })).cells).toHaveLength(4)
    const short = ViewSchema.safeParse(view({ cols: 3, rows: 3, cells: cells(8) }))
    expect(short.success).toBe(false)
    if (!short.success) {
      expect(short.error.issues[0]?.path).toEqual(['cells'])
      expect(short.error.issues[0]?.message).toBe(
        'cells.length must be cols * rows (3 * 3 = 9), got 8',
      )
    }
    expect(ViewSchema.safeParse(view({ cols: 2, rows: 2, cells: cells(5) })).success).toBe(false)
  })

  it('reports the cell count under views[n].cells inside a whole config', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      views: [view(), view({ id: 'v2', cols: 2, rows: 2, cells: cells(3) })],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['views', 1, 'cells'])
  })

  it('bounds the layout to 4x4 (VIEW-1)', () => {
    expect(ViewSchema.parse(view({ cols: 4, rows: 4, cells: cells(16) })).cols).toBe(4)
    expect(ViewSchema.parse(view({ cols: 1, rows: 1, cells: cells(1) })).rows).toBe(1)
    for (const dims of [
      { cols: 5, rows: 1, cells: cells(5) },
      { cols: 1, rows: 5, cells: cells(5) },
      { cols: 0, rows: 1, cells: cells(0) },
      { cols: 2.5, rows: 2, cells: cells(5) },
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

  it('needs an id and a name', () => {
    expect(ViewSchema.safeParse(view({ id: '' })).success).toBe(false)
    expect(ViewSchema.safeParse(view({ name: '' })).success).toBe(false)
  })
})

describe('CellSchema', () => {
  it('defaults an empty cell to no cameras and the CELL-2 motion settings', () => {
    expect(CellSchema.parse({})).toEqual({
      cameraIds: [],
      quality: null,
      motionSwitch: false,
      motionTriggers: ['motion', 'smartDetect', 'ring'],
      motionHoldSec: 15,
    })
  })

  it('leaves rotateIntervalSec absent rather than null, and floors it at 5 s (CELL-2)', () => {
    expect('rotateIntervalSec' in CellSchema.parse({})).toBe(false)
    expect(CellSchema.parse({ rotateIntervalSec: 5 }).rotateIntervalSec).toBe(5)
    for (const v of [4, 0, -5, 5.5, null]) {
      expect(CellSchema.safeParse({ rotateIntervalSec: v }).success).toBe(false)
    }
  })

  it('accepts a camera id or a package channel source (CAM-4)', () => {
    expect(CellSchema.parse({ cameraIds: ['camA', 'camB:package'] }).cameraIds).toEqual([
      'camA',
      'camB:package',
    ])
    expect(CellSchema.safeParse({ cameraIds: [''] }).success).toBe(false)
    expect(CellSchema.safeParse({ cameraIds: 'camA' }).success).toBe(false)
  })

  it('validates motionTriggers and keeps motionHoldSec non-negative (CELL-2)', () => {
    expect(CellSchema.parse({ motionTriggers: ['ring'] }).motionTriggers).toEqual(['ring'])
    expect(CellSchema.parse({ motionTriggers: [] }).motionTriggers).toEqual([])
    expect(CellSchema.safeParse({ motionTriggers: ['smartDetectZone'] }).success).toBe(false)
    expect(CellSchema.parse({ motionHoldSec: 0 }).motionHoldSec).toBe(0)
    expect(CellSchema.safeParse({ motionHoldSec: -1 }).success).toBe(false)
  })

  it('leaves smartDetectTypes open: a Protect upgrade must not invalidate the file (SPEC R8)', () => {
    expect(CellSchema.parse({ smartDetectTypes: ['person', 'vehicle'] }).smartDetectTypes).toEqual([
      'person',
      'vehicle',
    ])
    expect(CellSchema.parse({ smartDetectTypes: ['somethingNew'] }).smartDetectTypes).toEqual([
      'somethingNew',
    ])
    expect('smartDetectTypes' in CellSchema.parse({})).toBe(false)
    expect(CellSchema.safeParse({ smartDetectTypes: [''] }).success).toBe(false)
  })

  it('strips unknown cell keys', () => {
    expect(CellSchema.parse({ cameraIds: [], zoom: 2 })).not.toHaveProperty('zoom')
  })
})
