// P1.1/P3.1: the schemaVersion migration chain (src/main/config/migrations.ts). The mechanism is
// driven with synthetic steps (an imagined version 0, and steps with an explicit target), and the
// real chain — today the one step 1 -> 2 (P3.1, cell placements) — with v1 fixtures that have to
// come out as valid current configs.
import { describe, expect, it } from 'vitest'
import {
  MIGRATIONS,
  migrateConfig,
  type ConfigRecord,
  type MigrationStep,
} from '../../src/main/config/migrations'
import { ConfigSchema, CONFIG_SCHEMA_VERSION, defaultConfig } from '../../src/main/config/schema'

/** Synthetic 0 -> 1: version 0 is imagined to have held a single unnamed view layout. */
const zeroToOne: MigrationStep = {
  from: 0,
  to: 1,
  migrate: (config) => {
    const { cols, rows, ...rest } = config
    if (typeof cols !== 'number' || typeof rows !== 'number') return rest
    return {
      ...rest,
      views: [
        {
          id: 'migrated',
          name: 'Migrated',
          cols,
          rows,
          cells: Array.from({ length: cols * rows }, () => ({ cameraIds: [] })),
        },
      ],
      lastViewId: 'migrated',
    }
  },
}

/** Synthetic 1 -> 2, to prove several steps run in sequence. */
const oneToTwo: MigrationStep = {
  from: 1,
  to: 2,
  migrate: (config) => ({ ...config, ui: { overlayAutoHideSec: 5 } }),
}

describe('MIGRATIONS (the real chain)', () => {
  it('is ordered, contiguous and ends at CONFIG_SCHEMA_VERSION', () => {
    for (const [index, step] of MIGRATIONS.entries()) {
      expect(step.to).toBe(step.from + 1)
      const next = MIGRATIONS[index + 1]
      if (next) expect(next.from).toBe(step.to)
    }
    const last = MIGRATIONS.at(-1)
    if (last) expect(last.to).toBe(CONFIG_SCHEMA_VERSION)
  })

  it('leaves a config at the current version untouched', () => {
    const current: ConfigRecord = { ...defaultConfig() }
    const result = migrateConfig(current)
    expect(result).toMatchObject({
      ok: true,
      fromVersion: CONFIG_SCHEMA_VERSION,
      toVersion: CONFIG_SCHEMA_VERSION,
      applied: [],
    })
    if (result.ok) expect(result.config).toEqual(current)
  })

  it('has nothing to migrate from version 0: version 1 was the first shipped', () => {
    expect(migrateConfig({ schemaVersion: 0 })).toEqual({
      ok: false,
      reason: 'no-migration-path',
      message: `no migration from schemaVersion 0 towards ${String(CONFIG_SCHEMA_VERSION)}`,
    })
  })
})

/**
 * A v1 config as P1.1–P2.5 wrote it (SPEC §6 before P3.1): uniform grids, `cells` row-major with
 * `cells.length === cols * rows`, no placements, no `aspect` or `gap`. Sanitized: no real hosts,
 * ids or fingerprints.
 */
const V1_FIXTURE = {
  schemaVersion: 1,
  console: {
    host: '192.0.2.10',
    certFingerprint: 'sha256/AAAA',
    accessEnabled: false,
    accessBaseUrl: null,
    accessCertFingerprint: null,
  },
  doorLinks: { camA: 'door-1' },
  views: [
    {
      id: 'view-perimeter',
      name: 'Perimeter',
      cols: 3,
      rows: 2,
      fit: 'cover',
      gridQuality: 'medium',
      fillQuality: null,
      cells: [
        { cameraIds: ['camA'], quality: 'high' },
        {
          cameraIds: ['camB', 'camC'],
          rotateIntervalSec: 10,
          motionSwitch: true,
          motionTriggers: ['motion'],
          motionHoldSec: 20,
        },
        { cameraIds: [] },
        { cameraIds: ['camD'] },
        { cameraIds: [] },
        { cameraIds: ['camE:package'] },
      ],
    },
    {
      id: 'view-single',
      name: 'Doorbell',
      cols: 1,
      rows: 1,
      fit: 'contain',
      gridQuality: null,
      fillQuality: 'high',
      cells: [{ cameraIds: ['camE'] }],
    },
  ],
  lastViewId: 'view-single',
  streams: { defaultGridQuality: 'low', defaultFillQuality: 'high' },
  ui: { overlayAutoHideSec: 3 },
}

describe('1 -> 2: cell placements (P3.1, VIEW-1)', () => {
  it('turns a v1 file into a valid current config with the same layout', () => {
    const result = migrateConfig(V1_FIXTURE)
    expect(result).toMatchObject({ ok: true, fromVersion: 1, toVersion: 2, applied: [2] })
    if (!result.ok) return
    const parsed = ConfigSchema.parse(result.config)
    const [perimeter, single] = parsed.views
    // Row-major index i of a 3-wide grid sits at (i % 3, floor(i / 3)), every cell 1×1.
    expect(perimeter?.cells.map((c) => [c.col, c.row, c.colSpan, c.rowSpan])).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
    ])
    // Cameras and every cell setting stay with the cell they were on.
    expect(perimeter?.cells[0]).toMatchObject({ cameraIds: ['camA'], quality: 'high' })
    expect(perimeter?.cells[1]).toMatchObject({
      cameraIds: ['camB', 'camC'],
      rotateIntervalSec: 10,
      motionSwitch: true,
      motionTriggers: ['motion'],
      motionHoldSec: 20,
    })
    expect(perimeter?.cells[5]?.cameraIds).toEqual(['camE:package'])
    // View fields survive; the new ones take the schema's defaults.
    expect(perimeter).toMatchObject({
      fit: 'cover',
      gridQuality: 'medium',
      aspect: { w: 16, h: 9 },
      gap: 0,
    })
    expect(single?.cells).toEqual([
      expect.objectContaining({ col: 0, row: 0, cameraIds: ['camE'] }),
    ])
    // Everything outside the Views is untouched; a field added since v1 takes its default (CON-4's
    // `connectOnLaunch`, which needs no migration step of its own).
    expect(parsed.console).toEqual({ ...V1_FIXTURE.console, connectOnLaunch: false })
    expect(parsed.doorLinks).toEqual(V1_FIXTURE.doorLinks)
    expect(parsed.lastViewId).toBe('view-single')
  })

  it('does not mutate the input', () => {
    const copy = structuredClone(V1_FIXTURE)
    migrateConfig(copy)
    expect(copy).toEqual(V1_FIXTURE)
  })

  it('never throws on malformed raw JSON, and leaves what it cannot read for the schema', () => {
    const weird = [
      { schemaVersion: 1, views: 'not an array' },
      { schemaVersion: 1, views: [null, 7, 'view', []] },
      { schemaVersion: 1, views: [{ id: 'a', cells: [{ cameraIds: [] }] }] },
      { schemaVersion: 1, views: [{ id: 'a', cols: 'two', cells: [{}] }] },
      { schemaVersion: 1, views: [{ id: 'a', cols: 0, cells: [{}] }] },
      { schemaVersion: 1, views: [{ id: 'a', cols: 2, cells: 'nope' }] },
      { schemaVersion: 1, views: [{ id: 'a', cols: 2, rows: 1, cells: [null, 5] }] },
    ]
    for (const raw of weird) {
      const result = migrateConfig(raw)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      // Everything the step could not read is passed through untouched...
      expect(result.config).toEqual({ ...raw, schemaVersion: 2 })
      // ...and the schema is what refuses it.
      expect(ConfigSchema.safeParse(result.config).success).toBe(false)
    }
  })

  it('overwrites a placement already in the file with the row-major 1×1 one v1 meant', () => {
    // v1 had no placement fields, so these are a partial hand edit: kept, the 2×1 first cell would
    // overlap the second and the whole config would be moved aside.
    const result = migrateConfig({
      schemaVersion: 1,
      views: [
        {
          id: 'a',
          name: 'A',
          cols: 2,
          rows: 2,
          cells: [
            { col: 0, row: 0, colSpan: 2, cameraIds: ['camA'] },
            { row: 1 },
            { col: 1, rowSpan: 3 },
            {},
          ],
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = ConfigSchema.parse(result.config)
    expect(parsed.views[0]?.cells.map((c) => [c.col, c.row, c.colSpan, c.rowSpan])).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
    ])
    // Everything else in the cell is kept.
    expect(parsed.views[0]?.cells[0]?.cameraIds).toEqual(['camA'])
  })

  it('migrates a v1 file with no views at all', () => {
    const result = migrateConfig({ schemaVersion: 1 })
    expect(result.ok && ConfigSchema.parse(result.config)).toEqual(defaultConfig())
  })
})

describe('migrateConfig', () => {
  it('applies one step and validates against the current schema', () => {
    // The synthetic 0 -> 1 chains into the real 1 -> 2, so this also proves a synthetic and a real
    // step compose.
    const result = migrateConfig({ schemaVersion: 0, cols: 2, rows: 2 }, [zeroToOne, ...MIGRATIONS])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 2, applied: [1, 2] })
    const parsed = ConfigSchema.parse(result.config)
    expect(parsed.views).toHaveLength(1)
    expect(parsed.views[0]?.cells).toHaveLength(4)
    expect(parsed.lastViewId).toBe('migrated')
  })

  it('applies steps in sequence up to the target version', () => {
    const result = migrateConfig({ schemaVersion: 0, cols: 1, rows: 1 }, [zeroToOne, oneToTwo], 2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 2, applied: [1, 2] })
    expect(result.config.schemaVersion).toBe(2)
    expect(result.config.ui).toEqual({ overlayAutoHideSec: 5 })
  })

  it('stamps schemaVersion itself, so a step cannot forget to', () => {
    const forgetful: MigrationStep = { from: 0, to: 1, migrate: (config) => ({ ...config }) }
    const result = migrateConfig({ schemaVersion: 0 }, [forgetful], 1)
    expect(result.ok && result.config.schemaVersion).toBe(1)
  })

  it('gives each step a private copy, so the caller’s object is never mutated', () => {
    const original = { schemaVersion: 0, views: [{ id: 'old' }] }
    const destructive: MigrationStep = {
      from: 0,
      to: 1,
      migrate: (config) => {
        delete config.views
        config.touched = true
        return config
      },
    }
    const result = migrateConfig(original, [destructive], 1)
    expect(result.ok && result.config).toMatchObject({ schemaVersion: 1, touched: true })
    expect(original).toEqual({ schemaVersion: 0, views: [{ id: 'old' }] })
  })

  it('refuses a newer version instead of downgrading it (data loss)', () => {
    const result = migrateConfig({ schemaVersion: 3, somethingNew: true })
    expect(result).toMatchObject({ ok: false, reason: 'newer-version' })
    if (!result.ok) {
      expect(result.message).toContain('schemaVersion 3')
      expect(result.message).toContain('this build knows 2')
    }
    // Also when the chain could technically reach it: a step is not a licence to go backwards.
    expect(migrateConfig({ schemaVersion: 3 }, [zeroToOne, oneToTwo], 2)).toMatchObject({
      ok: false,
      reason: 'newer-version',
    })
  })

  it('rejects a missing or nonsensical schemaVersion', () => {
    for (const raw of [{}, { schemaVersion: '1' }, { schemaVersion: 1.5 }, { schemaVersion: -1 }]) {
      expect(migrateConfig(raw)).toMatchObject({ ok: false, reason: 'invalid-version' })
    }
    const result = migrateConfig({ schemaVersion: null })
    expect(result.ok ? '' : result.message).toContain('null')
  })

  it('rejects anything that is not a JSON object', () => {
    for (const raw of [null, undefined, 'config', 7, [], [{ schemaVersion: 1 }]]) {
      expect(migrateConfig(raw)).toMatchObject({ ok: false, reason: 'not-an-object' })
    }
  })

  it('reports a gap in the chain rather than skipping a step', () => {
    expect(migrateConfig({ schemaVersion: 0 }, [oneToTwo], 2)).toMatchObject({
      ok: false,
      reason: 'no-migration-path',
    })
  })

  it('refuses a step that does not move forwards (it would loop)', () => {
    const stuck: MigrationStep = { from: 0, to: 0, migrate: (config) => config }
    expect(migrateConfig({ schemaVersion: 0 }, [stuck], 1)).toMatchObject({
      ok: false,
      reason: 'no-migration-path',
    })
  })
})
