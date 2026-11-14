// The class of a header-style toggle button (styles.css `.app__navButton`), shared by the app's
// screen switcher (App.tsx) and any screen-level toolbar that wants to look like it (the temporary
// grid's size toggle, P2.4). Its own module so a screen never imports App.tsx, which imports it.

/** `app__navButton`, plus the `--active` modifier for the selected one. */
export function navClass(active: boolean): string {
  return active ? 'app__navButton app__navButton--active' : 'app__navButton'
}
