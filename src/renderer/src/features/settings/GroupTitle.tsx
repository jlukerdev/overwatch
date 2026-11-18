// A Settings group's heading (P5.3 cleanup): the section sidebar's focus target. Its id is
// `sectionTitleId(section)`; tabIndex -1 lets the sidebar move the focus to it without putting it
// in the tab order. Its own module so both SettingsPage and DoorLinksCard can use it without
// importing each other.
import type { JSX, ReactNode } from 'react'
import { sectionTitleId, type SettingsSection } from './settingsSections'

export function GroupTitle({
  section,
  children,
}: {
  section: SettingsSection
  children: ReactNode
}): JSX.Element {
  return (
    <h2 className="card__title settings__groupTitle" id={sectionTitleId(section)} tabIndex={-1}>
      {children}
    </h2>
  )
}
