// The shared snapshot cache (P5.2; CAM-1, CAM-3, CAM-4, VIEW-3): the Cameras tab's thumbnails and
// feed states, and the package-channel snapshots the View editor shows.
//
// Until P5.2 the thumbnails were `CameraList`'s own reducer state, so they lived and died with the
// tab. The View editor shows the same images behind its cells' names (VIEW-3), so the state moved
// here, where both screens read it and either can fill it: a snapshot the editor fetched is there
// when the Cameras tab opens, and the other way round.
//
// **Only applies the pure rules.** Every decision — what a reply means, which reply still applies,
// what an inventory change drops — is `thumbnailsReducer` / `packageSnapshotsReducer` in
// `camerasStore`, unit-tested without a DOM. This module adds what a component cannot own once two
// screens share the cache:
//  - **The request id counter**, so ids never repeat across screens (a reply is matched to the
//    request that asked by id alone), and the id of the newest load, so a superseded load knows it
//    is (`isLatestLoad`) even after a newer one has completed.
//  - **The Cameras tab's action error**, because a load outlives the tab and its answer must reach
//    whichever mount is on screen.
//  - **The sync on inventory changes** (CAM-2/3's drop-on-offline rule), subscribed to `appStore`'s
//    `cameras` once, at module load, so it runs exactly once per change whether or not any screen
//    is mounted. A camera that went offline while the Cameras tab was closed still loses its stale
//    image.
//  - **The fetches** ({@link requestCameras}, {@link requestPackages}, {@link fetchCamera}): a
//    camera is marked in flight first, and only the ids that this very request stamped are fetched,
//    so two screens asking for the same camera at once send one request (the `request` action's
//    "already in entries" check is the dedupe). Everything goes through the `snapshot` IPC and so
//    through main's one shared rate limiter (SPEC R9); never `highQuality`, never on a timer, and
//    nothing here opens a stream (QUAL-8).
//
// Snapshot **bytes** are kept, never object URLs: those belong to the component that renders the
// image and revokes it (ui/SnapshotImage).
import { create } from 'zustand'
import type { Camera, IpcError } from '@shared/ipc'
import { useAppStore } from './appStore'
import {
  EMPTY_THUMBNAILS,
  packageSnapshotsReducer,
  thumbnailsReducer,
  wantsStreamsQuery,
  type PackageSnapshots,
  type PackageSnapshotsAction,
  type StreamQualitiesEntry,
  type ThumbnailEntry,
  type ThumbnailsAction,
  type ThumbnailsState,
} from './camerasStore'

export interface ThumbnailsStoreState {
  /** The Cameras tab's sheet and load (P4.5); the editor reads `thumbnails.entries`. */
  readonly thumbnails: ThumbnailsState
  /** Package-channel snapshots by camera id (CAM-4); only the View editor asks for these. */
  readonly packages: PackageSnapshots
  /**
   * The Cameras tab's last action failure (Connect, or a load's inventory read), shown next to the
   * control used. Here rather than in the component because a load outlives the tab: its answer
   * must reach whichever mount of the tab is on screen when it arrives.
   */
  readonly actionError: IpcError | null
}

const INITIAL: ThumbnailsStoreState = {
  thumbnails: EMPTY_THUMBNAILS,
  packages: {},
  actionError: null,
}

export const useThumbnails = create<ThumbnailsStoreState>()(() => INITIAL)

/** Applies one thumbnails action. A no-op change leaves the store (and its subscribers) alone. */
export function dispatchThumbnails(action: ThumbnailsAction): void {
  useThumbnails.setState((state) => {
    const thumbnails = thumbnailsReducer(state.thumbnails, action)
    return thumbnails === state.thumbnails ? state : { thumbnails }
  })
}

/** Applies one package-snapshots action, as above. */
export function dispatchPackages(action: PackageSnapshotsAction): void {
  useThumbnails.setState((state) => {
    const packages = packageSnapshotsReducer(state.packages, action)
    return packages === state.packages ? state : { packages }
  })
}

/** Sets (or clears) the Cameras tab's action error. */
export function setActionError(error: IpcError | null): void {
  if (useThumbnails.getState().actionError !== error) useThumbnails.setState({ actionError: error })
}

interface HotData {
  lastRequestId?: number
  lastLoadId?: number
}

// Carried over a hot reload in development, so a re-run module never hands out an id a request
// still in flight already has (a reply is matched to its request by id alone).
const hotData = (import.meta.hot?.data ?? {}) as HotData
let lastRequestId = hotData.lastRequestId ?? 0
/** The newest load ever started: a load is superseded as soon as another starts after it. */
let lastLoadId = hotData.lastLoadId ?? 0

/** A fresh id for a load or a request. Shared by every screen, so no two requests have the same. */
export function nextRequestId(): number {
  lastRequestId += 1
  return lastRequestId
}

/**
 * Starts a load (P4.5) under a fresh id, which becomes the newest load: any earlier one is
 * superseded. `shownIds` are the cameras the grid shows meanwhile.
 */
export function startLoad(shownIds: readonly string[]): number {
  const requestId = nextRequestId()
  lastLoadId = requestId
  dispatchThumbnails({ type: 'loadStart', requestId, shownIds })
  return requestId
}

/** Whether `requestId` is still the newest load started, i.e. no later load superseded it. */
export function isLatestLoad(requestId: number): boolean {
  return requestId === lastLoadId
}

/** Whether the load `requestId` is still in flight (not superseded, abandoned or completed). */
export function isLoadInFlight(requestId: number): boolean {
  return useThumbnails.getState().thumbnails.load?.requestId === requestId
}

/**
 * One camera's requests under `requestId`, for a load or an incremental request alike: the
 * snapshot, then — unless it failed at list level (`wantsStreamsQuery`) — the feed state (QUAL-7).
 * Each reply is dispatched with the id; the reducer decides whether it still applies. With
 * `withStreams` (the default) the feed state is always asked for after a good snapshot: `request`
 * and `loadPlan` stamp the streams slot as loading too, and it would stay so otherwise. Without it
 * (the View editor, P5.2) only the snapshot is asked for, and no streams slot was stamped.
 */
export function fetchCamera(requestId: number, cameraId: string, withStreams = true): void {
  const { snapshot } = useAppStore.getState()
  // `highQuality` stays false: a full-HD snapshot is a 400 on any camera without
  // `supportsFullHdSnapshot` and sends no smaller image instead (SPEC §5.1), and 1.1 MB is the
  // wrong size for a thumbnail even where it is allowed.
  void snapshot({ cameraId, highQuality: false }).then((result) => {
    dispatchThumbnails({ type: 'result', requestId, cameraId, result })
    if (!withStreams || !wantsStreamsQuery(result)) return
    fetchStreams(requestId, cameraId)
  })
}

/** One camera's feed state alone (QUAL-7), under `requestId`. A GET: it never creates a stream. */
function fetchStreams(requestId: number, cameraId: string): void {
  void useAppStore
    .getState()
    .cameraStreamQualities(cameraId)
    .then((qualities) => {
      dispatchThumbnails({ type: 'streams', requestId, cameraId, result: qualities })
    })
}

/**
 * The common part of {@link requestCameras} and {@link requestPackages}: stamp `cameraIds` as in
 * flight under a fresh id, then fetch only the ones this request stamped, so a camera another
 * screen is already fetching is not asked for twice. Returns those ids.
 */
function requestInto(
  cameraIds: readonly string[],
  stamp: (requestId: number) => void,
  record: () => Readonly<Record<string, ThumbnailEntry | StreamQualitiesEntry>>,
  fetch: (requestId: number, cameraId: string) => void,
): string[] {
  if (cameraIds.length === 0) return []
  const requestId = nextRequestId()
  stamp(requestId)
  const after = record()
  const stamped = [...new Set(cameraIds)].filter((id) => {
    const entry = after[id]
    return entry?.status === 'loading' && entry.requestId === requestId
  })
  for (const cameraId of stamped) fetch(requestId, cameraId)
  return stamped
}

/**
 * Outside a load: fetch the thumbnail — and, with `streams` (the default), the feed state — of each
 * camera that has no entry in the committed sheet yet (see {@link requestInto}). The View editor
 * passes `streams: false`: it shows the image only (P5.2).
 */
export function requestCameras(
  cameraIds: readonly string[],
  { streams = true }: { readonly streams?: boolean } = {},
): string[] {
  return requestInto(
    cameraIds,
    (requestId) => {
      dispatchThumbnails({ type: 'request', requestId, cameraIds, streams })
    },
    () => useThumbnails.getState().thumbnails.entries,
    (requestId, cameraId) => {
      fetchCamera(requestId, cameraId, streams)
    },
  )
}

/**
 * Outside a load: the feed state alone of cameras that have a thumbnail and no streams slot (the
 * View editor fetched them; `streamsPlan`). Marked in flight first, so it is asked for once.
 */
export function requestStreams(cameraIds: readonly string[]): string[] {
  return requestInto(
    cameraIds,
    (requestId) => {
      dispatchThumbnails({ type: 'requestStreams', requestId, cameraIds })
    },
    () => useThumbnails.getState().thumbnails.streams,
    fetchStreams,
  )
}

/**
 * The View editor's one retry when it opens (P5.2): forget the `failed` / `unavailable` entries of
 * these cameras (main channel) and package cameras, so the editor's plan asks for them again.
 */
export function forgetFailed(plan: {
  readonly cameraIds: readonly string[]
  readonly packageIds: readonly string[]
}): void {
  if (plan.cameraIds.length > 0) dispatchThumbnails({ type: 'forget', cameraIds: plan.cameraIds })
  if (plan.packageIds.length > 0) dispatchPackages({ type: 'forget', cameraIds: plan.packageIds })
}

/** The same for package-channel snapshots (CAM-4): `channel=package`, no feed state. */
export function requestPackages(cameraIds: readonly string[]): string[] {
  return requestInto(
    cameraIds,
    (requestId) => {
      dispatchPackages({ type: 'request', requestId, cameraIds })
    },
    () => useThumbnails.getState().packages,
    (requestId, cameraId) => {
      void useAppStore
        .getState()
        .snapshot({ cameraId, highQuality: false, channel: 'package' })
        .then((result) => {
          dispatchPackages({ type: 'result', requestId, cameraId, result })
        })
    },
  )
}

// CAM-2/3: fold every inventory change into the cache, once per change, whatever is on screen.
// Dropping the entry of a camera that went away or went offline is what makes it fetch a fresh
// image by itself when it comes back, and keeps a stale one from showing beside a live state.
function sync(cameras: readonly Camera[]): void {
  dispatchThumbnails({ type: 'sync', cameras })
  dispatchPackages({ type: 'sync', cameras })
}
sync(useAppStore.getState().cameras)
const unsubscribe = useAppStore.subscribe((state, previous) => {
  if (state.cameras !== previous.cameras) sync(state.cameras)
})
// A hot reload re-runs this module: drop the old subscription (or every change would sync twice)
// and hand the id counters to the new copy.
import.meta.hot?.dispose((data: HotData) => {
  unsubscribe()
  data.lastRequestId = lastRequestId
  data.lastLoadId = lastLoadId
})
