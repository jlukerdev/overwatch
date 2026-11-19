// NFR-7 (P6.2): the one bridge subscription to `IPC_EVENTS.recover`, shared by every live player.
//
// Every `<LivePlayer>` wants to hear "woke from sleep / the network changed" (playerMachine.ts,
// rule 7), but a subscription per player is a listener per cell on the same IPC channel: a View of
// more than 10 cells trips Node's `MaxListenersExceededWarning`, and the preload would validate the
// same push once per player. So the players register here instead, and this module holds **one**
// bridge subscription — taken lazily when the first player registers, dropped when the last one
// leaves, so nothing listens while no View is drawn.
//
// The core ({@link createRecoverBus}) takes the bridge's subscribe function as an argument, so it is
// tested in the node environment (tests/renderer/recoverBus.test.ts); {@link onRecover} is the app's
// one instance on `window.viewProtect.onRecover`, resolved only when the first player registers.
//
// A listener that throws is logged and skipped, never allowed to stop the others: one broken cell
// must not keep every other cell waiting out its backoff.
import type { Recover, Unsubscribe } from '@shared/ipc'

export type RecoverListener = (event: Recover) => void

export interface RecoverBus {
  /** Registers `listener`; returns its unsubscribe (calling it twice does nothing the second time). */
  subscribe(listener: RecoverListener): Unsubscribe
}

export function createRecoverBus(source: (listener: RecoverListener) => Unsubscribe): RecoverBus {
  const listeners = new Set<RecoverListener>()
  let detach: Unsubscribe | null = null

  const deliver = (event: Recover): void => {
    // A copy, so a listener that unsubscribes (or subscribes) mid-delivery changes nothing here.
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[recoverBus] a listener threw', error)
      }
    }
  }

  return {
    subscribe(listener) {
      // Wrapped, so the same function registered twice is two registrations with two unsubscribes.
      const entry: RecoverListener = (event) => {
        listener(event)
      }
      listeners.add(entry)
      detach ??= source(deliver)
      let done = false
      return () => {
        if (done) return
        done = true
        listeners.delete(entry)
        if (listeners.size === 0 && detach !== null) {
          detach()
          detach = null
        }
      }
    },
  }
}

let singleton: RecoverBus | null = null

/** The app's bus, on `window.viewProtect.onRecover`. What each `<LivePlayer>` registers with. */
export function onRecover(listener: RecoverListener): Unsubscribe {
  singleton ??= createRecoverBus((deliver) => window.viewProtect.onRecover(deliver))
  return singleton.subscribe(listener)
}
