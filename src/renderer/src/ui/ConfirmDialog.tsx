// The app's own confirmation dialog (UX polish, off-plan 2026-11-17): replaces `window.confirm`,
// whose OS-drawn box broke the dark UI and could only say "OK" / "Cancel".
//
// `confirmDialog(options)` resolves `true` when the user confirms and `false` on Cancel, Esc or a
// click on the backdrop. One dialog at a time: asking again while one is open answers the open one
// `false` first. `<ConfirmHost>` is mounted once, by the app shell, and draws whatever is pending.
//
// A native `<dialog>` opened with `showModal()`: the browser makes the rest of the page inert,
// traps focus and turns Esc into a `cancel` event, so none of that is re-implemented here. Focus
// starts on Cancel, so Enter on a just-opened destructive prompt never confirms it.
import { useEffect, useRef, type JSX } from 'react'
import { create } from 'zustand'

export interface ConfirmOptions {
  readonly title: string
  /** One or two sentences under the title. */
  readonly message?: string
  /** Names the action, e.g. "Delete View". Never "OK". */
  readonly confirmLabel: string
  readonly cancelLabel?: string
  /** A destructive action: the confirm button is drawn as `button--danger`. */
  readonly danger?: boolean
}

interface Pending {
  readonly options: ConfirmOptions
  readonly resolve: (confirmed: boolean) => void
}

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }))

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().pending?.resolve(false)
    useConfirmStore.setState({ pending: { options, resolve } })
  })
}

function settle(confirmed: boolean): void {
  const { pending } = useConfirmStore.getState()
  if (pending === null) return
  useConfirmStore.setState({ pending: null })
  pending.resolve(confirmed)
}

export function ConfirmHost(): JSX.Element | null {
  const pending = useConfirmStore((s) => s.pending)
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (pending === null || dialog === null) return undefined
    // What had the focus when the question was asked. React removes the dialog before this
    // cleanup can close it, and a detached dialog does not hand the focus back by itself.
    const opener = document.activeElement
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [pending])

  if (pending === null) return null
  const { title, message, confirmLabel, cancelLabel = 'Cancel', danger = false } = pending.options

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => {
        // Esc: answer `false` ourselves, so React, not the browser, removes the dialog.
        event.preventDefault()
        settle(false)
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; its content is the inner box.
        if (event.target === event.currentTarget) settle(false)
      }}
    >
      <div className="dialog__box">
        <h2 className="dialog__title" id="confirm-dialog-title">
          {title}
        </h2>
        {message === undefined ? null : <p className="dialog__message">{message}</p>}
        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            autoFocus
            onClick={() => {
              settle(false)
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'button button--danger-solid' : 'button button--primary'}
            onClick={() => {
              settle(true)
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
