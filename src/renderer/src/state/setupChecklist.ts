// The setup checklist of the Live and Cameras empty states (UX polish 2026-11-17; CON-1, CON-3, CON-4): the
// steps between a fresh install and a connected console, each marked done or not, so the empty
// state says what is left rather than only that something is.
//
// What is missing is `setupGaps`' answer (state/camerasStore.ts) — the same rule the Cameras screen
// uses — so the two screens never disagree about why there is nothing to show. The last step,
// connecting, is done only while Protect is `connected`: it is the one step that is an action
// rather than a stored setting, and it happens on the Cameras screen.
import type { EndpointStatus } from '@shared/ipc'
import { setupGaps, type SetupGap } from './camerasStore'

export type SetupStepId = SetupGap | 'connect'

export interface SetupStep {
  readonly id: SetupStepId
  /** An instruction, the same whether done or not; the tick says which. */
  readonly label: string
  readonly done: boolean
}

/** In the order the user does them (Settings top to bottom, then connect). */
const STEP_LABELS: readonly (readonly [SetupStepId, string])[] = [
  ['host', 'Enter the console address'],
  ['credential', 'Save a Protect API key'],
  ['certificate', 'Accept the console’s certificate'],
  ['connect', 'Connect to the console'],
]

/** Every setup step for Protect's status, in order, with the ones already done marked. */
export function setupChecklist(protect: EndpointStatus): SetupStep[] {
  const gaps = setupGaps(protect)
  return STEP_LABELS.map(([id, label]) => ({
    id,
    label,
    done: id === 'connect' ? protect.phase === 'connected' : !gaps.includes(id),
  }))
}

/** How many steps are still open, for the empty state's hint. */
export function openSetupSteps(steps: readonly SetupStep[]): number {
  return steps.filter((step) => !step.done).length
}
