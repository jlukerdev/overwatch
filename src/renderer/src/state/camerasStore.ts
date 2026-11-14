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
// SPEC R9 (the 10 req/s budget, hence the bounded thumbnail concurrency).
import { isCameraOnline } from '@shared/models'
import type { Camera, EndpointStatus, IpcError, IpcResult, SnapshotResult } from '@shared/ipc'

// -------------------------------------------------------------------------------------------------
// How one camera reads (CAM-1, CAM-3)

/**
 * CAM-1's fallback chain: Protect's `name`, then the model (`type`), then the id. The id is never
 * pretty, but a row the user cannot identify at all is worse than an ugly one — and a camera that
 * is missing from the list is worse still.
 */
export function cameraDisplayName(camera: Camera): string {
  const name = camera.name?.trim() ?? ''
  if (name !== '') return name
  const model = camera.model.trim()
  if (model !== '') return model
  return camera.id
}

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

/**
 * Display order: by display name, case-insensitively, numbers compared as numbers (`Cam 10` after
 * `Cam 2`), and **ties keep their inventory order** — `Array.prototype.sort` is stable, so two
 * cameras with the same name never swap places between renders.
 *
 * Offline cameras are deliberately *not* grouped or pushed to the end. Being offline is a state,
 * not a position: a camera that drops off for a minute would otherwise jump to the bottom and back,
 * and the row the user is watching during the G1 unplug test has to stay where it is.
 */
export function sortCameras(cameras: readonly Camera[]): Camera[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...cameras].sort((a, b) => collator.compare(cameraDisplayName(a), cameraDisplayName(b)))
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

export interface ThumbnailsState {
  readonly entries: Readonly<Record<string, ThumbnailEntry>>
  /**
   * The last failure that was *not* about a camera. Held at list level because that is where the
   * user can be sent to Settings to fix it; a per-row message for fifteen rows with the same bad
   * API key would be fifteen copies of one problem.
   */
  readonly error: IpcError | null
}

export const EMPTY_THUMBNAILS: ThumbnailsState = { entries: {}, error: null }

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
      let changed = false
      for (const cameraId of action.cameraIds) {
        if (cameraId in entries) continue
        entries[cameraId] = { status: 'loading', requestId: action.requestId }
        changed = true
      }
      return changed ? { ...state, entries } : state
    }

    case 'result': {
      // Only the request that is still outstanding for this camera may fill it in. Three things
      // are stale: a reply after a Refresh cleared the cache, a reply after the camera went
      // offline and its entry was dropped (writing it back would put an image next to an
      // "Offline" placeholder, CAM-3), and a reply from an earlier batch for a camera a later
      // batch has already asked about again.
      const entry = state.entries[action.cameraId]
      if (entry?.status !== 'loading' || entry.requestId !== action.requestId) return state
      return {
        entries: { ...state.entries, [action.cameraId]: toEntry(action.result) },
        error: action.result.ok ? state.error : action.result.error,
      }
    }

    case 'refresh':
      return EMPTY_THUMBNAILS
  }
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
  const entries: Record<string, ThumbnailEntry> = {}
  let changed = false
  for (const [cameraId, entry] of Object.entries(state.entries)) {
    if (keep.has(cameraId)) entries[cameraId] = entry
    else changed = true
  }
  return changed ? { ...state, entries } : state
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
