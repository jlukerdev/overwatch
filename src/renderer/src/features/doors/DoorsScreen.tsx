// The Doors screen (P5.6; DOOR-0…DOOR-6): every Access door on a card of its own — lock state,
// door position, the rule controlling it, its actions and its linked cameras — with lockdown and
// evacuation in the header and the Access read intervals at the bottom.
//
// The app shell mounts it only while the **saved** Access switch is on (DOOR-0, App.tsx), so
// nothing here runs, and main is asked nothing, while Access is off.
//
// **Where the state comes from.** Main reads the console while this screen is open
// (./useDoorsScreenWatch.ts) and pushes one whole `DoorsScreenState`, kept in the app store. The
// cards are ./doorLinks.ts's (`buildDoorCards`: every listed door, plus linked doors the list
// lacks), their words are ./doorRule.ts's and ./doorActions.ts's. This file is the wiring.
//
// **Every action is confirmed in a dialog** (user decision 2026-11-18; unlock included, no
// press-and-hold on this screen): a button only opens `confirmDialog()`, which names the door and
// the action; confirming it sends exactly **one** IPC call, which is never repeated, whatever the
// answer (DOOR-3/4). Nothing here acts from a timer, a pushed state or a key alone. The outcome is
// a toast, since these are actions away from any form; an unknown outcome (sent, no answer) is a
// warning that asks for a look first. The door's new state then arrives as main's next push.
//
// **Links** (DOOR-2, moved here from Settings): Add and ✕ save at once through `setDoorLinks` with
// the whole map — one save at a time for the whole screen, each payload built from the store's
// links at the moment of the change, so two quick changes cannot have the second write back a link
// the first one replaced — and a failed save is reported on the card that made it.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DoorAction, DoorLinks, IpcError } from '@shared/ipc'
import { defaultAccessPolling } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { showToast } from '../../state/toastStore'
import { confirmDialog } from '../../ui/ConfirmDialog'
import { AlertIcon, DoorIcon, GearIcon, RefreshIcon } from '../../ui/icons'
import { StatusLine } from '../../ui/StatusLine'
import { DoorCardView } from './DoorCardView'
import { PollingCard } from './PollingCard'
import {
  actionBlock,
  activeEmergencies,
  doorActionConfirm,
  doorActionFailureToast,
  doorActionResultToast,
  EMERGENCY_MODES,
  emergencyBannerText,
  emergencyCommand,
  emergencyConfirm,
  emergencyFailureToast,
  emergencyInput,
  emergencyModeName,
  emergencyResultToast,
  emergencyStartBlock,
  SEND_FAILED_REASON,
  type EmergencyMode,
} from './doorActions'
import {
  addCameraOptions,
  addCameraPlaceholder,
  buildDoorCards,
  cameraListNotice,
  domId,
  doorsBody,
  doorsErrorHint,
  doorsReadWarning,
  linkCamera,
  unlinkCamera,
  type DoorCard,
} from './doorLinks'
import { doorLockLook, doorRuleLine, ruleAllowsReset, type RuleClock } from './doorRule'
import { useDoorsScreenWatch } from './useDoorsScreenWatch'
import './doors.css'

const NO_LINKS: DoorLinks = {}
const REFRESH_ID = 'doors-refresh'

/** How often "now" moves on, so a rule's "until 6:00 PM" drops once that time has passed. */
const CLOCK_TICK_MS = 30_000

/** The current time as state: read in an effect, never during render. */
function useClock(): RuleClock {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, CLOCK_TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  return useMemo(() => ({ nowMs }), [nowMs])
}

/**
 * A call that rejected instead of answering. The bridge is written never to reject (ipc.ts rule 2),
 * so this is a bug somewhere — but a card must still leave its busy state and say something.
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
 * After a ✕ removed the row that had the focus, hands the focus to that card's Add camera select,
 * then Refresh — so the keyboard user is not dropped onto `document.body`. Deferred a tick so
 * React has committed the removal, and a no-op when the focus survived.
 */
function restoreFocus(ids: readonly string[]): void {
  setTimeout(() => {
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected) return
    for (const id of [...ids, REFRESH_ID]) {
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

export function DoorsScreen({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const cameras = useAppStore((s) => s.cameras)
  const links = useAppStore((s) => s.settings?.doorLinks ?? NO_LINKS)
  const polling = useAppStore((s) => s.settings?.accessPolling)
  const state = useAppStore((s) => s.doorsScreen)
  const doorAction = useAppStore((s) => s.doorAction)
  const setDoorEmergency = useAppStore((s) => s.setDoorEmergency)
  const setDoorLinks = useAppStore((s) => s.setDoorLinks)

  const refresh = useDoorsScreenWatch()
  const clock = useClock()

  /** The doors with an action in flight. The ref is the guard; the state is what is drawn. */
  const actingRef = useRef(new Set<string>())
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set())
  const emergencyBusyRef = useRef(false)
  const [emergencyBusy, setEmergencyBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  /** The last failed link save, shown on the card that made it. */
  const [saveError, setSaveError] = useState<{ doorId: string; error: IpcError } | null>(null)

  const cards = useMemo(
    () => buildDoorCards(cameras, links, state.doors),
    [cameras, links, state.doors],
  )
  const cameraOptions = useMemo(() => addCameraOptions(cameras, links), [cameras, links])
  const cameraPlaceholder = addCameraPlaceholder(cameras, cameraOptions)
  // A save error for a card that has gone is dropped rather than kept to reappear later. Set during
  // render, the documented way to adjust state to new props without an effect.
  if (saveError !== null && !cards.some((card) => card.doorId === saveError.doorId)) {
    setSaveError(null)
  }

  /** DOOR-3/4: ask, then send once. Answers whether the user confirmed. */
  const runDoorAction = async (
    card: DoorCard,
    action: DoorAction,
    minutes: number | null,
  ): Promise<boolean> => {
    const { doorId, title } = card
    if (actingRef.current.has(doorId)) return false
    if (!(await confirmDialog(doorActionConfirm(action, title, minutes)))) return false
    // Still one at a time per door, whatever happened while the dialog was open.
    if (actingRef.current.has(doorId)) return false
    actingRef.current.add(doorId)
    setActing(new Set(actingRef.current))
    try {
      // Exactly one request per confirmed dialog; never retried.
      const result = await doorAction(
        action === 'custom' && minutes !== null ? { doorId, action, minutes } : { doorId, action },
      )
      showToast(
        result.ok
          ? doorActionResultToast(result.value)
          : doorActionFailureToast(action, title, minutes, result.error.message),
      )
    } catch {
      showToast(doorActionFailureToast(action, title, minutes, SEND_FAILED_REASON))
    } finally {
      actingRef.current.delete(doorId)
      setActing(new Set(actingRef.current))
    }
    return true
  }

  /** DOOR-3/4: lockdown / evacuation on or off, for every door: ask, then send once. */
  const runEmergency = async (mode: EmergencyMode, on: boolean): Promise<void> => {
    if (emergencyBusyRef.current) return
    if (!(await confirmDialog(emergencyConfirm(mode, on)))) return
    // The pair is computed from what is known **now**, after the dialog: never from a guess.
    const current = useAppStore.getState().doorsScreen.emergency
    if (current === null || (on && emergencyStartBlock(mode, current) !== null)) {
      showToast(
        emergencyFailureToast(
          mode,
          on,
          'The emergency status changed or is not known right now, so nothing was sent.',
        ),
      )
      return
    }
    emergencyBusyRef.current = true
    setEmergencyBusy(true)
    try {
      const result = await setDoorEmergency(emergencyInput(mode, on, current))
      showToast(
        result.ok
          ? emergencyResultToast(mode, on, result.value)
          : emergencyFailureToast(mode, on, result.error.message),
      )
    } catch {
      showToast(emergencyFailureToast(mode, on, SEND_FAILED_REASON))
    } finally {
      emergencyBusyRef.current = false
      setEmergencyBusy(false)
    }
  }

  /**
   * One link save: `next` computes the new map from the store's links as they are now, not the
   * `links` this render was given (header).
   */
  const saveLinks = async (
    doorId: string,
    next: (stored: DoorLinks) => DoorLinks,
  ): Promise<void> => {
    if (saving) return
    const stored = useAppStore.getState().settings?.doorLinks ?? links
    setSaving(true)
    setSaveError(null)
    try {
      const result = await setDoorLinks({ links: next(stored) })
      if (!result.ok) setSaveError({ doorId, error: result.error })
    } catch (err) {
      setSaveError({ doorId, error: rejected(err) })
    } finally {
      setSaving(false)
    }
  }

  const body = doorsBody(state)
  const warning = doorsReadWarning(state)
  const camerasNotice = body === 'loading' ? null : cameraListNotice(cameras, links)
  const banners = activeEmergencies(state.emergency)
  const errorHint = state.error === null ? null : doorsErrorHint(state.error)

  const cardList =
    cards.length === 0 || body === 'loading' ? null : (
      <ul className="doors__grid">
        {cards.map((card) => (
          <DoorCardView
            key={card.doorId}
            card={card}
            look={doorLockLook(card.door, state.stale)}
            ruleLine={
              // Own keys only: a door id such as `constructor` must not find a prototype member.
              card.door !== null && Object.hasOwn(state.rules, card.doorId)
                ? doorRuleLine(state.rules[card.doorId], clock)
                : null
            }
            allowReset={
              Object.hasOwn(state.rules, card.doorId) && ruleAllowsReset(state.rules[card.doorId])
            }
            block={actionBlock({
              stale: state.stale,
              boundToHub: card.door?.boundToHub ?? false,
            })}
            acting={acting.has(card.doorId)}
            saving={saving}
            cameraOptions={cameraOptions}
            cameraPlaceholder={cameraPlaceholder}
            saveError={saveError?.doorId === card.doorId ? saveError.error : null}
            onAction={(action, minutes) => runDoorAction(card, action, minutes)}
            onAddCamera={(cameraId) => {
              void saveLinks(card.doorId, (stored) => linkCamera(stored, cameraId, card.doorId))
            }}
            onUnlink={(cameraId) => {
              void saveLinks(card.doorId, (stored) => unlinkCamera(stored, cameraId)).then(() => {
                restoreFocus([domId('door-card-add', card.doorId)])
              })
            }}
          />
        ))}
      </ul>
    )

  return (
    <section className="doors">
      <header className="doors__header row">
        <h2 className="doors__title">Doors</h2>
        <div className="doors__actions row">
          {EMERGENCY_MODES.map((mode) => {
            const blocked = emergencyStartBlock(mode, state.emergency)
            return (
              <button
                key={mode}
                type="button"
                className="button button--danger"
                disabled={blocked !== null}
                aria-disabled={emergencyBusy}
                title={blocked ?? undefined}
                onClick={() => {
                  if (blocked === null) void runEmergency(mode, true)
                }}
              >
                {emergencyModeName(mode)}
              </button>
            )
          })}
          <button
            id={REFRESH_ID}
            type="button"
            className="button"
            disabled={body === 'loading'}
            onClick={refresh}
          >
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </header>

      {/* Lockdown or evacuation is on: said at the top, with the way to end it (through a dialog). */}
      {banners.map((mode) => (
        <div key={mode} className="banner banner--error" role="alert">
          <AlertIcon />
          <span className="banner__text">{emergencyBannerText(mode)}</span>
          <button
            type="button"
            className="button button--sm"
            aria-disabled={emergencyBusy}
            onClick={() => {
              void runEmergency(mode, false)
            }}
          >
            {emergencyCommand(mode, false)}
          </button>
        </div>
      ))}

      {/* There is a list, but the reads are failing: the cards stay, with what is wrong on top. */}
      {warning === null ? null : (
        <div className="banner banner--warn" role="status">
          <AlertIcon />
          <span className="banner__text">{warning}</span>
        </div>
      )}
      {camerasNotice === null ? null : <StatusLine kind="muted">{camerasNotice}</StatusLine>}

      {body === 'loading' ? (
        <div className="emptyState doors__empty" role="status">
          <span className="spinner emptyState__spinner" aria-hidden="true" />
          <p className="emptyState__hint">Reading the doors…</p>
        </div>
      ) : body === 'error' ? (
        <div
          className={cards.length === 0 ? 'emptyState doors__empty' : 'emptyState doors__problem'}
          role="alert"
        >
          <span className="emptyState__icon emptyState__icon--error">
            <AlertIcon />
          </span>
          <h3 className="emptyState__title">The doors could not be read</h3>
          <p className="emptyState__hint">{state.error?.message}</p>
          {errorHint === null ? null : <p className="emptyState__hint">{errorHint}</p>}
          <div className="emptyState__actions">
            {errorHint === null ? null : (
              <button type="button" className="button button--primary" onClick={onOpenSettings}>
                <GearIcon />
                Open settings
              </button>
            )}
            <button type="button" className="button" onClick={refresh}>
              <RefreshIcon />
              Try again
            </button>
          </div>
        </div>
      ) : body === 'empty' ? (
        <div
          className={cards.length === 0 ? 'emptyState doors__empty' : 'emptyState doors__problem'}
        >
          <span className="emptyState__icon">
            <DoorIcon />
          </span>
          <h3 className="emptyState__title">No doors</h3>
          <p className="emptyState__hint">
            Your console has no doors. Add one in Access, then press Refresh.
          </p>
        </div>
      ) : null}

      {cardList}

      <PollingCard polling={polling ?? defaultAccessPolling()} />
    </section>
  )
}
