// The active View, drawn letterboxed (P3.2; VIEW-5, VIEW-7): the largest grid whose 1×1 cells are
// exactly the View's `aspect`, centred in whatever box this component is given, with the View's
// `gap` between cells and the page background in the bars and the gaps.
//
// Thin on purpose (no jsdom here; CLAUDE.md). The two decisions live in pure, tested code:
// `buildViewSlots` (./gridLayout) says what goes in each cell, `layoutGrid` / `cellRect`
// (@shared/viewLayout) say where. This file only measures its own box and places the result.
//
// **Absolutely positioned, not a CSS grid.** The P2.4 grid stretched `1fr` tracks to the window, so
// a cell had whatever shape the window had. VIEW-5 wants every unit cell at one exact aspect and
// spans of any rectangle, which `layoutGrid` already computes in px; CSS grid would have to be
// re-taught the same arithmetic. Values stay fractional — CSS lays out at subpixel precision, and
// rounding would make the grid narrower than it could be (see `layoutGrid`).
//
// **One component across View switches.** The Live screen renders the same `<GridView>` whatever the
// active View, and the slots are keyed by camera — a cell's first (`buildViewSlots`) — so a camera
// that leads a cell in both the old and the new View keeps its player and its stream; only the box
// around it moves. A multi-camera cell keyed the same in both keeps its scheduler too, `configure`d
// to the new View's cell, so the camera it shows carries over. The player is
// built for that: a moved `<vp-mse-player>` keeps playing (MsePlayer.ts, `onconnect`).
//
// **Multi-camera cells** (P4.2; CELL-2, FILL-3). `useCellSchedulers` (features/cells/) keeps one
// scheduler per slot whose cell has two or more cameras, driven by the Protect event bus and a
// timer, and says which of the cell's cameras each one shows; `buildViewSlots` draws that one. The
// slot's key follows the cell's first camera, not the shown one, so a rotation or a motion switch
// keeps the slot, its `<Cell>` and its zoom layer mounted and only hands the cell a new `cameraId`
// (Cell.tsx restarts the player for it). The filled slot's scheduler is pinned in the same render
// that fills it, and unpinned in the one that leaves, so a filled cell never changes camera on its
// own. The overlay's position and next / previous (P4.3; CELL-3) read the slot's `position` and
// call the hook's stable `step`, handed to every cell as `onStep` — a camera cell's `<Cell>` and a
// multi-camera cell's missing-camera placeholder (`<MissingCell>`) alike, in the grid and in fill.
// A filled multi-camera cell stays filled when a step lands on a missing camera (`filledSlotKey`).
// **Pre-warm** (P4.4): the hook also names, per rotating slot, the camera its next rotation step
// shows once that step is 2 s away; `buildViewSlots` resolves it to a camera and the quality it will
// play at, and the slot's `<Cell>` opens it hidden, so the step lands on a picture that is already
// decoding (Cell.tsx). Only for a slot on screen (`canPrewarm`): never the filled slot (pinned, so no
// upcoming rotation), a slot covered by it, or a slot drawn at zero size.
//
// **Fill lives here too** (P3.5; FILL-1/2/3, QUAL-5/6). Clicking a camera cell fills the grid area with
// it, and that is this component re-placing one slot, not another component appearing: the filled
// slot keeps its key, its `<Cell>` and its `<LivePlayer>`, gets `gridView__slot--filled` (the whole
// grid area; the header and the View switcher stay usable beside it, grid.css) instead of its rectangle, and is
// handed the slot's `fillQuality` and `FILL_FIT`. The player's own quality swap does the rest
// seamlessly (FILL-2). Every other slot stays mounted and laid out underneath — covered, not hidden —
// so its stream keeps running and leaving fill is instant; while covered it is `inert` and
// `aria-hidden`, so Tab and assistive tech cannot reach controls nobody can see. Which slot is
// filled, and which clicks and keys enter and leave, are the pure rules in features/fill/fillMode.ts;
// this file keeps the state, listens for `Esc` while filled, and draws the answer.
//
// **The fill / back transition** (FILL-1, UX polish; features/fill/fillTransition.ts). The re-placing
// above is still instant: layout changes once, in the commit. Right after it — in a layout effect, so
// before the browser paints the new placement — the slot that filled or unfilled gets one Web
// Animation on its own element: a `transform` from "drawn where it came from" to none, ~170 ms,
// ease-out. Transform only (the compositor runs it; no width / height / top / left is animated, no
// React state changes per frame), on `.gridView__slot`, never on the zoom's `.zoomPan` layer inside
// the cell, and the slot's `<Cell>` and player are untouched, so FILL-2's "same player" holds and
// the quality swap runs under it as before. A slot shrinking back carries `data-fill-transition`
// until it is home, to stay above its siblings (grid.css). Skipped under
// `prefers-reduced-motion`, on a View switch (the grid under the fill is another grid), and when the
// layout has no size; a new transition cancels one still running, and a cancelled or finished
// animation leaves no transform behind. Nothing waits for it: `Esc`, double-click, the back control
// and a View switch act at once, as before, and the animation only follows.
//
// **Quality pickers live here too** (P3.7; QUAL-4/5/6). A cell's picker in the grid saves the cell's
// override straight away (`viewsActions.updateView` + `setCellQuality`); the store's answer changes
// the slot's `quality`, and the player's seamless swap does the rest (QUAL-6). The fill picker's pick
// is *session* state here (`fillPick`), applied above QUAL-5's chain and dropped on every way out of
// fill, or when another slot fills (`activeFillPick`, fillMode.ts); the fill picker's Save writes the
// shown quality to `view.fillQuality` and drops the pick once the store has it, so the picture does
// not swap back and forth on the way. A save that fails is only logged: the picker snaps back to the
// stored value on its own, because it always shows the store's (or the session's) state. A cell
// pick that would not change the stored View sends nothing; a save that lands drops only the pick
// it saved, never a newer one made meanwhile.
//
// **Audio is wired here too** (P5.1; AUD-1/2/3). The rules are state/audioStore.ts's: one active
// source, a slot of this View *with the camera it showed when unmuted*. This component reads it and
// tells each camera cell whether it is that source (`audible`, by the store's one rule
// `isSlotAudible`), and hands every cell the app-wide volume, so a cell that becomes audible already
// has the right level (a volume drag re-renders the cells; their players only set a property).
// After every render that rebuilds the slots or changes the filled one, the same rule lets the store
// drop a source no longer heard (`syncSlots`: a rotation, a step, a trigger switch, the camera gone,
// offline or its mic off, a View switch, or another cell filled — filling mutes every other cell,
// user decision 2026-11-16), so audio never follows a cell onto another camera, even one that rotates
// back. Unmounting — leaving the Live screen or opening the View editor — mutes everything. `M` mutes
// all (features/audio/muteShortcut.ts), heard only while a cell is unmuted, like `Esc` only while
// filled.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Camera } from '@shared/ipc'
import type { View } from '@shared/models'
import { isQuality, type Quality, type QualityDefaults, type StreamQuality } from '@shared/quality'
import { cellRect, layoutGrid, type Rect } from '@shared/viewLayout'
import { useAppStore } from '../../state/appStore'
import { audioActions, isSlotAudible, useAudioStore } from '../../state/audioStore'
import { isMuteAllKey } from '../audio/muteShortcut'
import { viewsActions, type ViewResult } from '../../state/viewsStore'
import { Cell } from '../cells/Cell'
import { MissingCell } from '../cells/MissingCell'
import { overlayAutoHideMs } from '../cells/overlayVisibility'
import { shownIndices, type StepDirection } from '../cells/schedulerSet'
import { useCellSchedulers } from '../cells/useCellSchedulers'
import {
  activeFillPick,
  canSaveFillQuality,
  effectiveFillQuality,
  FILL_FIT,
  fillClickStep,
  filledSlotKey,
  isFillExitKey,
  pickAfterFillSave,
  type FillClickEvent,
  type FillQualityPick,
  type FillState,
} from '../fill/fillMode'
import {
  FILL_TRANSITION_EASING,
  FILL_TRANSITION_MS,
  fillTransitionPlan,
  flipTransform,
  flipTransformCss,
} from '../fill/fillTransition'
import { setCellQuality } from '../quality/qualityChoice'
import { keyEventTarget } from '../viewSwitcher/viewShortcut'
import { buildViewSlots, schedulerEntries, type GridSlot } from './gridLayout'
import './grid.css'

export interface GridViewProps {
  readonly view: View
  /** The inventory: names, and whether a View's camera still exists. */
  readonly cameras: readonly Camera[]
  /** `settings.streams`, the last level of QUAL-3's chain. */
  readonly streams: QualityDefaults
}

interface BoxSize {
  readonly width: number
  readonly height: number
}

/** Set on a slot while it shrinks back from fill (grid.css). */
const FILL_TRANSITION_ATTRIBUTE = 'data-fill-transition'

/** Read when a transition is about to start, never subscribed to: the next one sees a change. */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function GridView({ view, cameras, streams }: GridViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // `null` until the first measure.
  const [box, setBox] = useState<BoxSize | null>(null)

  // The content box in CSS px, kept current through every window or sidebar resize (VIEW-5:
  // "reflows on resize"). The observer reports once right after `observe`, which is the first
  // measure; until then nothing is drawn (see the render below).
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (rect === undefined) return
      setBox((previous) =>
        previous !== null && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      )
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [])

  // CELL-4. Read here, once for the grid, and handed down as a number so `<Cell>` stays memoised on
  // primitives. `undefined` before settings load, which `overlayAutoHideMs` turns into the default.
  const autoHideMs = overlayAutoHideMs(useAppStore((s) => s.settings?.ui.overlayAutoHideSec))

  // FILL-1. The state names a slot of a View; `filledSlotKey` decides whether it is still filled
  // (another View on screen, the camera gone, the cell edited away: no). A state that no longer
  // fills anything is dropped right away, in render (React's "adjust state when props change"), so
  // coming back to that View later does not re-fill a cell out of nowhere.
  const [fill, setFill] = useState<FillState>(null)

  // CELL-2 / FILL-3 (header): the multi-camera cells' schedulers pick what each slot shows. The pin
  // is the fill *request* for this View, read before the slots exist because the slots depend on
  // what the schedulers show; a request that turns out not to fill (its slot is not a camera) is
  // dropped just below, and the next render unpins it. Entries are memoised on the View; the hook
  // compares them by content anyway.
  const entries = useMemo(() => schedulerEntries(view), [view])
  const pinnedKey = fill !== null && fill.viewId === view.id ? fill.slotKey : null
  const {
    views: schedulerViewsByKey,
    step: onStep,
    prewarm,
  } = useCellSchedulers(entries, pinnedKey)
  const shown = useMemo(() => shownIndices(schedulerViewsByKey), [schedulerViewsByKey])

  // `prewarm` is stable while its targets are, so this rebuilds only when one starts or ends.
  const slots = useMemo(
    () => buildViewSlots({ view, cameras, streams, shown, prewarm }),
    [view, cameras, streams, shown, prewarm],
  )

  const filledKey = filledSlotKey(fill, view.id, slots)
  if (fill !== null && filledKey === null) setFill(null)
  const isFilled = filledKey !== null

  // QUAL-5's session pick (header). Counts only for the slot filled now; one that no longer counts
  // is dropped in render like the fill state, so filling that cell again starts from the stored
  // quality.
  const [fillPick, setFillPick] = useState<FillQualityPick>(null)
  const pickedQuality = activeFillPick(fillPick, view.id, filledKey)
  if (fillPick !== null && pickedQuality === null) setFillPick(null)

  // The latest slots, for the stable quality callbacks below (a camera push rebuilds `slots`, and
  // depending on it would re-render every memoised `<Cell>`).
  const slotsRef = useRef(slots)
  // The stored View, for the same callbacks: `onQualityChange` checks a pick against it (below).
  const viewRef = useRef(view)
  useLayoutEffect(() => {
    slotsRef.current = slots
    viewRef.current = view
  }, [slots, view])

  // `fillClickStep`'s "armed" flag (fillMode.ts, "does not bounce"). Only event handlers touch it.
  const armedRef = useRef(false)
  // Disarmed on every way out of fill — Esc, the back control, a View switch, the slot going away —
  // not only by grid clicks, so a later way *into* fill that skips a grid click (a shortcut, say)
  // can never start armed and leave on its first double-click.
  useEffect(() => {
    if (!isFilled) armedRef.current = false
  }, [isFilled])

  // Stable across everything but a View switch, so memoised `<Cell>`s keep their memo. `filled` is
  // what that cell showed when the event arrived, which is what the user was looking at.
  const onCellClick = useCallback(
    (slotKey: string, filled: boolean, event: FillClickEvent): void => {
      const result = fillClickStep(armedRef.current, filled, event)
      armedRef.current = result.armed
      if (result.action === 'fill') setFill({ viewId: view.id, slotKey })
      else if (result.action === 'unfill') setFill(null)
    },
    [view.id],
  )

  const onBack = useCallback((): void => {
    setFill(null)
  }, [])

  // QUAL-4: a cell's picker in the grid. Saved at once, addressed by the cell's top-left slot. A
  // pick that changes nothing in the stored View (the same override, or the cell gone) sends
  // nothing: checked here against the View this grid shows, because `updateView` hands its
  // updater a copy and so cannot tell a no-op from an edit (`setCellQuality`).
  const onQualityChange = useCallback(
    (slotKey: string, quality: Quality | null): void => {
      const slot = slotsRef.current.find((candidate) => candidate.key === slotKey)
      if (slot === undefined) return
      const { col, row } = slot.placement
      const stored = viewRef.current
      if (stored.id === view.id && setCellQuality(stored, col, row, quality) === stored) return
      logFailure(viewsActions.updateView(view.id, (v) => setCellQuality(v, col, row, quality)))
    },
    [view.id],
  )

  // QUAL-5: a pick in fill, for this fill only.
  const onFillQualityPick = useCallback(
    (slotKey: string, quality: Quality): void => {
      setFillPick({ viewId: view.id, slotKey, quality })
    },
    // The setter is stable; listed because the compiler infers it (it is also called in render).
    [view.id, setFillPick],
  )

  // QUAL-5's fill-picker Save: the shown quality becomes `view.fillQuality`; the pick, now equal
  // to it, is dropped once the store has it — that pick only, so one made while the save was in
  // flight survives (`pickAfterFillSave`, header).
  const onSaveFillQuality = useCallback(
    (slotKey: string, quality: StreamQuality): void => {
      if (!isQuality(quality)) return
      const saving = viewsActions.updateView(view.id, (v) => ({ ...v, fillQuality: quality }))
      logFailure(saving)
      void saving.then((result) => {
        if (!result.ok) return
        const saved = { viewId: view.id, slotKey, quality }
        setFillPick((current) => pickAfterFillSave(current, saved))
      })
    },
    [view.id, setFillPick],
  )

  // AUD-2/3 (header): the source, and the level.
  const activeAudio = useAudioStore((state) => state.active)
  const volume = useAudioStore((state) => state.volume)
  const viewId = view.id
  // After the slots are drawn, a source no longer heard — or not the filled slot — is dropped.
  useLayoutEffect(() => {
    audioActions.syncSlots(viewId, slots, filledKey)
  }, [viewId, slots, filledKey])
  // Leaving the Live screen, or the editor replacing the grid: nothing stays audible.
  useEffect(
    () => () => {
      audioActions.muteAll()
    },
    [],
  )

  const onAudioToggle = useCallback(
    (slotKey: string, cameraId: string, unmute: boolean): void => {
      const source = { viewId: view.id, slotKey, cameraId }
      if (unmute) audioActions.unmute(source)
      else audioActions.mute(source)
    },
    [view.id],
  )

  // AUD-3's `M`: listening only while a cell is unmuted, so the key is free otherwise.
  const anyAudible = activeAudio !== null
  useEffect(() => {
    if (!anyAudible) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isMuteAllKey(event, keyEventTarget(event.target))) return
      event.preventDefault()
      audioActions.muteAll()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [anyAudible])

  // The fill / back transition (header): what was filled, and in which View, at the last commit,
  // and the animation still running. The slot's element is looked up by its `data-slot-key` among
  // the root's children when a transition starts — once per fill, so no ref per slot is kept.
  const lastFillRef = useRef<{ readonly viewId: string; readonly key: string | null }>({
    viewId: view.id,
    key: null,
  })
  const fillAnimationRef = useRef<Animation | null>(null)
  // Runs on every commit that changes any of these, and acts only when the filled slot did
  // (`fillTransitionPlan`): the other dependencies are what the geometry is read from. No cleanup
  // on re-run — a camera push that rebuilds `slots` mid-animation must not cut it short.
  useLayoutEffect(() => {
    const last = lastFillRef.current
    lastFillRef.current = { viewId: view.id, key: filledKey }
    // The hot path (a camera push, a resize frame): the filled slot did not change, nothing to do.
    if (last.key === filledKey) return
    // Whatever was still running is over: the slot it was on is being re-placed again, or left.
    fillAnimationRef.current?.cancel()
    fillAnimationRef.current = null
    const grid = layoutGrid({
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      cols: view.cols,
      rows: view.rows,
      aspect: view.aspect,
      gap: view.gap,
    })
    const plan = fillTransitionPlan({
      previousKey: last.key,
      nextKey: filledKey,
      sameView: last.viewId === view.id,
      drawable: grid.unitWidth > 0 && grid.unitHeight > 0,
      reducedMotion: prefersReducedMotion(),
    })
    if (plan === null || box === null) return
    const element = Array.from(rootRef.current?.children ?? []).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.slotKey === plan.slotKey,
    )
    const slot = slots.find((candidate) => candidate.key === plan.slotKey)
    if (element === undefined || slot === undefined) return
    const cell = cellRect(grid, slot.placement)
    const area: Rect = { x: 0, y: 0, width: box.width, height: box.height }
    const flip = plan.direction === 'fill' ? flipTransform(cell, area) : flipTransform(area, cell)
    if (flip === null) return
    const animation = element.animate(
      [{ transform: flipTransformCss(flip) }, { transform: 'none' }],
      { duration: FILL_TRANSITION_MS, easing: FILL_TRANSITION_EASING },
    )
    fillAnimationRef.current = animation
    if (plan.direction === 'unfill') {
      // Above its siblings until it is home (grid.css); `finish` and `cancel` both end it.
      element.setAttribute(FILL_TRANSITION_ATTRIBUTE, '')
      const done = (): void => {
        element.removeAttribute(FILL_TRANSITION_ATTRIBUTE)
      }
      animation.addEventListener('finish', done)
      animation.addEventListener('cancel', done)
    }
  }, [filledKey, view, slots, box])
  // Unmounting mid-animation: nothing left running on a detached element.
  useEffect(
    () => () => {
      fillAnimationRef.current?.cancel()
      fillAnimationRef.current = null
    },
    [],
  )

  // FILL-1's `Esc`: listening only while something is filled, so the key is free otherwise.
  useEffect(() => {
    if (!isFilled) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFillExitKey(event, keyEventTarget(event.target))) return
      event.preventDefault()
      setFill(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isFilled])

  const layout = layoutGrid({
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    cols: view.cols,
    rows: view.rows,
    aspect: view.aspect,
    gap: view.gap,
  })
  // Before the first measure nothing is drawn: there is no size yet, and mounting every player a
  // frame early would only start its streams sooner. After it, a zero layout (a transient 0×0 box
  // while the window is minimised or a sidebar animates, or a box too small to hold a cell) keeps
  // every slot **mounted** but hidden at zero size. Rendering none would unmount every
  // `<LivePlayer>` and reconnect every stream the moment the box comes back.
  const measured = box !== null
  const drawable = layout.unitWidth > 0 && layout.unitHeight > 0

  return (
    <div className="gridView" ref={rootRef}>
      {measured
        ? slots.map((slot) => {
            const filled = slot.key === filledKey
            // Under the filled cell: still playing, not reachable (header).
            const covered = isFilled && !filled
            // The same rule the store syncs by (header).
            const audible = isSlotAudible(activeAudio, view.id, slot, filledKey)
            return (
              <div
                key={slot.key}
                // For the fill / back transition's lookup (header).
                data-slot-key={slot.key}
                className={filled ? 'gridView__slot gridView__slot--filled' : 'gridView__slot'}
                // Filled: the class places it, whatever the layout says (even a zero one).
                style={
                  filled
                    ? undefined
                    : drawable
                      ? slotStyle(cellRect(layout, slot.placement))
                      : HIDDEN_SLOT
                }
                inert={covered}
                aria-hidden={covered ? true : undefined}
              >
                <SlotContent
                  slot={slot}
                  showNames={view.showNames}
                  autoHideMs={autoHideMs}
                  filled={filled}
                  fillPick={filled ? pickedQuality : null}
                  onCellClick={onCellClick}
                  onBack={onBack}
                  onQualityChange={onQualityChange}
                  onFillQualityPick={onFillQualityPick}
                  onSaveFillQuality={onSaveFillQuality}
                  onStep={onStep}
                  // P4.4: only a cell someone can see warms its next camera. The filled one is
                  // pinned anyway; a covered one or a zero-size one would open a stream for a
                  // picture nobody is looking at.
                  canPrewarm={!filled && !covered && drawable}
                  audible={audible}
                  volume={volume}
                  onAudioToggle={onAudioToggle}
                />
              </div>
            )
          })
        : null}
    </div>
  )
}

/** A quality save that failed is only logged (header); the picker already shows the stored value. */
function logFailure(saving: ViewResult): void {
  void saving.then((result) => {
    if (!result.ok) console.warn('[GridView] quality not saved:', result.error.message)
  })
}

/** A slot kept mounted through a zero layout: no size, not painted, not in the a11y tree. */
const HIDDEN_SLOT = {
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  visibility: 'hidden',
} as const

/** Left/top/size rather than a transform, so the box *is* the cell and the player fills it. */
function slotStyle(rect: Rect): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

function SlotContent({
  slot,
  showNames,
  autoHideMs,
  filled,
  fillPick,
  onCellClick,
  onBack,
  onQualityChange,
  onFillQualityPick,
  onSaveFillQuality,
  onStep,
  canPrewarm,
  audible,
  volume,
  onAudioToggle,
}: {
  readonly slot: GridSlot
  /** VIEW-8: the View's `showNames`. */
  readonly showNames: boolean
  readonly autoHideMs: number
  readonly filled: boolean
  /** QUAL-5's session pick, when this slot is the filled one and has one. */
  readonly fillPick: Quality | null
  readonly onCellClick: (slotKey: string, filled: boolean, event: FillClickEvent) => void
  readonly onBack: () => void
  readonly onQualityChange: (slotKey: string, quality: Quality | null) => void
  readonly onFillQualityPick: (slotKey: string, quality: Quality) => void
  readonly onSaveFillQuality: (slotKey: string, quality: StreamQuality) => void
  /** P4.3: a multi-camera cell's next / previous (`useCellSchedulers`' stable `step`). */
  readonly onStep: (slotKey: string, direction: StepDirection) => void
  /** P4.4: whether this slot may pre-warm its next camera (visible, not filled, not covered). */
  readonly canPrewarm: boolean
  /** AUD-2: this slot, with the camera it shows, is the one heard. */
  readonly audible: boolean
  /** AUD-3: the app-wide level (header). */
  readonly volume: number
  readonly onAudioToggle: (slotKey: string, cameraId: string, unmute: boolean) => void
}): JSX.Element {
  switch (slot.kind) {
    case 'camera': {
      // Filled: the fill stream (the session pick over QUAL-5's chain) and fit. A change of
      // `quality` is the player's seamless swap (FILL-2, QUAL-6); the badge shows it (QUAL-7).
      const fillQuality = effectiveFillQuality(slot.fillQuality, fillPick)
      return (
        <Cell
          slotKey={slot.key}
          cameraId={slot.cameraId}
          cameraRef={slot.ref}
          name={slot.name}
          showName={showNames}
          quality={filled ? fillQuality : slot.quality}
          fit={filled ? FILL_FIT : slot.fit}
          overlayAutoHideMs={autoHideMs}
          filled={filled}
          onClickEvent={onCellClick}
          onBack={onBack}
          cellQuality={slot.qualityChoice?.override ?? null}
          inheritedQuality={slot.qualityChoice?.inherited ?? null}
          canSaveFillQuality={filled && canSaveFillQuality(fillQuality, slot.fillQuality)}
          onQualityChange={onQualityChange}
          onFillQualityPick={onFillQualityPick}
          onSaveFillQuality={onSaveFillQuality}
          cameraIndex={slot.position.index}
          cameraCount={slot.position.count}
          onStep={onStep}
          // P4.4 (header). Never for the filled slot (pinned, and its quality is fill's), a covered
          // one or a zero-size one (`canPrewarm`).
          prewarmCameraId={canPrewarm ? (slot.prewarm?.cameraId ?? null) : null}
          prewarmQuality={canPrewarm ? (slot.prewarm?.quality ?? null) : null}
          audio={slot.audio}
          audible={audible}
          volume={volume}
          onAudioToggle={onAudioToggle}
          onVolumeChange={audioActions.setVolume}
        />
      )
    }
    case 'missing':
      // No player: the camera is gone from the console, or has no package camera to play
      // (gridLayout.ts header). Never filled by a click; a multi-camera cell keeps its next /
      // previous here, and stays filled on it — leaving by back, Esc or double-click
      // (MissingCell.tsx).
      return (
        <MissingCell
          slotKey={slot.key}
          cameraRef={slot.ref}
          label={slot.label}
          cameraIndex={slot.position.index}
          cameraCount={slot.position.count}
          overlayAutoHideMs={autoHideMs}
          filled={filled}
          onBack={onBack}
          onClickEvent={onCellClick}
          onStep={onStep}
        />
      )
    case 'empty':
      return <div className="gridCell gridCell--empty" aria-hidden="true" />
  }
}
