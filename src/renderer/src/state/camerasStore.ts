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
// SPEC R9 (the 10 req/s budget, hence the bounded thumbnail concurrency), and QUAL-7's second half
// (which RTSPS qualities exist on the console).
//
// **The RTSPS qualities ride along with the thumbnails** (P3.7). They are a per-camera fact about
// the console that is just as stale or fresh as a snapshot, so they share its whole lifecycle in
// one reducer rather than a second one that would have to repeat it: asked for in the same batch
// (same `requestId`), skipped for offline cameras, dropped when a camera goes offline or leaves,
// cleared by Refresh, and never polled. They are asked for *after* the batch's thumbnails, in a
// second pass with the same `THUMBNAIL_CONCURRENCY` ({@link streamsQueryPlan}), so the pictures the
// user is waiting for fill at full speed, and only for cameras whose snapshot did not fail with a
// list-level error ({@link wantsStreamsQuery}): a bad key, an unpinned console or a rate limit would
// fail the GET just the same, so it is not sent and the row says "streams unknown" straight away.
// What differs from a thumbnail is the failure: not knowing which streams exist is not worth an
// error, so it is a quiet "streams unknown" on the row and never the list-level `error`.
import { isCameraOnline } from '@shared/models'
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
  const audio = camera.hasMic && camera.micEnabled
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
   * In flight. `requestId` is the batch that asked, and only that batch's reply may fill this slot:
   * `status` alone cannot tell request N from request N+1 for the same camera, so a Refresh issued
   * while the first batch was still in flight would otherwise store the old bytes in the new slot
   * and then discard the new reply as stale — showing exactly the image Refresh meant to replace.
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
 * the batch's `requestId` for the same reason a thumbnail's does.
 */
export type StreamQualitiesEntry =
  | { readonly status: 'loading'; readonly requestId: number }
  | { readonly status: 'known'; readonly available: RtspsAvailability }
  /** The call failed, for whatever reason. A quiet note on the row, not an error (see header). */
  | { readonly status: 'unknown' }

export interface ThumbnailsState {
  readonly entries: Readonly<Record<string, ThumbnailEntry>>
  /** QUAL-7, keyed like `entries` and always asked for in the same batch. */
  readonly streams: Readonly<Record<string, StreamQualitiesEntry>>
  /**
   * The last failure that was *not* about a camera. Held at list level because that is where the
   * user can be sent to Settings to fix it; a per-row message for fifteen rows with the same bad
   * API key would be fifteen copies of one problem.
   */
  readonly error: IpcError | null
}

export const EMPTY_THUMBNAILS: ThumbnailsState = { entries: {}, streams: {}, error: null }

export type ThumbnailsAction =
  /** The inventory changed (CAM-2): forget what no longer applies. */
  | { readonly type: 'sync'; readonly cameras: readonly Camera[] }
  /**
   * These ids are now in flight, as one batch under `requestId`. Keeps a second pass from asking
   * twice, and stamps the slot so only this batch's replies can fill it.
   */
  | {
      readonly type: 'request'
      readonly requestId: number
      readonly cameraIds: readonly string[]
    }
  /** Whatever `snapshot()` answered. The reducer, not the component, applies the CAM-3 rule. */
  | {
      readonly type: 'result'
      /** The batch this reply belongs to. A reply from an older batch is dropped. */
      readonly requestId: number
      readonly cameraId: string
      readonly result: IpcResult<SnapshotResult>
    }
  /** Whatever `cameraStreamQualities()` answered (QUAL-7). Same batch rule as `result`. */
  | {
      readonly type: 'streams'
      readonly requestId: number
      readonly cameraId: string
      readonly result: IpcResult<RtspsAvailability>
    }
  /** The Refresh button: drop everything and fetch again. */
  | { readonly type: 'refresh' }

export function thumbnailsReducer(
  state: ThumbnailsState,
  action: ThumbnailsAction,
): ThumbnailsState {
  switch (action.type) {
    case 'sync':
      return syncEntries(state, action.cameras)

    case 'request': {
      const entries = { ...state.entries }
      const streams = { ...state.streams }
      let changed = false
      for (const cameraId of action.cameraIds) {
        if (cameraId in entries) continue
        const loading = { status: 'loading', requestId: action.requestId } as const
        entries[cameraId] = loading
        // Together with the thumbnail, so the two can never be asked for by different batches.
        streams[cameraId] = loading
        changed = true
      }
      return changed ? { ...state, entries, streams } : state
    }

    case 'result': {
      // Only the request that is still outstanding for this camera may fill it in. Three things
      // are stale: a reply after a Refresh cleared the cache, a reply after the camera went
      // offline and its entry was dropped (writing it back would put an image next to an
      // "Offline" placeholder, CAM-3), and a reply from an earlier batch for a camera a later
      // batch has already asked about again.
      const entry = state.entries[action.cameraId]
      if (entry?.status !== 'loading' || entry.requestId !== action.requestId) return state
      // A list-level failure means the RTSPS GET is not sent either (header): its slot, if this
      // batch is still waiting on it, is "unknown" now rather than "loading" for ever.
      const streamsEntry = state.streams[action.cameraId]
      const skipStreams =
        !wantsStreamsQuery(action.result) &&
        streamsEntry?.status === 'loading' &&
        streamsEntry.requestId === action.requestId
      return {
        ...state,
        entries: { ...state.entries, [action.cameraId]: toEntry(action.result) },
        streams: skipStreams
          ? { ...state.streams, [action.cameraId]: { status: 'unknown' } }
          : state.streams,
        error: action.result.ok ? state.error : action.result.error,
      }
    }

    case 'streams': {
      // The same three stale cases as `result`, against the streams slot.
      const entry = state.streams[action.cameraId]
      if (entry?.status !== 'loading' || entry.requestId !== action.requestId) return state
      const next: StreamQualitiesEntry = action.result.ok
        ? { status: 'known', available: action.result.value }
        : { status: 'unknown' }
      // `error` is left alone on purpose: a failure here is "streams unknown" on the row, and a
      // bad key or a missing pin is already reported by the thumbnail beside it.
      return { ...state, streams: { ...state.streams, [action.cameraId]: next } }
    }

    case 'refresh':
      return EMPTY_THUMBNAILS
  }
}

/**
 * Whether a camera's RTSPS qualities are worth asking for after its snapshot answered `result`. A
 * failed call is what this module treats as *not about the camera* (`toEntry`'s `failed`, the
 * list-level `error`): a bad key, an unpinned console, a rate limit — the GET would fail the same
 * way, so it is not sent. A camera-specific answer, the CAM-3 "no image available" included, says
 * the console is reachable, so the question is still worth a request.
 */
export function wantsStreamsQuery(result: IpcResult<SnapshotResult>): boolean {
  return result.ok
}

/**
 * The second pass of a batch (header): of `cameraIds`, in their order, the ones whose snapshot has
 * answered and {@link wantsStreamsQuery}. A camera with no answer recorded is left out too — the
 * pass runs after every snapshot of the batch has settled, so that can only be a bug, and a GET
 * for it would be a guess.
 */
export function streamsQueryPlan(
  cameraIds: readonly string[],
  snapshots: ReadonlyMap<string, IpcResult<SnapshotResult>>,
): string[] {
  return cameraIds.filter((cameraId) => {
    const result = snapshots.get(cameraId)
    return result !== undefined && wantsStreamsQuery(result)
  })
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
 * both still in the inventory **and** online. So a camera that drops off loses its cached
 * thumbnail, which means that when the devices feed says `CONNECTED` again `thumbnailPlan` asks for
 * a fresh one with no user action — and the stale image from before the outage is never shown next
 * to a live state.
 */
function syncEntries(state: ThumbnailsState, cameras: readonly Camera[]): ThumbnailsState {
  const keep = new Set(cameras.filter((c) => isCameraOnline(c.state)).map((c) => c.id))
  const entries = keepOnly(state.entries, keep)
  // The streams slot goes with the thumbnail: when the camera is back, both are asked for again.
  const streams = keepOnly(state.streams, keep)
  return entries === state.entries && streams === state.streams
    ? state
    : { ...state, entries, streams }
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

/**
 * How many snapshots may be in flight at once.
 *
 * The console allows 10 requests per second per API key (SPEC R9) and main throttles every call
 * through one shared limiter, so a stampede cannot break the limit — but it can still spend the
 * whole budget. Fifteen snapshots at once would queue for a second and a half and delay the live
 * devices feed behind them, which is exactly the path gate G1 times. Three at a time keeps the
 * thumbnails filling visibly while leaving most of each second's budget for everything else.
 */
export const THUMBNAIL_CONCURRENCY = 3

/**
 * Which cameras still need a snapshot, in the order given (pass `sortCameras`' output, so the grid
 * fills top-left first). Offline cameras are skipped — they render a placeholder (CAM-3) and a
 * snapshot of them would spend a permit to be told so — and so is anything already in flight or
 * already answered, which is what keeps a re-render from re-asking.
 */
export function thumbnailPlan(
  cameras: readonly Camera[],
  loaded: Readonly<Record<string, ThumbnailEntry>>,
): string[] {
  return cameras
    .filter((camera) => isCameraOnline(camera.state) && !(camera.id in loaded))
    .map((camera) => camera.id)
}

/**
 * Runs `fn` over `items` with at most `limit` of them outstanding: `limit` workers pulling from one
 * cursor, so a slow camera cannot hold up the rest and the cap holds however long each call takes.
 * Rejections are left to `fn` — the caller dispatches a result for every outcome, so there is
 * nothing here to catch.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) return
      await fn(item)
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
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

/**
 * What is missing before the app could list anything, read from the status main reports rather than
 * guessed from an empty array: an empty list on a configured console is a different thing (no
 * adopted cameras, or nothing fetched yet) and must not be dressed up as a setup problem.
 */
/** Which body the screen shows. See {@link cameraListBody}. */
export type CameraListBody = 'grid' | 'setup' | 'empty'

/**
 * What to put on the screen, given how many cameras are in hand and what setup is missing.
 *
 * **Cameras win.** A setup gap that appears on a console that has already loaded its inventory —
 * the user clears the API key in Settings, say — must not blank the grid and replace it with "the
 * app has never reached a console": that is both untrue and alarming, and it throws away the one
 * thing the screen is for. The gap belongs in a banner above the rows instead (see
 * {@link cameraListShowsSetupBanner}); the full setup card is for when there is genuinely nothing
 * to show.
 */
export function cameraListBody(cameraCount: number, gaps: readonly SetupGap[]): CameraListBody {
  if (cameraCount > 0) return 'grid'
  return gaps.length > 0 ? 'setup' : 'empty'
}

/** The gaps go in a banner exactly when there are rows that would otherwise be replaced. */
export function cameraListShowsSetupBanner(
  cameraCount: number,
  gaps: readonly SetupGap[],
): boolean {
  return gaps.length > 0 && cameraListBody(cameraCount, gaps) === 'grid'
}

export function setupGaps(protect: EndpointStatus): SetupGap[] {
  const gaps: SetupGap[] = []
  if (protect.hostPort === null) gaps.push('host')
  if (!protect.credentialStored) gaps.push('credential')
  if (!protect.pinned) gaps.push('certificate')
  return gaps
}
