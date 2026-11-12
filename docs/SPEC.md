# View Protect — Prototype Specification

**Status:** Draft v0.1 (prototype) · **Owner:** personal use only · **Built by:** coding agents (see `/CLAUDE.md`)

View Protect is a desktop app for Windows and macOS that connects to a local UniFi Protect console through the official **Integration API**. It shows live camera feeds in named, user-defined grid **Views**. It also does light UniFi Access control: unlocking the door linked to a camera.

It is **not** an NVR client. There is no playback, timeline or export, because the Protect web app already covers those.

---

## 1. Environment (target)

| Item | Value |
|---|---|
| Console | UDM SE |
| UniFi Protect | 7.3.74 |
| UniFi Access | 4.3.24 (Door Hub Mini, G3 Reader Pro) |
| Cameras | up to 15 total, 8–10 live in a single view |
| Encoding | Most cameras use Enhanced Encoding (H.265). Can be disabled per camera if needed |
| Network | Local LAN only. Remote use goes through a VPN and is treated as LAN |
| Users | One person. Not distributed |

## 2. Scope

### 2.1 Prototype (this spec)
Prove the hard parts end to end with functional UI, but no polish:
1. Connect to Protect with an API key. List cameras.
2. Create, edit, delete and switch between named grid Views.
3. Live grid that always scales to the window.
4. Click a cell to make that camera fill the view. Escape or a click goes back to the grid.
5. Digital zoom with a reset to 100%.
6. Multi-camera cells: rotate on an interval, and/or auto-switch on motion.
7. Per-cell audio mute/unmute.
8. Unlock the Access door linked to a camera.

### 2.2 Deferred to MVP or later
- Auto-update, code signing and notarization
- Two-way talk (talkback)
- Multi-monitor views and kiosk/auto-start
- PTZ control
- Cells that span multiple grid slots (non-uniform layouts)
- Exporting and importing views
- Cloud connections other than a VPN

### 2.3 Out of scope
- Recording, playback, timeline and event browsing
- Any use of the private (undocumented) Protect API or username/password login

---

## 3. Functional requirements

IDs are referenced in `DEV_PLAN.md` and in commit messages.

### Connection (CON)
- **CON-1** The user enters a console host (IP or hostname) and a Protect Integration API key. Optionally they also enter an Access API token.
- **CON-2** Secrets are encrypted at rest with the OS keystore (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows). They are never written in plaintext and never logged.
- **CON-3** TLS uses **trust-on-first-use pinning**. On first connect the app shows the certificate's SHA-256 fingerprint and the user accepts it. After that, a mismatched fingerprint blocks the connection with a clear warning. Disabling TLS verification globally is not allowed.
- **CON-4** A "Test connection" button calls `GET /meta/info` (Protect) and lists doors (Access), then shows the versions or the error.
- **CON-5** Connection status is always visible (connected / reconnecting / error).

### Cameras (CAM)
- **CAM-1** List all adopted cameras with name, model, online state, mic presence, and a snapshot thumbnail.
- **CAM-2** Camera state stays current through the Integration API device websocket: online/offline, renames, adds and removals.
- **CAM-3** An offline camera's cell shows an "Offline" placeholder and resumes on its own when the camera comes back.

### Views (VIEW)
- **VIEW-1** A View has a name and a uniform grid layout, `cols × rows`. Presets are 1×1, 2×2, 3×2, 3×3, 4×3 and 4×4. Custom sizes go up to 4×4.
- **VIEW-2** Each cell holds zero or more cameras (see CELL).
- **VIEW-3** The user can create, rename, duplicate, delete and reorder Views. A view editor assigns cameras to cells with drag-and-drop or a picker.
- **VIEW-4** The active View is chosen from a View switcher (sidebar or top bar). Keyboard: `1`–`9` select View N.
- **VIEW-5** The grid always fills the window. Each cell keeps the camera's aspect ratio inside it (`contain` by default, `cover` as an option per View), and the layout reflows on resize with no scrollbars.
- **VIEW-6** Views and settings are stored locally as versioned JSON and survive restarts. The app reopens the last active View.

### Cells (CELL)
- **CELL-1** A cell with one camera shows that camera live.
- **CELL-2** A cell with several cameras is a **multi-camera cell** with:
  - `rotateIntervalSec` (optional, ≥ 5): cycles through its cameras in order.
  - `motionSwitch` (on/off): when a camera in the cell reports motion or a smart detection, the cell switches to it.
  - `motionHoldSec` (default 15): how long a motion-triggered camera stays shown after the last motion event before rotation resumes.
  - Priority: if several cameras have motion, the most recent event wins. Ties go to the earlier position in the list.
- **CELL-3** The overlay shows the camera name, a motion indicator, a mute toggle (only if the camera has a mic), an unlock button (only if a door is linked), and for multi-camera cells the position (e.g. `2/4`) with manual next/previous buttons.
- **CELL-4** Overlay controls show on hover and auto-hide after 3 s of no mouse movement.

### Focus / fill (FILL)
- **FILL-1** Clicking a cell (outside the controls) fills the window with that camera. `Esc`, a click on the back control, or a double-click returns to the grid.
- **FILL-2** The grid uses the **low** quality stream. Filled mode switches to **high** quality. The switch should look seamless: keep the low stream playing until the first high frame renders.
- **FILL-3** A filled multi-camera cell pins the current camera (no rotation) until the user returns to the grid.

### Zoom (ZOOM)
- **ZOOM-1** Digital zoom works in filled mode, and optionally in cells: mouse wheel or pinch zooms at the cursor (1×–8×), and drag pans.
- **ZOOM-2** A "100%" control and double-click with a modifier reset the zoom. Zoom resets when you leave filled mode.
- **ZOOM-3** Zoom is a client-side CSS transform. It never changes camera settings.

### Audio (AUD)
- **AUD-1** Every cell starts muted.
- **AUD-2** Unmuting a cell mutes all other cells. Only one source plays at a time.
- **AUD-3** Volume control in filled mode. A global mute-all shortcut (`M`).

### Access door unlock (DOOR)
- **DOOR-1** If an Access token is set, the app fetches the list of doors.
- **DOOR-2** In settings, the user links a camera to a door. In the prototype this mapping is manual. Later the app could suggest matches by name or device.
- **DOOR-3** The cell or filled-view unlock control asks for confirmation (press-and-hold for 1 s, or a confirm dialog). It then calls the Access remote-unlock endpoint and shows success or failure.
- **DOOR-4** Unlock never runs from a keyboard shortcut alone or from an automatic trigger.
- **DOOR-5** Each unlock (time, door, result) goes to a local log file.

---

## 4. Non-functional requirements

| ID | Requirement | Target (prototype) |
|---|---|---|
| NFR-1 | Platforms | macOS 14+ (Apple Silicon), Windows 11 x64 |
| NFR-2 | Concurrent streams | 10 low-quality H.265 streams + 1 high-quality stream |
| NFR-3 | Decode | Hardware video decode. Verify in `chrome://gpu` / media internals |
| NFR-4 | Resource use | ≤ 40% CPU on a mid-range machine with 10 streams. No memory growth over 8 h |
| NFR-5 | Latency | ≤ 2 s glass-to-glass on LAN |
| NFR-6 | Startup | Last View is live within 5 s of launch |
| NFR-7 | Resilience | Streams and event sockets reconnect with backoff after an NVR reboot, network loss or sleep/wake. No manual restart needed |
| NFR-8 | Power | Stop display sleep while a View is visible |
| NFR-9 | Security | Secrets in the OS keystore. Pinned TLS. The renderer is sandboxed with `contextIsolation`, and the only API is a typed preload bridge |
| NFR-10 | Install | Prototype: unsigned local builds (`.dmg` / NSIS `.exe`). Reinstalling a newer build keeps user data |

---

## 5. External interfaces

> ⚠️ The endpoint details below come from community libraries and docs. **Phase 0 checks each one against the docs on the UDM SE itself**, and this section gets corrected.

### 5.1 UniFi Protect Integration API
- Base: `https://<console>/proxy/protect/integration/v1`
- Auth: header `X-API-KEY: <key>`. Keys are created in UniFi OS → Settings → Control Plane → Integrations. There is no read-only scope, so treat the key as an admin credential.
- Used:
  - `GET /meta/info`: version and health check
  - `GET /cameras`, `GET /cameras/{id}`: inventory
  - `GET /cameras/{id}/snapshot`: thumbnails
  - `GET|POST|DELETE /cameras/{id}/rtsps-stream`: fetch or create RTSPS URLs per quality (`high`, `medium`, `low`)
  - WebSocket `/subscribe/devices`: device state changes
  - WebSocket `/subscribe/events`: motion and smart detection events
- Later: talkback session endpoint (two-way audio).

### 5.2 UniFi Access API
- Base: `https://<console>:12445/api/v1/developer`. On newer firmware it may also be reachable through the console proxy on 443.
- Auth: `Authorization: Bearer <token>`. The token is created in Access → Settings → Advanced → API Token.
- Used: `GET /doors`, `PUT /doors/{id}/unlock`.
- Open question: one community source says unlock may need a different auth path on some firmware. Phase 0 verifies this on Access 4.3.24.

### 5.3 Streaming pipeline
Protect RTSPS → **go2rtc** (bundled, bound to 127.0.0.1 only) → MSE over WebSocket → Chromium `<video>` with hardware decode. Each camera/quality pair is one go2rtc stream. go2rtc keeps **one upstream connection per stream** however many cells consume it, and connects lazily when a consumer appears. See `ARCHITECTURE.md`.

---

## 6. Data model (persisted)

```jsonc
// <userData>/config.json  (secrets live separately in secrets.bin, encrypted)
{
  "schemaVersion": 1,
  "console": { "host": "192.168.1.1", "certFingerprint": "sha256/…", "accessEnabled": true },
  "doorLinks": { "<cameraId>": "<accessDoorId>" },
  "views": [
    {
      "id": "uuid",
      "name": "Perimeter",
      "cols": 3, "rows": 3,
      "fit": "contain",
      "cells": [
        { "cameraIds": ["camA"] },
        { "cameraIds": ["camB", "camC", "camD"], "rotateIntervalSec": 10, "motionSwitch": true, "motionHoldSec": 15 },
        { "cameraIds": [] }
      ]
    }
  ],
  "lastViewId": "uuid",
  "ui": { "overlayAutoHideSec": 3 }
}
```

`cells.length === cols * rows`, in row-major order. The schema is validated with zod on load. Unknown or older `schemaVersion` values go through migrations in `src/main/config/migrations.ts`.

---

## 7. Open questions / risks

| # | Item | Mitigation |
|---|---|---|
| R1 | H.265 over MSE in Electron on Windows depends on the GPU driver and HEVC support | Phase 0 gate. Fallbacks, in order: (a) turn off Enhanced Encoding on the affected cameras, (b) have go2rtc transcode via FFmpeg (CPU cost), (c) switch the player to libmpv (see ARCHITECTURE alternatives) |
| R2 | Not yet confirmed which qualities `rtsps-stream` exposes per camera model, and whether creating one affects the NVR | Phase 0 spike. Create only `low` + `high` |
| R3 | Access unlock auth path on 4.3.24 | Phase 0 spike |
| R4 | Self-signed cert on RTSPS for go2rtc | Use go2rtc's no-verify RTSPS scheme toward the pinned console host only. Bind go2rtc to loopback |
| R5 | Integration API key is admin-level | Store only in the keystore. Never send it to the renderer |
