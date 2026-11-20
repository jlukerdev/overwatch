// The Add / Edit stream dialog (RTSP-1, RTSP-2): a camera name and up to three RTSP addresses, one
// per quality. A native modal `<dialog>` drawn with the shared `.dialog` styles, as ui/ConfirmDialog:
// Esc or a click on the backdrop cancels, the focus goes back to the button that opened it.
//
// **Write-only (RTSP-2).** A stored address is never shown (the renderer only knows it exists): its
// field reads "Saved" with **Replace** and **Clear**. Every rule — what each mode sends, the "at
// least one address" rule, what Save allows — is in ./streamForm, tested without a DOM; this
// component only draws the form and sends what `toSaveInput` builds.
import { useEffect, useRef, useState, type JSX } from 'react'
import type { IpcError } from '@shared/ipc'
import type { RtspQualitiesStored, RtspQuality } from '@shared/rtsp'
import { RTSP_QUALITIES } from '@shared/rtsp'
import { useAppStore } from '../../state/appStore'
import { rejectedCall } from '../../state/rejectedCall'
import { CheckIcon, UndoIcon } from '../../ui/icons'
import { StatusLine } from '../../ui/StatusLine'
import {
  NO_URL_MESSAGE,
  clearUrl,
  keepUrl,
  replaceUrl,
  setName,
  setUrl,
  streamFormFrom,
  toSaveInput,
  validateStreamForm,
  type StreamField,
  type StreamForm,
} from './streamForm'

/** Stable fallback so the store selector never returns a fresh array (zustand would loop). */
const NO_STREAMS: readonly { readonly id: string; readonly name: string }[] = []

/** The Add stream button's id: the screen renders exactly one, in the header or the empty state. */
export const ADD_STREAM_BUTTON_ID = 'streams-add'

const URL_PLACEHOLDER = 'rtsp://user:password@camera-address:554/stream'

const QUALITY_TEXT: Readonly<Record<RtspQuality, { label: string; hint: string }>> = {
  high: { label: 'High quality', hint: 'The camera’s main stream, for a single big cell or fill.' },
  medium: { label: 'Medium quality', hint: 'A mid-sized stream, for cells in smaller grids.' },
  low: { label: 'Low quality', hint: 'A smaller stream, for big grids.' },
}

/** Why Save or Add stream cannot write an address (CON-2: no plaintext fallback). */
export const NO_KEYSTORE_TITLE =
  'Stream addresses can’t be saved without Keychain or DPAPI; they are never stored as plain text.'

export function StreamDialog({
  stream,
  stored,
  onClose,
}: {
  /** The stream to edit, or `null` to add one. */
  stream: { readonly id: string; readonly name: string } | null
  /** Which of its qualities have an address (Edit only). */
  stored: RtspQualitiesStored | undefined
  onClose: () => void
}): JSX.Element {
  const streams = useAppStore((s) => s.settings?.rtsp.streams ?? NO_STREAMS)
  const keystoreAvailable = useAppStore((s) => s.keystoreAvailable)
  const saveRtspStream = useAppStore((s) => s.saveRtspStream)

  const [form, setForm] = useState<StreamForm>(() => streamFormFrom(stream ?? undefined, stored))
  const [touched, setTouched] = useState<ReadonlySet<StreamField>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<IpcError | null>(null)

  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  // Where the focus goes after a Replace / Clear / Keep re-renders the field (the button pressed
  // is gone), by element id.
  const focusNext = useRef<string | null>(null)
  // A click counts as "on the backdrop" only if it also started there, so a text selection dragged
  // out of a field does not throw away what was typed.
  const downOnBackdrop = useRef(false)

  const adding = stream === null
  const idPrefix = adding ? 'stream-add' : `stream-edit-${stream.id}`
  const check = validateStreamForm(form, streams)
  const blockedByKeystore = !keystoreAvailable && check.writesUrl
  const canSave = check.canSave && !blockedByKeystore && !busy

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return undefined
    const opener = document.activeElement
    if (!dialog.open) dialog.showModal()
    nameRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      // The empty state's Add stream button is gone once the first stream is added: fall back to
      // the header's, which replaced it.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
      else document.getElementById(ADD_STREAM_BUTTON_ID)?.focus()
    }
  }, [])

  useEffect(() => {
    if (focusNext.current === null) return
    document.getElementById(focusNext.current)?.focus()
    focusNext.current = null
  })

  const touch = (field: StreamField): void => {
    setTouched((previous) => (previous.has(field) ? previous : new Set(previous).add(field)))
  }

  const shownError = (field: StreamField): string | null =>
    touched.has(field) ? check.errors[field] : null

  const cancel = (): void => {
    if (!busy) onClose()
  }

  const submit = async (): Promise<void> => {
    if (!canSave) {
      setTouched(new Set<StreamField>(['name', ...RTSP_QUALITIES]))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await saveRtspStream(toSaveInput(form))
      if (result.ok) {
        onClose()
        return
      }
      setError(result.error)
    } catch (err) {
      setError(rejectedCall(err))
    }
    setBusy(false)
  }

  const nameError = shownError('name')
  const nameErrorId = `${idPrefix}-name-error`

  return (
    <dialog
      ref={dialogRef}
      className="dialog streamDialog"
      aria-labelledby={`${idPrefix}-title`}
      onCancel={(event) => {
        // Esc: close through React, which removes the dialog.
        event.preventDefault()
        cancel()
      }}
      onMouseDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; its content is the inner form.
        if (downOnBackdrop.current && event.target === event.currentTarget) cancel()
        downOnBackdrop.current = false
      }}
    >
      <form
        className="dialog__box"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 className="dialog__title" id={`${idPrefix}-title`}>
          {adding ? 'Add stream' : 'Edit stream'}
        </h2>

        {keystoreAvailable ? null : <StatusLine kind="warn">{NO_KEYSTORE_TITLE}</StatusLine>}

        <div className="field">
          <label className="field__label" htmlFor={`${idPrefix}-name`}>
            Camera name
          </label>
          <input
            ref={nameRef}
            id={`${idPrefix}-name`}
            className="field__input"
            type="text"
            autoComplete="off"
            placeholder="e.g. Front door"
            value={form.name}
            aria-invalid={nameError !== null}
            aria-describedby={nameError === null ? undefined : nameErrorId}
            onChange={(event) => {
              setForm((previous) => setName(previous, event.target.value))
              touch('name')
            }}
            onBlur={() => {
              touch('name')
            }}
          />
          {nameError === null ? null : (
            <span className="field__error" id={nameErrorId}>
              {nameError}
            </span>
          )}
        </div>

        <p className="streamDialog__note">
          At least one address is needed. Saved addresses are never shown again.
        </p>

        {RTSP_QUALITIES.map((quality) => (
          <UrlField
            key={quality}
            idPrefix={`${idPrefix}-${quality}`}
            quality={quality}
            form={form}
            error={shownError(quality)}
            onChange={(value) => {
              setForm((previous) => setUrl(previous, quality, value))
            }}
            onBlur={() => {
              touch(quality)
            }}
            onReplace={() => {
              focusNext.current = `${idPrefix}-${quality}-input`
              setForm((previous) => replaceUrl(previous, quality))
            }}
            onClear={() => {
              focusNext.current = `${idPrefix}-${quality}-undo`
              setForm((previous) => clearUrl(previous, quality))
            }}
            onKeep={() => {
              focusNext.current = `${idPrefix}-${quality}-replace`
              setForm((previous) => keepUrl(previous, quality))
              setTouched((previous) => {
                const next = new Set(previous)
                next.delete(quality)
                return next
              })
            }}
          />
        ))}

        {/* Edit only: every address cleared. Add says the same in the note above. */}
        {!adding && check.noUrl ? <StatusLine kind="warn">{NO_URL_MESSAGE}</StatusLine> : null}
        {error === null ? null : (
          <StatusLine kind="error" role="alert">
            {error.message}
          </StatusLine>
        )}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={!canSave}
            title={
              blockedByKeystore
                ? NO_KEYSTORE_TITLE
                : check.noUrl
                  ? NO_URL_MESSAGE
                  : !check.canSave
                    ? 'Fix the fields above first.'
                    : undefined
            }
          >
            {busy ? 'Saving…' : adding ? 'Add stream' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/**
 * One quality's address. With nothing stored, or after Replace: a text field. With an address
 * stored and untouched: "Saved" with Replace and Clear. Cleared: a line saying so, with Undo.
 */
function UrlField({
  idPrefix,
  quality,
  form,
  error,
  onChange,
  onBlur,
  onReplace,
  onClear,
  onKeep,
}: {
  idPrefix: string
  quality: RtspQuality
  form: StreamForm
  error: string | null
  onChange: (value: string) => void
  onBlur: () => void
  onReplace: () => void
  onClear: () => void
  onKeep: () => void
}): JSX.Element {
  const draft = form.urls[quality]
  const { label, hint } = QUALITY_TEXT[quality]
  const labelId = `${idPrefix}-label`
  const hintId = `${idPrefix}-hint`
  const errorId = `${idPrefix}-error`

  if (draft.mode === 'keep' || draft.mode === 'clear') {
    const cleared = draft.mode === 'clear'
    return (
      <div className="field" role="group" aria-labelledby={labelId}>
        <span className="field__label" id={labelId}>
          {label}
        </span>
        <div className="row streamDialog__saved">
          {cleared ? (
            <>
              <span className="streamDialog__cleared">Will be removed when you save.</span>
              <button
                type="button"
                id={`${idPrefix}-undo`}
                className="button button--sm button--ghost"
                onClick={onKeep}
              >
                <UndoIcon />
                Undo
              </button>
            </>
          ) : (
            <>
              <span className="qualityChip streamDialog__savedChip">
                <CheckIcon />
                Saved
              </span>
              <button
                type="button"
                id={`${idPrefix}-replace`}
                className="button button--sm"
                onClick={onReplace}
              >
                Replace
              </button>
              <button
                type="button"
                className="button button--sm button--ghost button--danger"
                onClick={onClear}
              >
                Clear
              </button>
            </>
          )}
        </div>
        <span className="field__hint">{hint}</span>
      </div>
    )
  }

  const replacing = draft.mode === 'replace'
  const describedBy = error === null ? hintId : `${errorId} ${hintId}`
  return (
    <div className="field">
      <label className="field__label" htmlFor={`${idPrefix}-input`}>
        {label}
      </label>
      <div className="row">
        <input
          id={`${idPrefix}-input`}
          className="field__input streamDialog__url"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={URL_PLACEHOLDER}
          value={draft.value}
          aria-invalid={error !== null}
          aria-describedby={describedBy}
          onChange={(event) => {
            // Never trimmed (RTSP-2): a stray space is shown as an error, not silently fixed.
            onChange(event.target.value)
          }}
          onBlur={onBlur}
        />
        {replacing ? (
          <button
            type="button"
            className="button button--icon button--ghost"
            aria-label={`Keep the saved ${label.toLowerCase()} address`}
            title="Keep the saved address"
            onClick={onKeep}
          >
            <UndoIcon />
          </button>
        ) : null}
      </div>
      {error === null ? null : (
        <span className="field__error" id={errorId}>
          {error}
        </span>
      )}
      <span className="field__hint" id={hintId}>
        {replacing ? 'Leave empty to keep the saved address.' : hint}
      </span>
    </div>
  )
}
