// Settings' door-link card (P5.3; DOOR-1, DOOR-2): which Access door each camera looks at, for the
// unlock control P5.4 puts on its cell. Rendered only while the **saved** Access switch is on
// (DOOR-0) — SettingsPage decides that from `settings.console.accessEnabled`, not from the console
// form's unsaved draft, so flipping the checkbox without saving reveals nothing that would make an
// Access call.
//
// The door list is read **once when the card mounts** — one read per Settings visit, SPEC §5.2 —
// and again only from the Refresh doors (or Retry) button. Never on a timer: the Access API
// documents no rate limit and P1.4's client paces nothing, so the app asks only when the user does.
//
// What is drawn comes from `buildDoorLinkRows` (./doorLinks.ts), which is where the rules live: a
// stored link is never pruned (an unknown door or an unknown camera keeps its row, with a way to
// unlink it), and a door that cannot be unlocked remotely stays selectable with a label saying so.
//
// Saving is the Streams card's pattern (SettingsPage): a select has no half-typed state, so a change
// saves at once; one save at a time for the whole card (every select and Unlink button is disabled
// while it is in flight); each payload is built from the store's links at the moment of the change,
// so two quick changes cannot have the second write back a link the first one replaced; and a failed
// save leaves the select on the stored value with the reason under that row.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DoorLinks, IpcError } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { RefreshIcon, TrashIcon } from '../../ui/icons'
import {
  buildDoorLinkRows,
  cameraListNotice,
  doorLinkFieldId,
  doorListHint,
  doorListNotice,
  NOT_LINKED,
  sameLink,
  withLink,
  type DoorLinkRow,
  type DoorListState,
} from './doorLinks'

/**
 * A call that rejected instead of answering. The bridge is written never to reject (ipc.ts rule 2),
 * so this is a bug somewhere — but the card must still leave its busy state and say something
 * rather than spin for ever.
 */
function rejected(err: unknown): IpcError {
  return {
    kind: 'internal',
    message: err instanceof Error ? err.message : 'An unexpected error occurred in View Protect.',
    endpoint: null,
    retryable: true,
  }
}

/**
 * The card. SettingsPage **keys** it on `doorListKey` (./doorLinks.ts) — the saved Access address,
 * its pin and whether a token is stored — so a change to any of them remounts it: the previous
 * list (whose door ids may belong to another console) is discarded, and the new endpoint is read
 * at once instead of leaving an error the user has just fixed on screen.
 */
export function DoorLinksCard({ links }: { links: DoorLinks }): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const listDoors = useAppStore((s) => s.listDoors)
  const setDoorLinks = useAppStore((s) => s.setDoorLinks)

  const [list, setList] = useState<DoorListState>({ state: 'loading' })
  const [saving, setSaving] = useState(false)
  /** The last failed save, shown under the row that made it. */
  const [saveError, setSaveError] = useState<{ cameraId: string; error: IpcError } | null>(null)

  /**
   * Bumped by every read and by unmount, so only the newest read's answer lands: a Refresh pressed
   * while the first read is in flight supersedes it, and an answer after the card has gone (Access
   * switched off, its endpoint changed, Settings left) is dropped.
   */
  const latest = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1
    const id = latest.current
    setList({ state: 'loading' })
    // A reload starts clean: a save error from before is about a list that is being replaced.
    setSaveError(null)
    let next: DoorListState
    try {
      const result = await listDoors()
      next = result.ok
        ? { state: 'loaded', doors: result.value }
        : { state: 'failed', error: result.error }
    } catch (err) {
      next = { state: 'failed', error: rejected(err) }
    }
    if (id !== latest.current) return
    setList(next)
  }, [listDoors])

  // Once per mount (SPEC §5.2). Deferred a tick like the camera list's first load, so the state
  // change happens outside the effect body; a StrictMode double mount clears the first timer, so it
  // still makes one read.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => {
      clearTimeout(timer)
      latest.current += 1
    }
  }, [load])

  const change = async (cameraId: string, doorId: string | null): Promise<void> => {
    // The store's links as they are now, not the `links` this render was given (header).
    const stored = useAppStore.getState().settings?.doorLinks ?? links
    if (sameLink(stored, cameraId, doorId)) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await setDoorLinks({ links: withLink(stored, cameraId, doorId) })
      // A success on any row clears the error too (above); a failure lands under this row.
      if (!result.ok) setSaveError({ cameraId, error: result.error })
    } catch (err) {
      setSaveError({ cameraId, error: rejected(err) })
    } finally {
      setSaving(false)
    }
  }

  const rows = useMemo(() => buildDoorLinkRows(cameras, links, list), [cameras, links, list])
  // A save error for a row that has gone (its link was removed elsewhere, or its camera left the
  // inventory) is dropped rather than kept to reappear under a later row with the same camera.
  // Set during render, the documented way to adjust state to new props without an effect.
  if (saveError !== null && !rows.some((row) => row.cameraId === saveError.cameraId)) {
    setSaveError(null)
  }
  const notice = doorListNotice(list)
  const hint = list.state === 'failed' ? doorListHint(list.error) : null
  const camerasNotice = cameraListNotice(cameras, links)

  return (
    <section className="card">
      <div className="row settings__cardHead">
        <h2 className="card__title">Door links</h2>
        <button
          type="button"
          className="button button--sm settings__push"
          disabled={list.state === 'loading'}
          onClick={() => {
            void load()
          }}
        >
          <RefreshIcon />
          Refresh doors
        </button>
      </div>
      <p className="card__hint">
        Which UniFi Access door each camera looks at, for the unlock control on its cell. Several
        cameras may share a door, and a doorbell&rsquo;s package camera shares the doorbell&rsquo;s
        link. Changes save at once. The door list is read when Settings opens; use Refresh doors
        after changing doors on the console.
      </p>

      {notice === null ? null : (
        <p className="field__hint settings__doorNotice" role="status">
          {notice}
        </p>
      )}
      {list.state === 'failed' ? (
        <div className="settings__doorNotice" role="alert">
          <p className="field__error">{list.error.message}</p>
          {hint === null ? null : <p className="field__hint">{hint}</p>}
          <button
            type="button"
            className="button button--sm"
            onClick={() => {
              void load()
            }}
          >
            <RefreshIcon />
            Retry
          </button>
        </div>
      ) : null}

      {camerasNotice === null ? null : (
        <p className="field__hint settings__doorNotice">{camerasNotice}</p>
      )}

      {rows.map((row) => (
        <DoorLinkField
          key={row.cameraId}
          row={row}
          id={doorLinkFieldId(row.cameraId)}
          disabled={saving}
          error={saveError?.cameraId === row.cameraId ? saveError.error : null}
          onChange={(doorId) => {
            void change(row.cameraId, doorId)
          }}
        />
      ))}
    </section>
  )
}

/**
 * One camera's link. An inventory camera has a select ("Not linked" plus every door, and the stored
 * door whatever the list says); a stored link whose camera is not in the inventory has only its
 * door and an Unlink button. Controlled by the stored link, not by a draft.
 */
function DoorLinkField({
  row,
  id,
  disabled,
  error,
  onChange,
}: {
  row: DoorLinkRow
  id: string
  disabled: boolean
  error: IpcError | null
  onChange: (doorId: string | null) => void
}): JSX.Element {
  const unlink =
    row.unlinkButton && row.doorId !== null ? (
      <button
        type="button"
        className="button button--sm button--danger"
        disabled={disabled}
        aria-label={`Unlink ${row.cameraLabel} from ${row.doorLabel ?? row.doorId}`}
        onClick={() => {
          onChange(null)
        }}
      >
        <TrashIcon />
        Unlink
      </button>
    ) : null

  return (
    <div className="field">
      {row.options === null ? (
        <>
          <span className="field__label" id={`${id}-label`}>
            {row.cameraLabel}
            {/* A not-loaded row's label already carries the id. */}
            {row.camera === 'unknown' ? <span className="mono"> {row.cameraId}</span> : null}
          </span>
          <div className="row" aria-labelledby={`${id}-label`} role="group">
            <span>{row.doorLabel}</span>
            {unlink}
          </div>
        </>
      ) : (
        <>
          <label className="field__label" htmlFor={id}>
            {row.cameraLabel}
          </label>
          <div className="row">
            <select
              id={id}
              className="field__input settings__doorSelect"
              value={row.doorId ?? NOT_LINKED}
              // Disabled until a list with doors has loaded: the only change possible before that is
              // an unlink, which the button beside it does (doorLinks.ts rule 1).
              disabled={disabled || !row.selectable}
              onChange={(event) => {
                onChange(event.target.value)
              }}
            >
              {row.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {unlink}
          </div>
        </>
      )}
      {row.status === 'unknown-door' ? (
        <p className="field__hint">
          This door is not in the console&rsquo;s door list. The link is kept until you unlink it.
        </p>
      ) : null}
      {error === null ? null : <p className="field__error">{error.message}</p>}
    </div>
  )
}
