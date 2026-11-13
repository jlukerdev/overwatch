// Shared domain model: the Views, cells and settings of SPEC §6, as zod schemas plus the types
// inferred from them (one definition, never a hand-written twin).
//
// The renderer imports this, so there are **no Node and no Electron imports** — only zod, which the
// renderer already needs to validate IPC payloads (CLAUDE.md). It also may not import from
// `src/main/` at all: `tsconfig.web.json` lists `src/shared/**` and the renderer bundle must not
// reach into main. That is why these schemas live here and not in `src/main/config/schema.ts`,
// which composes them into the persisted file (the `schemaVersion` envelope, defaults, migrations).
//
// Quality types live in ./quality (QUAL preamble) — import them from there.
//
// `Camera`, `Door` and `ProtectEvent` are **not** here yet: they come from the API clients, not from
// the config. P1.3 adds `Camera`/`ProtectEvent` (trimmed from the generated Protect types) and P1.4
// adds `Door` (from src/main/access/types.ts), per docs/DEV_PLAN.md.
//
// Two rules shape how strict this is:
//  1. **Defaults everywhere sensible**, so a partial or hand-edited file still loads.
//  2. **Unknown keys are stripped, not rejected** (zod's default for objects). A rejected config is
//     moved aside and replaced by defaults (config/store.ts), which costs the user every View, so
//     needless strictness is a VIEW-6 hazard.
import { z } from 'zod'
import { QualitySchema } from './quality'

/** Largest layout preset, so a custom layout cannot exceed 4×4 either (VIEW-1). */
export const MAX_GRID_DIMENSION = 4

/** CELL-2: a rotation faster than 5 s is not allowed. */
export const MIN_ROTATE_INTERVAL_SEC = 5

/** CELL-2. */
export const DEFAULT_MOTION_HOLD_SEC = 15

/** CELL-4: overlay controls auto-hide after 3 s of no mouse movement. */
export const DEFAULT_OVERLAY_AUTO_HIDE_SEC = 3

/** VIEW-5: each cell keeps the camera's aspect ratio; `cover` crops instead of letterboxing. */
export const FitSchema = z.enum(['contain', 'cover'])
export type Fit = z.infer<typeof FitSchema>

/**
 * Event types that flip a multi-camera cell (CELL-2). `smartDetect` covers `smartDetectZone`,
 * `smartDetectLine` and `smartDetectLoiterZone`; mapping Protect's event types onto these belongs
 * with the event plumbing (P1.3/P4.1), not here.
 */
export const MOTION_TRIGGERS = ['motion', 'smartDetect', 'ring'] as const
export const MotionTriggerSchema = z.enum(MOTION_TRIGGERS)
export type MotionTrigger = z.infer<typeof MotionTriggerSchema>

/** CELL-2: all three unless the user narrows them. */
export const DEFAULT_MOTION_TRIGGERS: readonly MotionTrigger[] = MOTION_TRIGGERS

/**
 * `null` = inherit from the next level up (QUAL-2/3). It stays distinct from an absent key *on
 * input*: an absent key parses to an explicit `null`, so every consumer sees `Quality | null` and
 * nobody has to tell `undefined` from `null`.
 */
const InheritedQualitySchema = QualitySchema.nullable().default(null)

/**
 * One grid slot. Zero or more cameras (VIEW-2); several make it a multi-camera cell (CELL-2).
 *
 * `cameraIds` entries are Protect camera ids, or `<cameraId>:package` for a doorbell's package
 * channel (CAM-4), so they are plain non-empty strings here.
 */
export const CellSchema = z.object({
  cameraIds: z.array(z.string().min(1)).default(() => []),
  /** Overrides the View's grid quality for this cell (QUAL-3). */
  quality: InheritedQualitySchema,
  /** Absent = no rotation. CELL-2 floors it at 5 s. */
  rotateIntervalSec: z.int().min(MIN_ROTATE_INTERVAL_SEC).optional(),
  motionSwitch: z.boolean().default(false),
  motionTriggers: z.array(MotionTriggerSchema).default(() => [...DEFAULT_MOTION_TRIGGERS]),
  /**
   * Optional smart-detection filter, e.g. `["person", "vehicle"]`. Deliberately **not** an enum:
   * Protect's list (`person, vehicle, package, licensePlate, face, animal`) comes from the camera's
   * `featureFlags.smartDetectTypes` at runtime and a console upgrade can add to it (SPEC R8). An
   * enum here would turn a new Protect type into a rejected config, i.e. lost Views (VIEW-6).
   */
  smartDetectTypes: z.array(z.string().min(1)).optional(),
  /** Hold after the event's `end` timestamp before rotation resumes (CELL-2). */
  motionHoldSec: z.int().min(0).default(DEFAULT_MOTION_HOLD_SEC),
})
export type Cell = z.infer<typeof CellSchema>

/**
 * A named grid View (VIEW-1/2/5). `cells` is row-major and must be exactly `cols * rows` long
 * (SPEC §6) — the grid is uniform in the prototype, so a short or long array is a bug, not a layout.
 */
export const ViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    cols: z.int().min(1).max(MAX_GRID_DIMENSION),
    rows: z.int().min(1).max(MAX_GRID_DIMENSION),
    fit: FitSchema.default('contain'),
    /** Overrides `streams.defaultGridQuality` for every cell in this View (QUAL-2). */
    gridQuality: InheritedQualitySchema,
    /** Overrides `streams.defaultFillQuality` in fill mode (QUAL-5). */
    fillQuality: InheritedQualitySchema,
    cells: z.array(CellSchema),
  })
  // Runs only once the fields above are valid, so cols/rows are real numbers here.
  .check((ctx) => {
    const { cols, rows, cells } = ctx.value
    const expected = cols * rows
    if (cells.length !== expected) {
      ctx.issues.push({
        code: 'custom',
        input: cells,
        path: ['cells'],
        message:
          `cells.length must be cols * rows (${String(cols)} * ${String(rows)} = ` +
          `${String(expected)}), got ${String(cells.length)}`,
      })
    }
  })
export type View = z.infer<typeof ViewSchema>

/**
 * Console connection (CON-1/3, DOOR-0). `host` is empty until the user enters it (CON-1). **No
 * secrets**: the API key and the Access token live in secrets.bin, encrypted (CON-2, NFR-9).
 *
 * The two fingerprints are separate on purpose: **TLS pinning is per host:port** (P0.4 §4, SPEC
 * §5.2), and the Access developer API answers on 12445 while Protect is behind 443, so one pin
 * cannot cover both. Their format is P1.2's business (`src/main/tls/`), so they are only checked for
 * being non-empty strings here.
 */
export const ConsoleConfigSchema = z
  .object({
    host: z.string().default(''),
    certFingerprint: z.string().min(1).nullable().default(null),
    /** DOOR-0: off by default. While off the app makes no Access API calls at all. */
    accessEnabled: z.boolean().default(false),
    /** `null` = derive `https://<host>:12445` (DOOR-0). Set for the dev mock (SPEC §5.2). */
    accessBaseUrl: z.url().nullable().default(null),
    /** Pin for `accessBaseUrl`'s host:port. Added after P0.4 §4; see the note in SPEC §6. */
    accessCertFingerprint: z.string().min(1).nullable().default(null),
  })
  .prefault({})
export type ConsoleConfig = z.infer<typeof ConsoleConfigSchema>

/** `{ "<cameraId>": "<accessDoorId>" }`, kept even while Access is disabled (DOOR-0/2). */
export const DoorLinksSchema = z.record(z.string().min(1), z.string().min(1)).default(() => ({}))
export type DoorLinks = z.infer<typeof DoorLinksSchema>

/** QUAL-1: the two app-wide quality defaults. Low for the grid, high for one filled camera. */
export const StreamsConfigSchema = z
  .object({
    defaultGridQuality: QualitySchema.default('low'),
    defaultFillQuality: QualitySchema.default('high'),
  })
  .prefault({})
export type StreamsConfig = z.infer<typeof StreamsConfigSchema>

export const UiConfigSchema = z
  .object({
    overlayAutoHideSec: z.number().positive().default(DEFAULT_OVERLAY_AUTO_HIDE_SEC),
  })
  .prefault({})
export type UiConfig = z.infer<typeof UiConfigSchema>

/**
 * Everything the app persists apart from `schemaVersion`, which is a storage detail
 * (src/main/config/schema.ts adds it). This is the shape that crosses IPC to the renderer (P1.5).
 *
 * `lastViewId` is **not** checked against `views[]`. A dangling id is a normal state (the View was
 * deleted elsewhere) and the View switcher falls back to the first View (VIEW-6); rejecting the
 * whole config over it would cost every View.
 */
export const SettingsSchema = z.object({
  console: ConsoleConfigSchema,
  doorLinks: DoorLinksSchema,
  views: z.array(ViewSchema).default(() => []),
  lastViewId: z.string().min(1).nullable().default(null),
  streams: StreamsConfigSchema,
  ui: UiConfigSchema,
})
export type Settings = z.infer<typeof SettingsSchema>
