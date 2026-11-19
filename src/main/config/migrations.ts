// `schemaVersion` migrations for config.json (SPEC §6). Runs on the raw parsed JSON, before the zod
// schema sees it, and hands the result to `ConfigSchema` for validation (store.ts).
//
// The chain is an ordered list of one-step migrations, so adding a version is mechanical: append
// `{ from: n, to: n + 1, migrate }`, bump `CONFIG_SCHEMA_VERSION`, add a fixture test. A step only
// moves data — the chain stamps `schemaVersion` itself, so a step cannot forget to.
//
// A step works on **raw JSON** that nothing has validated yet, so it is written defensively: it
// rewrites what it recognises and leaves everything else exactly as it found it, never throws, and
// leaves judging the result to `ConfigSchema`. A step that threw on a malformed View would turn one
// bad entry into a load failure, and the store would replace the whole file with defaults (VIEW-6).
//
// A **newer** file than this build knows is refused rather than parsed. Stripping the fields a later
// version added and writing the result back is a silent, permanent downgrade of the user's data, so
// store.ts treats this like a corrupt file: the file is moved aside and defaults are used (VIEW-6).
import { CONFIG_SCHEMA_VERSION } from './schema'

/** Raw config JSON, before validation. */
export type ConfigRecord = Record<string, unknown>

export interface MigrationStep {
  /** `schemaVersion` this step reads. */
  readonly from: number
  /** `schemaVersion` it produces. Must be greater than `from`. */
  readonly to: number
  /** Moves the data. Gets a private copy it may mutate; `schemaVersion` is stamped by the chain. */
  readonly migrate: (config: ConfigRecord) => ConfigRecord
}

/**
 * 1 → 2 (P3.1, VIEW-1): cells gain an explicit placement so they can span several slots.
 *
 * A v1 View is a uniform grid with `cells` in row-major order, so cell `i` sits at
 * `col = i % cols`, `row = floor(i / cols)` and spans 1×1 — the same layout, now written down. The
 * new View fields (`aspect`, `gap`) are left to the schema's defaults rather than written here, so
 * their default has one home.
 *
 * The placement is **always** assigned, overwriting any `col`/`row`/`colSpan`/`rowSpan` a cell
 * already carries. v1 never had those fields, so one in a v1 file is a hand edit made ahead of
 * time; keeping it can only produce an overlap with the cells placed around it, which fails the
 * schema and gets the whole config moved aside (VIEW-6). Row-major 1×1 is the layout v1 meant.
 *
 * Defensive on raw JSON (see the header): a View that is not an object, has no usable `cols` or no
 * `cells` array, and any cell that is not an object, is passed through untouched. The schema then
 * rejects it with a precise message.
 */
function migrateCellPlacements(config: ConfigRecord): ConfigRecord {
  const { views } = config
  if (!Array.isArray(views)) return config
  return {
    ...config,
    views: views.map((view: unknown) => {
      if (!isConfigRecord(view)) return view
      const { cols, cells } = view
      if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1) return view
      if (!Array.isArray(cells)) return view
      return {
        ...view,
        cells: cells.map((cell: unknown, index) => {
          if (!isConfigRecord(cell)) return cell
          return {
            ...cell,
            // Last, so they replace any placement already in the file (see above).
            col: index % cols,
            row: Math.floor(index / cols),
            colSpan: 1,
            rowSpan: 1,
          }
        }),
      }
    }),
  }
}

/**
 * The real chain, ordered by `from`. Version 1 is the first shipped version, so the chain starts
 * there. `tests/unit/configMigrations.test.ts` also drives the mechanism with synthetic steps, and
 * has a v1 fixture for each real one.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  { from: 1, to: 2, migrate: migrateCellPlacements },
]

export type MigrationFailureReason =
  /** Not a JSON object (array, string, null, …). */
  | 'not-an-object'
  /** `schemaVersion` missing, or not a non-negative integer. */
  | 'invalid-version'
  /** Written by a newer build. Never migrated down — see the header. */
  | 'newer-version'
  /** No step leads from the file's version to this build's. */
  | 'no-migration-path'

export type MigrationResult =
  | {
      readonly ok: true
      readonly config: ConfigRecord
      readonly fromVersion: number
      readonly toVersion: number
      /** Versions produced along the way, in order. Empty when the file was already current. */
      readonly applied: readonly number[]
    }
  | { readonly ok: false; readonly reason: MigrationFailureReason; readonly message: string }

/**
 * Brings `raw` up to `targetVersion`, applying `steps` in sequence.
 *
 * `steps` and `targetVersion` are parameters so the mechanism can be tested with synthetic versions
 * (there is only one real version today). Production callers pass neither.
 */
export function migrateConfig(
  raw: unknown,
  steps: readonly MigrationStep[] = MIGRATIONS,
  targetVersion: number = CONFIG_SCHEMA_VERSION,
): MigrationResult {
  if (!isConfigRecord(raw)) {
    return { ok: false, reason: 'not-an-object', message: 'config is not a JSON object' }
  }

  const fromVersion = raw.schemaVersion
  if (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion) || fromVersion < 0) {
    return {
      ok: false,
      reason: 'invalid-version',
      message: `schemaVersion is missing or not a non-negative integer (got ${describe(fromVersion)})`,
    }
  }

  if (fromVersion > targetVersion) {
    return {
      ok: false,
      reason: 'newer-version',
      message:
        `config was written by a newer version of OverWatch (schemaVersion ${String(fromVersion)}, ` +
        `this build knows ${String(targetVersion)}). Migrating it down would discard its newer fields.`,
    }
  }

  // Private copy: a step may mutate what it is given, and the caller's object must not change.
  let config = structuredClone(raw)
  let version = fromVersion
  const applied: number[] = []

  while (version < targetVersion) {
    const step = steps.find((candidate) => candidate.from === version)
    if (!step) {
      return {
        ok: false,
        reason: 'no-migration-path',
        message: `no migration from schemaVersion ${String(version)} towards ${String(targetVersion)}`,
      }
    }
    if (step.to <= version) {
      // A chain that does not move forwards would loop here.
      return {
        ok: false,
        reason: 'no-migration-path',
        message: `migration step ${String(step.from)} -> ${String(step.to)} does not move forwards`,
      }
    }
    config = { ...step.migrate(config), schemaVersion: step.to }
    version = step.to
    applied.push(version)
  }

  return { ok: true, config, fromVersion, toVersion: version, applied }
}

function isConfigRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Describes an unexpected `schemaVersion` for a message, without inlining a whole object. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object'
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value
}
