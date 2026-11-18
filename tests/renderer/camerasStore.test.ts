// P1.7: the camera list's decisions (CAM-1/2/3, SPEC R9). The screen itself is deliberately thin —
// everything with a rule in it lives in `camerasStore` as pure functions, so it can be tested
// without a DOM (this project has no jsdom; CLAUDE.md).
//
// What these tests protect:
//  - CAM-1's name fallback chain, so a camera is never unidentifiable and never missing.
//  - CAM-3's presentation, including a `state` Protect has not documented: anything other than
//    `CONNECTED` is offline, because an enum here would turn a console upgrade into a dropped
//    camera (SPEC R8/R11).
//  - the order the rows appear in, including that going offline does not move a row.
//  - the refetch-on-recovery rule: a camera that comes back online gets a fresh thumbnail with no
//    user action, and never shows the one taken before the outage.
//  - QUAL-7's RTSPS qualities riding the thumbnail lifecycle (P3.7): same request, same stale
//    rules, dropped and refetched with the thumbnail, a failure that stays quiet, and no GET at
//    all for a camera whose snapshot failed at list level ("streams unknown" at once).
//  - the list loading all at once (P4.5, CAM-1/QUAL-7): progress counted in cameras, shown from
//    the first render, the grid swapped in only when all have settled (failures included), the
//    old grid kept during a Refresh, a superseded load's replies dropped, and a load abandoned
//    when the inventory empties.
import type {
  Camera,
  EndpointStatus,
  IpcError,
  IpcResult,
  RtspsAvailability,
  SnapshotResult,
} from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import {
  cameraDisplayName,
  cameraListBody,
  cameraListShowsSetupBanner,
  cameraPresentation,
  EMPTY_THUMBNAILS,
  fetchesIncrementally,
  gridCameras,
  loadProgress,
  packageSnapshotsReducer,
  rtspsSummary,
  setupGaps,
  sortCameras,
  streamsPlan,
  thumbnailPlan,
  thumbnailsReducer,
  wantsLoad,
  wantsStreamsQuery,
  type ThumbnailEntry,
  type ThumbnailsState,
} from '../../src/renderer/src/state/camerasStore'

function camera(overrides: Partial<Camera> & { id: string }): Camera {
  return {
    name: null,
    model: '',
    state: 'CONNECTED',
    hasMic: false,
    micEnabled: false,
    hasSpeaker: false,
    smartDetectTypes: [],
    supportsFullHdSnapshot: false,
    hasPackageCamera: false,
    ...overrides,
  }
}

function status(overrides: Partial<EndpointStatus> = {}): EndpointStatus {
  return {
    endpoint: 'protect',
    phase: 'idle',
    hostPort: 'console.example:443',
    pinned: true,
    credentialStored: true,
    version: null,
    error: null,
    updatedAt: 0,
    ...overrides,
  }
}

const ERROR: IpcError = {
  kind: 'auth',
  message: 'The Protect API key was rejected.',
  endpoint: 'console.example:443',
  retryable: false,
}

function okSnapshot(byte: number): IpcResult<SnapshotResult> {
  return {
    ok: true,
    value: {
      state: 'ok',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([byte]),
      capturedAt: 1_762_000_000_000,
    },
  }
}

const UNAVAILABLE: IpcResult<SnapshotResult> = {
  ok: true,
  value: { state: 'unavailable', reason: 'Camera is offline' },
}

/** The request id every single-batch test uses; the out-of-order test uses two of its own. */
const REQ = 1

/** Puts the given ids straight into `loading`, which is the only state a result may fill in. */
function loadingState(...cameraIds: string[]): ThumbnailsState {
  return thumbnailsReducer(EMPTY_THUMBNAILS, { type: 'request', requestId: REQ, cameraIds })
}

/** The camera went offline (CAM-2), which drops both of its slots so a later request may re-ask. */
function dropCamera(state: ThumbnailsState, cameraId: string): ThumbnailsState {
  return thumbnailsReducer(state, {
    type: 'sync',
    cameras: [camera({ id: cameraId, state: 'DISCONNECTED' })],
  })
}

describe('cameraDisplayName (CAM-1)', () => {
  const cases: readonly {
    readonly label: string
    readonly input: Camera
    readonly want: string
  }[] = [
    {
      label: 'the name when there is one',
      input: camera({ id: 'c1', name: 'Driveway' }),
      want: 'Driveway',
    },
    {
      label: 'the model when the console has no name',
      input: camera({ id: 'c1', name: null, model: 'G4 Bullet' }),
      want: 'G4 Bullet',
    },
    {
      label: 'the model when the name is blank rather than null',
      input: camera({ id: 'c1', name: '   ', model: 'G4 Bullet' }),
      want: 'G4 Bullet',
    },
    {
      label: 'the id when neither a name nor a model arrived',
      input: camera({ id: 'c1', name: null, model: '' }),
      want: 'c1',
    },
    {
      label: 'the id when both are blank',
      input: camera({ id: 'c1', name: '', model: '  ' }),
      want: 'c1',
    },
    {
      label: 'a trimmed name',
      input: camera({ id: 'c1', name: '  Side gate ' }),
      want: 'Side gate',
    },
  ]

  for (const { label, input, want } of cases) {
    it(`uses ${label}`, () => {
      expect(cameraDisplayName(input)).toBe(want)
    })
  }
})

describe('cameraPresentation (CAM-1/CAM-3)', () => {
  const cases = [
    { state: 'CONNECTED', online: true, placeholder: null, stateLabel: 'Online' },
    { state: 'CONNECTING', online: false, placeholder: 'connecting', stateLabel: 'Connecting…' },
    { state: 'DISCONNECTED', online: false, placeholder: 'offline', stateLabel: 'Offline' },
    // A state from a console upgrade: offline, but shown as itself rather than flattened.
    { state: 'REBOOTING', online: false, placeholder: 'offline', stateLabel: 'REBOOTING' },
    // Lower case is not CONNECTED (isCameraOnline is exact) and an absent state is not streamable.
    { state: 'connected', online: false, placeholder: 'offline', stateLabel: 'connected' },
    { state: '', online: false, placeholder: 'offline', stateLabel: 'Unknown' },
  ] as const

  for (const { state, online, placeholder, stateLabel } of cases) {
    it(`reads ${state === '' ? 'an empty state' : state} as ${online ? 'online' : 'offline'}`, () => {
      const presentation = cameraPresentation(camera({ id: 'c1', state }))
      expect(presentation.online).toBe(online)
      expect(presentation.placeholder).toBe(placeholder)
      expect(presentation.stateLabel).toBe(stateLabel)
    })
  }

  const audioCases = [
    { hasMic: false, micEnabled: false, want: false },
    { hasMic: true, micEnabled: false, want: false },
    { hasMic: false, micEnabled: true, want: false },
    { hasMic: true, micEnabled: true, want: true },
  ] as const

  for (const { hasMic, micEnabled, want } of audioCases) {
    it(`reports audio=${String(want)} for hasMic=${String(hasMic)} micEnabled=${String(micEnabled)}`, () => {
      // CAM-1 asks for `featureFlags.hasMic && isMicEnabled`: a mic that is switched off is not
      // an audio source.
      expect(cameraPresentation(camera({ id: 'c1', hasMic, micEnabled })).audio).toBe(want)
    })
  }
})

describe('sortCameras', () => {
  it('orders by display name, case-insensitively and numerically', () => {
    const cameras = [
      camera({ id: 'c3', name: 'Camera 10' }),
      camera({ id: 'c1', name: 'back door' }),
      camera({ id: 'c2', name: 'Camera 2' }),
      camera({ id: 'c4', name: 'Attic' }),
    ]
    expect(sortCameras(cameras).map((c) => c.id)).toEqual(['c4', 'c1', 'c2', 'c3'])
  })

  it('falls back through the display name, not the raw name', () => {
    const cameras = [
      camera({ id: 'zz', name: null, model: 'Attic unit' }),
      camera({ id: 'aa', name: 'Zebra' }),
    ]
    expect(sortCameras(cameras).map((c) => c.id)).toEqual(['zz', 'aa'])
  })

  it('keeps two cameras with the same name in inventory order', () => {
    const cameras = [
      camera({ id: 'second', name: 'Garage' }),
      camera({ id: 'first', name: 'garage' }),
    ]
    expect(sortCameras(cameras).map((c) => c.id)).toEqual(['second', 'first'])
  })

  it('does not move a camera because it went offline', () => {
    // Being offline is a state, not a position: the row the user watches during the G1 unplug test
    // has to stay where it is.
    const online = [
      camera({ id: 'a', name: 'Alley', state: 'CONNECTED' }),
      camera({ id: 'b', name: 'Barn', state: 'CONNECTED' }),
      camera({ id: 'c', name: 'Cellar', state: 'CONNECTED' }),
    ]
    const withOutage = online.map((c) => (c.id === 'b' ? { ...c, state: 'DISCONNECTED' } : c))
    expect(sortCameras(withOutage).map((c) => c.id)).toEqual(sortCameras(online).map((c) => c.id))
  })

  it('does not mutate its input', () => {
    const cameras = [camera({ id: 'b', name: 'B' }), camera({ id: 'a', name: 'A' })]
    sortCameras(cameras)
    expect(cameras.map((c) => c.id)).toEqual(['b', 'a'])
  })
})

describe('thumbnailPlan (CAM-3, SPEC R9)', () => {
  const cameras = [
    camera({ id: 'a', name: 'A', state: 'CONNECTED' }),
    camera({ id: 'b', name: 'B', state: 'DISCONNECTED' }),
    camera({ id: 'c', name: 'C', state: 'CONNECTING' }),
    camera({ id: 'd', name: 'D', state: 'CONNECTED' }),
  ]

  it('asks only for online cameras, in the order given', () => {
    expect(thumbnailPlan(cameras, {})).toEqual(['a', 'd'])
  })

  it('leaves out anything already in flight or already answered', () => {
    const loaded: Record<string, ThumbnailEntry> = {
      a: { status: 'loading', requestId: REQ },
      d: { status: 'unavailable', reason: 'Camera is offline' },
    }
    expect(thumbnailPlan(cameras, loaded)).toEqual([])
  })

  it('asks again once an entry is dropped', () => {
    const loaded: Record<string, ThumbnailEntry> = { a: { status: 'loading', requestId: REQ } }
    expect(thumbnailPlan(cameras, loaded)).toEqual(['d'])
  })
})

describe('thumbnailsReducer', () => {
  it('marks ids in flight once, so a re-render cannot ask twice', () => {
    const first = loadingState('a', 'b')
    expect(Object.keys(first.entries)).toEqual(['a', 'b'])
    // Same action again: no change at all, so React does not re-render in a loop.
    expect(
      thumbnailsReducer(first, { type: 'request', requestId: REQ, cameraIds: ['a', 'b'] }),
    ).toBe(first)
  })

  it('stores a snapshot for a camera it was waiting on', () => {
    const next = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(next.entries.a).toEqual({
      status: 'ready',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
      capturedAt: 1_762_000_000_000,
    })
    expect(next.error).toBeNull()
  })

  it('treats an unavailable snapshot as a placeholder, not a failure (CAM-3)', () => {
    const next = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: UNAVAILABLE,
    })
    expect(next.entries.a).toEqual({ status: 'unavailable', reason: 'Camera is offline' })
    // CAM-3 is normal: nothing goes in the list-level problem banner.
    expect(next.error).toBeNull()
  })

  it('surfaces an IpcError as a list-level problem', () => {
    const next = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(next.entries.a).toEqual({ status: 'failed', error: ERROR })
    expect(next.error).toBe(ERROR)
  })

  it('ignores a result for a camera it is not waiting on', () => {
    // A snapshot that lands after a Refresh cleared the cache, or after the camera went offline:
    // writing it back would put an image next to an "Offline" placeholder.
    const state = loadingState('a')
    expect(
      thumbnailsReducer(state, {
        type: 'result',
        requestId: REQ,
        cameraId: 'b',
        result: okSnapshot(2),
      }),
    ).toBe(state)
    const answered = thumbnailsReducer(state, {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(
      thumbnailsReducer(answered, {
        type: 'result',
        requestId: REQ,
        cameraId: 'a',
        result: okSnapshot(9),
      }),
    ).toBe(answered)
  })

  it('drops a reply from a superseded request, however it is interleaved', () => {
    // The camera dropped off and came back while the first request was still in flight: two
    // requests are outstanding for the same camera. Without a request id the slot can only say
    // "loading", so the first request's bytes land in the second's slot and the second's reply is
    // then thrown away as stale — showing exactly the image the second was meant to replace.
    const first = thumbnailsReducer(EMPTY_THUMBNAILS, {
      type: 'request',
      requestId: 1,
      cameraIds: ['a'],
    })
    const second = thumbnailsReducer(dropCamera(first, 'a'), {
      type: 'request',
      requestId: 2,
      cameraIds: ['a'],
    })

    // Stale reply first: it must not fill the new slot.
    const afterStale = thumbnailsReducer(second, {
      type: 'result',
      requestId: 1,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(afterStale).toBe(second)

    // The reply that was asked for still applies.
    const afterFresh = thumbnailsReducer(afterStale, {
      type: 'result',
      requestId: 2,
      cameraId: 'a',
      result: okSnapshot(2),
    })
    expect(afterFresh.entries.a).toMatchObject({ status: 'ready', bytes: new Uint8Array([2]) })

    // And the other order: a stale reply arriving after the fresh one cannot undo it.
    expect(
      thumbnailsReducer(afterFresh, {
        type: 'result',
        requestId: 1,
        cameraId: 'a',
        result: okSnapshot(1),
      }),
    ).toBe(afterFresh)
  })

  it('does not re-stamp a camera a newer batch is already waiting on', () => {
    const second = thumbnailsReducer(loadingState('a'), {
      type: 'request',
      requestId: REQ + 1,
      cameraIds: ['a'],
    })
    // Still batch REQ's slot: the plan excludes anything in flight, so a second batch never
    // contains it in practice, and if it did it must not orphan the outstanding request.
    expect(second.entries.a).toEqual({ status: 'loading', requestId: REQ })
  })

  it('drops a cached thumbnail when its camera goes offline, and fetches again on recovery', () => {
    const cam = camera({ id: 'a', name: 'Alley', state: 'CONNECTED' })
    const ready = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(thumbnailPlan([cam], ready.entries)).toEqual([])

    const offline = { ...cam, state: 'DISCONNECTED' }
    const afterOutage = thumbnailsReducer(ready, { type: 'sync', cameras: [offline] })
    expect(afterOutage.entries.a).toBeUndefined()
    // Still nothing to fetch while it is offline — a snapshot of it would spend a permit to be
    // told so (SPEC R9, CAM-3).
    expect(thumbnailPlan([offline], afterOutage.entries)).toEqual([])

    // CAM-2: the devices feed says CONNECTED again, with no user action in between.
    const recovered = thumbnailsReducer(afterOutage, { type: 'sync', cameras: [cam] })
    expect(thumbnailPlan([cam], recovered.entries)).toEqual(['a'])
  })

  it('drops the entry of a camera that left the inventory', () => {
    const ready = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(thumbnailsReducer(ready, { type: 'sync', cameras: [] }).entries).toEqual({})
  })

  it('leaves the state identical when a sync changes nothing', () => {
    const cam = camera({ id: 'a', state: 'CONNECTED' })
    const ready = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: okSnapshot(1),
    })
    expect(thumbnailsReducer(ready, { type: 'sync', cameras: [cam] })).toBe(ready)
  })
})

describe('RTSPS qualities in the thumbnail cache (QUAL-7)', () => {
  const AVAILABLE: RtspsAvailability = { high: true, medium: false, low: true, package: false }

  function streamsReply(
    state: ThumbnailsState,
    cameraId: string,
    result: IpcResult<RtspsAvailability>,
    requestId = REQ,
  ): ThumbnailsState {
    return thumbnailsReducer(state, { type: 'streams', requestId, cameraId, result })
  }

  it('is asked for in the same batch as the thumbnail', () => {
    expect(loadingState('a').streams.a).toEqual({ status: 'loading', requestId: REQ })
  })

  it('stores the booleans for a camera it was waiting on', () => {
    const next = streamsReply(loadingState('a'), 'a', { ok: true, value: AVAILABLE })
    expect(next.streams.a).toEqual({ status: 'known', available: AVAILABLE })
    // The thumbnail slot is its own: still waiting for the snapshot.
    expect(next.entries.a).toEqual({ status: 'loading', requestId: REQ })
  })

  it('turns a failure into "unknown" and keeps it out of the list-level problem', () => {
    const next = streamsReply(loadingState('a'), 'a', { ok: false, error: ERROR })
    expect(next.streams.a).toEqual({ status: 'unknown' })
    expect(next.error).toBeNull()
  })

  it('drops a reply from a superseded request or for a camera it is not waiting on', () => {
    const second = thumbnailsReducer(dropCamera(loadingState('a'), 'a'), {
      type: 'request',
      requestId: REQ + 1,
      cameraIds: ['a'],
    })
    expect(streamsReply(second, 'a', { ok: true, value: AVAILABLE }, REQ)).toBe(second)
    expect(streamsReply(second, 'b', { ok: true, value: AVAILABLE }, REQ + 1)).toBe(second)
    const answered = streamsReply(second, 'a', { ok: true, value: AVAILABLE }, REQ + 1)
    expect(streamsReply(answered, 'a', { ok: false, error: ERROR }, REQ + 1)).toBe(answered)
  })

  it('is dropped with the thumbnail when the camera goes offline', () => {
    const known = streamsReply(loadingState('a'), 'a', { ok: true, value: AVAILABLE })
    expect(dropCamera(known, 'a').streams).toEqual({})
  })

  it('is asked for only after a snapshot that did not fail at list level', () => {
    expect(wantsStreamsQuery(okSnapshot(1))).toBe(true)
    // CAM-3's "no image" is about the camera; the console answered, so the GET is worth it.
    expect(wantsStreamsQuery(UNAVAILABLE)).toBe(true)
    expect(wantsStreamsQuery({ ok: false, error: ERROR })).toBe(false)
  })

  it('reads "unknown" even if a feed state answers after a list-level snapshot failure', () => {
    // Defensive: the component sends no GET after such a failure, but a reply that arrives anyway
    // must not turn the row into "known".
    const failed = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(failed.streams.a).toEqual({ status: 'unknown' })
    expect(streamsReply(failed, 'a', { ok: true, value: AVAILABLE })).toBe(failed)
  })

  it('reads "unknown" when a list-level snapshot failure lands after a feed state (defensive)', () => {
    const known = streamsReply(loadingState('a'), 'a', { ok: true, value: AVAILABLE })
    const failed = thumbnailsReducer(known, {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(failed.streams.a).toEqual({ status: 'unknown' })
  })

  it('keeps the feed state beside a camera-specific "no image" (CAM-3)', () => {
    const unavailable = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: UNAVAILABLE,
    })
    expect(streamsReply(unavailable, 'a', { ok: true, value: AVAILABLE }).streams.a).toEqual({
      status: 'known',
      available: AVAILABLE,
    })
  })

  it('settles the streams slot as "unknown" when the snapshot failed at list level', () => {
    const failed = thumbnailsReducer(loadingState('a', 'b'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(failed.streams.a).toEqual({ status: 'unknown' })
    // The other camera's slot, and a camera whose snapshot loaded, keep waiting for the GET.
    expect(failed.streams.b).toEqual({ status: 'loading', requestId: REQ })
    const loaded = thumbnailsReducer(failed, {
      type: 'result',
      requestId: REQ,
      cameraId: 'b',
      result: okSnapshot(2),
    })
    expect(loaded.streams.b).toEqual({ status: 'loading', requestId: REQ })
  })

  it('leaves a newer batch’s streams slot alone on a stale failed snapshot', () => {
    const second = thumbnailsReducer(dropCamera(loadingState('a'), 'a'), {
      type: 'request',
      requestId: REQ + 1,
      cameraIds: ['a'],
    })
    const stale = thumbnailsReducer(second, {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(stale).toBe(second)
  })

  it('is left identical by a sync that changes nothing', () => {
    const known = streamsReply(loadingState('a'), 'a', { ok: true, value: AVAILABLE })
    expect(thumbnailsReducer(known, { type: 'sync', cameras: [camera({ id: 'a' })] })).toBe(known)
  })
})

describe('rtspsSummary (QUAL-7)', () => {
  const plain = camera({ id: 'a' })
  const doorbell = camera({ id: 'd', hasPackageCamera: true })
  const none: RtspsAvailability = { high: false, medium: false, low: false, package: false }

  it('shows nothing for a camera that was never asked about (offline)', () => {
    expect(rtspsSummary(plain, undefined)).toBeNull()
  })

  it('says loading, then unknown on a failure', () => {
    expect(rtspsSummary(plain, { status: 'loading', requestId: REQ })).toEqual({ kind: 'loading' })
    expect(rtspsSummary(plain, { status: 'unknown' })).toEqual({ kind: 'unknown' })
  })

  it('lists every quality best first with its badge label, absent ones marked', () => {
    const summary = rtspsSummary(plain, {
      status: 'known',
      available: { ...none, high: true, low: true },
    })
    expect(summary).toEqual({
      kind: 'known',
      badges: [
        { quality: 'high', label: 'HIGH', present: true },
        { quality: 'medium', label: 'MED', present: false },
        { quality: 'low', label: 'LOW', present: true },
      ],
    })
  })

  it('lists the package channel only for a camera that has one, or when the console reports it', () => {
    const lowOnly = { status: 'known', available: { ...none, low: true } } as const
    const quals = (cam: Camera, entry: Parameters<typeof rtspsSummary>[1]) => {
      const summary = rtspsSummary(cam, entry)
      return summary?.kind === 'known' ? summary.badges.map((b) => b.quality) : []
    }
    expect(quals(plain, lowOnly)).toEqual(['high', 'medium', 'low'])
    expect(quals(doorbell, lowOnly)).toEqual(['high', 'medium', 'low', 'package'])
    expect(
      quals(plain, { status: 'known', available: { ...none, low: true, package: true } }),
    ).toContain('package')
  })

  it('says "none yet" when no quality exists', () => {
    expect(rtspsSummary(doorbell, { status: 'known', available: none })).toEqual({ kind: 'none' })
  })
})

describe('setupGaps (CON-1/CON-3)', () => {
  const cases = [
    {
      label: 'a fresh install',
      input: status({ hostPort: null, pinned: false, credentialStored: false }),
      want: ['host', 'credential', 'certificate'],
    },
    {
      label: 'a host with no key',
      input: status({ credentialStored: false }),
      want: ['credential'],
    },
    {
      label: 'a key with no accepted certificate',
      input: status({ pinned: false }),
      want: ['certificate'],
    },
    { label: 'an unresolvable address', input: status({ hostPort: null }), want: ['host'] },
    { label: 'a console that is ready', input: status(), want: [] },
    // An empty list on a connected console is not a setup problem: it is an answer.
    { label: 'a connected console', input: status({ phase: 'connected' }), want: [] },
  ] as const

  for (const { label, input, want } of cases) {
    it(`reports ${want.length === 0 ? 'nothing missing' : want.join(', ')} for ${label}`, () => {
      expect(setupGaps(input)).toEqual(want)
    })
  }
})

describe('cameraListBody', () => {
  const cases = [
    {
      label: 'a fresh install with nothing set up',
      cameraCount: 0,
      gaps: ['host', 'credential', 'certificate'],
      body: 'setup',
      banner: false,
    },
    {
      label: 'a ready console that has not been asked yet',
      cameraCount: 0,
      gaps: [],
      body: 'empty',
      banner: false,
    },
    { label: 'cameras in hand', cameraCount: 3, gaps: [], body: 'grid', banner: false },
    {
      // The key missing on a console whose cameras are already listed — e.g. the user cleared it
      // in Settings. Replacing the grid with "the app has never reached a console" would be
      // untrue and would throw away the only thing this screen is for.
      label: 'cameras in hand but a credential cleared',
      cameraCount: 3,
      gaps: ['credential'],
      body: 'grid',
      banner: true,
    },
    {
      label: 'cameras in hand but the pin gone',
      cameraCount: 1,
      gaps: ['certificate'],
      body: 'grid',
      banner: true,
    },
  ] as const

  for (const { label, cameraCount, gaps, body, banner } of cases) {
    it(`shows the ${body} body for ${label}`, () => {
      expect(cameraListBody(cameraCount, gaps)).toBe(body)
      expect(cameraListShowsSetupBanner(cameraCount, gaps)).toBe(banner)
    })
  }

  it('shows the loading body during the first load, banner or not (P4.5)', () => {
    expect(cameraListBody(3, [], true)).toBe('loading')
    expect(cameraListBody(0, ['host'], true)).toBe('loading')
    expect(cameraListShowsSetupBanner(3, ['credential'], true)).toBe(false)
  })
})

describe('loading the list all at once (P4.5, CAM-1/QUAL-7)', () => {
  const AVAILABLE: RtspsAvailability = { high: true, medium: true, low: false, package: false }
  const LOAD = 10

  function start(
    state: ThumbnailsState,
    requestId = LOAD,
    shownIds: readonly string[] = [],
  ): ThumbnailsState {
    return thumbnailsReducer(state, { type: 'loadStart', requestId, shownIds })
  }

  function plan(state: ThumbnailsState, cameraIds: string[], requestId = LOAD): ThumbnailsState {
    return thumbnailsReducer(state, { type: 'loadPlan', requestId, cameraIds })
  }

  function snap(
    state: ThumbnailsState,
    cameraId: string,
    result: IpcResult<SnapshotResult>,
    requestId = LOAD,
  ): ThumbnailsState {
    return thumbnailsReducer(state, { type: 'result', requestId, cameraId, result })
  }

  function feed(
    state: ThumbnailsState,
    cameraId: string,
    result: IpcResult<RtspsAvailability> = { ok: true, value: AVAILABLE },
    requestId = LOAD,
  ): ThumbnailsState {
    return thumbnailsReducer(state, { type: 'streams', requestId, cameraId, result })
  }

  /** A load of `ids` that has completed with a snapshot `byte` and the feed state for each. */
  function loaded(ids: string[], byte = 1, requestId = LOAD): ThumbnailsState {
    let state = plan(start(EMPTY_THUMBNAILS, requestId), ids, requestId)
    for (const id of ids) {
      state = feed(snap(state, id, okSnapshot(byte), requestId), id, undefined, requestId)
    }
    return state
  }

  it('shows indeterminate progress from the first render of a load about to start', () => {
    // Cameras in hand and nothing loaded yet: the loading card shows before any dispatch, so the
    // bare grid never flashes (the component starts the load from an effect).
    const pending = { settled: 0, total: null, label: 'Loading cameras…' }
    expect(loadProgress(EMPTY_THUMBNAILS, 3)).toEqual(pending)
    expect(loadProgress(EMPTY_THUMBNAILS, 0)).toBeNull()
    // Started, inventory not answered yet: still indeterminate.
    expect(loadProgress(start(EMPTY_THUMBNAILS), 3)).toEqual(pending)
    expect(loadProgress(start(EMPTY_THUMBNAILS), 0)).toEqual(pending)
    // Done: nothing.
    expect(loadProgress(loaded(['a']), 1)).toBeNull()
  })

  it('shows indeterminate progress on a re-open that is about to reload (P5.2)', () => {
    // The cache outlives the tab, so a re-open finds a loaded grid; it reloads like Refresh and
    // the header shows the progress from the first render.
    const pending = { settled: 0, total: null, label: 'Loading cameras…' }
    expect(loadProgress(loaded(['a']), 1, true)).toEqual(pending)
  })

  it('counts cameras, each settling when its snapshot and its feed state have answered', () => {
    let state = plan(start(EMPTY_THUMBNAILS), ['a', 'b', 'c'])
    expect(loadProgress(state, 3)).toEqual({
      settled: 0,
      total: 3,
      label: 'Loading 0 / 3 cameras',
    })
    state = snap(state, 'a', okSnapshot(1))
    // The snapshot alone does not settle it: its feed state follows.
    expect(loadProgress(state, 3)).toMatchObject({ settled: 0, total: 3 })
    state = feed(state, 'a')
    expect(loadProgress(state, 3)).toMatchObject({ settled: 1, label: 'Loading 1 / 3 cameras' })
  })

  it('fills nothing on screen until every camera has settled, then swaps it in at once', () => {
    let state = plan(start(EMPTY_THUMBNAILS), ['a', 'b'])
    state = snap(state, 'a', okSnapshot(1))
    state = feed(state, 'a')
    state = snap(state, 'b', okSnapshot(2))
    expect(state.entries).toEqual({})
    expect(state.loaded).toBe(false)

    state = feed(state, 'b')
    expect(state.load).toBeNull()
    expect(state.loaded).toBe(true)
    expect(state.entries.a).toMatchObject({ status: 'ready', bytes: new Uint8Array([1]) })
    expect(state.entries.b).toMatchObject({ status: 'ready', bytes: new Uint8Array([2]) })
    expect(state.streams.b).toEqual({ status: 'known', available: AVAILABLE })
  })

  it('settles a camera on a list-level snapshot failure, with no feed-state request', () => {
    // A bad key costs no second request per camera: the component sends no GET
    // (`wantsStreamsQuery`), and the reducer does not wait for one.
    let state = plan(start(EMPTY_THUMBNAILS), ['a', 'b'])
    state = snap(state, 'a', { ok: false, error: ERROR })
    expect(loadProgress(state, 2)).toMatchObject({ settled: 1, total: 2 })
    state = snap(state, 'b', { ok: false, error: ERROR })
    expect(state.loaded).toBe(true)
    expect(state.entries.a).toEqual({ status: 'failed', error: ERROR })
    expect(state.streams.a).toEqual({ status: 'unknown' })
    expect(state.streams.b).toEqual({ status: 'unknown' })
    expect(state.error).toBe(ERROR)
  })

  it('completes with camera-specific failures too: the camera still shows', () => {
    let state = plan(start(EMPTY_THUMBNAILS), ['b'])
    state = snap(state, 'b', UNAVAILABLE)
    expect(state.loaded).toBe(false)
    state = feed(state, 'b', { ok: false, error: ERROR })
    expect(state.loaded).toBe(true)
    expect(state.entries.b).toEqual({ status: 'unavailable', reason: 'Camera is offline' })
    expect(state.streams.b).toEqual({ status: 'unknown' })
    expect(state.error).toBeNull()
  })

  it('completes at once when there is no online camera to ask about', () => {
    const state = plan(start(EMPTY_THUMBNAILS), [])
    expect(state.load).toBeNull()
    expect(state.loaded).toBe(true)
  })

  it('keeps the previous grid during a Refresh and replaces all of it, problem included', () => {
    const first = snap(
      plan(start(EMPTY_THUMBNAILS, 1), ['a'], 1),
      'a',
      { ok: false, error: ERROR },
      1,
    )
    expect(first.loaded).toBe(true)
    expect(first.error).toBe(ERROR)

    let state = plan(start(first, 2, ['a']), ['a'], 2)
    state = snap(state, 'a', okSnapshot(5), 2)
    // Still the old grid, old problem and all.
    expect(state.entries.a).toEqual({ status: 'failed', error: ERROR })
    expect(state.error).toBe(ERROR)
    state = feed(state, 'a', undefined, 2)
    expect(state.entries.a).toMatchObject({ status: 'ready', bytes: new Uint8Array([5]) })
    expect(state.streams.a).toEqual({ status: 'known', available: AVAILABLE })
    expect(state.error).toBeNull()
  })

  it('drops the replies of a superseded load (a Refresh during a load), without counting them', () => {
    let state = plan(start(EMPTY_THUMBNAILS, 1), ['a'], 1)
    state = plan(start(state, 2), ['a'], 2)
    const stale = feed(snap(state, 'a', okSnapshot(1), 1), 'a', undefined, 1)
    expect(stale).toBe(state)
    // A plan from the superseded load cannot overwrite the new one either.
    expect(plan(state, ['x', 'y'], 1)).toBe(state)
    const done = feed(snap(state, 'a', okSnapshot(2), 2), 'a', undefined, 2)
    expect(done.entries.a).toMatchObject({ status: 'ready', bytes: new Uint8Array([2]) })
  })

  it('ignores a reply for a camera the load did not plan', () => {
    const state = plan(start(EMPTY_THUMBNAILS), ['a'])
    expect(snap(state, 'z', okSnapshot(1))).toBe(state)
  })

  it('counts a reply for a camera that went offline mid-load, but does not apply it (CAM-3)', () => {
    let state = plan(start(EMPTY_THUMBNAILS), ['a', 'b'])
    state = thumbnailsReducer(state, {
      type: 'sync',
      cameras: [camera({ id: 'a', state: 'DISCONNECTED' }), camera({ id: 'b' })],
    })
    state = feed(snap(state, 'a', okSnapshot(1)), 'a')
    state = feed(snap(state, 'b', okSnapshot(2)), 'b')
    expect(state.loaded).toBe(true)
    expect(state.entries.a).toBeUndefined()
    expect(state.streams.a).toBeUndefined()
    // When the devices feed says CONNECTED again, the incremental path asks for it on its own.
    const back = [camera({ id: 'a', name: 'A' }), camera({ id: 'b', name: 'B' })]
    expect(fetchesIncrementally(state)).toBe(true)
    expect(thumbnailPlan(back, state.entries)).toEqual(['a'])
  })

  it('abandons a load when the inventory empties, so returning cameras load all at once', () => {
    const inFlight = snap(
      plan(start(loaded(['a'], 1, 1), 2, ['a']), ['a'], 2),
      'a',
      okSnapshot(2),
      2,
    )
    const emptied = thumbnailsReducer(inFlight, { type: 'sync', cameras: [] })
    expect(emptied).toEqual(EMPTY_THUMBNAILS)
    // The abandoned load's late replies match nothing.
    expect(feed(emptied, 'a', undefined, 2)).toBe(emptied)
    expect(wantsLoad(emptied, 2)).toBe(true)
    expect(fetchesIncrementally(emptied)).toBe(false)
  })

  it('lets incremental replies land in the grid while a load is in flight', () => {
    const grid = thumbnailsReducer(loaded(['a'], 1, 1), {
      type: 'request',
      requestId: 2,
      cameraIds: ['b'],
    })
    const refreshing = start(grid, 3, ['a', 'b'])
    const next = snap(refreshing, 'b', okSnapshot(9), 2)
    expect(next.entries.b).toMatchObject({ status: 'ready' })
    expect(next.load).toEqual(refreshing.load)
  })

  it('shows the grid it had during a Refresh, with live state; everything otherwise', () => {
    const a = camera({ id: 'a', name: 'A' })
    const b = camera({ id: 'b', name: 'B', state: 'DISCONNECTED' })
    const added = camera({ id: 'c', name: 'C' })
    const sorted = [a, b, added]
    const grid = loaded(['a'])
    expect(gridCameras(sorted, grid)).toBe(sorted)
    // The first load shows no grid at all (the progress replaces it), so nothing is filtered.
    expect(gridCameras(sorted, start(EMPTY_THUMBNAILS))).toBe(sorted)
    // A Refresh: the camera the new inventory adds waits for the swap; `b` keeps its live state.
    expect(gridCameras(sorted, start(grid, LOAD + 1, ['a', 'b']))).toEqual([a, b])
  })

  it('starts a load by itself only with cameras in hand, never loaded, and none in flight', () => {
    expect(wantsLoad(EMPTY_THUMBNAILS, 0)).toBe(false)
    expect(wantsLoad(EMPTY_THUMBNAILS, 3)).toBe(true)
    expect(wantsLoad(start(EMPTY_THUMBNAILS), 3)).toBe(false)
    expect(wantsLoad(loaded(['a']), 3)).toBe(false)
    expect(fetchesIncrementally(EMPTY_THUMBNAILS)).toBe(false)
    expect(fetchesIncrementally(start(loaded(['a']), LOAD + 1))).toBe(false)
  })

  it('forgets a completed load when the inventory empties', () => {
    const emptied = thumbnailsReducer(loaded(['a']), { type: 'sync', cameras: [] })
    expect(emptied).toEqual(EMPTY_THUMBNAILS)
    expect(wantsLoad(emptied, 2)).toBe(true)
    // Already empty: the same object back, so React does not re-render.
    expect(thumbnailsReducer(EMPTY_THUMBNAILS, { type: 'sync', cameras: [] })).toBe(
      EMPTY_THUMBNAILS,
    )
  })
})

describe('packageSnapshotsReducer (P5.2, CAM-4)', () => {
  const bell = (state = 'CONNECTED', hasPackageCamera = true): Camera =>
    camera({ id: 'bell', state, hasPackageCamera })

  it('stamps only cameras with no entry, and leaves the state alone when there are none', () => {
    const asked = packageSnapshotsReducer(
      {},
      { type: 'request', requestId: 1, cameraIds: ['bell'] },
    )
    expect(asked).toEqual({ bell: { status: 'loading', requestId: 1 } })
    const again = packageSnapshotsReducer(asked, {
      type: 'request',
      requestId: 2,
      cameraIds: ['bell'],
    })
    expect(again).toBe(asked)
  })

  it("fills a slot only from the request that stamped it, with CAM-3's meaning", () => {
    const asked = packageSnapshotsReducer(
      {},
      { type: 'request', requestId: 1, cameraIds: ['bell'] },
    )
    const stale = packageSnapshotsReducer(asked, {
      type: 'result',
      requestId: 7,
      cameraId: 'bell',
      result: okSnapshot(9),
    })
    expect(stale).toBe(asked)
    const ready = packageSnapshotsReducer(asked, {
      type: 'result',
      requestId: 1,
      cameraId: 'bell',
      result: okSnapshot(9),
    })
    expect(ready.bell).toMatchObject({ status: 'ready', bytes: new Uint8Array([9]) })
    const none = packageSnapshotsReducer(asked, {
      type: 'result',
      requestId: 1,
      cameraId: 'bell',
      result: UNAVAILABLE,
    })
    expect(none.bell).toEqual({ status: 'unavailable', reason: 'Camera is offline' })
    const failed = packageSnapshotsReducer(asked, {
      type: 'result',
      requestId: 1,
      cameraId: 'bell',
      result: { ok: false, error: ERROR },
    })
    expect(failed.bell).toEqual({ status: 'failed', error: ERROR })
  })

  it('drops a reply that arrives after the camera went offline', () => {
    const asked = packageSnapshotsReducer(
      {},
      { type: 'request', requestId: 1, cameraIds: ['bell'] },
    )
    const dropped = packageSnapshotsReducer(asked, {
      type: 'sync',
      cameras: [bell('DISCONNECTED')],
    })
    expect(dropped).toEqual({})
    const late = packageSnapshotsReducer(dropped, {
      type: 'result',
      requestId: 1,
      cameraId: 'bell',
      result: okSnapshot(1),
    })
    expect(late).toEqual({})
  })

  it('keeps an entry while the camera is online with a package camera, and drops it otherwise', () => {
    const ready = packageSnapshotsReducer(
      packageSnapshotsReducer({}, { type: 'request', requestId: 1, cameraIds: ['bell'] }),
      { type: 'result', requestId: 1, cameraId: 'bell', result: okSnapshot(1) },
    )
    expect(packageSnapshotsReducer(ready, { type: 'sync', cameras: [bell()] })).toBe(ready)
    expect(packageSnapshotsReducer(ready, { type: 'sync', cameras: [bell('CONNECTING')] })).toEqual(
      {},
    )
    expect(
      packageSnapshotsReducer(ready, { type: 'sync', cameras: [bell('CONNECTED', false)] }),
    ).toEqual({})
    expect(
      packageSnapshotsReducer(ready, { type: 'sync', cameras: [camera({ id: 'other' })] }),
    ).toEqual({})
    // An emptied inventory clears the record.
    expect(packageSnapshotsReducer(ready, { type: 'sync', cameras: [] })).toEqual({})
  })
})

describe('snapshot-only requests, feed state alone, and forgetting failures (P5.2)', () => {
  const AVAILABLE: RtspsAvailability = { high: true, medium: false, low: false, package: false }

  it('a request without streams stamps the thumbnail only', () => {
    const state = thumbnailsReducer(EMPTY_THUMBNAILS, {
      type: 'request',
      requestId: 4,
      cameraIds: ['a', 'a'],
      streams: false,
    })
    expect(state.entries).toEqual({ a: { status: 'loading', requestId: 4 } })
    expect(state.streams).toEqual({})
    // A list-level failure then leaves no streams slot behind, rather than "unknown".
    const failed = thumbnailsReducer(state, {
      type: 'result',
      requestId: 4,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(failed.streams).toEqual({})
  })

  it('streamsPlan picks online cameras with an answered thumbnail and no streams slot', () => {
    const cameras = [
      camera({ id: 'ready' }),
      camera({ id: 'none' }),
      camera({ id: 'loading' }),
      camera({ id: 'failed' }),
      camera({ id: 'has' }),
      camera({ id: 'off', state: 'DISCONNECTED' }),
      camera({ id: 'absent' }),
    ]
    const entries: Record<string, ThumbnailEntry> = {
      ready: { status: 'ready', bytes: new Uint8Array([1]), mimeType: 'image/jpeg', capturedAt: 1 },
      none: { status: 'unavailable', reason: 'x' },
      loading: { status: 'loading', requestId: 1 },
      failed: { status: 'failed', error: ERROR },
      has: { status: 'unavailable', reason: 'x' },
      off: { status: 'unavailable', reason: 'x' },
    }
    expect(streamsPlan(cameras, { entries, streams: { has: { status: 'unknown' } } })).toEqual([
      'ready',
      'none',
    ])
  })

  it('requestStreams stamps only cameras with a thumbnail and no streams slot, then fills them', () => {
    const base = thumbnailsReducer(
      thumbnailsReducer(EMPTY_THUMBNAILS, {
        type: 'request',
        requestId: 1,
        cameraIds: ['a'],
        streams: false,
      }),
      { type: 'result', requestId: 1, cameraId: 'a', result: okSnapshot(1) },
    )
    const asked = thumbnailsReducer(base, {
      type: 'requestStreams',
      requestId: 2,
      cameraIds: ['a', 'stranger'],
    })
    expect(asked.streams).toEqual({ a: { status: 'loading', requestId: 2 } })
    expect(
      thumbnailsReducer(asked, { type: 'requestStreams', requestId: 3, cameraIds: ['a'] }),
    ).toBe(asked)
    const known = thumbnailsReducer(asked, {
      type: 'streams',
      requestId: 2,
      cameraId: 'a',
      result: { ok: true, value: AVAILABLE },
    })
    expect(known.streams.a).toEqual({ status: 'known', available: AVAILABLE })
  })

  it('forget drops only failed and unavailable entries, with their streams slot', () => {
    let state = thumbnailsReducer(EMPTY_THUMBNAILS, {
      type: 'request',
      requestId: 1,
      cameraIds: ['bad', 'none', 'good', 'busy'],
    })
    state = thumbnailsReducer(state, {
      type: 'result',
      requestId: 1,
      cameraId: 'bad',
      result: { ok: false, error: ERROR },
    })
    state = thumbnailsReducer(state, {
      type: 'result',
      requestId: 1,
      cameraId: 'none',
      result: UNAVAILABLE,
    })
    state = thumbnailsReducer(state, {
      type: 'result',
      requestId: 1,
      cameraId: 'good',
      result: okSnapshot(1),
    })
    const forgotten = thumbnailsReducer(state, {
      type: 'forget',
      cameraIds: ['bad', 'none', 'good', 'busy', 'stranger'],
    })
    expect(Object.keys(forgotten.entries).sort()).toEqual(['busy', 'good'])
    expect(Object.keys(forgotten.streams).sort()).toEqual(['busy', 'good'])
    expect(thumbnailsReducer(forgotten, { type: 'forget', cameraIds: ['good'] })).toBe(forgotten)
  })

  it('forget works the same on the package record', () => {
    const asked = packageSnapshotsReducer(
      {},
      { type: 'request', requestId: 1, cameraIds: ['p', 'q'] },
    )
    const answered = packageSnapshotsReducer(
      packageSnapshotsReducer(asked, {
        type: 'result',
        requestId: 1,
        cameraId: 'p',
        result: UNAVAILABLE,
      }),
      { type: 'result', requestId: 1, cameraId: 'q', result: okSnapshot(2) },
    )
    const forgotten = packageSnapshotsReducer(answered, { type: 'forget', cameraIds: ['p', 'q'] })
    expect(Object.keys(forgotten)).toEqual(['q'])
    expect(packageSnapshotsReducer(forgotten, { type: 'forget', cameraIds: ['q'] })).toBe(forgotten)
  })
})
