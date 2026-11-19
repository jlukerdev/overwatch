// NFR-8 (P6.2): telling main whether a View is on screen, so it keeps the display awake exactly
// then (`setViewVisible`, src/shared/ipc.ts; main holds one `prevent-display-sleep` blocker while
// the last answer was `true`, and counts a reload or a lost renderer as `false`).
//
// Pure of React, the DOM and the bridge, so every rule is tested in the node environment
// (CLAUDE.md; tests/renderer/viewVisibility.test.ts). `useViewVisibleReport` is the thin shell that
// hands in `document.visibilityState` and `window.viewProtect.setViewVisible`.
//
// **What "a View is on screen" means.** The wall is drawn — `<GridView>` is mounted, which already
// means the Live screen is showing, the View editor is closed and there is an active View with
// cameras to draw (LiveScreen.tsx: every empty state, "No Views yet" and the editor replace it) —
// **and** the document is `visible`: not minimised and not otherwise hidden (Chromium can also
// report a fully covered window as `hidden`, which is just as right here). A wall nobody can see
// should not keep a screen on, and an empty state is not worth keeping one on for.
//
// **The reporter.** One per mounted wall:
//  - sends the first value at once (mount), then only on a **change** — `visibilitychange` fires for
//    more than visibility (and twice around a minimise on some platforms), and every send is an IPC;
//  - sends `false` when the wall goes away (`dispose`), unless `false` is already what main holds;
//  - a send that fails (an `ok: false` answer or a bridge that throws) is logged and nothing more:
//    there is nothing for the user to do about it. The value is then forgotten, so the next update
//    — even with the same value — sends again. Only the latest send's failure counts: an older
//    one that fails after a newer one went out must not make the reporter forget the newer value.

/** NFR-8's rule (header): the wall is drawn and the document is visible. */
export function viewOnScreen(input: {
  readonly wallShown: boolean
  readonly visibilityState: DocumentVisibilityState
}): boolean {
  return input.wallShown && input.visibilityState === 'visible'
}

export interface ViewVisibleReporter {
  /** The current answer; sent only when it differs from the last one sent (header). */
  update(visible: boolean): void
  /** The wall went away: `false`, unless that is already what was sent. Later updates do nothing. */
  dispose(): void
}

export interface ViewVisibleReporterDeps {
  /** `window.viewProtect.setViewVisible`; only `ok` is read from the answer. */
  readonly send: (visible: boolean) => Promise<{ readonly ok: boolean }>
  /** Where a failure is logged (`console.warn` in the app). */
  readonly warn: (message: string, detail: unknown) => void
}

export function createViewVisibleReporter({
  send,
  warn,
}: ViewVisibleReporterDeps): ViewVisibleReporter {
  /** The last value sent, or `null` when nothing has been sent or the last send failed. */
  let sent: boolean | null = null
  let sequence = 0
  let disposed = false

  const report = (visible: boolean): void => {
    if (sent === visible) return
    sent = visible
    sequence += 1
    const mine = sequence
    const failed = (detail: unknown): void => {
      warn('[power] could not tell main whether a View is on screen', detail)
      // Forgotten only if no newer send has gone out since (header).
      if (mine === sequence) sent = null
    }
    send(visible).then((result) => {
      if (!result.ok) failed(result)
    }, failed)
  }

  return {
    update(visible) {
      if (disposed) return
      report(visible)
    },
    dispose() {
      if (disposed) return
      report(false)
      disposed = true
    },
  }
}
