// `<ToastHost>`: draws state/toastStore.ts's toasts, bottom right of the window, above the screens
// (P5.4). Mounted once by the app shell.
//
// The list is one polite live region (`role="status"`), always in the DOM even when empty, so a
// screen reader is already watching it when a toast arrives and reads the new one out. Each toast
// is an icon, its sentence and, for an error or a warning, a Dismiss button (`.button--ghost
// .button--icon`); a success goes by itself (the store's timers). A warning (`--warn` amber) is for
// an outcome that is not known to have failed, e.g. an unlock with no answer from Access. Not focus-stealing: a toast never takes the focus,
// so holding an unlock and reading its outcome never moves the keyboard anywhere.
import type { JSX } from 'react'
import { dismissToast, useToastStore } from '../state/toastStore'
import { AlertIcon, CheckIcon, XIcon } from './icons'

export function ToastHost(): JSX.Element {
  const toasts = useToastStore((state) => state.toasts)
  return (
    <div className="toastHost" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span className="toast__icon">
            {toast.tone === 'success' ? <CheckIcon /> : <AlertIcon />}
          </span>
          <p className="toast__message">{toast.message}</p>
          {toast.tone !== 'success' ? (
            <button
              type="button"
              className="button button--ghost button--icon button--sm toast__dismiss"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => {
                dismissToast(toast.id)
              }}
            >
              <XIcon />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
