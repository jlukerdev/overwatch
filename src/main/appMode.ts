// The app mode's refusals (MODE-1, MODE-4): one error class and one set of sentences for every
// call main will not make in the current mode, so the connection manager, the IPC handlers and the
// error mapping all agree on the kind and the wording.
//
// **In RTSP mode the app makes no Protect or Access call of any kind** (MODE-4). Every path that
// would send one checks {@link isRtspMode} against the live config first and refuses with an
// {@link AppModeError}, which `toIpcError` maps to `bad-request`, never retryable: the request is
// well formed but not one main will act on in this mode, and repeating it unchanged cannot help
// until the user switches back to UniFi Protect in Settings. (`disabled` is DOOR-0's "Access is
// turned off" and keeps that one meaning.)
//
// No Electron and no I/O: a plain module the tests import as is.
import type { AppMode } from '@shared/models'

/** MODE-4: true while the app is in RTSP streams mode, read from the live config per call. */
export function isRtspMode(config: { readonly mode: AppMode }): boolean {
  return config.mode === 'rtsp'
}

/** The sentence every RTSP-mode refusal starts with. Homeowner text, no requirement ID. */
const IN_RTSP_MODE = 'OverWatch is in RTSP streams mode'

/** How to leave it, said once at the end of each refusal. */
const SWITCH_BACK = 'Switch to UniFi Protect in Settings to use it.'

/** MODE-4's refusal messages, one per kind of call, each naming what was not done. */
export const RTSP_MODE_MESSAGES = {
  /** Connect, Test connection, the camera list, snapshots, stream qualities. */
  protect: `${IN_RTSP_MODE}, so it does not contact a UniFi console. ${SWITCH_BACK}`,
  /** An unlock from a cell, a Doors screen action, the emergency status. */
  door: `${IN_RTSP_MODE}, so nothing was sent to the door. ${SWITCH_BACK}`,
  /** The Doors screen's reason nothing is read. */
  doors: `${IN_RTSP_MODE}, so the doors are not read. ${SWITCH_BACK}`,
} as const

/**
 * A View write whose mode changed between the request and the write (MODE-4): see `saveFields` in
 * src/main/ipc/handlers.ts for why it is refused rather than written to either list.
 */
export const MODE_SWITCHED_MESSAGE =
  'The app mode changed while the Views were being saved, so nothing was saved. Try again.'

/**
 * A call refused because of the app mode (MODE-4). `toIpcError` maps it to `bad-request`, never
 * retryable. The message is one of the fixed sentences above: it carries no address, no id and no
 * secret.
 */
export class AppModeError extends Error {
  readonly kind = 'bad-request' as const

  constructor(message: string) {
    super(message)
    this.name = 'AppModeError'
  }
}
