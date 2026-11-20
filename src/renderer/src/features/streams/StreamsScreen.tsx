// The Streams screen (MODE-3, RTSP-1): RTSP mode's stand-in for the Cameras screen, where each
// camera's RTSP addresses are added, edited and deleted. It is in the header's nav only in RTSP mode
// (navScreens.ts) and is the start screen there until a stream and a View exist (initialScreen.ts).
//
// Laid out as the Cameras screen: QUAL-1's default-quality Settings bar first (the same
// `StreamsSettings`), then the title row, any banner, then the cards or the empty state.
//
// The addresses themselves never reach this screen (RTSP-2, CON-2): it knows the stream list from
// `settings.rtsp.streams` and, per stream, which qualities have an address from
// `secretsStored.rtspUrls` (booleans). The dialog's rules live in ./streamForm.
import { useState, type JSX } from 'react'
import { useAppStore } from '../../state/appStore'
import { showToast } from '../../state/toastStore'
import { confirmDialog } from '../../ui/ConfirmDialog'
import { AlertIcon, CameraIcon, PlusIcon } from '../../ui/icons'
import { StreamsSettings } from '../cameras/StreamsSettings'
import { StreamCard } from './StreamCard'
import { ADD_STREAM_BUTTON_ID, NO_KEYSTORE_TITLE, StreamDialog } from './StreamDialog'
import { sortStreams, streamCountLabel } from './streamForm'
import './streams.css'

/** Which dialog is open: Add, Edit of one stream (by id), or none. */
type Editing = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly id: string } | null

export function StreamsScreen(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const rtspUrls = useAppStore((s) => s.secretsStored.rtspUrls)
  const keystoreAvailable = useAppStore((s) => s.keystoreAvailable)
  const deleteRtspStream = useAppStore((s) => s.deleteRtspStream)
  const [editing, setEditing] = useState<Editing>(null)

  const streams = sortStreams(settings?.rtsp.streams ?? [])
  const editingStream =
    editing?.kind === 'edit' ? streams.find((stream) => stream.id === editing.id) : undefined

  const openAdd = (): void => {
    setEditing({ kind: 'add' })
  }

  const remove = async (id: string, name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `Delete "${name}"?`,
      message: 'Views that show this stream will show Camera not found.',
      confirmLabel: 'Delete stream',
      danger: true,
    })
    if (!confirmed) return
    try {
      const result = await deleteRtspStream(id)
      if (!result.ok) showToast({ tone: 'error', message: result.error.message })
    } catch {
      showToast({ tone: 'error', message: `"${name}" could not be deleted.` })
    }
  }

  // Creating a stream always writes an address, which needs the keystore (CON-2).
  const addButton = (
    <button
      id={ADD_STREAM_BUTTON_ID}
      type="button"
      className="button button--primary"
      onClick={openAdd}
      disabled={!keystoreAvailable}
      title={keystoreAvailable ? undefined : NO_KEYSTORE_TITLE}
    >
      <PlusIcon />
      Add stream
    </button>
  )

  return (
    <section className="streams">
      {settings === null ? null : <StreamsSettings streams={settings.streams} />}

      <header className="streams__header row">
        <h2 className="streams__title">Streams</h2>
        <span className="streams__count app__muted">{streamCountLabel(streams.length)}</span>
        <div className="streams__actions row">{streams.length === 0 ? null : addButton}</div>
      </header>

      {keystoreAvailable ? null : (
        <div className="banner banner--warn" role="status">
          <AlertIcon />
          <span className="banner__text">
            Secure storage is not available. Stream addresses can&rsquo;t be saved without Keychain
            or DPAPI; they are never stored as plain text.
          </span>
        </div>
      )}

      {streams.length === 0 ? (
        <div className="emptyState streams__empty">
          <span className="emptyState__icon">
            <CameraIcon />
          </span>
          <h3 className="emptyState__title">No streams yet</h3>
          <p className="emptyState__hint">Add a stream for each camera, using its RTSP address.</p>
          <div className="emptyState__actions">{addButton}</div>
        </div>
      ) : (
        <ul className="streams__list">
          {streams.map((stream) => (
            <StreamCard
              key={stream.id}
              id={stream.id}
              name={stream.name}
              stored={rtspUrls[stream.id]}
              onEdit={() => {
                setEditing({ kind: 'edit', id: stream.id })
              }}
              onDelete={() => {
                void remove(stream.id, stream.name)
              }}
            />
          ))}
        </ul>
      )}

      {editing === null || (editing.kind === 'edit' && editingStream === undefined) ? null : (
        <StreamDialog
          // A new key per stream, so switching from one Edit to another starts a fresh form.
          key={editing.kind === 'edit' ? editing.id : 'add'}
          stream={editingStream ?? null}
          stored={editingStream === undefined ? undefined : rtspUrls[editingStream.id]}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}
