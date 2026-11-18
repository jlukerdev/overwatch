// Settings' Door links card (P5.3; DOOR-1, DOOR-2): which Access door each camera looks at, for the
// unlock control P5.4 puts on its cell. Rendered only while the **saved** Access switch is on
// (DOOR-0) — SettingsPage decides that from `settings.console.accessEnabled`, not from the console
// form's unsaved draft, so flipping the checkbox without saving reveals nothing that would make an
// Access call.
//
// Laid out as **door cards with the cameras inside** (user request 2026-11-17): an "Add door"
// dropdown with its Add button at the top, then one small card per door, wrapping across the width.
// Each card lists its cameras with a ✕ to unlink each, an "Add camera" dropdown and Add button for
// the cameras linked to no door (a move between doors is unlink, then add), and a "Remove door" ✕.
// A dropdown only holds a pending choice: nothing acts on `change` (see AddPicker). What is drawn comes from ./doorLinks.ts, which is where the rules live: a stored
// link is never pruned, a door the list lacks keeps its card, and an empty card is session state
// only (nothing is saved until a camera is in it).
//
// The door list is read **once when the card mounts** — one read per Settings visit, SPEC §5.2 —
// and again only from the Refresh doors (or Retry) button. Never on a timer: the Access API
// documents no rate limit and P1.4's client paces nothing, so the app asks only when the user does.
//
// Saving is the Streams card's pattern (SettingsPage): Add and ✕ save at once; one save at a time
// for the whole card (every control is `aria-disabled` while it is in flight, keeping the focus); each payload is built from the
// store's links at the moment of the change, so two quick changes cannot have the second write back
// a link the first one replaced; and a failed save is reported on the door card it belongs to.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DoorLinks, IpcError } from '@shared/ipc'
import { useAppStore } from '../../state/appStore'
import { RefreshIcon, XIcon } from '../../ui/icons'
import {
  addCameraOptions,
  addCameraPlaceholder,
  addDoorOptions,
  buildDoorCards,
  cameraListNotice,
  domId,
  doorListHint,
  doorListNotice,
  linkCamera,
  NO_HUB_NOTE,
  PLACEHOLDER,
  pruneAddedDoors,
  removeDoor,
  removeDoorAction,
  unlinkCamera,
  withAddedDoor,
  withoutAddedDoor,
  type DoorCard,
  type DoorListState,
  type DropdownOption,
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
 * list (whose door ids may belong to another console) and any empty door cards are discarded, and
 * the new endpoint is read at once instead of leaving an error the user has just fixed on screen.
 */
export function DoorLinksCard({ links }: { links: DoorLinks }): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const listDoors = useAppStore((s) => s.listDoors)
  const setDoorLinks = useAppStore((s) => s.setDoorLinks)

  const [list, setList] = useState<DoorListState>({ state: 'loading' })
  /** Doors added with "Add door" this session; a card with no camera exists only here (rule 2). */
  const [addedDoorIds, setAddedDoorIds] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  /** The last failed save, shown on the door card that made it. */
  const [saveError, setSaveError] = useState<{ doorId: string; error: IpcError } | null>(null)

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
    // An empty card for a door this list no longer has is dropped from the state, not just hidden,
    // so it cannot come back on a later reload or while one is loading (doorLinks.ts rule 2).
    setAddedDoorIds((current) => pruneAddedDoors(current, next))
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

  /**
   * One save: `next` computes the new map from the store's links as they are now, not the `links`
   * this render was given (header). Answers whether it landed, so a caller can follow up.
   */
  const save = async (doorId: string, next: (stored: DoorLinks) => DoorLinks): Promise<boolean> => {
    const stored = useAppStore.getState().settings?.doorLinks ?? links
    setSaving(true)
    setSaveError(null)
    try {
      const result = await setDoorLinks({ links: next(stored) })
      if (result.ok) return true
      setSaveError({ doorId, error: result.error })
    } catch (err) {
      setSaveError({ doorId, error: rejected(err) })
    } finally {
      setSaving(false)
    }
    return false
  }

  const addDoor = (doorId: string): void => {
    setAddedDoorIds((current) => withAddedDoor(current, doorId))
  }

  const addCamera = async (doorId: string, cameraId: string): Promise<void> => {
    await save(doorId, (stored) => linkCamera(stored, cameraId, doorId))
  }

  const unlink = async (doorId: string, cameraId: string): Promise<void> => {
    // Kept as a session card once its last camera goes, whichever way the card first appeared, until
    // the user removes it or leaves Settings (doorLinks.ts rule 2). Added before the save so the
    // card never blinks out between the store update and this state update.
    setAddedDoorIds((current) => withAddedDoor(current, doorId))
    await save(doorId, (stored) => unlinkCamera(stored, cameraId))
    restoreFocus([domId('door-card-add', doorId), domId('door-card-remove', doorId)])
  }

  const removeCard = async (doorId: string): Promise<void> => {
    // Decided from the links as stored now, not from the card this render drew: a save that landed
    // since may have emptied it, or a camera may have been linked to it.
    const stored = useAppStore.getState().settings?.doorLinks ?? links
    if (removeDoorAction(stored, doorId) === 'save') {
      // Every camera of this door in one save; the card goes once it has landed.
      if (!(await save(doorId, (current) => removeDoor(current, doorId)))) return
    }
    setAddedDoorIds((current) => withoutAddedDoor(current, doorId))
    restoreFocus([])
  }

  const cards = useMemo(
    () => buildDoorCards(cameras, links, list, addedDoorIds),
    [cameras, links, list, addedDoorIds],
  )
  const doorOptions = useMemo(() => addDoorOptions(list, cards), [list, cards])
  const cameraOptions = useMemo(() => addCameraOptions(cameras, links), [cameras, links])
  // A save error for a card that has gone is dropped rather than kept to reappear later. Set during
  // render, the documented way to adjust state to new props without an effect.
  if (saveError !== null && !cards.some((card) => card.doorId === saveError.doorId)) {
    setSaveError(null)
  }
  const notice = doorListNotice(list)
  const hint = list.state === 'failed' ? doorListHint(list.error) : null
  const camerasNotice = cameraListNotice(cameras, links)
  const cameraPlaceholder = addCameraPlaceholder(cameras, cameraOptions)

  return (
    <section className="card">
      <div className="row settings__cardHead">
        <h2 className="card__title">Door links</h2>
        <button
          id={REFRESH_ID}
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
        Which UniFi Access door each camera looks at, for the unlock control on its cell. Add a
        door, then the cameras that look at it. A camera belongs to one door: to move one, unlink
        it, then add it to the other door. A doorbell&rsquo;s package camera shares the
        doorbell&rsquo;s door. Changes save at once. The door list is read when Settings opens; use
        Refresh doors after changing doors on the console.
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

      <div className="field">
        <label className="field__label" htmlFor={ADD_DOOR_ID}>
          Door to add
        </label>
        <AddPicker
          id={ADD_DOOR_ID}
          buttonLabel="Add door"
          placeholder={doorOptions.length === 0 ? 'No more doors' : 'Choose a door…'}
          options={doorOptions}
          unavailable={list.state !== 'loaded' || doorOptions.length === 0}
          busy={saving}
          onAdd={addDoor}
        />
      </div>

      {cards.length === 0 ? null : (
        <ul className="settings__doorCards">
          {cards.map((card) => (
            <DoorCardView
              key={card.doorId}
              card={card}
              cameraOptions={cameraOptions}
              cameraPlaceholder={cameraPlaceholder}
              busy={saving}
              error={saveError?.doorId === card.doorId ? saveError.error : null}
              onAddCamera={(cameraId) => addCamera(card.doorId, cameraId)}
              onUnlink={(cameraId) => {
                void unlink(card.doorId, cameraId)
              }}
              onRemove={() => {
                void removeCard(card.doorId)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

const ADD_DOOR_ID = 'door-links-add-door'
const REFRESH_ID = 'door-links-refresh'

/**
 * After a ✕ removed the control that had the focus (its camera row, or its whole card), hands the
 * focus to the first of `ids` that can take it, then the Add door select, then Refresh doors — so
 * the keyboard user is not dropped onto `document.body`. Deferred a tick so React has committed the
 * removal, and a no-op when the focus survived (it is still somewhere in the document).
 */
function restoreFocus(ids: readonly string[]): void {
  setTimeout(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected) return
    for (const id of [...ids, ADD_DOOR_ID, REFRESH_ID]) {
      const target = document.getElementById(id)
      if (
        target instanceof HTMLElement &&
        !(target instanceof HTMLButtonElement && target.disabled) &&
        !(target instanceof HTMLSelectElement && target.disabled)
      ) {
        target.focus()
        return
      }
    }
  }, 0)
}

/**
 * One door: its heading, its cameras with a ✕ each, Add camera, and Remove door.
 *
 * **No control here is `disabled` while a save runs** (`busy`): disabling the button that has the
 * focus throws the focus to `document.body`. They are `aria-disabled` instead and ignore the press,
 * which keeps the focus where the user left it. `disabled` is only for what cannot apply at all
 * (Add camera on a door the list does not have loaded).
 */
function DoorCardView({
  card,
  cameraOptions,
  cameraPlaceholder,
  busy,
  error,
  onAddCamera,
  onUnlink,
  onRemove,
}: {
  card: DoorCard
  cameraOptions: readonly DropdownOption[]
  cameraPlaceholder: string
  busy: boolean
  error: IpcError | null
  onAddCamera: (cameraId: string) => Promise<void>
  onUnlink: (cameraId: string) => void
  onRemove: () => void
}): JSX.Element {
  const headingId = domId('door-card', card.doorId)
  return (
    <li className="settings__doorCard" aria-labelledby={headingId}>
      <div className="row settings__doorCardHead">
        <div className="settings__grow">
          <h3 className="settings__doorTitle" id={headingId}>
            {card.title}
          </h3>
          {card.noHub ? <p className="field__hint">{NO_HUB_NOTE}</p> : null}
        </div>
        <button
          id={domId('door-card-remove', card.doorId)}
          type="button"
          className="button button--ghost button--icon button--sm"
          aria-disabled={busy}
          aria-label={`Remove ${card.title}`}
          title={`Remove ${card.title}`}
          onClick={() => {
            if (!busy) onRemove()
          }}
        >
          <XIcon />
        </button>
      </div>

      {card.cameras.length === 0 ? (
        <p className="field__hint">No cameras yet. Nothing is saved until you add one.</p>
      ) : (
        <ul className="settings__doorCameras">
          {card.cameras.map((camera) => (
            <li key={camera.cameraId} className="row settings__doorCamera">
              <span className="settings__grow">{camera.label}</span>
              <button
                type="button"
                className="button button--ghost button--icon button--sm"
                aria-disabled={busy}
                aria-label={`Unlink ${camera.label} from ${card.title}`}
                title={`Unlink ${camera.label} from ${card.title}`}
                onClick={() => {
                  if (!busy) onUnlink(camera.cameraId)
                }}
              >
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Not for a door the loaded list lacks: there is nothing to link a new camera to. While the
          list is not in (a pending card) it is there but unavailable. */}
      {card.kind === 'unknown' ? null : (
        <AddPicker
          id={domId('door-card-add', card.doorId)}
          selectLabel={`Camera to add to ${card.title}`}
          buttonLabel={`Add camera to ${card.title}`}
          placeholder={cameraPlaceholder}
          options={cameraOptions}
          unavailable={card.kind !== 'known' || cameraOptions.length === 0}
          busy={busy}
          onAdd={onAddCamera}
        />
      )}
      {error === null ? null : <p className="field__error">{error.message}</p>}
    </li>
  )
}

/**
 * An "Add …" control: a select that only holds a **pending** choice, and an Add button that acts on
 * it. Nothing happens on `change` — on Windows and Linux an arrow key on a closed select fires one,
 * so a select that acted on change would save (or add) whatever the arrow landed on.
 *
 * The Add button is usable only with something chosen and no save running; it is `aria-disabled`
 * rather than `disabled` for the second, so the focus stays on it through the save (DoorCardView).
 * After a press the select goes back to its placeholder. A choice the options no longer contain (the
 * camera was linked elsewhere, the door got a card) reads as no choice.
 */
function AddPicker({
  id,
  selectLabel,
  buttonLabel,
  placeholder,
  options,
  unavailable,
  busy,
  onAdd,
}: {
  id: string
  /** The select's own accessible name, when no visible `<label>` points at it. */
  selectLabel?: string
  /** The button's accessible name: "Add door" or "Add camera to <door>". */
  buttonLabel: string
  placeholder: string
  options: readonly DropdownOption[]
  /** Nothing can be added at all (no list, no options): the select itself is disabled. */
  unavailable: boolean
  busy: boolean
  onAdd: (value: string) => void | Promise<void>
}): JSX.Element {
  const [pending, setPending] = useState<string>(PLACEHOLDER)
  const choice = options.some((option) => option.value === pending) ? pending : PLACEHOLDER
  const ready = !unavailable && !busy && choice !== PLACEHOLDER

  return (
    <div className="row settings__doorAdd">
      <select
        id={id}
        className="field__input settings__doorSelect"
        aria-label={selectLabel}
        value={choice}
        disabled={unavailable}
        onChange={(event) => {
          setPending(event.target.value)
        }}
      >
        <option value={PLACEHOLDER} disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button button--sm"
        aria-disabled={!ready}
        aria-label={buttonLabel}
        onClick={() => {
          if (!ready) return
          setPending(PLACEHOLDER)
          void onAdd(choice)
        }}
      >
        Add
      </button>
    </div>
  )
}
