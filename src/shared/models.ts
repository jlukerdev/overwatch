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
// The last section of this file is the **runtime** domain: `Camera`, `CameraEvent`,
// `CameraStateChange` (P1.3, trimmed from the generated Protect types) and `Door` (P1.4, trimmed
// from `src/main/access/types.ts`). Those come from the API clients rather than from the config, but
// they live here for the same reason the config schemas do: the renderer needs them and they are
// what crosses IPC (P1.5). Main maps the wire shapes onto them; nothing wire-shaped belongs here.
//
// Two rules shape how strict this is:
//  1. **Defaults everywhere sensible**, so a partial or hand-edited file still loads.
//  2. **Unknown keys are stripped, not rejected** (zod's default for objects). A rejected config is
//     moved aside and replaced by defaults (config/store.ts), which costs the user every View, so
//     needless strictness is a VIEW-6 hazard.
import { z } from 'zod'
import { QualitySchema } from './quality'
import { normalizeCells, tilingIssues } from './viewTiling'

/** Largest layout preset, so a custom layout cannot exceed 4×4 either (VIEW-1). */
export const MAX_GRID_DIMENSION = 4

/**
 * Largest gap between adjacent cells, in CSS px (VIEW-1). Generous for a 4×4 wall on a 4K screen;
 * the cap exists so a hand-edited `gap: 100000` cannot collapse every cell to nothing (the layout
 * math would survive it, the user would see a black window).
 */
export const MAX_GRID_GAP = 64

/**
 * VIEW-5: the shape a 1×1 cell is laid out at. 16:9 because that is what every current Protect
 * camera streams at in landscape, and the Integration API reports **no** camera resolution to read
 * a better default from (SPEC §5.1). A camera of another shape still letterboxes or crops inside its
 * cell through the View's `fit`.
 */
export const DEFAULT_VIEW_ASPECT: { readonly w: number; readonly h: number } = { w: 16, h: 9 }

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
 * One cell of a View: a rectangle of grid slots (VIEW-1) holding zero or more cameras (VIEW-2);
 * several cameras make it a multi-camera cell (CELL-2).
 *
 * **Placement** (`col`, `row`, `colSpan`, `rowSpan`, added in schemaVersion 2): the 0-based top-left
 * slot and how many slots the cell spans, so one camera can take a 2×2 corner of a 3×3 wall.
 * `col`/`row` have no default — there is no sensible guess for where a cell goes, and the v1 → v2
 * migration supplies them for older files. The spans default to 1, so a hand-written unit cell
 * needs only its position. Whether the cells of a View tile its grid is `ViewSchema`'s check, not
 * this one's: a single cell cannot know its neighbours.
 *
 * `cameraIds` entries are Protect camera ids, or `<cameraId>:package` for a doorbell's package
 * channel (CAM-4), so they are plain non-empty strings here.
 */
export const CellSchema = z.object({
  col: z.int().min(0),
  row: z.int().min(0),
  colSpan: z.int().min(1).default(1),
  rowSpan: z.int().min(1).default(1),
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

/** VIEW-5: a width:height ratio, e.g. `{ w: 16, h: 9 }`. Whole numbers, so `4:3` stays `4:3`. */
export const AspectSchema = z.object({
  w: z.int().positive(),
  h: z.int().positive(),
})
export type Aspect = z.infer<typeof AspectSchema>

/**
 * A named grid View (VIEW-1/2/5).
 *
 * The grid is `cols × rows` slots, and `cells` must **tile** it: every cell inside the grid, no two
 * overlapping, every slot covered by exactly one cell (an empty slot is an explicit cell with no
 * cameras). The rules and their messages live in `tilingIssues` (./viewTiling); each issue is
 * reported under `cells[<index>]` when a cell is to blame, so a rejected config names the cell.
 *
 * On a successful parse `cells` comes back in canonical order — by the top-left slot's row, then
 * column (`normalizeCells`). The order has no layout meaning, but keeping one means a cell's index
 * survives a save round trip, which is what the editor addresses cells by.
 *
 * `aspect` and `gap` drive the on-screen layout (`layoutGrid` in ./viewLayout): the grid is scaled
 * and centred in its box so that a 1×1 cell is exactly `aspect`, with `gap` CSS px between
 * adjacent cells and none around the outer edge.
 */
export const ViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    cols: z.int().min(1).max(MAX_GRID_DIMENSION),
    rows: z.int().min(1).max(MAX_GRID_DIMENSION),
    fit: FitSchema.default('contain'),
    /** Shape of a 1×1 cell (VIEW-5). See {@link DEFAULT_VIEW_ASPECT} for why 16:9. */
    aspect: AspectSchema.default(() => ({ ...DEFAULT_VIEW_ASPECT })),
    /** CSS px between adjacent cells, never around the outside (VIEW-1). */
    gap: z.int().min(0).max(MAX_GRID_GAP).default(0),
    /** Overrides `streams.defaultGridQuality` for every cell in this View (QUAL-2). */
    gridQuality: InheritedQualitySchema,
    /** Overrides `streams.defaultFillQuality` in fill mode (QUAL-5). */
    fillQuality: InheritedQualitySchema,
    /**
     * Whether the cells draw their camera's name over the picture (VIEW-8), in the grid and in fill.
     * Shown by default. Optional with a default, so a file written before it existed (P4.3) parses
     * as "shown" and needs no `schemaVersion` bump or migration, like `gridQuality` / `fillQuality`.
     */
    showNames: z.boolean().default(true),
    cells: z.array(CellSchema),
  })
  // Runs only once the fields above are valid, so cols/rows and every placement are whole numbers.
  .check((ctx) => {
    for (const issue of tilingIssues(ctx.value)) {
      ctx.issues.push({
        code: 'custom',
        input: issue.cellIndex === null ? ctx.value.cells : ctx.value.cells[issue.cellIndex],
        path: issue.cellIndex === null ? ['cells'] : ['cells', issue.cellIndex],
        message: issue.message,
      })
    }
  })
  // `overwrite`, not `transform`: the output type stays `View`, so the schema can still be composed
  // and its input/output types do not split. zod may run it on a View that failed the tiling check
  // too, which is harmless: it only reorders, and that parse fails anyway.
  .overwrite((view) => ({ ...view, cells: normalizeCells(view.cells) }))
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
    /**
     * CON-4's launch exception: `true` once a connect has worked (the devices feed reached `open`),
     * back to `false` when the user clears or replaces the Protect key or moves the Protect
     * endpoint. Main alone writes it (src/main/connection.ts) — it is not in `ConsoleInput`, so a
     * Settings save cannot set it. Defaulted, so a file written before it existed loads as `false`
     * with no schemaVersion bump: such a user has simply not connected under this rule yet.
     */
    connectOnLaunch: z.boolean().default(false),
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

// -------------------------------------------------------------------------------------------------
// Runtime domain: what the API clients produce and what crosses IPC (P1.5)
//
// These are **trimmed** shapes, not the wire shapes. The wire shapes are the generated Protect types
// (`src/main/protect/generated.ts`, via `protect/types.ts`) and the Access schemas
// (`src/main/access/types.ts`); main maps those onto the schemas below. Two reasons for the split:
// the renderer must never see a field it has no business with (an RTSPS URL, CON-2/NFR-9), and the
// clients parse leniently (SPEC R8/R11) so that one new or changed field from a console upgrade
// cannot empty the camera list.
//
// Leniency rule, same as `Cell.smartDetectTypes` above: a value Protect may extend is a string, not
// an enum. An enum would turn a console upgrade into a dropped camera or a rejected event.

/** `camera.state` values the contract defines today (SPEC §5.1). Not an enum: see above. */
export const CAMERA_STATES = ['CONNECTED', 'CONNECTING', 'DISCONNECTED'] as const
export type KnownCameraState = (typeof CAMERA_STATES)[number]

/** The one state that means "streaming works" (CAM-3). Everything else shows the cell as offline. */
export const CAMERA_STATE_CONNECTED = 'CONNECTED'

/** CAM-3: online is `state === 'CONNECTED'` — any other value, known or not, counts as offline. */
export function isCameraOnline(state: string): boolean {
  return state === CAMERA_STATE_CONNECTED
}

/**
 * A camera as the app knows it (CAM-1/2/3), trimmed from `ProtectCamera`.
 *
 * `id` is the only required field: a camera with a surprising payload still has to appear in the
 * list (CAM-1), offline if need be, rather than disappear. **No stream URLs** — those stay in main
 * (CON-2, NFR-9); the renderer gets loopback go2rtc names from P2.2 instead.
 */
export const CameraSchema = z.object({
  id: z.string().min(1),
  /** Protect's `name`, `null` when the console has none. The UI falls back to the model and id. */
  name: z.string().nullable().default(null),
  /** Protect's `type`, i.e. the model (`G4 Bullet`). Empty when the console omits it. */
  model: z.string().default(''),
  /** `CONNECTED | CONNECTING | DISCONNECTED` today; read it through `isCameraOnline`. */
  state: z.string().default(''),
  /** `featureFlags.hasMic` — whether the camera has a microphone at all (AUD-1). */
  hasMic: z.boolean().default(false),
  /** `isMicEnabled` — whether its audio is actually on, which is the one that mutes a cell. */
  micEnabled: z.boolean().default(false),
  /** `featureFlags.hasSpeaker`. Unused in the prototype; talkback is an MVP idea (SPEC §5.1). */
  hasSpeaker: z.boolean().default(false),
  /** `featureFlags.smartDetectTypes`: what this camera can detect, for the cell editor (CELL-2). */
  smartDetectTypes: z.array(z.string().min(1)).default(() => []),
  /** `featureFlags.supportFullHdSnapshot`. False means `highQuality=true` is a 400 (SPEC §5.1). */
  supportsFullHdSnapshot: z.boolean().default(false),
  /** A doorbell's second channel, addressed as `<cameraId>:package` (CAM-4, QUAL-8). */
  hasPackageCamera: z.boolean().default(false),
})
export type Camera = z.infer<typeof CameraSchema>

/**
 * One camera trigger from the Protect events WebSocket, trimmed for CELL-2 and P4.1.
 *
 * `trigger` is the `MotionTrigger` the cell logic reasons about; `protectType` keeps Protect's own
 * `item.type` for logs and for triggers the prototype does not act on yet.
 */
export const CameraEventSchema = z.object({
  id: z.string().min(1),
  /** Protect's `item.device`: the camera the event belongs to. */
  cameraId: z.string().min(1),
  trigger: MotionTriggerSchema,
  /** Protect's `item.type`, e.g. `smartDetectLoiterZone`. */
  protectType: z.string().min(1),
  /** `item.start`, ms since the epoch. */
  start: z.number(),
  /**
   * `item.end`, or `null` while the event is still running: the opening `add` **omits** `end`
   * entirely (SPEC §5.1 event lifecycle). The closing `update` sets it and may be **repeated**, so
   * consumers stay idempotent on `(id, end)`.
   */
  end: z.number().nullable().default(null),
  /** `item.smartDetectTypes`, empty for a plain `motion` event. */
  smartDetectTypes: z.array(z.string().min(1)).default(() => []),
})
export type CameraEvent = z.infer<typeof CameraEventSchema>

/**
 * A camera's state as the devices WebSocket reports it (CAM-2/3). **Shapes unverified** (SPEC R11:
 * 0 messages in 9 minutes), which is why the feed is parsed leniently and the inventory is re-read
 * from `GET /v1/cameras` after every reconnect rather than rebuilt from this feed.
 */
export const CameraStateChangeSchema = z.object({
  cameraId: z.string().min(1),
  state: z.string().min(1),
})
export type CameraStateChange = z.infer<typeof CameraStateChangeSchema>

/** A door's lock relay (DOOR-1): `unlock` for the few seconds after an unlock, else `lock`. */
export const DOOR_RELAY_STATES = ['lock', 'unlock'] as const
export type DoorRelayState = (typeof DOOR_RELAY_STATES)[number]

/** A door position sensor reading, or `null` when the door has no sensor. */
export const DOOR_POSITIONS = ['open', 'close'] as const
export type DoorPosition = (typeof DOOR_POSITIONS)[number]

/**
 * A door as the app knows it (DOOR-1/2), trimmed from `AccessDoor`.
 *
 * **Community-sourced and unverified** like everything Access (SPEC §5.2, R3): the wire shape and
 * its leniencies live in `src/main/access/types.ts`, and OS-1 is what confirms them. `relay` and
 * `position` keep their enums here because the Access schemas already reject anything else, so a
 * surprising value fails in main where it can be reported, not silently in the renderer.
 */
export const DoorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** `full_name`, e.g. `Ground Floor - Front Door`. */
  fullName: z.string(),
  floorId: z.string(),
  /** `door` in every community example; no enum is documented. */
  type: z.string(),
  /** `is_bind_hub`: remote unlock only works when true (DOOR-3). */
  boundToHub: z.boolean(),
  relay: z.enum(DOOR_RELAY_STATES),
  /** `''` from the console means "no sensor" and arrives here as `null`. */
  position: z.enum(DOOR_POSITIONS).nullable(),
})
export type Door = z.infer<typeof DoorSchema>

/**
 * DOOR-6 (P5.5): what the Live screen knows of one linked door, read by main from `GET /doors`.
 * `relay` is the lock relay (`unlock` while the door is released, whoever released it) and
 * `position` the door position sensor (`null`: no sensor).
 */
export const DoorLockStateSchema = z.object({
  relay: z.enum(DOOR_RELAY_STATES),
  position: z.enum(DOOR_POSITIONS).nullable(),
})
export type DoorLockState = z.infer<typeof DoorLockStateSchema>

/**
 * DOOR-6 (P5.5): `{ "<accessDoorId>": state }` for the **linked** doors whose state main currently
 * knows. A linked door that is missing here is **unknown** (not read yet, the read is failing, the
 * door is gone, or nobody is watching) and must be drawn neutral, never as locked or unlocked.
 */
export const DoorStatesSchema = z.record(z.string().min(1), DoorLockStateSchema)
export type DoorStates = z.infer<typeof DoorStatesSchema>
