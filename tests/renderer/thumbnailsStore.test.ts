// P5.2: the shared snapshot cache (state/thumbnailsStore). The rules are camerasStore's pure
// reducers, tested there; this protects what the store module adds once two screens share it:
//  - the inventory sync runs on every `cameras` change in appStore, with no screen mounted (CAM-2/3);
//  - two screens asking for the same camera send one request (the dedupe), and only the stamped
//    ids are fetched;
//  - a thumbnail fetch is the snapshot (never highQuality) then the feed state (QUAL-7), and a
//    package fetch asks for `channel=package` and no feed state (CAM-4).
// No jsdom: the store's IPC goes through appStore's `snapshot` / `cameraStreamQualities`, replaced
// here with fakes, so no `window` is needed.
import type {
  Camera,
  IpcResult,
  RtspsAvailability,
  SnapshotInput,
  SnapshotResult,
} from '@shared/ipc'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/src/state/appStore'
import { EMPTY_THUMBNAILS } from '../../src/renderer/src/state/camerasStore'
import {
  forgetFailed,
  isLatestLoad,
  isLoadInFlight,
  nextRequestId,
  requestCameras,
  requestPackages,
  requestStreams,
  setActionError,
  startLoad,
  useThumbnails,
} from '../../src/renderer/src/state/thumbnailsStore'

function camera(overrides: Partial<Camera> & { id: string }): Camera {
  return {
    name: null,
    model: '',
    state: 'CONNECTED',
    hasMic: false,
    micEnabled: false,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: true,
    hasPackageCamera: false,
    ...overrides,
  }
}

const SHOT: IpcResult<SnapshotResult> = {
  ok: true,
  value: { state: 'ok', mimeType: 'image/jpeg', bytes: new Uint8Array([1]), capturedAt: 1 },
}
const QUALITIES: RtspsAvailability = { high: true, medium: false, low: false, package: false }
const AVAILABLE: IpcResult<RtspsAvailability> = { ok: true, value: QUALITIES }

/** Lets every pending `.then` run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

let snapshot: ReturnType<typeof vi.fn<(input: SnapshotInput) => Promise<IpcResult<SnapshotResult>>>>
let streams: ReturnType<typeof vi.fn<(cameraId: string) => Promise<IpcResult<RtspsAvailability>>>>

beforeEach(() => {
  snapshot = vi.fn(() => Promise.resolve(SHOT))
  streams = vi.fn(() => Promise.resolve(AVAILABLE))
  useAppStore.setState({ cameras: [], snapshot, cameraStreamQualities: streams })
  useThumbnails.setState({ thumbnails: EMPTY_THUMBNAILS, packages: {}, actionError: null })
})

describe('thumbnailsStore (P5.2)', () => {
  it('hands out request ids that never repeat', () => {
    const first = nextRequestId()
    expect(nextRequestId()).toBeGreaterThan(first)
  })

  it('fetches the snapshot without highQuality, then the feed state, into the shared sheet', async () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' })] })
    expect(requestCameras(['a'])).toEqual(['a'])
    await settle()
    expect(snapshot).toHaveBeenCalledWith({ cameraId: 'a', highQuality: false })
    expect(streams).toHaveBeenCalledWith('a')
    const { entries, streams: sheetStreams } = useThumbnails.getState().thumbnails
    expect(entries.a).toMatchObject({ status: 'ready' })
    expect(sheetStreams.a).toEqual({ status: 'known', available: QUALITIES })
  })

  it('sends one request when two screens ask for the same camera', async () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' }), camera({ id: 'b' })] })
    expect(requestCameras(['a'])).toEqual(['a'])
    // The editor asks while the Cameras tab's request is in flight: only `b` is new.
    expect(requestCameras(['a', 'b'])).toEqual(['b'])
    await settle()
    expect(snapshot).toHaveBeenCalledTimes(2)
    // And once answered, nobody asks again.
    expect(requestCameras(['a', 'b'])).toEqual([])
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('asks for the package channel, with no feed state, into its own record (CAM-4)', async () => {
    useAppStore.setState({ cameras: [camera({ id: 'bell', hasPackageCamera: true })] })
    expect(requestPackages(['bell'])).toEqual(['bell'])
    expect(requestPackages(['bell'])).toEqual([])
    await settle()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledWith({
      cameraId: 'bell',
      highQuality: false,
      channel: 'package',
    })
    expect(streams).not.toHaveBeenCalled()
    expect(useThumbnails.getState().packages.bell).toMatchObject({ status: 'ready' })
    expect(useThumbnails.getState().thumbnails.entries.bell).toBeUndefined()
  })

  it('syncs with the inventory on every change, with no screen mounted (CAM-2/3)', async () => {
    useAppStore.setState({
      cameras: [camera({ id: 'a' }), camera({ id: 'bell', hasPackageCamera: true })],
    })
    requestCameras(['a', 'bell'])
    requestPackages(['bell'])
    await settle()
    // `a` goes offline: both its slots go, so it is fetched afresh when it is back.
    useAppStore.setState({
      cameras: [
        camera({ id: 'a', state: 'DISCONNECTED' }),
        camera({ id: 'bell', hasPackageCamera: true }),
      ],
    })
    const state = useThumbnails.getState()
    expect(state.thumbnails.entries.a).toBeUndefined()
    expect(state.thumbnails.entries.bell).toMatchObject({ status: 'ready' })
    expect(state.packages.bell).toMatchObject({ status: 'ready' })
    // The inventory empties: everything goes.
    useAppStore.setState({ cameras: [] })
    expect(useThumbnails.getState().thumbnails.entries).toEqual({})
    expect(useThumbnails.getState().packages).toEqual({})
  })

  it('the editor fetches the snapshot only; the tab then asks for the feed state alone', async () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' })] })
    expect(requestCameras(['a'], { streams: false })).toEqual(['a'])
    await settle()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(streams).not.toHaveBeenCalled()
    expect(useThumbnails.getState().thumbnails.streams.a).toBeUndefined()
    expect(requestStreams(['a'])).toEqual(['a'])
    expect(requestStreams(['a'])).toEqual([])
    await settle()
    expect(streams).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(useThumbnails.getState().thumbnails.streams.a).toEqual({
      status: 'known',
      available: QUALITIES,
    })
  })

  it('forgetFailed lets a failed camera be asked for once more', async () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' })] })
    snapshot.mockResolvedValueOnce({ ok: true, value: { state: 'unavailable', reason: 'x' } })
    requestCameras(['a'], { streams: false })
    await settle()
    expect(requestCameras(['a'], { streams: false })).toEqual([])
    forgetFailed({ cameraIds: ['a'], packageIds: [] })
    expect(requestCameras(['a'], { streams: false })).toEqual(['a'])
    await settle()
    expect(useThumbnails.getState().thumbnails.entries.a).toMatchObject({ status: 'ready' })
  })

  it('tells a superseded load from the newest, even after the newer one has finished', () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' })] })
    const first = startLoad(['a'])
    expect(isLatestLoad(first)).toBe(true)
    expect(isLoadInFlight(first)).toBe(true)
    const second = startLoad(['a'])
    expect(isLatestLoad(first)).toBe(false)
    expect(isLoadInFlight(first)).toBe(false)
    // The newer load completes (an empty plan settles at once): the first is still superseded.
    useThumbnails.setState({
      thumbnails: { ...useThumbnails.getState().thumbnails, load: null, loaded: true },
    })
    expect(isLatestLoad(first)).toBe(false)
    expect(isLatestLoad(second)).toBe(true)
  })

  it('keeps the action error in the store, for whichever mount of the tab is on screen', () => {
    const error = {
      kind: 'auth' as const,
      message: 'The Protect API key was rejected.',
      endpoint: null,
      retryable: false,
    }
    setActionError(error)
    expect(useThumbnails.getState().actionError).toBe(error)
    setActionError(null)
    expect(useThumbnails.getState().actionError).toBeNull()
  })

  it('leaves the cache alone when something other than the cameras changes', () => {
    useAppStore.setState({ cameras: [camera({ id: 'a' })] })
    requestCameras(['a'])
    const before = useThumbnails.getState()
    useAppStore.setState({ loadError: null })
    expect(useThumbnails.getState()).toBe(before)
  })
})
