// A cell's door unlock control (P5.4, P5.5; DOOR-0, DOOR-2, DOOR-3, DOOR-4, DOOR-6, CELL-3/4), drawn
// in the overlay's bottom slot (CellOverlay `bottom`) by `<Cell>`, in the grid and in fill. Thin on
// purpose: the hold is ./unlockHold's reducer, when it shows is ./doorLink's rule and what it shows
// of the door is ./doorState's, all pure and tested.
//
// **Press and hold for 1 s, pointer only** (user decision 2026-11-18). A mouse, touch or pen press
// of the primary button starts a hold; a fill grows over `HOLD_MS` (CSS, started by `data-phase`,
// `transform` only; static under reduced motion); a `setTimeout` — not the animation's end — sends
// the one unlock when it fires. Releasing, leaving the button, `pointercancel` or the window losing
// focus before then cancels. The button has **no click or key handler**: Space, Enter or a synthetic
// click do nothing, so no keyboard shortcut can ever unlock (DOOR-4). It is still focusable, so its
// name and tooltip ("Hold to unlock the door") are reachable. The press-and-hold is the only thing
// that sends an unlock: the door's pushed state (below) changes the look and nothing else.
//
// Touch pointers are implicitly captured by the element they press; that capture is released at
// the press so `pointerleave` fires when a finger slides off, like a mouse. The long-press context
// menu is suppressed, and `touch-action: none` (door.css) keeps a pan from cancelling the hold.
//
// **The request.** On the hold's expiry: `unlockDoor({ cameraRef })` — the ref, never a door id;
// main resolves the door from the saved links (DOOR-4) and logs the attempt (DOOR-5). While it is in
// flight the button is busy (`aria-busy`, a spinner) and ignores presses. The outcome is a toast
// (ui/Toast): success names the camera main reports; an unknown outcome (`outcome: 'unknown'`: no
// answer from Access, the door may have opened — user decision 2026-11-18) is a warning that asks
// for a look before another press; a failure names the camera this cell shows (there is no result
// to read it from) and carries main's safe message. Nothing is retried. The toast is shown even if
// the cell has gone meanwhile; only the button's own state and timers are skipped then.
//
// **The door's state (P5.5, DOOR-6).** The look is the linked door's real lock state, which main
// watches and pushes (`doorStates` in the app store; the Live wall's `useDoorWatch` asks for it):
// the open door in green while the door is unlocked — by this app, a card, the Access app or a
// schedule — and the neutral closed door otherwise. Neutral means **locked or not known**: a door
// main has no state for yet (or cannot read) looks like a locked one and is never green. The look
// is `data-door`, separate from the hold's `data-phase`, so a hold on an already unlocked door
// shows both; such a hold sends another unlock like any other. After this app's own unlock the
// button goes back to idle and turns green when main's push says so (main re-reads the door right
// after an unlock); an unknown outcome or a failure changes nothing here.
//
// **When it is drawn.** Only while Access is saved as on, the camera (or, for a package-channel
// cell, its doorbell) has a door link, the camera is connected, and the cell's player is showing
// live video (`streaming`, reported by `<LivePlayer>` through `<Cell>`). It is kept while a request
// is in flight even if that stops being true, so the busy state does not vanish; a hold, though, is
// aborted when the button stops being available. `<Cell>` keys it by camera ref, so a rotation to
// another camera starts from a fresh, idle button.
//
// **Always visible (user decision 2026-11-18).** Unlike the controls strip it does not auto-hide
// (CELL-4): whenever it is drawn it is on screen, in the grid and in fill (door.css). Its presses never fill the cell, pan
// the zoom or arm fill's double-click: the bottom slot stops them like the strip's slot does
// (CellOverlay), and the zoom skips presses that start in it (ZoomPan).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent,
} from 'react'
import { isCameraOnline } from '@shared/models'
import { useAppStore } from '../../state/appStore'
import { showToast } from '../../state/toastStore'
import { DoorIcon, DoorOpenIcon } from '../../ui/icons'
import { parseCameraRef } from '@shared/cameraRef'
import { doorForCell, unlockAvailable } from './doorLink'
import { doorLook, unlockLabel, unlockRestTitle } from './doorState'
import {
  HOLD_MS,
  INITIAL_UNLOCK_HOLD,
  reduceUnlockHold,
  unlockFailureMessage,
  unlockResultEvent,
  unlockSuccessMessage,
  unlockUnknownMessage,
  type UnlockHoldEvent,
  type UnlockHoldState,
} from './unlockHold'
import './door.css'

export interface UnlockButtonProps {
  /** The cell's camera ref, `<cameraId>` or `<cameraId>:package`: what main resolves the door from. */
  readonly cameraRef: string
  /** The name the cell shows for it, for the failure toast. */
  readonly cameraName: string
  /** The cell's visible player is showing live video. */
  readonly streaming: boolean
}

/** The hold's length, for the CSS fill (door.css), so the two never drift apart. */
const HOLD_STYLE = { '--unlock-hold-ms': `${String(HOLD_MS)}ms` } as CSSProperties

/** The tooltip during a hold or a request; at rest it is the door state's (`unlockRestTitle`). */
const BUSY_TITLES: Readonly<Record<Exclude<UnlockHoldState['phase'], 'idle'>, string>> = {
  holding: 'Keep holding to unlock the door',
  requesting: 'Unlocking the door…',
}

export function UnlockButton({
  cameraRef,
  cameraName,
  streaming,
}: UnlockButtonProps): JSX.Element | null {
  const accessEnabled = useAppStore((s) => s.settings?.console.accessEnabled ?? false)
  const doorId = useAppStore((s) => doorForCell(cameraRef, s.settings?.doorLinks, accessEnabled))
  const connected = useAppStore((s) => {
    const { cameraId } = parseCameraRef(cameraRef)
    const camera = s.cameras.find((entry) => entry.id === cameraId)
    return camera !== undefined && isCameraOnline(camera.state)
  })
  const unlockDoor = useAppStore((s) => s.unlockDoor)
  // DOOR-6: a string, so only a change of this door's look re-renders the button.
  const look = useAppStore((s) => doorLook(doorId, s.doorStates))
  const available = unlockAvailable({ doorId, connected, streaming })

  const [state, setState] = useState<UnlockHoldState>(INITIAL_UNLOCK_HOLD)
  const stateRef = useRef<UnlockHoldState>(INITIAL_UNLOCK_HOLD)
  const holdTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  // What the request needs at the moment it is sent, without making `dispatch` depend on it.
  const requestRef = useRef({ cameraRef, cameraName, unlockDoor })
  useEffect(() => {
    requestRef.current = { cameraRef, cameraName, unlockDoor }
  }, [cameraRef, cameraName, unlockDoor])

  const dispatch = useCallback((event: UnlockHoldEvent): void => {
    // `step`, not `dispatch`, is what the timers and the request call back into: the state is in
    // refs, so any closure of it acts on the current state (as CellOverlay's dispatch does).
    const step = (current: UnlockHoldEvent): void => {
      const previous = stateRef.current
      const next = reduceUnlockHold(previous, current)
      if (next === previous) return
      stateRef.current = next
      // Unmounted (a request answered after the cell went): no state and no new timer; the toast
      // was already shown by the caller.
      if (!mountedRef.current) return
      setState(next)

      // Leaving a phase drops its timer.
      if (previous.phase === 'holding' && holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }

      if (next.phase === 'holding') {
        const pointerId = next.pointerId
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null
          step({ type: 'holdElapsed', pointerId })
        }, HOLD_MS)
      } else if (next.phase === 'requesting') {
        // Exactly one request per completed hold (unlockHold.ts); never retried.
        const request = requestRef.current
        request
          .unlockDoor({ cameraRef: request.cameraRef })
          .then((result) => {
            if (result.ok && result.value.outcome === 'unknown') {
              showToast({ tone: 'warning', message: unlockUnknownMessage(result.value.cameraName) })
            } else if (result.ok) {
              showToast({ tone: 'success', message: unlockSuccessMessage(result.value.cameraName) })
            } else {
              showToast({
                tone: 'error',
                message: unlockFailureMessage(request.cameraName, result.error.message),
              })
            }
            step(unlockResultEvent(result))
          })
          .catch(() => {
            showToast({
              tone: 'error',
              message: unlockFailureMessage(
                request.cameraName,
                'The app could not send the request.',
              ),
            })
            step({ type: 'result', ok: false })
          })
      }
    }
    step(event)
  }, [])

  // No timer left behind. A request in flight still ends in its toast (header).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  // A hold the button can no longer see through ends: no longer available, or the window lost
  // focus (Alt+Tab mid-hold, where the release would never come back here).
  useEffect(() => {
    if (!available) dispatch({ type: 'abort' })
  }, [available, dispatch])
  const holding = state.phase === 'holding'
  useEffect(() => {
    if (!holding) return undefined
    const onBlur = (): void => {
      dispatch({ type: 'abort' })
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
    }
  }, [holding, dispatch])

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    const target = event.currentTarget
    // A touch press is captured by the button implicitly; let go so sliding off is a leave.
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    dispatch({
      type: 'press',
      pointerId: event.pointerId,
      primary: event.button === 0 && event.isPrimary,
    })
  }
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>): void => {
    dispatch({ type: 'release', pointerId: event.pointerId })
  }

  // Drawn only while available, or while a request it sent is still out (header).
  if (!available && state.phase !== 'requesting') return null

  const busy = state.phase === 'requesting'
  return (
    <button
      type="button"
      className="unlockButton"
      style={HOLD_STYLE}
      aria-label={unlockLabel(look)}
      title={state.phase === 'idle' ? unlockRestTitle(look) : BUSY_TITLES[state.phase]}
      aria-busy={busy ? true : undefined}
      aria-disabled={busy ? true : undefined}
      data-phase={state.phase}
      data-door={look}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={(event) => {
        // A touch long-press would open the context menu mid-hold.
        event.preventDefault()
      }}
    >
      <span className="unlockButton__fill" aria-hidden="true" />
      {busy ? (
        <span className="spinner unlockButton__spinner" aria-hidden="true" />
      ) : look === 'unlocked' ? (
        <DoorOpenIcon className="unlockButton__icon" />
      ) : (
        <DoorIcon className="unlockButton__icon" />
      )}
    </button>
  )
}
