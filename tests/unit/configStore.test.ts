// P1.1: the config.json store (src/main/config/store.ts) — the first-run path, the atomic write
// (VIEW-6), serialized saves, and the recovery path for a corrupt, schema-invalid or
// newer-than-known file. Real temp directories; no Electron and no mocks.
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfigStore, CONFIG_FILE_NAME } from '../../src/main/config/store'
import { defaultConfig, type Config } from '../../src/main/config/schema'

const onPosix = process.platform !== 'win32'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'view-protect-config-'))
})

afterEach(async () => {
  if (onPosix) await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

function store(): ReturnType<typeof createConfigStore> {
  return createConfigStore({ dir })
}

/** A config with one 2x2 View, so a round trip has something to lose. */
function configWithView(lastViewId = 'v1'): Config {
  const base = defaultConfig()
  return {
    ...base,
    console: { ...base.console, host: '192.0.2.10' },
    views: [
      {
        id: 'v1',
        name: 'Perimeter',
        cols: 2,
        rows: 2,
        fit: 'contain',
        aspect: { w: 16, h: 9 },
        gap: 0,
        gridQuality: null,
        fillQuality: 'high',
        showNames: true,
        cells: Array.from({ length: 4 }, (_, i) => ({
          col: i % 2,
          row: Math.floor(i / 2),
          colSpan: 1,
          rowSpan: 1,
          cameraIds: ['camA'],
          quality: null,
          motionSwitch: false,
          motionTriggers: ['motion' as const],
          motionHoldSec: 15,
        })),
      },
    ],
    lastViewId,
  }
}

async function entries(): Promise<string[]> {
  return (await readdir(dir)).sort()
}

describe('load', () => {
  it('returns defaults and writes nothing when there is no file (first run)', async () => {
    const result = await store().load()
    expect(result).toEqual({ source: 'defaults', config: defaultConfig() })
    expect(await entries()).toEqual([])
  })

  it('exposes the config.json path', () => {
    expect(store().path).toBe(join(dir, CONFIG_FILE_NAME))
  })

  it('round-trips a saved config', async () => {
    const saved = configWithView()
    await store().save(saved)
    const result = await store().load()
    expect(result).toEqual({ source: 'file', config: saved, migratedFrom: null })
  })

  it('fills in defaults for a partial file written by hand', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), '{ "schemaVersion": 2 }')
    const result = await store().load()
    expect(result).toEqual({ source: 'file', config: defaultConfig(), migratedFrom: null })
  })
  it('loads a file with a hand-edited polling interval that is out of range, without recovery (P5.6)', async () => {
    // One bad number must not cost the user every View: the file loads, that interval is its
    // default, and nothing is moved aside.
    await writeFile(
      join(dir, CONFIG_FILE_NAME),
      JSON.stringify({
        schemaVersion: 2,
        accessPolling: { withSocketSec: 0, withoutSocketSec: 4, unlockedSec: 99, detailsSec: 45 },
      }),
    )
    const result = await store().load()
    expect(result.source).toBe('file')
    expect(result.config.accessPolling).toEqual({
      withSocketSec: 5,
      withoutSocketSec: 4,
      unlockedSec: 1,
      detailsSec: 45,
    })
    expect(await entries()).toEqual([CONFIG_FILE_NAME])
  })

  it('migrates a v1 file to the current version with the polling defaults (P5.6: no new step)', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ schemaVersion: 1, views: [] }))
    const result = await store().load()
    expect(result).toMatchObject({ source: 'file', migratedFrom: 1 })
    expect(result.config.accessPolling).toEqual({
      withSocketSec: 5,
      withoutSocketSec: 2,
      unlockedSec: 1,
      detailsSec: 30,
    })
  })

  it('migrates a v1 file on load (P3.1: cells gain their placement)', async () => {
    await writeFile(
      join(dir, CONFIG_FILE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        views: [{ id: 'v1', name: 'n', cols: 2, rows: 1, cells: [{ cameraIds: ['camA'] }, {}] }],
      }),
    )
    const result = await store().load()
    expect(result).toMatchObject({ source: 'file', migratedFrom: 1 })
    if (result.source !== 'file') return
    expect(result.config.schemaVersion).toBe(2)
    expect(result.config.views[0]?.cells).toMatchObject([
      { col: 0, row: 0, colSpan: 1, rowSpan: 1, cameraIds: ['camA'] },
      { col: 1, row: 0, colSpan: 1, rowSpan: 1, cameraIds: [] },
    ])
  })
})

describe('save', () => {
  it('writes readable 2-space JSON with a trailing newline', async () => {
    await store().save(configWithView())
    const text = await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "schemaVersion": 2,')
    expect(text).toContain('\n      "cells": [')
  })

  it('leaves no temp file behind', async () => {
    await store().save(defaultConfig())
    await store().save(configWithView())
    expect(await entries()).toEqual([CONFIG_FILE_NAME])
  })

  it('creates the directory if it is missing', async () => {
    const nested = createConfigStore({ dir: join(dir, 'a', 'b') })
    await nested.save(defaultConfig())
    expect(await readFile(join(dir, 'a', 'b', CONFIG_FILE_NAME), 'utf8')).toContain('schemaVersion')
  })

  it('validates before writing, so an invalid config cannot replace a good file', async () => {
    const good = configWithView()
    await store().save(good)
    const view = good.views.at(0)
    if (!view) throw new Error('expected a view')
    // The cells no longer tile the grid (SPEC §6).
    const broken: Config = { ...good, views: [{ ...view, cells: [] }] }
    await expect(store().save(broken)).rejects.toThrow()
    expect((await store().load()).config).toEqual(good)
  })

  it('serializes overlapping saves and keeps the file parseable throughout (VIEW-6)', async () => {
    const s = store()
    await s.save(configWithView('v1'))

    const reads: unknown[] = []
    // An object, not a `let`: the flag is mutated from another task, which narrowing cannot see.
    const poll = { on: true }
    const reader = (async () => {
      while (poll.on) {
        const text = await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')
        // An atomic rename means every read sees one complete version, never a truncation.
        const seen: unknown = JSON.parse(text)
        reads.push(seen)
      }
    })()

    const ids = Array.from({ length: 20 }, (_unused, i) => `v${String(i)}`)
    await Promise.all(ids.map((id) => s.save(configWithView(id))))
    poll.on = false
    await reader

    expect(reads.length).toBeGreaterThan(0)
    // FIFO: the last save enqueued is the one left on disk.
    expect((await s.load()).config.lastViewId).toBe(ids.at(-1))
    expect(await entries()).toEqual([CONFIG_FILE_NAME])
  })

  it.skipIf(!onPosix)('leaves the previous file intact when the write fails', async () => {
    const s = store()
    const good = configWithView()
    await s.save(good)
    await chmod(dir, 0o500)
    await expect(s.save(configWithView('v2'))).rejects.toThrow()
    await chmod(dir, 0o700)
    expect(await entries()).toEqual([CONFIG_FILE_NAME])
    expect((await s.load()).config).toEqual(good)
  })
})

describe('update (the read-modify-write every writer in main uses, VIEW-6)', () => {
  it('refuses to run before load(), since there is nothing to modify yet', async () => {
    await expect(store().update((latest) => latest)).rejects.toThrow(/before load/)
    expect(await entries()).toEqual([])
  })

  it('starts from what load() returned and writes the result', async () => {
    await store().save(configWithView('v1'))
    const s = store()
    await s.load()
    const written = await s.update((latest) => ({ ...latest, lastViewId: null }))
    expect(written.views.map((v) => v.id)).toEqual(['v1'])
    expect((await store().load()).config).toEqual(written)
  })

  it('gives each overlapping update the result of the one queued before it', async () => {
    const s = store()
    await s.load()
    // Neither call carries the other's field: each changes only its own, so both must survive.
    await Promise.all([
      s.update((latest) => ({ ...latest, console: { ...latest.console, host: 'udm.local' } })),
      s.update((latest) => ({ ...latest, views: configWithView().views })),
    ])
    const { config } = await store().load()
    expect(config.console.host).toBe('udm.local')
    expect(config.views.map((v) => v.id)).toEqual(['v1'])
  })

  it('starts from the last save too, not only the last update', async () => {
    const s = store()
    await s.load()
    await s.save(configWithView('v1'))
    const written = await s.update((latest) => latest)
    expect(written.views.map((v) => v.id)).toEqual(['v1'])
  })

  it('rejects an invalid result without writing it, and the next update starts from the file', async () => {
    const s = store()
    await s.load()
    await s.update((latest) => ({ ...latest, lastViewId: 'kept' }))
    // Edits its argument in place before failing validation: the copy keeps that from leaking.
    await expect(
      s.update((latest) => {
        latest.lastViewId = 'leaked'
        return { ...latest, schemaVersion: 99 } as unknown as Config
      }),
    ).rejects.toThrow()
    expect((await store().load()).config.lastViewId).toBe('kept')
    expect((await s.update((latest) => latest)).lastViewId).toBe('kept')
  })
})

describe('recovery', () => {
  async function loadBad(contents: string): Promise<{
    problem: string
    backupPath: string | null
    config: Config
  }> {
    await writeFile(join(dir, CONFIG_FILE_NAME), contents)
    const result = await store().load()
    expect(result.source).toBe('recovered')
    if (result.source !== 'recovered') throw new Error('unreachable')
    return { ...result.recovery, config: result.config }
  }

  it('keeps an unparseable file aside and carries on with defaults', async () => {
    const contents = '{ "schemaVersion": 1, "views": [ '
    const { problem, backupPath, config } = await loadBad(contents)
    expect(config).toEqual(defaultConfig())
    expect(problem).toContain('not valid JSON')
    expect(backupPath).not.toBeNull()
    if (backupPath === null) return
    // The user's bytes survive untouched, and config.json is gone so the next save is clean.
    expect(await readFile(backupPath, 'utf8')).toBe(contents)
    expect(await entries()).toEqual([basename(backupPath)])
    expect(backupPath).toMatch(/config\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
    // No colons: they are illegal in Windows filenames (NFR-1).
    expect(basename(backupPath)).not.toContain(':')
  })

  it('recovers a file that parses but does not match the schema', async () => {
    const { problem } = await loadBad(
      JSON.stringify({
        schemaVersion: 2,
        views: [{ id: 'v1', name: 'n', cols: 2, rows: 2, cells: [] }],
      }),
    )
    expect(problem).toContain('does not match the schema')
    expect(problem).toContain('is not covered by any cell')
  })

  it('refuses a config from a newer build instead of stripping its fields', async () => {
    const { problem, backupPath, config } = await loadBad(
      JSON.stringify({ schemaVersion: 99, views: [], somethingNew: true }),
    )
    expect(problem).toContain('newer version of OverWatch')
    expect(config).toEqual(defaultConfig())
    if (backupPath !== null) {
      expect(JSON.parse(await readFile(backupPath, 'utf8'))).toMatchObject({ somethingNew: true })
    }
  })

  it('recovers a version it has no migration for', async () => {
    const { problem } = await loadBad(JSON.stringify({ schemaVersion: 0 }))
    expect(problem).toContain('no migration from schemaVersion 0')
  })

  it('never overwrites an earlier backup', async () => {
    await loadBad('nope')
    await loadBad('nope either')
    const backups = (await entries()).filter((name) => name.includes('.corrupt-'))
    expect(backups).toHaveLength(2)
  })

  it('is followed by a working save', async () => {
    await loadBad('{')
    const s = store()
    await s.save(configWithView())
    expect((await s.load()).config).toEqual(configWithView())
  })

  it.skipIf(!onPosix)('reports when the file cannot even be moved aside', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), 'not json')
    await chmod(dir, 0o500)
    const result = await store().load()
    await chmod(dir, 0o700)
    expect(result.source).toBe('recovered')
    if (result.source !== 'recovered') return
    expect(result.recovery.backupPath).toBeNull()
    expect(result.recovery.problem).toContain('could not be moved aside')
    // Still there: nothing was thrown away.
    expect(await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe('not json')
  })
})

describe('a config from a newer build is kept apart from a corrupt one', () => {
  it('names the backup for what it is, so the newer build can find it again', async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ schemaVersion: 99, views: [] }))
    const result = await store().load()
    expect(result.source).toBe('recovered')
    if (result.source !== 'recovered') throw new Error('unreachable')
    const { backupPath } = result.recovery
    expect(backupPath).not.toBeNull()
    if (backupPath === null) return
    // Not `.corrupt-`: the file is undamaged, this build just cannot read it. A user who downgrades
    // and upgrades again should be able to tell which backup holds their Views (VIEW-6).
    expect(basename(backupPath)).toMatch(/^config\.newer-schema-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
  })
})
