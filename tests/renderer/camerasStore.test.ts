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
//  - the bounded concurrency that keeps a 15-camera refresh from spending the whole 10 req/s
//    budget (SPEC R9).
//  - QUAL-7's RTSPS qualities riding the thumbnail lifecycle (P3.7): same batch, same stale rules,
//    dropped and refetched with the thumbnail, a failure that stays quiet, and no GET at all for a
//    camera whose snapshot failed at list level.
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
  rtspsSummary,
  runWithConcurrency,
  setupGaps,
  sortCameras,
  streamsQueryPlan,
  THUMBNAIL_CONCURRENCY,
  thumbnailPlan,
  thumbnailsReducer,
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

  it('drops a reply from a superseded batch, however it is interleaved', () => {
    // Refresh while the first batch is still in flight: the two batches are both outstanding for
    // the same camera. Without a request id the slot can only say "loading", so the first batch's
    // bytes land in the second batch's slot and the second batch's reply is then thrown away as
    // stale — Refresh showing exactly the image it was meant to replace.
    const first = thumbnailsReducer(EMPTY_THUMBNAILS, {
      type: 'request',
      requestId: 1,
      cameraIds: ['a'],
    })
    const refreshed = thumbnailsReducer(first, { type: 'refresh' })
    const second = thumbnailsReducer(refreshed, {
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

  it('clears everything on refresh, problem included', () => {
    const failed = thumbnailsReducer(loadingState('a'), {
      type: 'result',
      requestId: REQ,
      cameraId: 'a',
      result: { ok: false, error: ERROR },
    })
    expect(thumbnailsReducer(failed, { type: 'refresh' })).toEqual(EMPTY_THUMBNAILS)
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

  it('drops a reply from a superseded batch or for a camera it is not waiting on', () => {
    const second = thumbnailsReducer(thumbnailsReducer(loadingState('a'), { type: 'refresh' }), {
      type: 'request',
      requestId: REQ + 1,
      cameraIds: ['a'],
    })
    expect(streamsReply(second, 'a', { ok: true, value: AVAILABLE }, REQ)).toBe(second)
    expect(streamsReply(second, 'b', { ok: true, value: AVAILABLE }, REQ + 1)).toBe(second)
    const answered = streamsReply(second, 'a', { ok: true, value: AVAILABLE }, REQ + 1)
    expect(streamsReply(answered, 'a', { ok: false, error: ERROR }, REQ + 1)).toBe(answered)
  })

  it('is dropped with the thumbnail when the camera goes offline, and cleared by Refresh', () => {
    const known = streamsReply(loadingState('a'), 'a', { ok: true, value: AVAILABLE })
    const offline = camera({ id: 'a', state: 'DISCONNECTED' })
    expect(thumbnailsReducer(known, { type: 'sync', cameras: [offline] }).streams).toEqual({})
    expect(thumbnailsReducer(known, { type: 'refresh' })).toEqual(EMPTY_THUMBNAILS)
  })

  it('is asked for only after a snapshot that did not fail at list level', () => {
    expect(wantsStreamsQuery(okSnapshot(1))).toBe(true)
    // CAM-3's "no image" is about the camera; the console answered, so the GET is worth it.
    expect(wantsStreamsQuery(UNAVAILABLE)).toBe(true)
    expect(wantsStreamsQuery({ ok: false, error: ERROR })).toBe(false)
  })

  it('plans the second pass in batch order, skipping failed and unanswered snapshots', () => {
    const snapshots = new Map<string, IpcResult<SnapshotResult>>([
      ['c', okSnapshot(3)],
      ['a', okSnapshot(1)],
      ['b', { ok: false, error: ERROR }],
      ['d', UNAVAILABLE],
    ])
    expect(streamsQueryPlan(['a', 'b', 'c', 'd', 'e'], snapshots)).toEqual(['a', 'c', 'd'])
    expect(streamsQueryPlan([], snapshots)).toEqual([])
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
    const second = thumbnailsReducer(thumbnailsReducer(loadingState('a'), { type: 'refresh' }), {
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

describe('runWithConcurrency (SPEC R9)', () => {
  /** A promise per id that the test resolves by hand, so timing is not involved. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => undefined
    const promise = new Promise<void>((res) => {
      resolve = () => {
        res()
      }
    })
    return { promise, resolve }
  }

  it('never has more than `limit` calls outstanding, and makes every call once', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
    const started: string[] = []
    let inFlight = 0
    let peak = 0

    const run = runWithConcurrency(ids, 2, async (id) => {
      started.push(id)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      const gate = deferred()
      gates.set(id, gate)
      await gate.promise
      inFlight -= 1
    })

    // Only the first two may have started before anything finished.
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])

    // Release them one at a time; each release lets exactly one more start.
    for (const id of ids) {
      gates.get(id)?.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    await run

    expect(peak).toBe(2)
    expect(started).toEqual(ids)
  })

  it('does nothing for an empty list', async () => {
    let calls = 0
    await runWithConcurrency([], THUMBNAIL_CONCURRENCY, async () => {
      calls += 1
      await Promise.resolve()
    })
    expect(calls).toBe(0)
  })

  it('still runs with a limit below one, and with a limit above the list', async () => {
    const seen: number[] = []
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      seen.push(n)
      await Promise.resolve()
    })
    await runWithConcurrency([4], 50, async (n) => {
      seen.push(n)
      await Promise.resolve()
    })
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('caps a 15-camera refresh well below the console budget', () => {
    // 10 requests per second per key (SPEC R9): three at a time leaves most of each second for
    // the live device feed and whatever the user is doing.
    expect(THUMBNAIL_CONCURRENCY).toBeGreaterThanOrEqual(2)
    expect(THUMBNAIL_CONCURRENCY).toBeLessThanOrEqual(3)
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
})
