// The Settings screen's section sidebar (P5.3 cleanup, user request 2026-11-17), as pure functions.
//
// Two decisions live here rather than in the component, so a test can reach them (no jsdom, see
// ./settingsForm.ts): which sections the page has, in page order, and which of them the sidebar
// marks as the one in view, given what the IntersectionObserver last reported.

/** A top-level group of the Settings page, and its sidebar link. */
export interface SettingsSection {
  /** The section element's DOM id; its heading's id is `${id}-title`. */
  readonly id: string
  readonly label: string
}

export const KEYSTORE_SECTION: SettingsSection = { id: 'settings-keystore', label: 'Keystore' }
export const CONSOLE_SECTION: SettingsSection = { id: 'settings-console', label: 'Console' }
export const STREAMS_SECTION: SettingsSection = { id: 'settings-streams', label: 'Streams' }
export const DOORS_SECTION: SettingsSection = { id: 'settings-doors', label: 'Door links' }

/**
 * The sections in page order: the keystore warning only while there is no keystore (CON-2), then
 * Console and Streams, then Door links last and only while Access is **saved** as on (DOOR-0).
 */
export function settingsSections(options: {
  readonly keystoreAvailable: boolean
  readonly accessEnabled: boolean
}): SettingsSection[] {
  return [
    ...(options.keystoreAvailable ? [] : [KEYSTORE_SECTION]),
    CONSOLE_SECTION,
    STREAMS_SECTION,
    ...(options.accessEnabled ? [DOORS_SECTION] : []),
  ]
}

/** The heading id of a section, which the sidebar scrolls to and focuses. */
export function sectionTitleId(section: SettingsSection): string {
  return `${section.id}-title`
}

/** The scroll container's geometry, as the scroll handler reads it. */
export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** How far down the container the "reading line" sits, as a fraction of its height. */
export const READING_LINE = 0.25

/**
 * The section the sidebar marks as current.
 *
 * - **Locked** (`lock`): right after a sidebar click the clicked section stays current until that
 *   programmatic scroll settles, so a short last section reaching the bottom cannot steal the
 *   highlight mid-scroll. The component clears the lock on `scrollend` (with a timeout fallback).
 * - **At the bottom**: the last section — but only when the content actually scrolls and has been
 *   scrolled, so a page that fits on screen keeps its first section current.
 * - Otherwise the **last section whose top is at or above the reading line** (`READING_LINE` of
 *   the container's height). `tops` holds each section's top relative to the container's visible
 *   top, in pixels (negative once scrolled past). None at or above the line: the first section.
 */
export function activeSection(
  sections: readonly Pick<SettingsSection, 'id'>[],
  tops: ReadonlyMap<string, number>,
  metrics: ScrollMetrics,
  lock: string | null = null,
): string | null {
  if (sections.length === 0) return null
  if (lock !== null && sections.some((section) => section.id === lock)) return lock
  const { scrollTop, scrollHeight, clientHeight } = metrics
  const scrolls = scrollHeight > clientHeight + 2
  if (scrolls && scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) {
    return sections[sections.length - 1]?.id ?? null
  }
  const line = clientHeight * READING_LINE
  let current: string | null = null
  for (const section of sections) {
    const top = tops.get(section.id)
    if (top !== undefined && top <= line) current = section.id
  }
  return current ?? sections[0]?.id ?? null
}
