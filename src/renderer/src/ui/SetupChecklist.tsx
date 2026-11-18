// The setup checklist, drawn (UX polish 2026-11-17; CON-1, CON-3, CON-4): the four steps between a
// fresh install and a connected console, the done ones ticked. One component for the Live and the
// Cameras empty states, so the two cannot drift; which steps are done is `setupChecklist`'s answer
// (state/setupChecklist.ts). The tick and the number are for the eye; "(done)" / "(to do)" say the
// same to a screen reader.
import type { JSX } from 'react'
import type { SetupStep } from '../state/setupChecklist'
import { CheckIcon } from './icons'

export function SetupChecklist({ steps }: { readonly steps: readonly SetupStep[] }): JSX.Element {
  return (
    <ol className="checklist">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={step.done ? 'checklist__step checklist__step--done' : 'checklist__step'}
        >
          <span className="checklist__mark" aria-hidden="true">
            {step.done ? <CheckIcon /> : String(index + 1)}
          </span>
          <span>
            {step.label}
            <span className="visuallyHidden">{step.done ? ' (done)' : ' (to do)'}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
