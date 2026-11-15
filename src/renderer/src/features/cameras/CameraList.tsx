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
//  1. **Thumbnails are fetched a few at a time, and only on demand.** The console allows 10
//     requests per second per API key (SPEC R9) and main throttles every call through one shared
//     limiter, so a burst cannot break the limit — but 15 snapshots at once would still spend a
//     second and a half of budget and delay the live devices feed behind them, which is the path
//     gate G1 times. Hence `THUMBNAIL_CONCURRENCY` and a manual Refresh button rather than a timer:
//     nothing in Phase 1 needs a polling thumbnail, and P2.3 replaces these with live streams.
//     The same batch then asks which RTSPS qualities exist on the console (QUAL-7, P3.7) in a
//     second pass once its thumbnails have settled, at the same concurrency, and only for cameras
//     whose snapshot did not fail at list level (`streamsQueryPlan`), so the thumbnails fill at full
//     speed and a bad key or a missing pin costs no second request per camera.
//  2. **Online state never comes from a snapshot.** It comes from `camera.state`, which the devices
//     feed pushes into `appStore` (CAM-2). A camera that goes offline shows a placeholder within
//     the 10 seconds G1 allows even though its last thumbnail loaded perfectly.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import type { ConnectionPhase, IpcError, IpcResult, SnapshotResult } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import type { SetupGap } from '../../state/camerasStore'
import {
  cameraDisplayName,
  cameraListBody,
  cameraListShowsSetupBanner,
  cameraPresentation,
  EMPTY_THUMBNAILS,
  rtspsSummary,
  runWithConcurrency,
  setupGaps,
  streamsQueryPlan,
  SETUP_GAP_LABELS,
  sortCameras,
  THUMBNAIL_CONCURRENCY,
  thumbnailPlan,
  thumbnailsReducer,
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
   * Stamps each batch of snapshot requests, so a reply can be matched to the request it answers.
   * A ref rather than state: it must not cause a render, and a batch is issued from an effect.
   */
  const requestIdRef = useRef(0)

  const sorted = useMemo(() => sortCameras(cameras), [cameras])

  // CAM-2: fold the new inventory into the cache. Dropping the entry of a camera that went away or
  // went offline is what makes it fetch a fresh thumbnail by itself when it comes back (CAM-3).
  useEffect(() => {
    dispatch({ type: 'sync', cameras })
  }, [cameras])

  const plan = useMemo(
    () => thumbnailPlan(sorted, thumbnails.entries),
    [sorted, thumbnails.entries],
  )

  useEffect(() => {
    if (plan.length === 0) return
    // Marking them in flight first is what stops this effect asking twice: the dispatch changes
    // `entries`, so the next `plan` leaves them out. The id travels with every reply, so a reply
    // from a batch that a Refresh has already superseded cannot overwrite the newer one.
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    dispatch({ type: 'request', requestId, cameraIds: plan })
    const runBatch = async (): Promise<void> => {
      const snapshots = new Map<string, IpcResult<SnapshotResult>>()
      await runWithConcurrency(plan, THUMBNAIL_CONCURRENCY, async (cameraId) => {
        // `highQuality` stays false: a full-HD snapshot is a 400 on any camera without
        // `supportsFullHdSnapshot` and sends no smaller image instead (SPEC §5.1), and 1.1 MB is
        // the wrong size for a grid thumbnail even where it is allowed.
        const result = await snapshot({ cameraId, highQuality: false })
        snapshots.set(cameraId, result)
        // No unmount guard: the reducer is gone with the component, the dispatch is a no-op, and
        // no object URL exists yet — those are created by the <img>, which cleans up after itself.
        // A list-level failure also settles the camera's streams slot as "unknown" (the reducer).
        dispatch({ type: 'result', requestId, cameraId, result })
      })
      // QUAL-7: a second pass after the thumbnails, not beside them (header), at the same cap, so
      // THUMBNAIL_CONCURRENCY still bounds what this list spends of the R9 budget. A GET only:
      // looking at the list never creates a stream on the console (QUAL-8).
      const wanted = streamsQueryPlan(plan, snapshots)
      await runWithConcurrency(wanted, THUMBNAIL_CONCURRENCY, async (cameraId) => {
        const qualities = await cameraStreamQualities(cameraId)
        dispatch({ type: 'streams', requestId, cameraId, result: qualities })
      })
    }
    void runBatch()
  }, [plan, snapshot, cameraStreamQualities])

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

  const onRefresh = useCallback(() => {
    // Both halves, because they answer different questions: `listCameras` is the authoritative
    // inventory (SPEC R11) and the thumbnail cache is what the user can see is stale.
    dispatch({ type: 'refresh' })
    void runAction(refreshCameras)
  }, [refreshCameras, runAction])

  if (connection === null) {
    return (
      <section className="cameras">
        <p className="app__muted">Reading the console status…</p>
      </section>
    )
  }

  const gaps = setupGaps(connection.protect)
  const body = cameraListBody(sorted.length, gaps)
  const phase = connection.protect.phase
  const connecting = busy || phase === 'connecting' || phase === 'reconnecting'

  return (
    <section className="cameras">
      <header className="cameras__header row">
        <h2 className="cameras__title">Cameras</h2>
        <span className="app__muted">
          {sorted.length === 0 ? 'none yet' : `${String(sorted.length)} adopted`}
        </span>
        <div className="cameras__actions row">
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
      {cameraListShowsSetupBanner(sorted.length, gaps) ? (
        <SetupBanner gaps={gaps} onOpenSettings={onOpenSettings} />
      ) : null}

      {body === 'setup' ? (
        <SetupCard gaps={gaps} onOpenSettings={onOpenSettings} />
      ) : body === 'empty' ? (
        <EmptyCard
          phase={phase}
          connecting={connecting}
          onConnect={onConnect}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <ul className="cameras__grid">
          {sorted.map((camera) => {
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
          : 'The console is configured and its certificate is accepted. Nothing connects by itself, so the list is empty until you connect.'}
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
