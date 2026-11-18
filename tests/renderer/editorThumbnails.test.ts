// P5.2 (VIEW-3): which snapshot a View editor cell shows, and which ones the draft still needs.
//
// What these tests protect: only the head camera of a cell is shown or fetched; a cached image of
// any state counts as "have it" (never re-asked, failures not retried); package refs go to their own
// record and only for a camera with a package camera; a missing or offline camera gets nothing.
import type { Camera, IpcError } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { ListLoad, ThumbnailEntry } from '../../src/renderer/src/state/camerasStore'
import {
  cellShownRef,
  cellSnapshot,
  editorRetryPlan,
  editorSnapshotPlan,
} from '../../src/renderer/src/features/viewEditor/editorThumbnails'

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

const ERROR: IpcError = {
  kind: 'auth',
  message: 'The Protect API key was rejected.',
  endpoint: null,
  retryable: false,
}

function ready(byte: number): ThumbnailEntry {
  return { status: 'ready', bytes: new Uint8Array([byte]), mimeType: 'image/jpeg', capturedAt: 1 }
}

const cell = (...cameraIds: string[]): { cameraIds: string[] } => ({ cameraIds })

const CAMERAS: Camera[] = [
  camera({ id: 'a' }),
  camera({ id: 'b' }),
  camera({ id: 'off', state: 'DISCONNECTED' }),
  camera({ id: 'bell', hasPackageCamera: true }),
]

describe('cellShownRef', () => {
  it('is the head of the list, or null for an empty cell', () => {
    expect(cellShownRef(cell('b', 'a'))).toBe('b')
    expect(cellShownRef(cell())).toBeNull()
  })
})

describe('editorSnapshotPlan (VIEW-3)', () => {
  it('asks for each distinct head camera once, in cell order, and nothing for the rest', () => {
    const plan = editorSnapshotPlan([cell('b', 'a'), cell('a'), cell('b'), cell()], CAMERAS, {}, {})
    expect(plan).toEqual({ cameraIds: ['b', 'a'], packageIds: [] })
  })

  it('skips cameras with any entry already: loading, ready, unavailable or failed', () => {
    const entries: Record<string, ThumbnailEntry> = {
      a: { status: 'loading', requestId: 3 },
      b: ready(1),
      bell: { status: 'failed', error: ERROR },
    }
    const plan = editorSnapshotPlan([cell('a'), cell('b'), cell('bell')], CAMERAS, entries, {})
    expect(plan.cameraIds).toEqual([])
    expect(
      editorSnapshotPlan([cell('a')], CAMERAS, { a: { status: 'unavailable', reason: 'x' } }, {})
        .cameraIds,
    ).toEqual([])
  })

  it('skips a missing camera and one that is not online (CAM-3)', () => {
    const plan = editorSnapshotPlan(
      [cell('gone'), cell('off'), cell('gone:package'), cell('off:package')],
      CAMERAS,
      {},
      {},
    )
    expect(plan).toEqual({ cameraIds: [], packageIds: [] })
  })

  it('sends a package ref to its own record, and only for a camera with a package camera', () => {
    const plan = editorSnapshotPlan([cell('bell:package'), cell('a:package')], CAMERAS, {}, {})
    expect(plan).toEqual({ cameraIds: [], packageIds: ['bell'] })
    // The main-channel entry of the same camera does not count for its package channel …
    expect(
      editorSnapshotPlan([cell('bell:package')], CAMERAS, { bell: ready(1) }, {}).packageIds,
    ).toEqual(['bell'])
    // … but its own record does.
    expect(
      editorSnapshotPlan([cell('bell:package')], CAMERAS, {}, { bell: ready(2) }).packageIds,
    ).toEqual([])
    // Both channels of one camera in two cells: one request each.
    expect(editorSnapshotPlan([cell('bell'), cell('bell:package')], CAMERAS, {}, {})).toEqual({
      cameraIds: ['bell'],
      packageIds: ['bell'],
    })
  })
})

describe('cellSnapshot (VIEW-3)', () => {
  const entries: Record<string, ThumbnailEntry> = {
    a: ready(1),
    b: { status: 'loading', requestId: 1 },
    bell: ready(3),
  }
  const packages: Record<string, ThumbnailEntry> = { bell: ready(4) }

  it("shows the head camera's ready image, and nothing for the others", () => {
    expect(cellSnapshot(cell('a', 'b'), CAMERAS, entries, packages)).toBe(entries.a)
    expect(cellSnapshot(cell('b', 'a'), CAMERAS, entries, packages)).toBeNull()
    expect(cellSnapshot(cell(), CAMERAS, entries, packages)).toBeNull()
  })

  it('shows the package channel for a package ref', () => {
    expect(cellSnapshot(cell('bell:package'), CAMERAS, entries, packages)).toBe(packages.bell)
    expect(cellSnapshot(cell('bell'), CAMERAS, entries, packages)).toBe(entries.bell)
  })

  it('stays text-only for a missing, offline or package-less camera, even with a cached image', () => {
    const cached = { gone: ready(1), off: ready(2), a: ready(3) }
    expect(cellSnapshot(cell('gone'), CAMERAS, cached, {})).toBeNull()
    expect(cellSnapshot(cell('off'), CAMERAS, cached, {})).toBeNull()
    expect(cellSnapshot(cell('a:package'), CAMERAS, cached, { a: ready(4) })).toBeNull()
  })

  it('stays text-only for an unavailable or failed snapshot', () => {
    expect(
      cellSnapshot(cell('a'), CAMERAS, { a: { status: 'unavailable', reason: 'x' } }, {}),
    ).toBeNull()
    expect(
      cellSnapshot(cell('a'), CAMERAS, { a: { status: 'failed', error: ERROR } }, {}),
    ).toBeNull()
  })
})

describe('editorSnapshotPlan with a Cameras-tab load in flight (P4.5)', () => {
  const loadOf = (outstanding: ListLoad['outstanding'], entries: string[] = []): ListLoad => ({
    requestId: 9,
    shownIds: [],
    outstanding,
    sheet: {
      entries: Object.fromEntries(entries.map((id) => [id, { status: 'loading', requestId: 9 }])),
      streams: {},
      error: null,
    },
  })

  it('waits for every main-channel camera while the load reads the inventory', () => {
    const plan = editorSnapshotPlan(
      [cell('a'), cell('bell:package')],
      CAMERAS,
      {},
      {},
      loadOf(null),
    )
    // The package channel is not the load's business.
    expect(plan).toEqual({ cameraIds: [], packageIds: ['bell'] })
  })

  it('leaves the cameras the load plans to it, and asks for the others', () => {
    const plan = editorSnapshotPlan(
      [cell('a'), cell('b')],
      CAMERAS,
      {},
      {},
      loadOf({ a: 2 }, ['a']),
    )
    expect(plan.cameraIds).toEqual(['b'])
  })
})

describe('editorRetryPlan (P5.2, once per open)', () => {
  it('lists the head cameras whose answer was failed or unavailable, per channel', () => {
    const entries: Record<string, ThumbnailEntry> = {
      a: { status: 'failed', error: ERROR },
      b: { status: 'unavailable', reason: 'x' },
      bell: ready(1),
      off: { status: 'failed', error: ERROR },
    }
    const packages: Record<string, ThumbnailEntry> = {
      bell: { status: 'unavailable', reason: 'x' },
    }
    const plan = editorRetryPlan(
      [cell('a'), cell('b'), cell('bell'), cell('bell:package'), cell('off'), cell('c', 'a')],
      CAMERAS,
      entries,
      packages,
    )
    expect(plan).toEqual({ cameraIds: ['a', 'b'], packageIds: ['bell'] })
  })

  it('lists nothing for loading, ready or missing entries', () => {
    const entries: Record<string, ThumbnailEntry> = {
      a: { status: 'loading', requestId: 1 },
      b: ready(1),
    }
    expect(editorRetryPlan([cell('a'), cell('b'), cell('bell')], CAMERAS, entries, {})).toEqual({
      cameraIds: [],
      packageIds: [],
    })
  })
})
