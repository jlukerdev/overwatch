# View Protect — Prototype Specification

**Status:** Draft v0.3 (prototype). §5 corrected against the Phase 0 spikes (P0.3–P0.5) on 2026-11-13. The Protect interface is verified against the official v7.3.74 contract **and** against the console running 7.3.74; Access is still community-sourced and unverified (§5.2) · **Owner:** personal use only · **Built by:** coding agents (see `/CLAUDE.md`)

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
- **CAM-3** A cell whose camera is not `CONNECTED` shows an "Offline" (or "Connecting…") placeholder and resumes on its own when the camera comes back. The contract says the snapshot endpoint returns 503 for offline cameras; treat that as normal, not an error. **Unobserved:** every camera was online throughout P0.3, so the 503 path was never seen (R11). Tolerate either a 503 or some other failure for an offline camera.
- **CAM-4** For doorbells with `hasPackageCamera`, the package camera can be put in a cell as its own source (`<cameraId>:package`). **Unverified:** the development network has no doorbell, so nothing with `hasPackageCamera` was exercised (P0.3 §2).

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
  - `motionHoldSec` (default 15): how long a triggered camera stays shown **after the event ends** before rotation resumes, measured from the event's `end` **timestamp** and not from when the `update` carrying it arrives (that update lags 3–5 s, §5.1), so the camera is held for 15 s after motion actually stopped (G4). If no `end` arrives within 60 s, treat the event as ended.
  - Priority: `ring` beats any other trigger. Otherwise the most recent event start wins. Ties go to the earlier position in the list.
  - **Setup requirement (P0.3 §5):** `motion` events only arrive for cameras whose **motion detection is enabled in Protect** — it was off on all 9 development cameras, which is why the first runs saw no `motion` at all. It is independent of smart detection: with both on, one walk-by produced both `motion` and `smartDetectZone` events. The Integration API exposes no motion-detection flag on the camera object, so the app cannot detect this or warn about it. The default trigger set (`motion`, `smartDetect`, `ring`) covers cameras with either setting on; document the per-camera Protect setting as user setup.
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
| `GET /v1/cameras/{id}/rtsps-stream` | Reuse existing stream URLs | Returns `{ high, medium, low, package }`, each a URI or `null`. URL shape `rtsps://<console-host>:7441/<16-char alias>?enableSrtp`, one alias per quality, with the host being the console address the API was called on. URLs were identical across repeated GETs within a run and across a POST (existing qualities untouched), so they can be cached per camera/quality for the lifetime of a session and refreshed on the QUAL-8 triggers. **P0.3 never compared URL values between runs**, so don't assume a cached URL survives an app restart or a console reboot — GET again on startup. ~10–25 ms per call |
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

**Codec detection (R7).** go2rtc's `/api/streams` reports the producer's codec, so main or the player can tell H.265 from H.264 per stream at runtime. This is the mechanism R7 asks for, and the `--list` mode of the video spike already uses it.

---

## 6. Data model (persisted)

```jsonc
// <userData>/config.json  (secrets live separately in secrets.bin, encrypted)
{
  "schemaVersion": 1,
  "console": { "host": "192.0.2.10", "certFingerprint": "7B:12:B7:0C:…:B8:5C:B6:6A", "accessEnabled": false,
               "accessBaseUrl": null, "accessCertFingerprint": null },   // DOOR-0: off by default; accessBaseUrl null = https://<host>:12445/api/v1/developer
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

`cells.length === cols * rows`, in row-major order.

**`console.host` and `console.accessBaseUrl`** (the rules `src/main/console/endpoints.ts` encodes, added in P1.3/P1.4). `host` is an IP or host name and may carry a non-default port (`udm.local:8443`); a scheme other than `https://` is refused rather than upgraded, since the API key may only travel over TLS (CON-2, R5), and an IPv6 literal needs brackets to tell the address from a port. `accessBaseUrl` is the **API root** — origin *and* path, the same value the P0.4 spike takes as `VP_ACCESS_BASE_URL` — so the §5.2 alternative behind the console proxy and the local mock are both just a different value here. `null` derives `https://<console.host>:12445/api/v1/developer`, **ignoring any port in `host`**, because the developer API has its own.

**Two certificate fingerprints, not one:** pinning is per host:port (§5.2, P0.4 §4), and the Access developer API answers on 12445 while Protect is behind 443, so `certFingerprint` pins the console and `accessCertFingerprint` pins the Access endpoint; both are `null` until the user accepts them (CON-3). The schema is validated with zod on load. Unknown or older `schemaVersion` values go through migrations in `src/main/config/migrations.ts`.

---

## 7. Open questions / risks

| # | Item | Mitigation |
|---|---|---|
| R1 | ~~H.265 over MSE in Electron on Windows depends on the GPU driver and HEVC support~~ **Closed by configuration, 2026-11-13: fallback (a) is the standing setup — all cameras run H.264 with Enhanced Encoding off** (§1), for requirements outside this app. G0's Windows real-stream H.265 check was **waived rather than passed** on the same date: macOS plays a real H.265 stream with hardware decode and audio, and on Windows (Intel Iris Xe, driver 32.0.101.7088, Microsoft HEVC Video Extensions installed) every other check passed on H.264 with all HEVC capability probes positive, but H.265 was never driven through a real stream there. **This risk reopens if Enhanced Encoding is turned back on**, and that needs the Windows real-stream check re-run first | Standing: H.264 everywhere, with per-stream codec detection kept anyway (R7). If H.265 returns and Windows then fails: (b) have go2rtc transcode via FFmpeg (CPU cost), (c) switch the player to libmpv (see ARCHITECTURE alternatives) |
| R2 | ~~Which qualities `rtsps-stream` exposes~~ **Resolved by the official contract and P0.3:** high/medium/low on all cameras, package on doorbells (unexercised). 4 of the 9 development cameras already had a `medium` stream created by another integration. Still open: whether the Protect UI shows API-created streams as "RTSP enabled" | GET first and POST only the quality actually needed (QUAL-8). Never DELETE |
| R3 | Access API isn't in the official docs; unlock auth path on 4.3.24 unverified, and **no Access hardware on the development network**. Nothing in §5.2 has run against real hardware | Feature is optional and off by default (DOOR-0). P0.4 built the local mock and the zod schemas (`src/main/access/types.ts`), each leniency marked `UNVERIFIED (OS-1)`, and the spike prints a shape note per normalization. **OS-1 is still the gate** before relying on the feature. Fallback: keep it disabled and ship the rest |
| R6 | ~~API key origin: the official docs say unifi.ui.com, while local Integrations keys also exist~~ **Resolved (P0.3 §1):** a locally created Integrations key works on the local endpoint, for REST and both WebSockets | No unifi.ui.com key needed. Treat the key as admin-level (R5) |
| R7 | No codec field on cameras, so the app can't tell H.265 ahead of time | **Mitigation is concrete:** read the producer's codec from go2rtc `/api/streams` at runtime (P0.5). Show a "codec unsupported" state instead of a black cell. Still required with every camera on H.264 (R1), because Enhanced Encoding is per camera and can be turned on without the app being told |
| R8 | Contract drift on Protect upgrades | Vendored versioned OpenAPI + generated types. Contract diff is part of the upgrade checklist. Known drift today: `lcdMessage` required but absent, extra `windowMs`/`limit` on 429 bodies (§5.1) |
| R4 | Self-signed cert on RTSPS for go2rtc, which **cannot pin a certificate** — the RTSPS leg is unpinned | Rewrite to go2rtc's no-verify `rtspx` scheme only for sources whose host equals the pinned console host, and bind go2rtc to loopback with authenticated API paths (§5.3). Accepted for the prototype |
| R5 | Integration API key is admin-level | Store only in the keystore. Never send it to the renderer |
| R9 | **Undocumented 10 req/s rate limit** per key (§5.1). A startup burst — snapshots for 15 cameras, or `ensureStream` for a 10-cell View — will hit it, and WebSocket upgrades share the budget | Queue and throttle all REST calls in P1.7/P2.2 (the spikes used ≥ 150 ms spacing), back off WebSocket reconnects, and treat 429 as retryable after `windowMs`. NFR-6's 5 s target is scoped to the active View's streams for this reason, with thumbnails loaded lazily |
| R10 | **Parked while all cameras run H.264 (R1)** — only H.265 showed it. H.265 `high` (2688×1512) dropped **6.7%** of frames on macOS, against 0.06% for H.264 `high` and ~0% for H.265 `medium`/`low`, at ~27.9 fps instead of 30. Nobody has watched that run by eye. Not a G0 blocker (decode, hardware decode and audio all pass) | Re-check only if Enhanced Encoding returns, in the P2.5 perf harness: re-run `high` with `--bare`, compare a longer run, and check whether the drops cluster at keyframes or at buffer trims. `--keep-open` to check for visible stutter |
| R11 | Two Protect behaviours are still unverified: the **devices WebSocket message shapes** (0 messages in 9 minutes) and the **snapshot 503 for an offline camera** (every camera was online) | P1.3 parses the device feed leniently and re-GETs `/v1/cameras` on reconnect rather than trusting the feed's shape. CAM-3 tolerates any failure for an offline camera, not just 503. Confirm both when a camera next goes offline |
