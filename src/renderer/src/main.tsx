// Renderer entry.
//
// The shared stylesheet is imported **before** App, so it comes first in the bundled CSS and a
// feature's rule (imported by its component) wins a tie of equal specificity over the shared
// primitive it refines — e.g. `.viewEditor__name` over `.field__input`, `.cellOverlay__icon` over
// `.icon`.
//
// The Protect event bus (P4.2; CELL-2) is created here, before the first render, so it buffers
// events from startup: a multi-camera cell mounted later — the Live screen coming back from
// Settings, a View switch — replays what it missed (state/eventBus.ts).
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { cameraEventBus } from './state/eventBus'

cameraEventBus()

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
