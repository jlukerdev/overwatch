// P1.1: the schemaVersion migration chain (src/main/config/migrations.ts). Version 1 is the first
// shipped version, so the real chain is empty; these tests drive the mechanism with synthetic
// version-0 and version-2 steps, so the first real migration only has to add a step.
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

  it('has nothing to migrate from version 0 today', () => {
    expect(migrateConfig({ schemaVersion: 0 })).toEqual({
      ok: false,
      reason: 'no-migration-path',
      message: 'no migration from schemaVersion 0 towards 1',
    })
  })
})

describe('migrateConfig', () => {
  it('applies one step and validates against the current schema', () => {
    const result = migrateConfig({ schemaVersion: 0, cols: 2, rows: 2 }, [zeroToOne])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 1, applied: [1] })
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
    const result = migrateConfig({ schemaVersion: 0 }, [forgetful])
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
    const result = migrateConfig(original, [destructive])
    expect(result.ok && result.config).toMatchObject({ schemaVersion: 1, touched: true })
    expect(original).toEqual({ schemaVersion: 0, views: [{ id: 'old' }] })
  })

  it('refuses a newer version instead of downgrading it (data loss)', () => {
    const result = migrateConfig({ schemaVersion: 2, somethingNew: true })
    expect(result).toMatchObject({ ok: false, reason: 'newer-version' })
    if (!result.ok) {
      expect(result.message).toContain('schemaVersion 2')
      expect(result.message).toContain('this build knows 1')
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
    expect(migrateConfig({ schemaVersion: 0 }, [stuck])).toMatchObject({
      ok: false,
      reason: 'no-migration-path',
    })
  })
})
