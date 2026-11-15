# View Protect — Prototype Specification

**Status:** Draft v0.3 (prototype). §5 corrected against the Phase 0 spikes (P0.3–P0.5) on 2026-11-13. Views amended on 2026-11-14 (spanning cells, letterboxed grid, cell gap: VIEW-1/5/7, §6 `schemaVersion: 2`). The Protect interface is verified against the official v7.3.74 contract **and** against the console running 7.3.74; Access is still community-sourced and unverified (§5.2) · **Owner:** personal use only · **Built by:** coding agents (see `/CLAUDE.md`)

View Protect is a desktop app for Windows and macOS that connects to a local UniFi Protect console through the official **Integration API**. It shows live camera feeds in named, user-defined grid **Views**. It also does light UniFi Access control: unlocking the door linked to a camera.

It is **not** an NVR client. There is no playback, timeline or export, because the Protect web app already covers those.

---

## 1. Environment (target)

| Item | Value |
|---|---|
| Console | UDM SE |
| UniFi Protect | 7.3.74 |
| UniFi Access | 4.3.24 (Door Hub Mini, G3 Reader Pro) **at the deployment site only**. The development network has no Access, so Access is an optional feature, verified against a local mock until on-site testing (§5.2, DOOR-0) |
| Cameras | up to 15 total, 8–10 live in a single view. The development console had **9 cameras, all `CONNECTED`** when P0.3 ran (3× G3 Instant, 4× G4 Instant, 1× G4 Bullet, 1× G5 Flex) and **no doorbell**, so the `package`, `ring` and `hasPackageCamera` paths are unexercised (§5.1, CAM-4) |
| Encoding | **All cameras run H.264. Enhanced Encoding (H.265) is off everywhere as of 2026-11-13**, for requirements outside this app (other consumers share the same RTSPS streams). It is a **per-camera** setting, so it was briefly on for Carport, Front Yard, Backyard and Side Yard on 2026-11-12, which is how H.265 was proven through go2rtc on macOS. The app still detects the codec per stream at runtime (R7) and works on either, but H.265 has never been driven through a real stream on Windows, so Enhanced Encoding must not be turned back on until that check is re-run (R1) |
| Network | Local LAN only. Remote use goes through a VPN and is treated as LAN |
| Users | One person. Not distributed |

## 2. Scope

### 2.1 Prototype (this spec)
Prove the hard parts end to end with functional UI, but no polish:
1. Connect to Protect with an API key. List cameras.
2. Create, edit, delete and switch between named grid Views, with cells that may span several grid slots.
3. Live grid that scales to the largest size that fits the window, keeping the View's aspect ratio (letterboxed).
4. Click a cell to make that camera fill the view. Escape or a click goes back to the grid.
5. Digital zoom with a reset to 100%.
6. Multi-camera cells: rotate on an interval, and/or auto-switch on motion.
7. Per-cell audio mute/unmute.
8. Unlock the Access door linked to a camera (optional feature, off by default; DOOR-0).

### 2.2 Deferred to MVP or later
- Auto-update, code signing and notarization
- Two-way talk (talkback)
- Multi-monitor views and kiosk/auto-start
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
- **CON-2** Secrets are encrypted at rest with the OS keystore (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows). They are never written in plaintext and never logged. The renderer can **write** a credential and clear it, but never read one back: it is told only *whether* one is stored (P1.5, §6.1). When the keystore is unavailable there is no plaintext fallback — Settings says so, and the key has to be re-entered next launch.
- **CON-3** TLS uses **trust-on-first-use pinning**. On first connect the app shows the certificate's SHA-256 fingerprint and the user accepts it. After that, a mismatched fingerprint blocks the connection with a clear warning. Disabling TLS verification globally is not allowed.
  - A pin belongs to one `host:port`. **Changing the console address clears the pin for the endpoint whose address changed** (P1.5), so a fingerprint accepted for one console can never be applied to a different one.
  - The app pins the fingerprint the user was *shown*: accepting re-reads the leaf certificate and refuses if it has changed in between.
  - Replacing an existing pin after a mismatch needs a second, explicit confirmation. Nothing re-pins on its own.
- **CON-4** A "Test connection" button calls `GET /meta/info` (Protect) and, when Access is enabled, lists doors (Access), then shows the versions or the error. Each half reports on its own — a working Protect key with a wrong Access token is a normal, informative result. **Nothing connects on launch:** resolving an address and reading a pin are offline, and the first request is always something the user asked for, which also keeps R9's per-key budget free for the streams.
- **CON-5** Connection status is always visible (connected / reconnecting / error), per endpoint, outside any one screen. The phases the app distinguishes (P1.5): `disabled` (Access off, DOOR-0), `unconfigured` (no host, no credential, or an address that will not parse), `idle` (ready, nothing asked of it yet), `connecting`, `connected`, `reconnecting`, `error`.

### Cameras (CAM)
- **CAM-1** List all adopted cameras with name (fall back to model `type` when `name` is null), model, `state`, mic availability (`featureFlags.hasMic && isMicEnabled`), and a snapshot thumbnail. Thumbnails are fetched a few at a time and refreshed on demand, never on a timer: 15 snapshots at once would spend the whole 10 req/s budget (R9) and delay the device feed, and Phase 2 replaces them with live streams anyway.
- **CAM-2** Camera state stays current through `/v1/subscribe/devices`: `state` changes, renames, adds and removals.
- **CAM-3** A cell whose camera is not `CONNECTED` shows an "Offline" (or "Connecting…") placeholder and resumes on its own when the camera comes back. The contract says the snapshot endpoint returns 503 for offline cameras; treat that as normal, not an error. **Unobserved:** every camera was online throughout P0.3, so the 503 path was never seen (R11). Tolerate either a 503 or some other failure for an offline camera.
- **CAM-4** For doorbells with `hasPackageCamera`, the package camera can be put in a cell as its own source (`<cameraId>:package`). **Unverified:** the development network has no doorbell, so nothing with `hasPackageCamera` was exercised (P0.3 §2).

### Views (VIEW)
- **VIEW-1** A View has a name, a `cols × rows` slot grid (each 1–4) and cells that each cover a rectangle of slots. Together the cells **tile the grid exactly**: no gaps and no overlaps; an empty slot is a cell with no cameras. Presets: 1×1, 2×2, 3×2, 3×3, 4×3 and 4×4 (all 1×1 cells), plus spanned presets such as **"1 + 5"** (3×3 with a 2×2 cell top-left) **"1 + 7"** (4×4 with a 3×3 cell top-left) and **"2 + 8"** (4×4 with two 2×2 cells across the top). Custom sizes go up to 4×4. The editor merges a selected rectangle of whole cells into one cell, or splits a spanned cell back into 1×1 cells (P3.3).
- **VIEW-2** Each cell holds zero or more cameras (see CELL).
- **VIEW-3** The user can create, rename, duplicate, delete and reorder Views. A view editor assigns cameras to cells with drag-and-drop or a picker.
  - **Editor (P3.3).** Opened from the View switcher ("Edit View" for the active View, "New View" for a new empty 2×2 one named "View N"); while it is open the Live grid and the `1`–`9` shortcuts are off. It edits a **draft** of one View: name, layout (a preset, or columns × rows 1–4 through `resizeGrid`), `aspect` (16:9, 4:3, 1:1, 9:16, 21:9 or a custom whole-number `w:h`), `gap`, `fit`, grid quality and fill quality (QUAL-2/5), and the cells. Nothing is stored until **Save**; **Discard** goes back to the stored View, and leaving or switching to another View with unsaved changes asks first — as does going to another screen or closing / reloading the window. The editor stays open across a visit to another screen: coming back to Live reopens it on the same View (the unsaved draft is gone once the user agreed to leave). New, duplicate (disabled while the draft has unsaved changes), delete (confirmed) and reorder act on the stored list at once.
  - **Cells.** Click a cell to select it; drag across cells or shift-click to select a rectangle, which grows to take in any cell it cuts through, so a selection is always mergeable. **Merge** keeps the first cell in reading order that has cameras (VIEW-1, `mergeCells`) and says how many other cells lost theirs; **Split** turns a spanned cell back into 1×1 cells. Picking a different preset carries the cells that have cameras, with their settings, onto the new cells in reading order and says how many did not fit.
  - **Cameras.** Drag a camera (or a doorbell's package camera, CAM-4) from the palette onto a cell to make it that cell's only camera; drag one cell onto another to swap their contents. The inspector for a selected cell lists its cameras in order, with add, remove and move up/down — until CELL-2 (Phase 4) only the first is shown on the Live screen — and the cell's quality override (QUAL-3).
- **VIEW-4** The active View is chosen from the View switcher, a sidebar on the Live screen that lists every View in order; the first nine show their number. Keyboard: while the Live screen is open, `1`–`9` (top row or numpad with Num Lock on, by physical key so any layout works) select View N if it exists. The shortcut is ignored with any modifier held (Ctrl, Cmd, Alt or Shift), on auto-repeat, while typing in a text field, select or editable element, and when something else already handled the key. Selecting a View stores it as the last View (VIEW-6); selecting the one already showing does nothing. (P3.2)
  - **No Views yet:** the Live screen offers "Create a View", which makes **View 1** showing the cameras in the camera list's order, one per cell, on the smallest uniform preset (1×1, 2×2, 3×2, 3×3, 4×3, 4×4) with a cell for each — at most 16; cells past the last camera stay empty. The editor (P3.3) changes it from there.
  - Until multi-camera cells arrive (CELL-2, Phase 4) a cell shows the **first** of its cameras; the others stay in the View. A cell whose camera is no longer on the console is drawn empty with "Camera not found" and its id, and asks for no stream; it plays again if the camera comes back (CAM-2). Likewise a `<cameraId>:package` cell whose camera has no package camera (`hasPackageCamera` false) is drawn empty with "No package camera" and the camera's name, and asks for no stream; it plays again if the flag comes back (CAM-4).
- **VIEW-5** The grid is scaled to the largest size that fits the window and centred horizontally or vertically, so that a 1×1 cell has exactly the View's video aspect ratio, `aspect` (per View, default 16:9). The leftover band is background. `aspect` is a View setting rather than read from the cameras because the Integration API does not report a camera's resolution: the `camera` schema in the contract has no width or height. A camera whose own shape differs from `aspect` (e.g. a doorbell) is fitted inside its cell by the View's `fit` (`contain` by default, `cover` as an option). The layout reflows on resize with no scrollbars.
- **VIEW-6** Views and settings are stored locally as versioned JSON and survive restarts. The app reopens the last active View.
- **VIEW-7** Each View has a `gap` in px (0–64, default 0) between adjacent cells only, with none at the outer edge. With unit cell `w × h` and gap `g > 0`, a cell spanning `k` slots is `k·w + (k−1)·g` wide and `k·h + (k−1)·g` tall, so it cannot match `aspect` exactly while the 1×1 cells do. The app keeps the 1×1 cells exact; the spanned cell's few px of difference is taken up by `fit` (e.g. ≈3.5 px of height for a 2×2 cell with an 8 px gap at 16:9). Accepted by the user on 2026-11-14.

### Cells (CELL)
- **CELL-1** A cell with one camera shows that camera live.
- **CELL-2** A cell with several cameras is a **multi-camera cell** with:
  - `rotateIntervalSec` (optional, ≥ 5): cycles through its cameras in order.
  - `motionSwitch` (on/off): when a camera in the cell reports a trigger event, the cell switches to it.
  - `motionTriggers` (default `["motion", "smartDetect", "ring"]`): which event types count. `smartDetect` covers `smartDetectZone`, `smartDetectLine` and `smartDetectLoiterZone`.
  - `smartDetectTypes` (optional filter, e.g. `["person", "vehicle"]`): only smart detections with these types trigger.
  - `motionHoldSec` (default 15): how long a triggered camera stays shown **after the event ends** before rotation resumes, measured from the event's `end` **timestamp** and not from when the `update` carrying it arrives (that update lags 3–5 s, §5.1), so the camera is held for 15 s after motion actually stopped (G4). If no `end` arrives within 60 s, treat the event as ended.
  - Priority: `ring` beats any other trigger. Otherwise the most recent event start wins. Ties go to the earlier position in the list.
  - **Setup requirement (P0.3 §5):** `motion` events only arrive for cameras whose **motion detection is enabled in Protect** — it was off on all 9 development cameras, which is why the first runs saw no `motion` at all. It is independent of smart detection: with both on, one walk-by produced both `motion` and `smartDetectZone` events. The Integration API exposes no motion-detection flag on the camera object, so the app cannot detect this or warn about it. The default trigger set (`motion`, `smartDetect`, `ring`) covers cameras with either setting on; document the per-camera Protect setting as user setup.
  - This matches Protect's own Live View slot model (`cycleMode: motion | time`, `cycleInterval`), with one difference: View Protect lets a cell use **both** at once (rotate on a timer and break in on motion).
- **CELL-3** The overlay shows the camera name, a motion indicator, a mute toggle (only if the camera has a mic), an unlock button (only if Access is enabled and a door is linked), and for multi-camera cells the position (e.g. `2/4`) with manual next/previous buttons.
  - The camera name sits top-left and is **always visible**. Everything else is in a controls strip, top-right, that auto-hides (CELL-4) and always carries the effective quality badge (QUAL-7). The controls arrive task by task: the back control while filled in P3.5 (FILL-1), the "100%" zoom reset while filled and zoomed in P3.6 (ZOOM-2), the quality picker in P3.7 — the cell's own in the grid (QUAL-4), the fill picker while filled (QUAL-5), none on a package-channel cell (CAM-4) — the position, next/previous and motion indicator in P4.3, mute in P5.1 and unlock in P5.3. A click on a control is only that control's; a click anywhere else on the cell, the name and badge included, is a click on the cell (FILL-1).
- **CELL-4** Overlay controls show on hover and auto-hide after 3 s of no mouse movement.
  - The delay is `ui.overlayAutoHideSec` (§6, default 3); every movement restarts it, and leaving the cell hides the controls at once. The cursor hides with them while it rests over the cell and comes back on the next movement. Keyboard focus inside the strip shows it and keeps it shown, so the controls can be reached by Tab; focus from a mouse click does not.

### Stream quality (QUAL)
Protect offers `high`, `medium` and `low` RTSPS streams for every camera, plus `package` on doorbells. **No quality is hard-coded.** The user picks it at each level below, and the most specific setting wins.

- **QUAL-1** App settings set two defaults: **grid quality** (default `low`) and **fill quality** (default `high`). They are set on the Settings screen's **Streams** card: each select saves on change (`vp:streams/defaults`) and shows a failed save under itself. They cannot be changed during a perf run, while the renderer is shown the run's quality as the grid default (P3.7).
- **QUAL-2** A View can override grid quality for all its cells (`gridQuality`).
  - Set in the View editor's settings row: **Grid quality** and **Fill quality** (QUAL-5) selects, each "App default (X)" — X naming the current app default, e.g. `LOW` — or High / Medium / Low. Saved with the rest of the draft. The inspector for a selected cell has the same select for the cell's `quality` (QUAL-3), with "View default (X)".
- **QUAL-3** A cell can override quality (`quality`). Effective grid quality = `cell.quality ?? view.gridQuality ?? settings.defaultGridQuality`.
- **QUAL-4** The cell overlay has a quality picker (Low / Med / High). Changing it updates that cell's `quality` and saves it. "Use View default" clears the override.
  - A compact select in the overlay's strip (CELL-3) of a grid cell: "View default (X)", where X is what the cell plays with its override cleared (`view.gridQuality ?? settings.defaultGridQuality`), then High / Medium / Low. It shows the cell's own override, "View default" when there is none. A pick is saved at once to that cell of the View and swaps seamlessly (QUAL-6); a save that fails is logged and the picker shows the stored value again. A package-channel cell (CAM-4) has no picker: the package channel is a source, not a quality.
  - While the select has focus — including the focus a click gives it, since its dropdown is then open — the strip does not auto-hide (CELL-4). A pick made with the mouse hands the focus back, and the strip then hides on the usual delay. A select focused with the mouse also hands the focus back when the pointer leaves the cell, or on `Esc` while its dropdown is closed (the next `Esc` then leaves fill), so a dropdown closed without a pick never pins the strip. Keyboard focus stays where it is. Pressing or using the select never fills the cell, pans the zoom or triggers the `1`–`9` shortcuts or fill's `Esc`.
- **QUAL-5** Filled mode uses `view.fillQuality ?? settings.defaultFillQuality`. The fill overlay also has a quality picker, which applies until you leave fill mode; it has a "save as default" option.
  - While filled, the strip's picker is the fill picker instead of the cell's: High / Medium / Low, showing what the filled camera plays. A pick is not stored: it applies to this fill only and is dropped on every way out of fill (Esc, back, double-click, a View switch, the camera or cell going away) and when another cell is filled, so filling again starts from the View's fill quality.
  - "Save as default" is a **Save for this View** button beside the fill picker (the user's call, 2026-11-15): it sets this View's `fillQuality` to the quality shown, and the pick is dropped once saved (it now equals the stored one) — unless a different pick was made while the save was in flight, which is kept. It is disabled while the shown quality already is the View's `fillQuality`. The app-wide fill default is changed only in Settings (QUAL-1). A package-channel cell has no fill picker and stays on the package channel (FILL-2).
- **QUAL-6** Changing quality swaps seamlessly: the current stream keeps playing until the new one renders its first frame (same mechanism as FILL-2).
- **QUAL-7** The app shows the effective quality on hover (e.g. `MED`), and in the camera list shows which RTSPS qualities exist on the console (P3.7), e.g. `RTSPS: HIGH · MED · LOW` with the missing ones dimmed, `none yet` when there are none, and `PKG` only for a camera with a package channel. It is fetched with the thumbnails — after them, in a second pass over the same cameras, a few at a time, on demand, again on Refresh, never on a timer, never for an offline camera, and not for a camera whose snapshot failed with a list-level error (bad key, unpinned certificate, rate limit), which reads `streams unknown` at once — and is a `GET rtsps-stream` only: it never creates a stream (that is QUAL-8's `ensureStream`). The renderer gets booleans, never URLs. A failure reads `streams unknown`, not an error. A quality a cell creates later shows after the next Refresh.
- **QUAL-8** RTSPS URLs are created **on demand**: the first time any cell or fill view needs a quality for a camera, main GETs the existing streams and POSTs only the missing quality. The app never deletes streams (they may be shared with other integrations).

### Focus / fill (FILL)
- **FILL-1** Clicking a cell (outside the controls) fills the grid area with that camera. `Esc`, a click on the back control, or a double-click returns to the grid.
  - Filled means the **whole grid area** (everything the View's letterboxed grid can use). The app header — with the connection badge and any error — and the View switcher stay visible and usable beside it; picking another View there returns to the grid like `1`–`9` does. Only a camera cell fills; an empty cell or one drawn as "Camera not found" / "No package camera" does nothing when clicked. Only a plain primary click fills: a click with Ctrl, Cmd, Alt or Shift held does not. A camera cell shows a pointer cursor in the grid (it still hides when idle, CELL-4).
  - The filled view keeps the cell's overlay (CELL-3/4): the name, and the auto-hiding strip with the quality badge (now the fill quality, QUAL-7), the fill quality picker (QUAL-5) and a **back control** ("← Grid").
  - `Esc` returns to the grid unless it is held down (auto-repeat), pressed with a modifier, typed into a text field, or already handled by something else. A double-click returns only **without** a modifier: modifier + double-click is reserved for ZOOM-2's zoom reset. A double-click on a grid cell fills it and stays filled — it does not fill and then immediately return: a double-click returns only if its first click arrived while already filled.
  - Switching View (`1`–`9`, VIEW-4) returns to the grid, as does the filled camera leaving the console (its cell becomes "Camera not found", CAM-2) or its cell no longer existing. Coming back to that View later shows the grid, not the fill.
  - The camera is fitted with `contain` in fill whatever the View's `fit`, so the whole picture is visible; detail is what zoom is for (ZOOM-1).
- **FILL-2** Filled mode switches from the cell's grid quality to the fill quality (QUAL-5) if they differ. The switch should look seamless: keep the grid stream playing until the first frame of the fill stream renders.
  - The filled view is the **same player** as the cell, enlarged — not a second one. Its quality changes to the fill quality, which is the player's own seamless swap (QUAL-6); returning to the grid swaps back the same way. A package-channel cell (CAM-4) stays on the package channel in fill.
  - The rest of the grid stays mounted underneath, covered but **still streaming** (NFR-2 budgets 10 grid streams plus 1 fill stream), so returning to the grid is instant. While covered, its cells can't be reached by Tab or assistive tech.
- **FILL-3** A filled multi-camera cell pins the current camera (no rotation) until the user returns to the grid.
  - Trivially true until multi-camera cells arrive in Phase 4: a cell shows only its first camera (CELL-2). Phase 4's scheduler (`cellScheduler`) must hold a filled cell's current camera.

### Zoom (ZOOM)
- **ZOOM-1** Digital zoom works in filled mode: mouse wheel or pinch zooms at the cursor (1×–8×), and drag pans.
  - **Fill only.** Grid cells never zoom or pan: a wheel over the grid does nothing, and a click there still fills (FILL-1). "Optionally in cells" is settled as not built, by the user's choice on 2026-11-15.
  - The wheel and a trackpad pinch zoom about the point under the cursor, which stays put, between 1× and 8×. Chromium delivers a trackpad pinch as a Ctrl+wheel, so a Ctrl+wheel zooms the camera too, a little faster per event than a plain wheel, and never zooms the app's page. On a touch screen two fingers pinch about their midpoint, and moving them pans.
  - A drag pans only while zoomed in; at 1× there is nothing to pan. The pan is clamped to the cell: the zoomed picture always covers the whole filled area, so it can never be dragged past an edge. Resizing the window keeps the zoom level and re-clamps the pan.
  - A drag is not a click: a press that moves more than a few px never counts as a click on the cell, so panning never starts fill's double-click return (FILL-1). Pressing a control in the overlay never pans.
  - The cursor shows "grab" while zoomed and "grabbing" while dragging; it still hides when idle (CELL-4).
- **ZOOM-2** A "100%" control and double-click with a modifier reset the zoom. Zoom resets when you leave filled mode.
  - The "100%" control sits in the overlay's strip next to "← Grid" (CELL-3) and is shown only while filled **and** zoomed in, where it does something.
  - The double-click is a primary-button double-click with Ctrl, Cmd, Alt or Shift held; it never leaves fill (FILL-1). On macOS Ctrl+click is a context click, so Ctrl + double-click does not reset there; the "100%" control's tooltip names the modifiers that work on the platform (⌘/⌥/⇧ on macOS, Ctrl/Alt/Shift elsewhere).
  - Every way out of fill resets the zoom: `Esc`, the back control, a plain double-click, a View switch, or the filled cell going away. Filling the camera again starts at 1×.
- **ZOOM-3** Zoom is a client-side CSS transform. It never changes camera settings.
  - The transform is on the player only: the overlay (name, badge, controls) stays the same size and in place while the picture zooms. The stream and its quality are untouched, and the player is the same one before, during and after zooming (FILL-2).

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
| NFR-3 | Decode | Hardware video decode. Verified programmatically as in P0.5: CDP `Media.playerPropertiesChanged` → `kVideoDecoderName` (`VideoToolboxVideoDecoder` on macOS, `D3D11VideoDecoder` on Windows) and `kIsPlatformVideoDecoder`, plus `app.getGPUFeatureStatus().video_decode === "enabled"`. CDP property values arrive as **strings** (`"true"`), so parse them. `chrome://gpu` and media internals are the manual equivalent |
| NFR-4 | Resource use | ≤ 40% CPU on a mid-range machine with 10 streams. No memory growth over 8 h |
| NFR-5 | Latency | ≤ 2 s glass-to-glass on LAN |
| NFR-6 | Startup | The last View's **streams** are live within 5 s of launch. The target covers streams only: camera thumbnails load lazily afterwards and never block the first frame, because the Protect rate limit (R9) makes a 15-camera snapshot burst cost seconds |
| NFR-7 | Resilience | Streams and event sockets reconnect with backoff after an NVR reboot, network loss or sleep/wake. No manual restart needed |
| NFR-8 | Power | Stop display sleep while a View is visible |
| NFR-9 | Security | Secrets in the OS keystore. Pinned TLS. The renderer is sandboxed with `contextIsolation`, and the only API is a typed preload bridge |
| NFR-10 | Install | Prototype: unsigned local builds (`.dmg` / NSIS `.exe`). Reinstalling a newer build keeps user data |

---

## 5. External interfaces

How much of each interface is actually proven differs, and the distinction matters when reading this section:

| Interface | Standing |
|---|---|
| Protect Integration API (§5.1) | **Verified against the console** in P0.3 (2026-11-12), on top of the vendored official contract. Exceptions are called out inline |
| UniFi Access API (§5.2) | **Community-sourced and unverified.** Built against a local mock (P0.4). Nothing has run against Access hardware; OS-1 is the check |
| Streaming pipeline (§5.3) | **Verified end to end** in P0.5 on macOS (2026-11-12) and Windows (2026-11-13), with the H.265 exception in R1 |

### 5.1 UniFi Protect Integration API (official contract, verified against the console in P0.3)

**Source of truth:** the official Ubiquiti contract, vendored at `docs/reference/protect-openapi-v7.3.74.json` (endpoint index: `docs/reference/protect-endpoints-v7.3.74.md`). It was fetched from `developer.ui.com/protect/v7.3.74/`. This matches the console exactly. (The 7.3.74 contract is byte-identical to 7.3.70.) The latest published docs are v7.4.96. When Protect is upgraded, re-download the matching version, regenerate the types and diff the contract. **Generate TypeScript types from this file (openapi-typescript). Don't write them by hand.**

**Verified on the console (P0.3, 2026-11-12, `docs/spikes/P0.3-protect-api.md`):** `GET /v1/meta/info` returned `applicationVersion: "7.3.74"`, matching the vendored contract. Every response sample validated against the contract except for the two drift items noted below. Three WebSocket runs totalling 9 minutes captured 70 event messages, all `smartDetectZone`; a later 5-minute re-run, after motion detection was enabled on two cameras, captured the 6 `motion` events. Every captured message validated against the contract.

- **Base URL (local):** `https://<consoleIP>/proxy/protect/integration` + `/v1/...`
- **Base URL (cloud, not used in prototype):** `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/protect/integration`. This is the Site Manager Cloud Connector. It carries REST and control calls without a VPN, **but the RTSPS URLs it returns still point at the console**, so live video still needs the LAN or a VPN. Possible MVP use: remote status and door unlock without a VPN.
- **Auth:** header `X-API-KEY: <key>`. The official docs say to generate keys at unifi.ui.com, but **a key created locally in UniFi OS → Settings → Control Plane → Integrations works on the local endpoint** (P0.3 §1, R6 resolved); no unifi.ui.com key is needed. The same header authenticates both WebSockets (`wss://<console>/proxy/protect/integration/v1/subscribe/{devices,events}`), with no subprotocol and no extensions. There is no read-only scope, so treat the key as an admin credential. **Unverified:** no run has pointed a *wrong* key at the two WebSockets, and undici fails a non-101 handshake without exposing the HTTP response, so what a rejected upgrade looks like to the client is unknown. P1.3 looks for 401/403 in the error's `cause` chain and then in its message, stops retrying when it finds one (a reconnect loop cannot fix a bad key) and treats anything unrecognised as a retryable network error. Confirm it on the next console run.
- **Errors:** every endpoint returns `{ error: string, name: string, cause?: object }` for non-2xx responses. Map these into typed app errors.
- **TLS (CON-3):** the console presents a self-signed leaf certificate, so the pinned undici Agent **must disable TLS session resumption** (`maxCachedSessions: 0`) or handle resumed sessions explicitly. On a resumed session `getPeerCertificate()` returns no fingerprint and the pin check fails (P0.3 §8). P1.2 has to carry this.

**Rate limit (not in the contract, found in P0.3 §7)**

- **10 requests per 1-second window, per key.** Over the limit: `429 { error: "Too many requests", name: "TOO_MANY_REQUESTS_ERROR", windowMs: 1000, limit: 10 }`. Treat 429 as retryable after `windowMs` — **for a GET**. A rate-limited **POST is never retried automatically** (P0.3's spike rule, which P1.3's client follows): `POST rtsps-stream` creates state, so the caller re-reads with a GET and decides whether the POST is still needed. The retry budget is 4 attempts.
- Responses carry `ratelimit: "10-in-1sec"; r=<remaining>; t=<reset s>` and `ratelimit-policy: "10-in-1sec"; q=10; w=1; pk=:<partition key>:`. The `pk` value is an opaque per-client key: **never log it.** Log these headers through an allowlist of the policy name and the numeric parameters only.
- **WebSocket upgrades count against the same budget.** A rate-limited upgrade is accepted, sent one JSON text frame with the 429 body, then closed with code **4500** and reason `Too many requests`.
- Consequence for P1.7 and P2.2: fetching snapshots for 15 cameras, or `ensureStream` for a 10-cell View, will blow the limit unless the calls are queued or throttled (the spikes spaced them ≥ 150 ms apart), and WebSocket reconnects must back off.

**Endpoints used in the prototype**

| Endpoint | Use | Notes (contract, plus what P0.3 saw on the console) |
|---|---|---|
| `GET /v1/meta/info` | Health check / Test connection (CON-4) | Returns `{ applicationVersion }`. Verified: `"7.3.74"` |
| `GET /v1/cameras`, `GET /v1/cameras/{id}` | Inventory (CAM-1) | Key fields: `id`, `name` (nullable), `type` (model), `state` ∈ `CONNECTED \| CONNECTING \| DISCONNECTED`, `isMicEnabled`, `featureFlags.{hasMic, hasSpeaker, smartDetectTypes, supportFullHdSnapshot}`, `hasPackageCamera`. **No codec field**, so H.265 has to be detected in the player (R7). **Contract drift:** `lcdMessage` is required in the contract but absent on every camera seen (none has a display), and 429 `genericError` bodies carry the extra properties `windowMs` and `limit`. Both are handled by the override layer added in P0.3b; no other undeclared properties were found |
| `GET /v1/cameras/{id}/snapshot` | Thumbnails | `image/jpeg`. Query `highQuality=true\|false`, `channel=main\|package`. **`highQuality=true` on a camera without `featureFlags.supportFullHdSnapshot` returns `400 BAD_REQUEST`** (`"Camera does not support full HD snapshot"`) and does **not** fall back to a smaller image, so only send it when the flag is true. On the one camera with the flag the default response is already 2688×1512 (~1.1 MB, 0.5–0.7 s); a typical default elsewhere was 640×360 (~32 KB, ~300 ms). The contract's **503 = camera offline is unobserved** (every camera was online): see CAM-3 and R11 |
| `GET /v1/cameras/{id}/rtsps-stream` | Reuse existing stream URLs | Returns `{ high, medium, low, package }`, each a URI or `null`. URL shape `rtsps://<console-host>:7441/<16-char alias>?enableSrtp`, one alias per quality, with the host being the console address the API was called on. URLs were identical across repeated GETs within a run and across a POST (existing qualities untouched), so they can be cached per camera/quality for the lifetime of a session and refreshed on the QUAL-8 triggers. **P0.3 never compared URL values between runs**, so don't assume a cached URL survives an app restart or a console reboot — GET again on startup. ~10–25 ms per call. Also read (GET only) for the camera list's QUAL-7 availability badges |
| `POST /v1/cameras/{id}/rtsps-stream` | Create a missing quality on demand (QUAL-8) | Body `{ "qualities": ["<quality>"] }` (min 1). **Returns only the qualities requested** (verified: `["high","low"]` → 200 with just `high` and `low`, existing `medium` untouched, ~75 ms). `high`/`medium`/`low` exist on **all** cameras per the contract. `package` only when `hasPackageCamera` (unexercised: no doorbell) |
| `DELETE /v1/cameras/{id}/rtsps-stream?qualities=…` | Not called automatically | 204. The app only ever creates streams; leave existing ones alone. **Verified need:** 4 of the 9 development cameras already had a `medium` stream and nothing else, created by something other than this app (likely Home Assistant) |
| WS `GET /v1/subscribe/devices` | Device state (CAM-2/3) | Messages `{ type: "add" \| "update" \| "remove", item }`, where `item.modelKey` tells you the kind of device (`camera`, `nvr`, …). **No initial state is sent on connect** — it is a change feed only, so load the inventory with `GET /v1/cameras` and re-GET after every reconnect. **Message shapes unverified:** 0 messages in 9 minutes, because no device changed (R11) |
| WS `GET /v1/subscribe/events` | Motion / smart detect (CELL-2) | Messages `{ type: "add" \| "update", item: { id, modelKey: "event", type, start, end?, device, smartDetectTypes? } }`. `device` is the camera id. `end` is **optional in the shape**: the opening `add` omits it rather than sending `end: null`, and the closing `update` sets it, so a schema that requires `end` rejects every `add`. See the event lifecycle below |

**Event types relevant to View Protect**

| `item.type` | Meaning | Used for | Seen in P0.3? |
|---|---|---|---|
| `motion` | Camera motion start/end | Motion auto-switch (default trigger) | **Yes**, 6 complete events, once motion detection was enabled on the camera |
| `smartDetectZone` | Smart detection; `smartDetectTypes` ⊂ `person, vehicle, package, licensePlate, face, animal` | Auto-switch with an optional type filter | **Yes**, 70 messages, all `person`, from the 5 G4 cameras |
| `smartDetectLine`, `smartDetectLoiterZone` | As above, line-crossing and loitering | Auto-switch with an optional type filter | No — contract only |
| `ring` | Doorbell/intercom ring | Auto-switch trigger (high priority) | No — contract only (no doorbell on the network) |
| `nfcCardScanned`, `fingerprintIdentified` | Reader scan at a device | Possible MVP feature: show the camera when someone badges in | No — contract only |
| others (sensors, alarm hub, relays, …) | — | Ignore | — |

**Event lifecycle (verified in P0.3 §5)**

- An event **starts** with `add`, whose item **omits `end` entirely** — it is not `end: null`. It **ends** with an `update` that sets `end`. `update` items are **full** event objects (`id, modelKey, type, start, device, smartDetectTypes[, end]`), not partial patches.
- **End updates may repeat.** The smartDetect end update was repeated two or three times with identical payloads 0–0.5 s apart; the motion end update arrived once. Consumers must be idempotent on `(id, end)`.
- **End signals lag the real world.** One smartDetect `end` update arrived about 4 s after its `end` timestamp, so expect an end signal 3–5 s after the scene goes quiet. Motion events ran roughly 10–30 s per walk-by. P0.3's two motion figures — a 16.6 s `start`→`end` and an end update 9.3 s after the `add` — come from different events and can't be combined, so **motion's end-update lag is unmeasured**; P4.1 must not depend on it. CELL-2's `motionHoldSec` is measured from the `end` timestamp, not from arrival.
- **Keepalive:** the server sent **no WebSocket pings** in 9 minutes and did not close an idle socket. The client has to detect dead connections itself (NFR-7). **P1.3 does not send pings:** undici's `WebSocket` has no standard ping API, and its connector already turns TCP keepalive on (60 s idle), so a dead peer surfaces as a socket error and the subscription reconnects with backoff. An app-level idle timeout exists but is **off by default** — both feeds are legitimately silent for many minutes, so a timeout would mostly cause reconnects that each spend a rate-limit permit and a re-read of `GET /v1/cameras`.

**Available but not used in the prototype (useful for MVP)**

| Endpoint | Possible use |
|---|---|
| `POST /v1/cameras/{id}/talkback-session` | Two-way talk. Returns `{ url, codec, samplingRate, bitsPerSample }`. Only when `featureFlags.hasSpeaker` |
| `POST /v1/cameras/{id}/ptz/goto/{slot}`, `…/ptz/patrol/start/{slot}`, `…/ptz/patrol/stop` | PTZ **presets and patrols only**. There's no continuous pan/tilt/zoom in the API |
| `GET/POST/PATCH /v1/liveviews` | Protect's own Live Views: `slots[]` of `{ cameras[], cycleMode: "motion" \| "time", cycleInterval }`, `layout` = slot count 1–26. Possible feature: import Protect Live Views as View Protect Views |
| `GET /v1/nvrs` | NVR info and arm mode |

### 5.2 UniFi Access API

> ⚠️ **Not in Ubiquiti's official developer portal.** developer.ui.com covers Site Manager, Network, Protect and others, **but not Access**. The details below come from community sources. P0.4 encoded them as a local mock and zod schemas; **OS-1 is what verifies them on the console.**

- Base: `https://<console>:12445/api/v1/developer`. On newer firmware it may also be reachable through the console proxy on 443. In the app this whole URL is `console.accessBaseUrl` (§6), so the alternative path needs no code change — only the setting.
- Auth: `Authorization: Bearer <token>`. The token is created in Access → Settings → Advanced → API Token.
- Used: `GET /doors`, `GET /doors/{id}` and `PUT /doors/{id}/unlock`. The single-door read is how the app sees an unlock take effect: the local API has no push for the lock relay, so it is polled (P0.4 §2, hubitat-unifi-access).
- Responses (community-sourced, unverified): envelope `{ code, msg, data }` with `code: "SUCCESS"` on success and a `CODE_*` value otherwise (e.g. `CODE_ACCESS_TOKEN_INVALID`, `CODE_NOT_EXISTS`, `CODE_PARAMS_INVALID`). Door fields and sources: `docs/spikes/P0.4-access-mock.md` §2; types and zod schemas: `src/main/access/types.ts`.
- **Client rules (P1.4 must follow these, P0.4 §3/§5):** an error is HTTP non-2xx **or** `code !== "SUCCESS"`, whatever the status — the HTTP status that goes with each error code is undocumented everywhere, and the real console may answer 200 with a non-`SUCCESS` code. A 401 is an auth error whatever the body. Show `msg` when it is present and fall back to the `code` plus the HTTP status when it is not — `msg` is optional in the schemas below, so a DOOR-3 failure must never surface an empty message.
- **Schema leniencies**, each marked `UNVERIFIED (OS-1)` in `types.ts`: `is_bind_hub` accepts `true`/`false` **and** the strings `"true"`/`"false"` and always parses to a boolean (anything else is rejected); the envelope's `msg` is optional while `code` stays required. `npm run spike:access` prints a **shape note** for every normalization it would apply, so OS-1 records which form the console really sends.
- **No throttle of our own.** The community guide mentions 429 throttling but documents no limit and no `Retry-After`, and R9's measured 10 req/s belongs to the *Protect* key, not to this API. P1.4's client therefore does not pace or retry anything; the door list is read once per Settings visit and an unlock is a single deliberate call (DOOR-3/4). If OS-1 finds a real limit, pacing goes where P1.7's queue goes.
- **TLS pinning is per host:port.** The certificate the console presents on 12445 may differ from the one on 443, so the Access pin is kept separately from the Protect pin (P0.4 §4).
- Open question: one community source says unlock may need a different auth path on some firmware; this is not modelled in the mock. **It can't be verified until on-site testing** (the development network has no Access).

**Development mock (built in P0.4).** Until then, the Access client is built and tested against a local mock server (`npm run mock:access`). The mock follows the community-documented shapes (base path, Bearer auth, the response envelope, door fields, unlock, and error cases including an unlock refused for a door with `is_bind_hub: false`) over HTTPS with a self-signed certificate, so the same TLS pinning path is exercised. Every shape it serves is marked as community-sourced and unverified, and the chosen HTTP statuses for errors are the mock's own guesses. Every mock response carries the header `x-view-protect-mock: 1`, which is how the spike tells a mock target from a real console. The same `npm run spike:access` script runs against the mock now and against the real console on-site (on-site checklist OS-1), and its result replaces the mock's assumptions. **Nothing in §5.2 has run against Access hardware.**

### 5.3 Streaming pipeline (verified end to end in P0.5)

Protect RTSPS → **go2rtc** (bundled, bound to 127.0.0.1 only) → MSE over WebSocket → Chromium `<video>` with hardware decode. Each camera/quality pair is one go2rtc stream. go2rtc keeps **one upstream connection per stream** however many cells consume it, and connects lazily when a consumer appears. See `ARCHITECTURE.md` for the design and `docs/spikes/P0.5-video.md` for the measurements; the pipeline was confirmed in that spike against go2rtc v1.9.15 and its tagged source, on macOS (2026-11-12) and Windows (2026-11-13). **Platform coverage differs:** the process, auth, ownership and renderer-isolation rules and the latency figures hold on both, while the real-stream H.265 pass, the 5 s GOP and its buffer-trim stall, and the ~4 MB keep-window cost were measured on macOS only — the Windows run was H.264 (R1).

**Source URL transform.** The URL from `rtsps-stream` must be rewritten before go2rtc can use it:

```
Protect:  rtsps://<console-host>:7441/<alias>?enableSrtp
go2rtc:   rtspx://<console-host>:7441/<alias>
```

`?enableSrtp` must be **stripped** or go2rtc cannot open the stream; other query parameters are kept. `rtspx` is go2rtc's TLS RTSP scheme with **certificate verification off**, and go2rtc cannot pin a certificate. The app therefore only passes sources whose host equals the pinned console host. **The RTSPS leg itself is not certificate-pinned** (R4); host equality plus loopback binding is the whole mitigation.

**go2rtc process contract.** Modules `api`, `ws`, `rtsp`, `mp4` only (no `webrtc`/`homekit`/`srtp`/`rtmp`). The API listens on `127.0.0.1:<free port>`. The RTSP **server** is off (`rtsp.listen: ""`) while the RTSP **client** still works. `allow_paths` is limited to `/api`, `/api/ws` and `/api/streams`, so there is no web UI, no `/api/config` and no `/api/exit`. Confirmed during a run that go2rtc's only listening socket is that loopback API port, plus one outbound connection to the console on 7441.

**go2rtc API auth.** Loopback-only is not enough: another local process, or a page using DNS rebinding, could otherwise read `/api/streams` or attach to `/api/ws` and watch a camera. So every launch generates a random `api.username` / `api.password` **and sets `api.local_auth: true`** — without `local_auth` go2rtc exempts loopback clients and the credentials do nothing. The config file is written `0600` and deleted as soon as the API answers (go2rtc keeps it in memory). Credentials are never persisted or logged, and go into the log redactor.

**Renderer isolation.** Main injects `Authorization: Basic …` and rewrites `Origin` to `http://127.0.0.1:<port>` in `session.webRequest.onBeforeSendHeaders`, filtered to `ws://127.0.0.1:<port>/*` and `http://127.0.0.1:<port>/*` only, so the renderer only ever gets the port and the stream name. The rewrite is required: go2rtc's default origin check accepts a WebSocket only when the `Origin` host equals the `Host`, which rejects both `Origin: file://` and the dev server's origin. **Never set `origin: "*"`** — any website open in the user's browser could then connect to the loopback port and watch the cameras. Handle `app.on('login')` so a wrong header cannot turn into an auth prompt.

**Listener ownership.** The free-port lookup and go2rtc's bind are not atomic, and go2rtc keeps running without a listener if the bind fails, so after start the app must confirm the port is its own: authenticated `GET /api` → 200, unauthenticated `GET /api` → 401, and the listening PID equal to the child's PID (`lsof` on macOS, **mandatory**; `netstat -ano` on Windows, best effort). On failure, kill the child, delete the config and retry on a new port, up to 3 attempts.

**Player.** MSE over WebSocket into a Chromium `<video>`. Hardware decode verified on both platforms: `VideoToolboxVideoDecoder` (macOS) and `D3D11VideoDecoder` (Windows), both with `platform=true` and GPU `video_decode` enabled. H.265 was verified **on a real stream on macOS** (`hvc1.1.6.L153.B0`, 2688×1512); on Windows only the HEVC capability probes are positive (see R1). Audio is AAC-LC (`mp4a.40.2`) decoded in software by `FFmpegAudioDecoder`, which is normal for audio in Chromium. Cameras may advertise two audio tracks (AAC 16 kHz mono and Opus 48 kHz stereo); go2rtc's MSE consumer picks AAC.

**Buffer-trim requirement (carries into P2.3).** Protect's `high` stream has a keyframe every ~5.0 s. MSE coded-frame removal means the player's default 5 s keep-window also removes every frame up to the next keyframe, which starves the video track: `high` stalls after about 4.4 s with `DEMUXER_UNDERFLOW` while audio keeps playing (`medium` and `low` are unaffected, and go2rtc delivers every packet, so this is purely a player fault). The player must keep **at least 2× the longest GOP** (15 s covers Protect's 5 s) or trim only up to the last keyframe before `currentTime`. Do this by subclassing `VideoRTC` and overriding `onmse()`, leaving the vendored file unmodified. Memory cost at `high` is about 4 MB per player.

**Latency (NFR-5).** The player steers `playbackRate` towards a ~1 s buffer; measured `buffered.end − currentTime` was 0.99–1.02 s mean with p95 ≤ 1.07 s on both platforms. First frame arrived 0.28–0.65 s after the WebSocket connect, which includes the lazily opened upstream RTSPS session. A rough glass-to-glass read gave ~1.5 s ± 1 s, which fits NFR-5 but needs a proper method in P2.5; the ~1 s player buffer is the biggest adjustable part.

**Codec detection (R7).** go2rtc's `/api/streams` reports the producer's codec, so main or the player can tell H.265 from H.264 per stream at runtime. This is the mechanism R7 asks for, and the `--list` mode of the video spike already uses it. The player (P2.3/P2.4) asks `MediaSource.isTypeSupported` about the mime go2rtc's MSE handshake offers and keeps the verdict **per quality**, because a codec belongs to one `<cameraId>_<quality>` stream: a `high` that will not decode never stops a `low` that does. When the asked-for quality is undecodable the cell keeps — and reconnects — the quality it was last showing; only when nothing decodable has been shown does it say "Codec not supported". go2rtc refusing the handshake because none of the codecs the player offered matches the camera's (its `codecs not matched` error, e.g. an H.265 camera where only H.264 could be offered) is the same verdict, not a stream error; only that fact is read from the error, never its text. A refused quality is not retried until go2rtc restarts (every verdict clears) or the cell's quality is changed to it again (that quality's verdict clears, so switching away and back is a one-attempt retry).

**Start-up failures (NFR-7).** A layer whose socket stays open but never plays is retried on the same backoff as a closed socket, in two cases: go2rtc answers the handshake with `{type: 'error'}` (other than the codec mismatch above), or no frame has painted within **10 s of visible time** after attach (`playerTiming.FIRST_FRAME_TIMEOUT_MS`). Time while the window is hidden or minimised does not count, because Chromium does not run the first-frame callback then; without that rule a hidden window would retry every waiting cell every 10 s. The 10 s is not P0.5's cold 0.28–0.65 s: a consumer joining a go2rtc producer that is already running (another cell, or the other swap layer, on the same stream) waits for the next keyframe, up to the ~5 s `high` GOP, so the window is about twice that. While nothing is on screen the cell says "Stream could not start" — only for a layer that never played; a playing stream that errors is handled as a lost socket that keeps its last frame. go2rtc's error text is never shown or logged, because it can contain the source RTSPS URL (CON-2, NFR-9).


### 5.4 Perf mode (development only, P2.5)

The perf harness (`npm run perf`, `scripts/perf/run.ts`, `src/main/perf/`) runs the built app in a measuring mode. Results and the method are in `docs/perf-results.md`.

- **When:** only when `VP_PERF_QUALITY` (`low`/`medium`/`high`) is set **and** the app is unpackaged. A packaged build ignores every `VP_PERF_*` variable. The others are `VP_PERF_DURATION_S`, `VP_PERF_WARMUP_S`, `VP_PERF_INTERVAL_S`, `VP_PERF_OUT` (absolute output directory) and `VP_PERF_LABEL`; invalid values stop the app at launch.
- **Auto-connects:** an explicit exception to CON-4's "nothing connects on launch". Starting the harness is the user's deliberate action, so main calls `connect()` itself, then opens the Live screen and picks the temp-grid preset by clicking its buttons. From P3.2 the temp grid is gone and the harness picks a View instead.
- **Grid quality:** the run's quality replaces `settings.streams.defaultGridQuality` in the settings the renderer is *shown* (IPC `AppState`), in memory only. The stored config is never changed and no save can persist the override.
- **Never writes Views:** from P3.2 the renderer is shown only the in-memory perf View. While it is set, main refuses every View write (`setViews`, `setLastView`) with `bad-request`, so nothing done in the window during a run can store the perf View over the user's Views.
- **Ends by itself:** after the warm-up and the measured duration (or early on a closed window, a quit request, a crashed renderer or a signal) it writes its results, stops go2rtc and quits. Nothing it records or prints contains a URL, the console address, the go2rtc port, a credential or a camera name (CON-2, NFR-9).

---

## 6. Data model (persisted)

```jsonc
// <userData>/config.json  (secrets live separately in secrets.bin, encrypted)
{
  "schemaVersion": 2,
  "console": { "host": "192.0.2.10", "certFingerprint": "7B:12:B7:0C:…:B8:5C:B6:6A", "accessEnabled": false,
               "accessBaseUrl": null, "accessCertFingerprint": null },   // DOOR-0: off by default; accessBaseUrl null = https://<host>:12445/api/v1/developer
  "doorLinks": { "<cameraId>": "<accessDoorId>" },
  "views": [
    {
      "id": "uuid",
      "name": "Perimeter",
      "cols": 3, "rows": 3,         // "1 + 5": one 2×2 cell and five 1×1 cells
      "aspect": { "w": 16, "h": 9 },  // shape of a 1×1 cell (VIEW-5)
      "gap": 0,                     // px between adjacent cells, 0–64 (VIEW-7)
      "fit": "contain",
      "gridQuality": null,          // null = use settings.defaultGridQuality (QUAL-2)
      "fillQuality": null,          // null = use settings.defaultFillQuality
      "cells": [                    // col/row = top-left slot, 0-based; colSpan/rowSpan default 1
        { "col": 0, "row": 0, "colSpan": 2, "rowSpan": 2, "cameraIds": ["camA"], "quality": "medium" },   // per-cell override (QUAL-3)
        { "col": 2, "row": 0, "colSpan": 1, "rowSpan": 1, "cameraIds": ["camB", "camC", "camD"], "rotateIntervalSec": 10, "motionSwitch": true,
          "motionTriggers": ["motion", "smartDetect", "ring"], "smartDetectTypes": ["person"], "motionHoldSec": 15 },
        { "col": 2, "row": 1, "colSpan": 1, "rowSpan": 1, "cameraIds": ["camE"] },
        { "col": 0, "row": 2, "colSpan": 1, "rowSpan": 1, "cameraIds": ["camF"] },
        { "col": 1, "row": 2, "colSpan": 1, "rowSpan": 1, "cameraIds": [] },
        { "col": 2, "row": 2, "colSpan": 1, "rowSpan": 1, "cameraIds": ["camG"] }
      ]
    }
  ],
  "lastViewId": "uuid",
  "streams": { "defaultGridQuality": "low", "defaultFillQuality": "high" },   // QUAL-1; values: "low" | "medium" | "high"
  "ui": { "overlayAutoHideSec": 3 }
}
```

**Tiling rule (VIEW-1):** every cell lies inside the grid (`col + colSpan ≤ cols`, `row + rowSpan ≤ rows`, spans ≥ 1) and every slot is covered by exactly one cell. Cells are stored sorted by `(row, col)`. `aspect.w` and `aspect.h` are positive; `gap` is 0–64.

**Migration 1 → 2** (`src/main/config/migrations.ts`): v1 stored exactly `cols * rows` cells in row-major order. Cell `i` becomes a 1×1 cell at `col = i % cols`, `row = ⌊i / cols⌋`; `aspect` and `gap` take their defaults (16:9, 0).

**`console.host` and `console.accessBaseUrl`** (the rules `src/main/console/endpoints.ts` encodes, added in P1.3/P1.4). `host` is an IP or host name and may carry a non-default port (`udm.local:8443`); a scheme other than `https://` is refused rather than upgraded, since the API key may only travel over TLS (CON-2, R5), and an IPv6 literal needs brackets to tell the address from a port. `accessBaseUrl` is the **API root** — origin *and* path, the same value the P0.4 spike takes as `VP_ACCESS_BASE_URL` — so the §5.2 alternative behind the console proxy and the local mock are both just a different value here. `null` derives `https://<console.host>:12445/api/v1/developer`, **ignoring any port in `host`**, because the developer API has its own.

**Two certificate fingerprints, not one:** pinning is per host:port (§5.2, P0.4 §4), and the Access developer API answers on 12445 while Protect is behind 443, so `certFingerprint` pins the console and `accessCertFingerprint` pins the Access endpoint; both are `null` until the user accepts them (CON-3). The schema is validated with zod on load. Unknown or older `schemaVersion` values go through migrations in `src/main/config/migrations.ts`.

### 6.1 What crosses IPC (P1.5, streams added in P2.2, Views in P3.1, stream qualities in P3.7)

The contract is `src/shared/ipc.ts`: one zod schema per request and per reply, validated in the preload *and* again in main. Three rules decide what may be in it.

**No secrets, ever** (CON-2, NFR-9). The API key, the Access token and every RTSPS URL stay in main. The renderer receives two booleans saying whether each credential is stored, the camera models of §5.1 trimmed to the shared `Camera`, snapshot **bytes**, door models, and — from Phase 2 — a stream handle per camera/quality pair: the go2rtc stream name `<cameraId>_<quality>`, the loopback port, the `ws://127.0.0.1:<port>/api/ws?src=<name>` URL built in main, and go2rtc's restart counter (`epoch`); and — from P3.7 — whether each RTSPS quality exists on a camera, as booleans. Never the RTSPS URL and never go2rtc's API credentials — main injects those into the WebSocket in `onBeforeSendHeaders` (§5.3), so the renderer plays a stream it can neither authenticate nor name on its own. The certificate fingerprints do cross: they are public values from a plain-text file, not secrets.

**Failure is a value, not a throw.** Every call answers `{ ok: true, value }` or `{ ok: false, error }`, where the error is a `kind` the UI can branch on plus one sentence written for a person — no stack, no cause chain, no URL and no query string. One `kind` is about the local gateway rather than the console: `gateway-down` means go2rtc is not up (crashed, restarting, or never started), is always retryable, and is deliberately distinct from CAM-3's camera-offline placeholder and from a Settings problem, because the camera is fine and nothing in Settings fixes it. An exception thrown out of a handler would otherwise reach the renderer as main's stack glued to a string, which is both useless to the UI and the easiest way to leak a path.

**Every mutation answers with the whole app state.** Saving a host, storing a key or accepting a certificate changes several things at once (the pin, what is resolvable, whether Access is on), so main returns the new truth rather than having the renderer patch its own copy and drift.

**Views (P3.1).** `vp:views/set` takes the whole View list plus `lastViewId`; main validates it with the View schema, tiling rule (§6) included, and unique View ids, and answers with `AppState` like every mutation. `vp:views/active` takes only `lastViewId`, so switching Views (VIEW-4) does not resend every View.

**Stream qualities (P3.7).** `vp:streams/defaults` takes both QUAL-1 defaults, `{ defaultGridQuality, defaultFillQuality }`: both required, both a `Quality` (never `package`), nothing defaulted, so a renderer bug cannot silently reset the other one. It answers with `AppState` and is refused during a perf run. `vp:cameras/rtsps` takes `{ cameraId }` and answers `{ high, medium, low, package }` as booleans: main reduces `GET rtsps-stream`'s URLs to "is there one" before replying, so no RTSPS URL crosses (QUAL-7).

Main pushes four things, and only these: the connection status (CON-5), the whole camera inventory after each connect, reconnect or add/remove (CAM-2 — `GET /v1/cameras` stays the authority, because the devices feed's shapes are unverified, R11), single camera `state` changes, which is the path gate G1 times at ten seconds, and — from Phase 2 — the go2rtc runtime: up on a port with an epoch, or down. go2rtc takes a new free port every launch, so a handle from an earlier epoch is dead; the push is what lets a player re-ask for its stream instead of inferring a restart from a closed socket (gate G2).

---

## 7. Open questions / risks

| # | Item | Mitigation |
|---|---|---|
| R1 | ~~H.265 over MSE in Electron on Windows depends on the GPU driver and HEVC support~~ **Closed by configuration, 2026-11-13: fallback (a) is the standing setup — all cameras run H.264 with Enhanced Encoding off** (§1), for requirements outside this app. G0's Windows real-stream H.265 check was **waived rather than passed** on the same date: macOS plays a real H.265 stream with hardware decode and audio, and on Windows (Intel Iris Xe, driver 32.0.101.7088, Microsoft HEVC Video Extensions installed) every other check passed on H.264 with all HEVC capability probes positive, but H.265 was never driven through a real stream there. **This risk reopens if Enhanced Encoding is turned back on**, and that needs the Windows real-stream check re-run first | Standing: H.264 everywhere, with per-stream codec detection kept anyway (R7). If H.265 returns and Windows then fails: (b) have go2rtc transcode via FFmpeg (CPU cost), (c) switch the player to libmpv (see ARCHITECTURE alternatives) |
| R2 | ~~Which qualities `rtsps-stream` exposes~~ **Resolved by the official contract and P0.3:** high/medium/low on all cameras, package on doorbells (unexercised). 4 of the 9 development cameras already had a `medium` stream created by another integration. Still open: whether the Protect UI shows API-created streams as "RTSP enabled" | GET first and POST only the quality actually needed (QUAL-8). Never DELETE |
| R3 | Access API isn't in the official docs; unlock auth path on 4.3.24 unverified, and **no Access hardware on the development network**. Nothing in §5.2 has run against real hardware | Feature is optional and off by default (DOOR-0). P0.4 built the local mock and the zod schemas (`src/main/access/types.ts`), each leniency marked `UNVERIFIED (OS-1)`, and the spike prints a shape note per normalization. **OS-1 is still the gate** before relying on the feature. Fallback: keep it disabled and ship the rest |
| R6 | ~~API key origin: the official docs say unifi.ui.com, while local Integrations keys also exist~~ **Resolved (P0.3 §1):** a locally created Integrations key works on the local endpoint, for REST and both WebSockets | No unifi.ui.com key needed. Treat the key as admin-level (R5) |
| R7 | No codec field on cameras, so the app can't tell H.265 ahead of time | **Mitigation is concrete:** read the producer's codec from go2rtc `/api/streams` at runtime (P0.5). Show a "codec unsupported" state instead of a black cell — scoped to the quality that failed, falling back to the quality last on screen (§5.3). Still required with every camera on H.264 (R1), because Enhanced Encoding is per camera and can be turned on without the app being told |
| R8 | Contract drift on Protect upgrades | Vendored versioned OpenAPI + generated types. Contract diff is part of the upgrade checklist. Known drift today: `lcdMessage` required but absent, extra `windowMs`/`limit` on 429 bodies (§5.1) |
| R4 | Self-signed cert on RTSPS for go2rtc, which **cannot pin a certificate** — the RTSPS leg is unpinned | Rewrite to go2rtc's no-verify `rtspx` scheme only for sources whose host equals the pinned console host, and bind go2rtc to loopback with authenticated API paths (§5.3). Accepted for the prototype |
| R5 | Integration API key is admin-level | Store only in the keystore. Never send it to the renderer |
| R9 | **Undocumented 10 req/s rate limit** per key (§5.1). A startup burst — snapshots for 15 cameras, or `ensureStream` for a 10-cell View — will hit it, and WebSocket upgrades share the budget | Queue and throttle all REST calls in P1.7/P2.2 (the spikes used ≥ 150 ms spacing), back off WebSocket reconnects, and treat 429 as retryable after `windowMs`. NFR-6's 5 s target is scoped to the active View's streams for this reason, with thumbnails loaded lazily |
| R10 | **Parked while all cameras run H.264 (R1)** — only H.265 showed it. H.265 `high` (2688×1512) dropped **6.7%** of frames on macOS, against 0.06% for H.264 `high` and ~0% for H.265 `medium`/`low`, at ~27.9 fps instead of 30. Nobody has watched that run by eye. Not a G0 blocker (decode, hardware decode and audio all pass) | Re-check only if Enhanced Encoding returns, in the P2.5 perf harness: re-run `high` with `--bare`, compare a longer run, and check whether the drops cluster at keyframes or at buffer trims. `--keep-open` to check for visible stutter |
| R11 | Two Protect behaviours are still unverified: the **devices WebSocket message shapes** (0 messages in 9 minutes) and the **snapshot 503 for an offline camera** (every camera was online) | P1.3 parses the device feed leniently and re-GETs `/v1/cameras` on reconnect rather than trusting the feed's shape. CAM-3 tolerates any failure for an offline camera, not just 503. Confirm both when a camera next goes offline |
