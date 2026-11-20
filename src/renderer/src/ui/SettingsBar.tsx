// A screen's own settings, as a collapsible bar under the screen's title row (the Doors screen's
// polling, P5.6, and the Cameras screen's stream qualities, P5.7). The look is `.settingsBar` in
// ../styles.css, which also says where the bar must sit. Only the toggle opens and closes it.
//
// Closed by default; the whole bar is the toggle, titled "Settings" with a gear, and opening it
// expands downwards over the screen's content, covering it rather than moving it. The body is
// unmounted while closed, so anything that must outlive a close (a half-typed form) is the caller's
// state, kept outside `children`.
//
// Titled "Settings" (user decision 2026-11-19), so there are two "Settings" buttons on screen. The
// perf harness (src/main/perf/perfMode.ts) finds nav buttons by text scoped to `nav.app__nav`
// (today it clicks only "Live"); any new harness step that clicks "Settings" must keep that scope,
// or it will hit this bar.
import { useState, type JSX, type ReactNode } from 'react'
import { ChevronDownIcon, ChevronUpIcon, GearIcon } from './icons'

export interface SettingsBarProps {
  /** Prefix of the heading's and the body's DOM ids (`${id}-title`, `${id}-body`); unique per screen. */
  readonly id: string
  /** The body, rendered only while the bar is open. */
  readonly children: ReactNode
}

export function SettingsBar({ id, children }: SettingsBarProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const titleId = `${id}-title`
  const bodyId = `${id}-body`
  return (
    <section className="card settingsBar" aria-labelledby={titleId}>
      <h3 className="settingsBar__heading" id={titleId}>
        <button
          type="button"
          className="settingsBar__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open)
          }}
        >
          <span className="row">
            <GearIcon />
            Settings
          </span>
          {/* Closed, it opens downwards. */}
          {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="settingsBar__body">
          {children}
        </div>
      ) : null}
    </section>
  )
}
