# View Protect — Prototype Specification

**Status:** Draft v0.2 (prototype). Protect API verified against the official v7.3.74 contract · **Owner:** personal use only · **Built by:** coding agents (see `/CLAUDE.md`)

View Protect is a desktop app for Windows and macOS that connects to a local UniFi Protect console through the official **Integration API**. It shows live camera feeds in named, user-defined grid **Views**. It also does light UniFi Access control: unlocking the door linked to a camera.

It is **not** an NVR client. There is no playback, timeline or export, because the Protect web app already covers those.

---

## 1. Environment (target)

| Item | Value |
|---|---|
| Console | UDM SE |
| UniFi Protect | 7.3.74 |
| UniFi Access | 4.3.24 (Door Hub Mini, G3 Reader Pro) **at the deployment site only**. The development network has no Access, so Access is an optional feature, verified against a local mock until on-site testing (§5.2, DOOR-0) |
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
8. Unlock the Access door linked to a camera (optional feature, off by default; DOOR-0).

### 2.2 Deferred to MVP or later
- Auto-update, code signing and notarization
- Two-way talk (talkback)
- Multi-monitor views and kiosk/auto-start
- Cells that span multiple grid slots (non-uniform layouts)
- Exporting and importing views
- Remote access through the Site Manager Cloud Connector, for control/status/unlock only (§5.1). Video still needs LAN or VPN
- Importing Protect's own Live Views (`/v1/liveviews`) as View Protect Views
- PTZ preset/patrol buttons (the API has presets and patrols only, no continuous PTZ)
- Auto-show a camera on `nfcCardScanned` / `fingerprintIdentified` at its reader

### 2.3 Out of scope
- Recording, playback, timeline and event browsing
- Any use of the private (undocumented) Protect API or username/password login

---

## 3. Functional requirements

IDs are referenced in `DEV_PLAN.md` and in commit messages.

### Connection (CON)
- **CON-1** The user enters a console host (IP or hostname) and a Protect Integration API key. If Access is enabled (DOOR-0), they also enter an Access API token.
- **CON-2** Secrets are encrypted at rest with the OS keystore (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows). They are never written in plaintext and never logged.
- **CON-3** TLS uses **trust-on-first-use pinning**. On first connect the app shows the certificate's SHA-256 fingerprint and the user accepts it. After that, a mismatched fingerprint blocks the connection with a clear warning. Disabling TLS verification globally is not allowed.
- **CON-4** A "Test connection" button calls `GET /meta/info` (Protect) and, when Access is enabled, lists doors (Access), then shows the versions or the error.
- **CON-5** Connection status is always visible (connected / reconnecting / error).

### Cameras (CAM)
- **CAM-1** List all adopted cameras with name (fall back to model `type` when `name` is null), model, `state`, mic availability (`featureFlags.hasMic && isMicEnabled`), and a snapshot thumbnail.
- **CAM-2** Camera state stays current through `/v1/subscribe/devices`: `state` changes, renames, adds and removals.
- **CAM-3** A cell whose camera is not `CONNECTED` shows an "Offline" (or "Connecting…") placeholder and resumes on its own when the camera comes back. The snapshot endpoint returns 503 for offline cameras; treat that as normal, not an error.
- **CAM-4** For doorbells with `hasPackageCamera`, the package camera can be put in a cell as its own source (`<cameraId>:package`).

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
  - `motionSwitch` (on/off): when a camera in the cell reports a trigger event, the cell switches to it.
  - `motionTriggers` (default `["motion", "smartDetect", "ring"]`): which event types count. `smartDetect` covers `smartDetectZone`, `smartDetectLine` and `smartDetectLoiterZone`.
  - `smartDetectTypes` (optional filter, e.g. `["person", "vehicle"]`): only smart detections with these types trigger.
  - `motionHoldSec` (default 15): how long a triggered camera stays shown **after the event ends** (the `update` that sets `end`) before rotation resumes. If no `end` arrives within 60 s, treat the event as ended.
  - Priority: `ring` beats any other trigger. Otherwise the most recent event start wins. Ties go to the earlier position in the list.
  - This matches Protect's own Live View slot model (`cycleMode: motion | time`, `cycleInterval`), with one difference: View Protect lets a cell use **both** at once (rotate on a timer and break in on motion).
- **CELL-3** The overlay shows the camera name, a motion indicator, a mute toggle (only if the camera has a mic), an unlock button (only if Access is enabled and a door is linked), and for multi-camera cells the position (e.g. `2/4`) with manual next/previous buttons.
- **CELL-4** Overlay controls show on hover and auto-hide after 3 s of no mouse movement.

### Stream quality (QUAL)
Protect offers `high`, `medium` and `low` RTSPS streams for every camera, plus `package` on doorbells. **No quality is hard-coded.** The user picks it at each level below, and the most specific setting wins.

- **QUAL-1** App settings set two defaults: **grid quality** (default `low`) and **fill quality** (default `high`).
- **QUAL-2** A View can override grid quality for all its cells (`gridQuality`).
- **QUAL-3** A cell can override quality (`quality`). Effective grid quality = `cell.quality ?? view.gridQuality ?? settings.defaultGridQuality`.
- **QUAL-4** The cell overlay has a quality picker (Low / Med / High). Changing it updates that cell's `quality` and saves it. "Use View default" clears the override.
- **QUAL-5** Filled mode uses `view.fillQuality ?? settings.defaultFillQuality`. The fill overlay also has a quality picker, which applies until you leave fill mode; it has a "save as default" option.
- **QUAL-6** Changing quality swaps seamlessly: the current stream keeps playing until the new one renders its first frame (same mechanism as FILL-2).
- **QUAL-7** The app shows the effective quality on hover (e.g. `MED`), and in the camera list shows which RTSPS qualities exist on the console.
- **QUAL-8** RTSPS URLs are created **on demand**: the first time any cell or fill view needs a quality for a camera, main GETs the existing streams and POSTs only the missing quality. The app never deletes streams (they may be shared with other integrations).

### Focus / fill (FILL)
- **FILL-1** Clicking a cell (outside the controls) fills the window with that camera. `Esc`, a click on the back control, or a double-click returns to the grid.
- **FILL-2** Filled mode switches from the cell's grid quality to the fill quality (QUAL-5) if they differ. The switch should look seamless: keep the grid stream playing until the first frame of the fill stream renders.
- **FILL-3** A filled multi-camera cell pins the current camera (no rotation) until the user returns to the grid.

### Zoom (ZOOM)
- **ZOOM-1** Digital zoom works in filled mode, and optionally in cells: mouse wheel or pinch zooms at the cursor (1×–8×), and drag pans.
- **ZOOM-2** A "100%" control and double-click with a modifier reset the zoom. Zoom resets when you leave filled mode.
- **ZOOM-3** Zoom is a client-side CSS transform. It never changes camera settings.

### Audio (AUD)
- **AUD-1** Every cell starts muted. The audio control only shows when `featureFlags.hasMic && isMicEnabled`.
- **AUD-2** Unmuting a cell mutes all other cells. Only one source plays at a time.
- **AUD-3** Volume control in filled mode. A global mute-all shortcut (`M`).

### Access door unlock (DOOR)
- **DOOR-0** Access integration is an **optional feature, disabled by default**. Settings has an "Enable UniFi Access" switch. While it's off, the app makes **no Access API calls**, doesn't ask for or store an Access token, and hides everything door-related: the door-link settings, the unlock controls and the door list in Test connection. Turning it on reveals the token field and those controls. Turning it off again keeps the saved token and door links (so they come back when re-enabled), but the app stops using them. A setting in Settings can also point the Access client at a different base URL (used for the dev mock, §5.2).
- **DOOR-1** When Access is enabled and a token is set, the app fetches the list of doors.
- **DOOR-2** In settings, the user links a camera to a door. In the prototype this mapping is manual. Later the app could suggest matches by name or device.
- **DOOR-3** The cell or filled-view unlock control asks for confirmation (press-and-hold for 1 s, or a confirm dialog). It then calls the Access remote-unlock endpoint and shows success or failure.
- **DOOR-4** Unlock never runs from a keyboard shortcut alone or from an automatic trigger.
- **DOOR-5** Each unlock (time, door, result) goes to a local log file.

---

## 4. Non-functional requirements

| ID | Requirement | Target (prototype) |
|---|---|---|
| NFR-1 | Platforms | macOS 14+ (Apple Silicon), Windows 11 x64 |
| NFR-2 | Concurrent streams | 10 grid streams at `low` + 1 fill stream at `high` (default settings). Also measure 10 × `medium` so the user can see what their choice costs |
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

### 5.1 UniFi Protect Integration API (official, verified against docs)

**Source of truth:** the official Ubiquiti contract, vendored at `docs/reference/protect-openapi-v7.3.74.json` (endpoint index: `docs/reference/protect-endpoints-v7.3.74.md`). It was fetched from `developer.ui.com/protect/v7.3.74/`. This matches the console exactly. (The 7.3.74 contract is byte-identical to 7.3.70.) The latest published docs are v7.4.96. When Protect is upgraded, re-download the matching version, regenerate the types and diff the contract. **Generate TypeScript types from this file (openapi-typescript). Don't write them by hand.**

- **Base URL (local):** `https://<consoleIP>/proxy/protect/integration` + `/v1/...`
- **Base URL (cloud, not used in prototype):** `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/protect/integration`. This is the Site Manager Cloud Connector. It carries REST and control calls without a VPN, **but the RTSPS URLs it returns still point at the console**, so live video still needs the LAN or a VPN. Possible MVP use: remote status and door unlock without a VPN.
- **Auth:** header `X-API-KEY: <key>`. The official docs say to generate keys at unifi.ui.com. Keys can also be created locally in UniFi OS → Settings → Control Plane → Integrations; P0.3 confirms which kind the local endpoint accepts. There is no read-only scope, so treat the key as an admin credential.
- **Errors:** every endpoint returns `{ error: string, name: string, cause?: object }` for non-2xx responses. Map these into typed app errors.

**Endpoints used in the prototype**

| Endpoint | Use | Notes from contract |
|---|---|---|
| `GET /v1/meta/info` | Health check / Test connection (CON-4) | Returns `{ applicationVersion }` |
| `GET /v1/cameras`, `GET /v1/cameras/{id}` | Inventory (CAM-1) | Key fields: `id`, `name` (nullable), `type` (model), `state` ∈ `CONNECTED \| CONNECTING \| DISCONNECTED`, `isMicEnabled`, `featureFlags.{hasMic, hasSpeaker, smartDetectTypes, supportFullHdSnapshot}`, `hasPackageCamera`. **No codec field**, so H.265 has to be detected in the player |
| `GET /v1/cameras/{id}/snapshot` | Thumbnails | `image/jpeg`. Query `highQuality=true\|false`, `channel=main\|package`. **503 = camera offline** |
| `GET /v1/cameras/{id}/rtsps-stream` | Reuse existing stream URLs | Returns `{ high, medium, low, package }`, each a URI or `null` |
| `POST /v1/cameras/{id}/rtsps-stream` | Create a missing quality on demand (QUAL-8) | Body `{ "qualities": ["<quality>"] }` (min 1). Returns a URI for each quality requested. `high`/`medium`/`low` exist on **all** cameras. `package` only when `hasPackageCamera` |
| `DELETE /v1/cameras/{id}/rtsps-stream?qualities=…` | Not called automatically | 204. The app only ever creates streams; leave existing ones alone (other integrations such as Home Assistant may share them) |
| WS `GET /v1/subscribe/devices` | Device state (CAM-2/3) | Messages `{ type: "add" \| "update" \| "remove", item }`, where `item.modelKey` tells you the kind of device (`camera`, `nvr`, …) |
| WS `GET /v1/subscribe/events` | Motion / smart detect (CELL-2) | Messages `{ type: "add" \| "update", item: { id, modelKey: "event", type, start, end, device, smartDetectTypes? } }`. **An event starts with `add` (`end` null) and ends with an `update` that sets `end`.** `device` is the camera id |

**Event types relevant to View Protect**

| `item.type` | Meaning | Used for |
|---|---|---|
| `motion` | Camera motion start/end | Motion auto-switch (default trigger) |
| `smartDetectZone`, `smartDetectLine`, `smartDetectLoiterZone` | Smart detection; `smartDetectTypes` ⊂ `person, vehicle, package, licensePlate, face, animal` | Auto-switch with an optional type filter |
| `ring` | Doorbell/intercom ring | Auto-switch trigger (high priority) |
| `nfcCardScanned`, `fingerprintIdentified` | Reader scan at a device | Possible MVP feature: show the camera when someone badges in |
| others (sensors, alarm hub, relays, …) | — | Ignore |

**Available but not used in the prototype (useful for MVP)**

| Endpoint | Possible use |
|---|---|
| `POST /v1/cameras/{id}/talkback-session` | Two-way talk. Returns `{ url, codec, samplingRate, bitsPerSample }`. Only when `featureFlags.hasSpeaker` |
| `POST /v1/cameras/{id}/ptz/goto/{slot}`, `…/ptz/patrol/start/{slot}`, `…/ptz/patrol/stop` | PTZ **presets and patrols only**. There's no continuous pan/tilt/zoom in the API |
| `GET/POST/PATCH /v1/liveviews` | Protect's own Live Views: `slots[]` of `{ cameras[], cycleMode: "motion" \| "time", cycleInterval }`, `layout` = slot count 1–26. Possible feature: import Protect Live Views as View Protect Views |
| `GET /v1/nvrs` | NVR info and arm mode |

### 5.2 UniFi Access API

> ⚠️ **Not in Ubiquiti's official developer portal.** developer.ui.com covers Site Manager, Network, Protect and others, **but not Access**. The details below come from community sources. P0.4 verifies them on the console.

- Base: `https://<console>:12445/api/v1/developer`. On newer firmware it may also be reachable through the console proxy on 443.
- Auth: `Authorization: Bearer <token>`. The token is created in Access → Settings → Advanced → API Token.
- Used: `GET /doors`, `PUT /doors/{id}/unlock`.
- Responses (community-sourced, unverified): envelope `{ code, msg, data }` with `code: "SUCCESS"` on success and a `CODE_*` value otherwise (e.g. `CODE_ACCESS_TOKEN_INVALID`, `CODE_NOT_EXISTS`, `CODE_PARAMS_INVALID`). The HTTP status that goes with each error is undocumented, so the client treats any `code` other than `SUCCESS` as an error whatever the status. Door fields and sources: `docs/spikes/P0.4-access-mock.md`; types and zod schemas: `src/main/access/types.ts`.
- Open question: one community source says unlock may need a different auth path on some firmware. **This can't be verified until on-site testing** (the development network has no Access).

**Development mock.** Until then, the Access client is built and tested against a local mock server (`npm run mock:access`, P0.4). The mock follows the community-documented shapes (base path, Bearer auth, the response envelope, door fields, unlock) over HTTPS with a self-signed certificate, so the same TLS pinning path is exercised. Every shape it serves is marked as community-sourced and unverified. The same `npm run spike:access` script runs against the mock now and against the real console on-site (on-site checklist OS-1), and its result replaces the mock's assumptions.

### 5.3 Streaming pipeline
Protect RTSPS → **go2rtc** (bundled, bound to 127.0.0.1 only) → MSE over WebSocket → Chromium `<video>` with hardware decode. Each camera/quality pair is one go2rtc stream. go2rtc keeps **one upstream connection per stream** however many cells consume it, and connects lazily when a consumer appears. See `ARCHITECTURE.md`.

---

## 6. Data model (persisted)

```jsonc
// <userData>/config.json  (secrets live separately in secrets.bin, encrypted)
{
  "schemaVersion": 1,
  "console": { "host": "192.0.2.10", "certFingerprint": "sha256/…", "accessEnabled": false, "accessBaseUrl": null },   // DOOR-0: off by default; accessBaseUrl null = https://<host>:12445,
  "doorLinks": { "<cameraId>": "<accessDoorId>" },
  "views": [
    {
      "id": "uuid",
      "name": "Perimeter",
      "cols": 3, "rows": 3,
      "fit": "contain",
      "gridQuality": null,          // null = use settings.defaultGridQuality (QUAL-2)
      "fillQuality": null,          // null = use settings.defaultFillQuality
      "cells": [
        { "cameraIds": ["camA"], "quality": "medium" },   // per-cell override (QUAL-3)
        { "cameraIds": ["camB", "camC", "camD"], "rotateIntervalSec": 10, "motionSwitch": true,
          "motionTriggers": ["motion", "smartDetect", "ring"], "smartDetectTypes": ["person"], "motionHoldSec": 15 },
        { "cameraIds": [] }
      ]
    }
  ],
  "lastViewId": "uuid",
  "streams": { "defaultGridQuality": "low", "defaultFillQuality": "high" },   // QUAL-1; values: "low" | "medium" | "high"
  "ui": { "overlayAutoHideSec": 3 }
}
```

`cells.length === cols * rows`, in row-major order. The schema is validated with zod on load. Unknown or older `schemaVersion` values go through migrations in `src/main/config/migrations.ts`.

---

## 7. Open questions / risks

| # | Item | Mitigation |
|---|---|---|
| R1 | H.265 over MSE in Electron on Windows depends on the GPU driver and HEVC support | Phase 0 gate. Fallbacks, in order: (a) turn off Enhanced Encoding on the affected cameras, (b) have go2rtc transcode via FFmpeg (CPU cost), (c) switch the player to libmpv (see ARCHITECTURE alternatives) |
| R2 | ~~Which qualities `rtsps-stream` exposes~~ **Resolved by the official contract:** high/medium/low on all cameras, package on doorbells. Still open: whether the Protect UI shows API-created streams as "RTSP enabled" | GET first and POST only the quality actually needed (QUAL-8). Never DELETE |
| R3 | Access API isn't in the official docs; unlock auth path on 4.3.24 unverified, and **no Access hardware on the development network** | Feature is optional and off by default (DOOR-0). Build against the P0.4 mock. Verify on-site with `spike:access` (OS-1) before relying on it. Fallback: keep it disabled and ship the rest |
| R6 | API key origin: the official docs say unifi.ui.com, while local Integrations keys also exist | P0.3 tries a locally created key first |
| R7 | No codec field on cameras, so the app can't tell H.265 ahead of time | Detect in the player (go2rtc stream info). Show a "codec unsupported" state instead of a black cell |
| R8 | Contract drift on Protect upgrades | Vendored versioned OpenAPI + generated types. Contract diff is part of the upgrade checklist |
| R4 | Self-signed cert on RTSPS for go2rtc | Use go2rtc's no-verify RTSPS scheme toward the pinned console host only. Bind go2rtc to loopback |
| R5 | Integration API key is admin-level | Store only in the keystore. Never send it to the renderer |
