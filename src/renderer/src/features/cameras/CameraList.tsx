// The camera list screen (P1.7): every adopted camera with its name, model, state, audio
// availability and a snapshot thumbnail (CAM-1), kept current by main's devices feed (CAM-2) and
// showing a placeholder for anything that is not `CONNECTED` (CAM-3).
//
// It orchestrates and renders; it decides nothing. The rules live in `../../state/camerasStore` as
// pure functions (name fallback, presentation, order, which snapshots are still wanted, what a
// snapshot result means) because this project has no jsdom and CLAUDE.md asks for logic without UI
// to be unit-tested.
//
// Two things are worth knowing before reading the effects:
//
//  1. **The list loads all at once** (P4.5, CAM-1/QUAL-7). Opening the tab with cameras in hand,
//     cameras arriving on a list that never loaded, or Refresh starts a load: the inventory (not
//     when main has just pushed it), then every online camera at once — main throttles every
//     Protect call through one shared limiter (SPEC R9), so the burst cannot break the 10 req/s
//     budget, it only queues. Per camera the RTSPS feed state follows its snapshot, and is not
//     sent after a list-level failure (a bad key costs no second request per camera). The replies
//     fill a pending sheet; a progress bar counts the cameras ("Loading 7 / 18 cameras"), and when
//     the last has settled the reducer swaps the grid in at once. On Refresh the old grid stays up
//     until then, and a Refresh during a load supersedes it. Every request is bounded by main's
//     own per-request timeout, so a hung camera cannot hold the load for ever. The feed state is a
//     GET only: looking at the list never creates a stream (QUAL-8). Outside a load, a camera that
//     comes back online (CAM-3) or is added (CAM-2) fetches its own thumbnail and feed state,
//     which fill in on their own. Nothing is polled.
//  2. **Online state never comes from a snapshot.** It comes from `camera.state`, which the devices
//     feed pushes into `appStore` (CAM-2). A camera that goes offline shows a placeholder within
//     the 10 seconds G1 allows even though its last thumbnail loaded perfectly — during a load too,
//     because the grid always renders the live inventory.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import type { ConnectionPhase, IpcError, IpcResult } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import type { LoadProgress, SetupGap } from '../../state/camerasStore'
import {
  cameraDisplayName,
  cameraListBody,
  cameraListShowsSetupBanner,
  cameraPresentation,
  EMPTY_THUMBNAILS,
  fetchesIncrementally,
  gridCameras,
  loadProgress,
  rtspsSummary,
  setupGaps,
  SETUP_GAP_LABELS,
  sortCameras,
  thumbnailPlan,
  thumbnailsReducer,
  wantsLoad,
  wantsStreamsQuery,
} from '../../state/camerasStore'
import { GearIcon, PlugIcon, RefreshIcon } from '../../ui/icons'
import { CameraCard } from './CameraCard'
import { CameraThumbnail } from './CameraThumbnail'
import './cameras.css'

export interface CameraListProps {
  /** Takes the user to the screen that can fix a missing host, key or pin (CON-1/2/3). */
  readonly onOpenSettings: () => void
}

export function CameraList({ onOpenSettings }: CameraListProps): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const connection = useAppStore((s) => s.connection)
  const snapshot = useAppStore((s) => s.snapshot)
  const cameraStreamQualities = useAppStore((s) => s.cameraStreamQualities)
  const connect = useAppStore((s) => s.connect)
  const refreshCameras = useAppStore((s) => s.refreshCameras)

  const [thumbnails, dispatch] = useReducer(thumbnailsReducer, EMPTY_THUMBNAILS)
  /** A failure of the user's own action (connect, refresh), shown next to the control they used. */
  const [actionError, setActionError] = useState<IpcError | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * Stamps each load and each incremental request, so a reply can be matched to the request it
   * answers and a reply from a superseded load is dropped. A ref rather than state: it must not
   * cause a render, and requests are issued from effects.
   */
  const requestIdRef = useRef(0)
  /** Whether this mount has started its first load, which is the one that reads the inventory. */
  const openedRef = useRef(false)
  /** False once unmounted, so nothing more is sent for a screen that is gone. */
  const aliveRef = useRef(false)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const sorted = useMemo(() => sortCameras(cameras), [cameras])
  const shown = useMemo(() => gridCameras(sorted, thumbnails), [sorted, thumbnails])

  // CAM-2: fold the new inventory into both sheets. Dropping the entry of a camera that went away
  // or went offline is what makes it fetch a fresh thumbnail by itself when it comes back (CAM-3).
  useEffect(() => {
    dispatch({ type: 'sync', cameras })
  }, [cameras])

  /**
   * One camera's requests under `requestId`, for a load or the incremental path alike: the snapshot,
   * then — unless it failed at list level (`wantsStreamsQuery`) — the feed state. Each reply is
   * dispatched with the id; the reducer decides whether it still applies. No guard on the
   * dispatches: after an unmount the reducer is gone and they are no-ops, and no object URL exists
   * yet — those are created by the <img>, which cleans up after itself.
   */
  const fetchCamera = useCallback(
    (requestId: number, cameraId: string): void => {
      // `highQuality` stays false: a full-HD snapshot is a 400 on any camera without
      // `supportsFullHdSnapshot` and sends no smaller image instead (SPEC §5.1), and 1.1 MB is the
      // wrong size for a grid thumbnail even where it is allowed.
      void snapshot({ cameraId, highQuality: false }).then((result) => {
        dispatch({ type: 'result', requestId, cameraId, result })
        if (!wantsStreamsQuery(result) || !aliveRef.current) return
        void cameraStreamQualities(cameraId).then((qualities) => {
          dispatch({ type: 'streams', requestId, cameraId, result: qualities })
        })
      })
    },
    [snapshot, cameraStreamQualities],
  )

  /**
   * One load (header): the inventory if asked for, then every online camera at once. A load that
   * a newer one (or an unmount) has superseded while the inventory was being read sends nothing
   * more and leaves the action error alone.
   */
  const runLoad = useCallback(
    async (fetchInventory: boolean): Promise<void> => {
      requestIdRef.current += 1
      const requestId = requestIdRef.current
      const before = useAppStore.getState().cameras
      dispatch({ type: 'loadStart', requestId, shownIds: before.map((camera) => camera.id) })
      let inventory = before
      if (fetchInventory) {
        // `listCameras` is the authoritative inventory (SPEC R11); the store takes it as well. A
        // failure goes next to Refresh, and the list in hand is still worth its thumbnails.
        const result = await refreshCameras()
        if (!aliveRef.current || requestIdRef.current !== requestId) return
        setActionError(result.ok ? null : result.error)
        inventory = result.ok ? result.value : useAppStore.getState().cameras
      }
      const plan = thumbnailPlan(sortCameras(inventory), {})
      dispatch({ type: 'loadPlan', requestId, cameraIds: plan })
      for (const cameraId of plan) fetchCamera(requestId, cameraId)
    },
    [refreshCameras, fetchCamera],
  )

  // A load that starts by itself (`wantsLoad`): the tab opened with cameras in hand, or cameras
  // arrived on a list that never loaded. Started from a timer the cleanup cancels, so StrictMode's
  // mount–unmount–mount in development, or a real unmount, starts exactly one load or none. The
  // first load of a mount reads the inventory; a later one uses what main has just pushed.
  const startsLoad = wantsLoad(thumbnails, cameras.length)
  useEffect(() => {
    if (!startsLoad) return
    const timer = setTimeout(() => {
      const fetchInventory = !openedRef.current
      openedRef.current = true
      void runLoad(fetchInventory)
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [startsLoad, runLoad])

  // The incremental path: between loads, a camera with no entry (back online, or just added)
  // fetches its own thumbnail and feed state. Marking them in flight first is what stops this
  // effect asking twice: the dispatch changes `entries`, so the next `plan` leaves them out.
  const incremental = fetchesIncrementally(thumbnails)
  const plan = useMemo(
    () => (incremental ? thumbnailPlan(sorted, thumbnails.entries) : []),
    [incremental, sorted, thumbnails.entries],
  )
  useEffect(() => {
    if (plan.length === 0) return
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    dispatch({ type: 'request', requestId, cameraIds: plan })
    for (const cameraId of plan) fetchCamera(requestId, cameraId)
  }, [plan, fetchCamera])

  const runAction = useCallback(async (action: () => Promise<IpcResult<unknown>>) => {
    setBusy(true)
    setActionError(null)
    const result = await action()
    if (!result.ok) setActionError(result.error)
    setBusy(false)
  }, [])

  const onConnect = useCallback(() => {
    void runAction(connect)
  }, [connect, runAction])

  // Enabled during a load too: pressing it supersedes the load in flight (new id, its replies
  // dropped), and the header keeps showing the progress of the new one.
  const onRefresh = useCallback(() => {
    openedRef.current = true
    void runLoad(true)
  }, [runLoad])

  // Derived, not dispatched: a load about to start already shows its (indeterminate) progress, so
  // the first render is the loading card and never a bare grid.
  const progress = loadProgress(thumbnails, cameras.length)

  if (connection === null) {
    return (
      <section className="cameras">
        <p className="app__muted">Reading the console status…</p>
      </section>
    )
  }

  const gaps = setupGaps(connection.protect)
  // The first load replaces the body with its progress; a Refresh shows it in the header instead.
  const firstLoad = progress !== null && !thumbnails.loaded
  const body = cameraListBody(shown.length, gaps, firstLoad)
  const connectionPhase = connection.protect.phase
  const connecting = busy || connectionPhase === 'connecting' || connectionPhase === 'reconnecting'

  return (
    <section className="cameras">
      <header className="cameras__header row">
        <h2 className="cameras__title">Cameras</h2>
        <span className="app__muted">
          {firstLoad ? null : shown.length === 0 ? 'none yet' : `${String(shown.length)} adopted`}
        </span>
        <div className="cameras__actions row">
          {progress !== null && !firstLoad ? <LoadBar progress={progress} compact /> : null}
          <button type="button" className="button" onClick={onRefresh} disabled={busy}>
            <RefreshIcon />
            Refresh
          </button>
          <button type="button" className="button" onClick={onOpenSettings}>
            <GearIcon />
            Settings
          </button>
        </div>
      </header>

      {/* A snapshot failure that is not about a camera is a credential or a pin problem, so it is
          reported once for the whole list with the way to fix it (CON-1/2/3), not per row. */}
      {thumbnails.error === null ? null : (
        <Problem error={thumbnails.error} onOpenSettings={onOpenSettings} />
      )}
      {actionError === null ? null : (
        <Problem error={actionError} onOpenSettings={onOpenSettings} />
      )}

      {/* Setup that is missing on a console whose cameras are already listed: a banner above the
          rows, never instead of them (see `cameraListBody`). */}
      {cameraListShowsSetupBanner(shown.length, gaps, firstLoad) ? (
        <SetupBanner gaps={gaps} onOpenSettings={onOpenSettings} />
      ) : null}

      {body === 'loading' && progress !== null ? (
        <div className="card cameras__loading">
          <LoadBar progress={progress} />
        </div>
      ) : body === 'setup' ? (
        <SetupCard gaps={gaps} onOpenSettings={onOpenSettings} />
      ) : body === 'empty' ? (
        <EmptyCard
          phase={connectionPhase}
          connecting={connecting}
          onConnect={onConnect}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <ul className="cameras__grid">
          {shown.map((camera) => {
            const name = cameraDisplayName(camera)
            const presentation = cameraPresentation(camera)
            return (
              <CameraCard
                key={camera.id}
                camera={camera}
                name={name}
                presentation={presentation}
                entry={thumbnails.entries[camera.id]}
                rtsps={rtspsSummary(camera, thumbnails.streams[camera.id])}
                thumbnail={
                  <CameraThumbnail
                    name={name}
                    placeholder={presentation.placeholder}
                    entry={thumbnails.entries[camera.id]}
                  />
                }
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * The load's progress (P4.5): cameras settled out of the online cameras in the load, a camera
 * settling when its snapshot (and its feed state, if one was asked for) have answered.
 * Indeterminate until the inventory has answered. `compact` is the header's version during a
 * Refresh, beside the button.
 */
function LoadBar({
  progress,
  compact = false,
}: {
  progress: LoadProgress
  compact?: boolean
}): JSX.Element {
  const { settled, total, label } = progress
  const percent = total === null || total === 0 ? 0 : Math.round((settled / total) * 100)
  return (
    <div className={compact ? 'cameras__progress cameras__progress--compact' : 'cameras__progress'}>
      <div
        className={total === null ? 'cameras__bar cameras__bar--indeterminate' : 'cameras__bar'}
        role="progressbar"
        aria-label="Loading cameras"
        aria-valuemin={0}
        aria-valuemax={total ?? undefined}
        aria-valuenow={total === null ? undefined : settled}
        aria-valuetext={label}
      >
        <div
          className="cameras__barFill"
          style={total === null ? undefined : { width: `${String(percent)}%` }}
        />
      </div>
      <span className="cameras__progressLabel app__muted">{label}</span>
    </div>
  )
}

/**
 * The same CON-1/3 information as {@link SetupCard}, one line high, for a screen that has cameras
 * to show. Clearing the API key on a working console makes the rows stale, not wrong, so they stay
 * on screen — with the live state they already had (CAM-2) and a note of what will stop working.
 */
function SetupBanner({
  gaps,
  onOpenSettings,
}: {
  gaps: readonly SetupGap[]
  onOpenSettings: () => void
}): JSX.Element {
  return (
    <div className="cameras__warning" role="status">
      <span className="cameras__warningText">
        {/* Not lower-cased: `Protect API key` is a product name and an acronym, and "no protect
            api key stored" reads like a typo. The labels are written to follow a colon as they are. */}
        {`Setup is incomplete, so this list may stop updating: ${gaps
          .map((gap) => SETUP_GAP_LABELS[gap])
          .join('; ')}.`}
      </span>
      <button type="button" className="button" onClick={onOpenSettings}>
        <GearIcon />
        Open settings
      </button>
    </div>
  )
}

/**
 * The CON-1/3 setup state. Not an error: a fresh install has no host, no key and no accepted
 * certificate, and this says so in those words. Read from `connection.protect`, never inferred
 * from the list being empty.
 */
function SetupCard({
  gaps,
  onOpenSettings,
}: {
  gaps: readonly SetupGap[]
  onOpenSettings: () => void
}): JSX.Element {
  return (
    <div className="card cameras__notice">
      <h3 className="card__title">Not set up yet</h3>
      <p className="card__hint">
        The app has never reached a console, so there is nothing to list. What is still missing:
      </p>
      <ul className="cameras__gaps">
        {gaps.map((gap) => (
          <li key={gap}>{SETUP_GAP_LABELS[gap]}</li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="button button--primary" onClick={onOpenSettings}>
          <GearIcon />
          Open settings
        </button>
      </div>
    </div>
  )
}

/**
 * Configured and pinned, but no cameras in hand. Either nothing has been asked of the console yet
 * — on purpose: nothing connects at startup (CON-4, SPEC R9) — or it answered with an empty
 * inventory, which is a true answer and not a failure.
 */
function EmptyCard({
  phase,
  connecting,
  onConnect,
  onOpenSettings,
}: {
  phase: ConnectionPhase
  connecting: boolean
  onConnect: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const connected = phase === 'connected'
  return (
    <div className="card cameras__notice">
      <h3 className="card__title">{connected ? 'No cameras adopted' : 'Not connected yet'}</h3>
      <p className="card__hint">
        {connected
          ? 'The console answered with an empty camera list. Adopt a camera in Protect and refresh.'
          : 'The console is configured and its certificate is accepted. The list is empty until you connect; after a connect that works, the app connects by itself at every launch until you disconnect.'}
      </p>
      <div className="row">
        <button
          type="button"
          className="button button--primary"
          onClick={onConnect}
          disabled={connecting}
        >
          <PlugIcon />
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
        <button type="button" className="button" onClick={onOpenSettings}>
          <GearIcon />
          Open settings
        </button>
      </div>
    </div>
  )
}

/** A real failure, with the one place that can fix it a click away. */
function Problem({
  error,
  onOpenSettings,
}: {
  error: IpcError
  onOpenSettings: () => void
}): JSX.Element {
  return (
    <div className="cameras__problem" role="status">
      <span className="cameras__problemText">{error.message}</span>
      <button type="button" className="button" onClick={onOpenSettings}>
        <GearIcon />
        Open settings
      </button>
    </div>
  )
}
