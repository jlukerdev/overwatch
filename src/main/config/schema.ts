// The persisted config file, `<userData>/config.json` (SPEC §6): the `schemaVersion` envelope
// around the shared domain model, plus the defaults a fresh install starts from. Validated on every
// load (after migrations) and again before every save, so a malformed object never reaches the disk.
//
// The schemas for what is *inside* the file live in @shared/models, because the renderer needs the
// same definitions (View editor, Settings, IPC validation) and `src/shared` cannot import from
// `src/main`. This file owns only what is specific to storage: the version, the whole-document
// schema and `defaultConfig()`.
//
// **No secrets here** (CON-2, NFR-9): the API key and the Access token live in `secrets.bin`,
// encrypted with safeStorage (src/main/secrets/secrets.ts). config.json is plain, readable JSON.
import { SettingsSchema } from '@shared/models'
import { z } from 'zod'

/**
 * Version this build writes and understands. Bump it together with a step in migrations.ts.
 *
 *  - **1** (P1.1): uniform grids, `cells` row-major with `cells.length === cols * rows`.
 *  - **2** (P3.1): cells carry their own placement (`col`, `row`, `colSpan`, `rowSpan`) and may
 *    span several slots; Views gain `aspect` and `gap` (VIEW-1, VIEW-5).
 */
export const CONFIG_SCHEMA_VERSION = 2

/**
 * The whole file (SPEC §6).
 *
 * `schemaVersion` is a literal, not a range: migrations.ts brings an older file up to this version
 * before this schema sees it, and refuses a newer one outright. It is spread first so it stays the
 * first key in the written JSON, as in SPEC §6.
 */
export const ConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  ...SettingsSchema.shape,
})
export type Config = z.infer<typeof ConfigSchema>

/**
 * A fresh config: every default from the schemas, nothing else. Built by parsing the minimum input,
 * so the defaults have exactly one home (the schemas) and each call gets its own object.
 */
export function defaultConfig(): Config {
  return ConfigSchema.parse({ schemaVersion: CONFIG_SCHEMA_VERSION })
}
