// The camera list's decisions (P1.7, CAM-1/2/3), as pure functions over plain data.
//
// The inventory itself lives in `appStore` — main pushes it and the store folds it in (CAM-2). This
// module owns only what the list *makes* of it: how a camera reads (name fallback, online state,
// placeholder, audio), the order the rows appear in, and the thumbnail cache. There is no zustand
// store here on purpose: two copies of the inventory is how a row ends up disagreeing with the
// badge, and CLAUDE.md asks for logic without UI to be pure and unit-tested. The project has no
// jsdom, so anything a test must reach has to be callable without a DOM — which is also why the
// cache keeps snapshot **bytes** and never an object URL: `URL.createObjectURL` belongs to the one
// component that can also revoke it (CameraThumbnail).
//
// Requirements served: CAM-1 (name/model/state/audio/thumbnail), CAM-2 and CAM-3 (the list reacts
// to `state` from the devices feed, not to whether a snapshot loaded — gate G1 times that at 10 s),
// SPEC R9 (the 10 req/s budget, which main's one shared rate limiter enforces), and QUAL-7's second
// half (which RTSPS qualities exist on the console).
//
// **The list loads all at once** (P4.5). Opening the Cameras tab with cameras in hand, cameras
// arriving on a list that has never loaded, or pressing Refresh starts a *load* ({@link ListLoad}):
// the inventory (except when main has just pushed it), then every online camera at once — main's
// limiter queues the requests, so asking for all of them together costs no more of the budget than
// asking a few at a time, and the list is ready sooner. The replies fill a pending
// {@link ThumbnailSheet} that nothing renders; when the last camera has settled, success or
// failure, the reducer swaps it in as the committed sheet in one step, so the grid appears (or, on
// Refresh, changes) at once instead of row by row. Until then the screen shows
// {@link loadProgress} — from the very first render when a load is about to start — and on a
// Refresh the previous grid stays up, limited to the cameras it already showed
// ({@link gridCameras}), while the live `state` of each card still comes from the devices feed. A
// Refresh during a load supersedes it: its replies no longer match and are dropped.
//
// Outside a load, a camera that needs a thumbnail — one that came back online (CAM-3), or one the
// devices feed added (CAM-2) — gets one on its own, straight into the committed sheet
// ({@link thumbnailPlan}): that is an incremental update, not the list loading.
//
// **The RTSPS qualities ride along with the thumbnails** (P3.7). They are a per-camera fact about
// the console that is just as stale or fresh as a snapshot, so they share its whole lifecycle in
// one sheet rather than a second one that would have to repeat it: asked for in the same request
// (same `requestId`), skipped for offline cameras, dropped when a camera goes offline or leaves,
// replaced by Refresh, and never polled. Per camera the feed state is asked for straight after its
// snapshot answers (the cameras themselves all go at once), and only when the snapshot did not
// fail with a list-level error ({@link wantsStreamsQuery}): a bad key, an unpinned console or a
// rate limit would fail the GET just the same, so it is not sent and the row says "streams
// unknown" straight away. What differs from a thumbnail is the failure: not knowing which streams exist is not
// worth an error, so it is a quiet "streams unknown" on the row and never the list-level `error`.
import { isCameraOnline } from '@shared/models'
import { cameraHasAudio } from '../features/audio/cameraAudio'
import { QUALITIES, PACKAGE_CHANNEL, qualityBadgeLabel, type StreamQuality } from '@shared/quality'
import type {
  Camera,
  EndpointStatus,
  IpcError,
  IpcResult,
  RtspsAvailability,
  SnapshotResult,
} from '@shared/ipc'

// -------------------------------------------------------------------------------------------------
// How one camera reads (CAM-1, CAM-3)

// `cameraDisplayName` lives in @shared/cameraOrder with `sortCameras`, so main (the P3.2 perf
// harness) orders cameras exactly as this list does. Re-exported so callers keep importing here.
export { cameraDisplayName, sortCameras } from '@shared/cameraOrder'

/** What a placeholder stands in for, or `null` when the thumbnail is shown instead (CAM-3). */
export type CameraPlaceholder = 'offline' | 'connecting'

export interface CameraPresentation {
  /** CAM-3: `state === 'CONNECTED'` and nothing else. Never derived from a loaded snapshot. */
  readonly online: boolean
  readonly placeholder: CameraPlaceholder | null
  /** CAM-1: the camera has a microphone *and* it is switched on, which is what mutes a cell. */
  readonly audio: boolean
  /** The `state` column, written for a person. */
  readonly stateLabel: string
}

/**
 * The single place that decides how a camera reads, so the components hold no rules.
 *
 * Unknown states count as offline but keep their own label: `src/shared/models.ts` parses `state`
 * as a string precisely so a console upgrade cannot drop a camera (SPEC R8/R11), and showing
 * `REBOOTING` as itself is more use to the person looking at the wall than flattening it to
 * "Offline" — while still refusing to treat it as streamable.
 */
export function cameraPresentation(camera: Camera): CameraPresentation {
  // AUD-1's predicate, shared with the grid (features/audio/cameraAudio.ts). Mic-capable, online or
  // not: the badge says what the camera can do, not whether it plays now.
  const audio = cameraHasAudio(camera)
  if (isCameraOnline(camera.state)) {
    return { online: true, placeholder: null, audio, stateLabel: 'Online' }
  }
  if (camera.state === 'CONNECTING') {
    return { online: false, placeholder: 'connecting', audio, stateLabel: 'Connecting…' }
  }
  const state = camera.state.trim()
  const stateLabel = state === '' ? 'Unknown' : state === 'DISCONNECTED' ? 'Offline' : state
  return { online: false, placeholder: 'offline', audio, stateLabel }
}

// -------------------------------------------------------------------------------------------------
// The thumbnail cache (CAM-1, CAM-3, SPEC R9)

/**
 * One camera's thumbnail state. `ready` carries the JPEG bytes rather than an object URL: the URL
 * is created and revoked by the component that renders it, so unmounting a row cannot leak one.
 */
export type ThumbnailEntry =
  /**
   * In flight. `requestId` is the request that asked, and only that request's reply may fill this
   * slot: `status` alone cannot tell request N from request N+1 for the same camera, so a reply
   * from a superseded request would otherwise store old bytes in the new slot.
   */
  | { readonly status: 'loading'; readonly requestId: number }
  | {
      readonly status: 'ready'
      readonly bytes: Uint8Array
      readonly mimeType: string
      readonly capturedAt: number
    }
  /** CAM-3: the console said no image is available. A placeholder, not an error. */
  | { readonly status: 'unavailable'; readonly reason: string }
  /** A real failure — a bad key, an unpinned console. Settings' business (see `error` below). */
  | { readonly status: 'failed'; readonly error: IpcError }

/**
 * One camera's RTSPS qualities (QUAL-7). Booleans from main, never a URL (CON-2). `loading` carries
 * the request's `requestId` for the same reason a thumbnail's does.
 */
export type StreamQualitiesEntry =
  | { readonly status: 'loading'; readonly requestId: number }
  | { readonly status: 'known'; readonly available: RtspsAvailability }
  /** The call failed, for whatever reason. A quiet note on the row, not an error (see header). */
  | { readonly status: 'unknown' }

/** Everything the list knows per camera: what the grid renders, or what a load is filling in. */
export interface ThumbnailSheet {
  readonly entries: Readonly<Record<string, ThumbnailEntry>>
  /** QUAL-7, keyed like `entries` and always asked for in the same request. */
  readonly streams: Readonly<Record<string, StreamQualitiesEntry>>
  /**
   * The last failure that was *not* about a camera. Held at list level because that is where the
   * user can be sent to Settings to fix it; a per-row message for fifteen rows with the same bad
   * API key would be fifteen copies of one problem.
   */
  readonly error: IpcError | null
}

/**
 * A load in flight (P4.5, header): every online camera's snapshot and feed state, filling `sheet`
 * until all of the cameras have settled.
 */
export interface ListLoad {
  /** Every reply carries it; a reply from a superseded load does not match and is dropped. */
  readonly requestId: number
  /** The cameras the grid showed when the load started: a Refresh keeps showing just those. */
  readonly shownIds: readonly string[]
  /**
   * Per planned camera, how many of its requests are still outstanding: 2 (snapshot, then feed
   * state), 1, or 0 once it has settled. `null` until the load knows which cameras to ask about.
   * Counted whether or not a reply still applies to its camera (one that went offline meanwhile,
   * say), so the load always completes.
   */
  readonly outstanding: Readonly<Record<string, number>> | null
  readonly sheet: ThumbnailSheet
}

export interface ThumbnailsState extends ThumbnailSheet {
  /** Whether a load has ever completed, i.e. whether there is a grid to show at all. */
  readonly loaded: boolean
  readonly load: ListLoad | null
}

const EMPTY_SHEET: ThumbnailSheet = { entries: {}, streams: {}, error: null }

export const EMPTY_THUMBNAILS: ThumbnailsState = { ...EMPTY_SHEET, loaded: false, load: null }

export type ThumbnailsAction =
  /** The inventory changed (CAM-2): forget what no longer applies, in both sheets. */
  | { readonly type: 'sync'; readonly cameras: readonly Camera[] }
  /**
   * A load starts under `requestId` (the tab opened, or Refresh). It supersedes any load still in
   * flight; the committed sheet stays on screen until this one completes.
   */
  | {
      readonly type: 'loadStart'
      readonly requestId: number
      readonly shownIds: readonly string[]
    }
  /**
   * The load knows which cameras to ask about (after the inventory, if it asked for one). An empty
   * plan completes the load at once.
   */
  | { readonly type: 'loadPlan'; readonly requestId: number; readonly cameraIds: readonly string[] }
  /**
   * Outside a load: these ids are now in flight in the committed sheet, under `requestId`. Keeps
   * a re-render from asking twice, and stamps the slot so only this request's replies can fill it.
   */
  | {
      readonly type: 'request'
      readonly requestId: number
      readonly cameraIds: readonly string[]
    }
  /**
   * Whatever `snapshot()` answered, for a load or for a `request`, told apart by `requestId`. The
   * reducer, not the component, applies the CAM-3 rule.
   */
  | {
      readonly type: 'result'
      readonly requestId: number
      readonly cameraId: string
      readonly result: IpcResult<SnapshotResult>
    }
  /** Whatever `cameraStreamQualities()` answered (QUAL-7). Same routing rule as `result`. */
  | {
      readonly type: 'streams'
      readonly requestId: number
      readonly cameraId: string
      readonly result: IpcResult<RtspsAvailability>
    }

export function thumbnailsReducer(
  state: ThumbnailsState,
  action: ThumbnailsAction,
): ThumbnailsState {
  switch (action.type) {
    case 'sync':
      return syncState(state, action.cameras)

    case 'loadStart':
      return {
        ...state,
        load: {
          requestId: action.requestId,
          shownIds: action.shownIds,
          outstanding: null,
          sheet: EMPTY_SHEET,
        },
      }

    case 'loadPlan': {
      const load = state.load
      if (load?.requestId !== action.requestId || load.outstanding !== null) return state
      const loading = { status: 'loading', requestId: action.requestId } as const
      const entries: Record<string, ThumbnailEntry> = {}
      const streams: Record<string, StreamQualitiesEntry> = {}
      const outstanding: Record<string, number> = {}
      for (const cameraId of action.cameraIds) {
        entries[cameraId] = loading
        streams[cameraId] = loading
        outstanding[cameraId] = 2
      }
      return settle(state, { ...load, outstanding, sheet: { ...load.sheet, entries, streams } })
    }

    case 'request': {
      const entries = { ...state.entries }
      const streams = { ...state.streams }
      let changed = false
      for (const cameraId of action.cameraIds) {
        if (cameraId in entries) continue
        const loading = { status: 'loading', requestId: action.requestId } as const
        entries[cameraId] = loading
        // Together with the thumbnail, so the two can never be asked for by different requests.
        streams[cameraId] = loading
        changed = true
      }
      return changed ? { ...state, entries, streams } : state
    }

    case 'result':
    case 'streams': {
      const load = state.load
      if (load !== null && load.requestId === action.requestId) {
        const left = load.outstanding?.[action.cameraId]
        if (load.outstanding === null || left === undefined) return state
        // A snapshot that failed at list level is the camera's last request: no feed-state GET
        // follows it (`wantsStreamsQuery`, which the component consults too).
        const nextLeft =
          action.type === 'result' && !wantsStreamsQuery(action.result) ? 0 : Math.max(0, left - 1)
        return settle(state, {
          ...load,
          outstanding: { ...load.outstanding, [action.cameraId]: nextLeft },
          sheet: applyReply(load.sheet, action),
        })
      }
      const sheet = applyReply(state, action)
      return sheet === state ? state : { ...state, ...sheet }
    }
  }
}

/** The load as given; or, once every camera has settled, its sheet swapped in as the grid's. */
function settle(state: ThumbnailsState, load: ListLoad): ThumbnailsState {
  const { outstanding } = load
  if (outstanding === null || Object.values(outstanding).some((left) => left > 0)) {
    return { ...state, load }
  }
  return { ...load.sheet, loaded: true, load: null }
}

/**
 * Whether a camera's feed state is worth asking for after its snapshot answered `result`. A failed
 * call is what this module treats as *not about the camera* (`toEntry`'s `failed`, the list-level
 * `error`): a bad key, an unpinned console, a rate limit — the GET would fail the same way, so it
 * is not sent and the reducer marks the camera "streams unknown". A camera-specific answer, the
 * CAM-3 "no image available" included, says the console is reachable, so the question is still
 * worth a request.
 */
export function wantsStreamsQuery(result: IpcResult<SnapshotResult>): boolean {
  return result.ok
}

/** One snapshot or feed-state reply applied to `sheet`, or `sheet` itself when it is stale. */
function applyReply<S extends ThumbnailSheet>(
  sheet: S,
  action: Extract<ThumbnailsAction, { type: 'result' | 'streams' }>,
): S {
  const { cameraId, requestId } = action
  if (action.type === 'result') {
    // Only the request that is still outstanding for this camera may fill it in. Three things are
    // stale: a reply after a newer load replaced the sheet, a reply after the camera went offline
    // and its entry was dropped (writing it back would put an image next to an "Offline"
    // placeholder, CAM-3), and a reply from an earlier request for a camera a later one has
    // already asked about again.
    const entry = sheet.entries[cameraId]
    if (entry?.status !== 'loading' || entry.requestId !== requestId) return sheet
    const listLevel = !action.result.ok
    return {
      ...sheet,
      entries: { ...sheet.entries, [cameraId]: toEntry(action.result) },
      // A list-level failure means the feed-state GET is not sent (`wantsStreamsQuery`), so the
      // camera reads "streams unknown" now rather than "loading" for ever. The streams slot always
      // belongs to the same request as an entry that passed the check above: both are stamped
      // together and dropped together.
      streams:
        listLevel && cameraId in sheet.streams
          ? { ...sheet.streams, [cameraId]: { status: 'unknown' } }
          : sheet.streams,
      error: action.result.ok ? sheet.error : action.result.error,
    }
  }
  // The same three stale cases, against the streams slot.
  const entry = sheet.streams[cameraId]
  if (entry?.status !== 'loading' || entry.requestId !== requestId) return sheet
  // Defensive: the snapshot beside it failed at list level, so no GET should have been sent; if one
  // was, the row still reads "streams unknown", as above.
  const listLevel = sheet.entries[cameraId]?.status === 'failed'
  const next: StreamQualitiesEntry =
    action.result.ok && !listLevel
      ? { status: 'known', available: action.result.value }
      : { status: 'unknown' }
  // `error` is left alone on purpose: a failure here is "streams unknown" on the row, and a bad
  // key or a missing pin is already reported by the thumbnail beside it.
  return { ...sheet, streams: { ...sheet.streams, [cameraId]: next } }
}

function toEntry(result: IpcResult<SnapshotResult>): ThumbnailEntry {
  if (!result.ok) return { status: 'failed', error: result.error }
  if (result.value.state === 'unavailable') {
    return { status: 'unavailable', reason: result.value.reason }
  }
  return {
    status: 'ready',
    bytes: result.value.bytes,
    mimeType: result.value.mimeType,
    capturedAt: result.value.capturedAt,
  }
}

/**
 * CAM-2/3's refetch-on-recovery rule, as a reducer step: an entry survives only while its camera is
 * both still in the inventory **and** online — in the committed sheet and in a load's. So a camera
 * that drops off loses its cached thumbnail, which means that when the devices feed says
 * `CONNECTED` again `thumbnailPlan` asks for a fresh one with no user action — and the stale image
 * from before the outage is never shown next to a live state.
 *
 * An inventory that empties (the console was left, the key cleared) also forgets that a load ever
 * completed, and abandons one in flight — its replies no longer match anything — so the cameras
 * that come next load all at once like a first open.
 */
function syncState(state: ThumbnailsState, cameras: readonly Camera[]): ThumbnailsState {
  if (cameras.length === 0) {
    return state.loaded ||
      state.load !== null ||
      state.error !== null ||
      Object.keys(state.entries).length > 0
      ? EMPTY_THUMBNAILS
      : state
  }
  const keep = new Set(cameras.filter((c) => isCameraOnline(c.state)).map((c) => c.id))
  const committed = syncSheet(state, keep)
  const loadSheet = state.load === null ? null : syncSheet(state.load.sheet, keep)
  const load =
    state.load === null || loadSheet === null || loadSheet === state.load.sheet
      ? state.load
      : { ...state.load, sheet: loadSheet }
  return committed === state && load === state.load ? state : { ...committed, load }
}

function syncSheet<S extends ThumbnailSheet>(sheet: S, keep: ReadonlySet<string>): S {
  const entries = keepOnly(sheet.entries, keep)
  // The streams slot goes with the thumbnail: when the camera is back, both are asked for again.
  const streams = keepOnly(sheet.streams, keep)
  return entries === sheet.entries && streams === sheet.streams
    ? sheet
    : { ...sheet, entries, streams }
}

/** `record` without the keys not in `keep`; the same object back when nothing was dropped. */
function keepOnly<T>(
  record: Readonly<Record<string, T>>,
  keep: ReadonlySet<string>,
): Readonly<Record<string, T>> {
  const out: Record<string, T> = {}
  let changed = false
  for (const [key, value] of Object.entries(record)) {
    if (keep.has(key)) out[key] = value
    else changed = true
  }
  return changed ? out : record
}

/**
 * Which cameras need a snapshot (and a feed state), in the order given (pass `sortCameras`' output,
 * so requests queue top-left first). Offline cameras are skipped — they render a placeholder
 * (CAM-3) and a snapshot of them would spend a permit to be told so — and so is anything already
 * in flight or already answered in `loaded`, which is what keeps a re-render from re-asking. A load
 * plans against an empty record; the incremental path against the committed sheet.
 */
export function thumbnailPlan(
  cameras: readonly Camera[],
  loaded: Readonly<Record<string, ThumbnailEntry>>,
): string[] {
  return cameras
    .filter((camera) => isCameraOnline(camera.state) && !(camera.id in loaded))
    .map((camera) => camera.id)
}

// -------------------------------------------------------------------------------------------------
// When to load, and what to show meanwhile (P4.5, CAM-1)

/**
 * Whether a load should start by itself: cameras are in hand, no load is in flight, and none has
 * completed yet (or the list was emptied since). That covers opening the tab on a console that has
 * already listed its cameras, and a connect from the empty card (main pushes the inventory, CAM-2),
 * so either fills the grid at once rather than row by row. An empty list on open loads nothing:
 * the inventory in the store is what main last read, and nothing connects at startup (CON-4).
 */
export function wantsLoad(state: ThumbnailsState, cameraCount: number): boolean {
  return !state.loaded && state.load === null && cameraCount > 0
}

/** Whether the incremental path may ask for thumbnails: only between loads, once one completed. */
export function fetchesIncrementally(state: ThumbnailsState): boolean {
  return state.loaded && state.load === null
}

export interface LoadProgress {
  /** Cameras whose snapshot (and feed state, if one was asked for) have answered. */
  readonly settled: number
  /** Cameras in the load, or `null` while the inventory is still being read: indeterminate. */
  readonly total: number | null
  /** Written for a person: "Loading 7 / 18 cameras", or "Loading cameras…" before the total. */
  readonly label: string
}

/**
 * The progress of the load in flight; an indeterminate one when a load is about to start
 * ({@link wantsLoad}), so the first render already shows the loading card and never a bare grid;
 * or `null` when there is neither.
 */
export function loadProgress(state: ThumbnailsState, cameraCount: number): LoadProgress | null {
  const load = state.load
  if (load === null) {
    return wantsLoad(state, cameraCount)
      ? { settled: 0, total: null, label: 'Loading cameras…' }
      : null
  }
  if (load.outstanding === null) return { settled: 0, total: null, label: 'Loading cameras…' }
  const counts = Object.values(load.outstanding)
  const settled = counts.filter((left) => left === 0).length
  return {
    settled,
    total: counts.length,
    label: `Loading ${String(settled)} / ${String(counts.length)} cameras`,
  }
}

/**
 * The cameras the grid shows, from the live inventory so every card's `state` is current (CAM-2,
 * gate G1). During a Refresh, just the ones that were on screen when it started: one the new
 * inventory adds appears with the rest when the load completes, not on its own before it. One that
 * left the inventory goes at once — its id means nothing on the console any more.
 */
export function gridCameras(sorted: readonly Camera[], state: ThumbnailsState): readonly Camera[] {
  if (state.load === null || !state.loaded) return sorted
  const shown = new Set(state.load.shownIds)
  return sorted.filter((camera) => shown.has(camera.id))
}

// -------------------------------------------------------------------------------------------------
// How a camera's RTSPS qualities read (QUAL-7)

/** One quality on the row: its badge text and whether the console has a stream for it. */
export interface RtspsBadge {
  readonly quality: StreamQuality
  readonly label: string
  readonly present: boolean
}

export type RtspsSummary =
  /** Asked, not answered yet. */
  | { readonly kind: 'loading' }
  /** The call failed. "streams unknown", quietly. */
  | { readonly kind: 'unknown' }
  /** No quality exists yet: QUAL-8 creates one the first time a cell needs it. */
  | { readonly kind: 'none' }
  /** Every quality the camera can have, best first, each marked present or absent. */
  | { readonly kind: 'known'; readonly badges: readonly RtspsBadge[] }

/**
 * What the camera row shows for its RTSPS qualities, or `null` for nothing at all — a camera that
 * was never asked about, which is an offline one (its thumbnail slot shows the CAM-3 placeholder,
 * and a "streams unknown" next to "Offline" would only repeat it).
 *
 * The qualities come from {@link QUALITIES} and the labels from `qualityBadgeLabel`, so nothing is
 * hard-coded (QUAL preamble). The package channel is listed only for a camera that has one (CAM-4)
 * or when the console reports one anyway, so an ordinary camera does not show a permanently dimmed
 * `PKG`.
 */
export function rtspsSummary(
  camera: Pick<Camera, 'hasPackageCamera'>,
  entry: StreamQualitiesEntry | undefined,
): RtspsSummary | null {
  if (entry === undefined) return null
  if (entry.status === 'loading') return { kind: 'loading' }
  if (entry.status === 'unknown') return { kind: 'unknown' }
  const { available } = entry
  const qualities: StreamQuality[] = [...QUALITIES]
  if (camera.hasPackageCamera || available[PACKAGE_CHANNEL]) qualities.push(PACKAGE_CHANNEL)
  const badges = qualities.map((quality) => ({
    quality,
    label: qualityBadgeLabel(quality),
    present: available[quality],
  }))
  return badges.some((badge) => badge.present) ? { kind: 'known', badges } : { kind: 'none' }
}

// -------------------------------------------------------------------------------------------------
// Why the list may be empty (CON-1/3, CAM-1)

/** A step of the CON-1/CON-3 setup that has not been done yet. */
export type SetupGap = 'host' | 'credential' | 'certificate'

export const SETUP_GAP_LABELS: Readonly<Record<SetupGap, string>> = {
  host: 'No console address yet',
  credential: 'No Protect API key stored',
  certificate: "The console's certificate has not been accepted",
}

/** Which body the screen shows. See {@link cameraListBody}. */
export type CameraListBody = 'grid' | 'setup' | 'empty' | 'loading'

/**
 * What to put on the screen, given how many cameras are in hand, what setup is missing, and
 * whether the first load is still in flight (P4.5: the grid appears once that has completed, with
 * a progress indicator in its place until then).
 *
 * **Cameras win.** A setup gap that appears on a console that has already loaded its inventory —
 * the user clears the API key in Settings, say — must not blank the grid and replace it with "the
 * app has never reached a console": that is both untrue and alarming, and it throws away the one
 * thing the screen is for. The gap belongs in a banner above the rows instead (see
 * {@link cameraListShowsSetupBanner}); the full setup card is for when there is genuinely nothing
 * to show.
 */
export function cameraListBody(
  cameraCount: number,
  gaps: readonly SetupGap[],
  firstLoad = false,
): CameraListBody {
  if (firstLoad) return 'loading'
  if (cameraCount > 0) return 'grid'
  return gaps.length > 0 ? 'setup' : 'empty'
}

/** The gaps go in a banner exactly when there are rows that would otherwise be replaced. */
export function cameraListShowsSetupBanner(
  cameraCount: number,
  gaps: readonly SetupGap[],
  firstLoad = false,
): boolean {
  return gaps.length > 0 && cameraListBody(cameraCount, gaps, firstLoad) === 'grid'
}

/**
 * What is missing before the app could list anything, read from the status main reports rather than
 * guessed from an empty array: an empty list on a configured console is a different thing (no
 * adopted cameras, or nothing fetched yet) and must not be dressed up as a setup problem.
 */
export function setupGaps(protect: EndpointStatus): SetupGap[] {
  const gaps: SetupGap[] = []
  if (protect.hostPort === null) gaps.push('host')
  if (!protect.credentialStored) gaps.push('credential')
  if (!protect.pinned) gaps.push('certificate')
  return gaps
}
