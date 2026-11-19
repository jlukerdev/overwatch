# View Protect — Prototype Development Plan

Phases run in order. Each one ends with a **gate**: a check you can demo or measure. A phase isn't done until its gate passes on **both macOS and Windows** (unless marked otherwise). Requirement IDs refer to `SPEC.md`.

---

## Phase 0 — Spikes & foundation (go/no-go)
**Goal:** prove the risky assumptions before building UI.

| # | Task |
|---|---|
| P0.1 | Scaffold the Electron + electron-vite + React + TS app in this folder, following the structure in `README.md`. Strict tsconfig, ESLint + Prettier, Vitest |
| P0.2 | `scripts/fetch-go2rtc.ts`: download the pinned go2rtc release for each platform/arch into `resources/bin/<platform>-<arch>/`, check the SHA-256, mark executable |
| P0.3 | API spike (`scripts/spikes/`): against the UDM SE, confirm a locally created API key works (R6). Exercise `meta/info`, `cameras`, `rtsps-stream` (GET, then POST one missing quality; confirm `medium` works too), `snapshot`, and both WS endpoints, and check the responses match `docs/reference/protect-openapi-v7.3.74.json`. Record one real motion start/end pair from the events WS. Save **sanitized** samples to `tests/fixtures/protect/` |
| P0.3b | Add `npm run gen:protect-types`: openapi-typescript → `src/main/protect/generated.ts` (committed). `types.ts` re-exports only the subset the app uses |
| P0.4 | **Access mock + spike** (no Access on the development network). `npm run mock:access`: local HTTPS mock of the community-documented Access developer API (`GET /doors`, `PUT /doors/{id}/unlock`, Bearer auth, response envelope, error cases) with a self-signed cert. `npm run spike:access`: client spike that runs against the mock now and against the real console on-site (OS-1). Fixtures in `tests/fixtures/access/` are marked mock-derived |
| P0.5 | Video spike: hard-coded go2rtc config with one Enhanced Encoding camera → MSE player in a bare Electron window |
| P0.6 | Fix SPEC §5 with what you verified |

**Gate G0:**
- One H.265 camera plays with audio in Electron on macOS **and** Windows, with hardware decode confirmed.
- Unlock works **against the Access mock** (P0.4). Real Access is verified on-site (OS-1).

If H.265 fails on Windows, pick a fallback from SPEC R1 before continuing.

**G0 outcome: PASSED on 2026-11-13, with one user waiver.**

| G0 item | Result |
|---|---|
| H.265 + audio + hardware decode, macOS | **Pass.** Real H.265 stream (`hvc1.1.6.L153.B0`, 2688×1512), `VideoToolboxVideoDecoder` with `platform=true`, GPU `video_decode` enabled, AAC audio decoded |
| H.265 + audio + hardware decode, Windows | **Pass except the real-stream H.265 check, which the user waived.** On H.264: MSE playback, `D3D11VideoDecoder` with `platform=true`, GPU `video_decode` enabled, AAC audio. Every HEVC capability probe is positive, but all cameras were back on H.264 that day, so H.265 was never driven through a real stream. Re-run when a camera has Enhanced Encoding on (SPEC R1) |
| Unlock against the Access mock | **Pass** (P0.4). Real Access hardware is still unverified — OS-1 |

**Fallback decision (2026-11-13):** rather than leave the waived check hanging, R1 fallback (a) is now the standing configuration — **all cameras run H.264 with Enhanced Encoding off**, for requirements outside this app. The Windows real-stream H.265 check has to be re-run before Enhanced Encoding is turned back on.

Evidence: `docs/spikes/P0.3-protect-api.md`, `docs/spikes/P0.4-access-mock.md`, `docs/spikes/P0.5-video.md`. The verified interface details are folded into `SPEC.md` §5 by P0.6. Items carried out of Phase 0: SPEC **R9** (the 10 req/s rate limit), **R10** (the H.265 `high` drop rate, parked with R1) and **R11** (the unverified devices-WS shapes and snapshot 503).

---

## Phase 1 — Connection & camera inventory
CON-1…5, CAM-1…3

| # | Task |
|---|---|
| P1.1 | `secrets/` (safeStorage) and `config/` store with zod schema + migrations |
| P1.2 | `tls/` TOFU pinning: fetch the fingerprint, accept dialog, pinned undici Agent used by every client |
| P1.3 | `protect/client.ts` REST client typed from the generated OpenAPI types, mapping the `{error,name,cause}` error shape. `protect/subscriptions.ts` WS with reconnect + backoff |
| P1.4 | `access/client.ts` (doors list and unlock), tested against the P0.4 mock. Does nothing unless Access is enabled (DOOR-0) |
| P1.5 | Typed IPC contract (`src/shared/ipc.ts`) and preload bridge |
| P1.6 | Settings screen: host, key, token, Test connection, status indicator |
| P1.7 | Camera list screen with snapshots and live online state |

**Gate G1:** a fresh install connects, pins the cert and lists all cameras. Unplugging a camera shows it offline within 10 s. Unit tests pass for the clients (fixtures), config and migrations.

**G1 outcome: PASSED on 2026-11-14.** The two console-dependent checks were run by the user against the UDM SE (the build machine cannot reach it, the same split as G0's Windows H.265 check); the unit half runs on every build.

| G1 item | Result |
|---|---|
| Unit tests for the clients, config and migrations | **Pass.** The whole suite is green, including the P1.5 contract and handler tests |
| A fresh install connects, pins the cert and lists all cameras | **Pass**, verified on the console with a throwaway profile (steps below) |
| Unplugging a camera shows it offline within 10 s | **Pass.** The path runs end to end: the devices feed updates `state`, main pushes `cameraState`, the store patches the row, and the placeholder comes from `state` alone, never from whether a snapshot loaded |

**How the two console checks were run** (a fresh install means an empty `userData`, so a throwaway profile was used rather than wiping the real one):

1. `npm run build`, then start the app with a clean profile: `npx electron . --user-data-dir=/tmp/vp-g1` (macOS/Linux) or `--user-data-dir=%TEMP%\vp-g1` (Windows).
2. It opens on **Settings**, because there is no host yet (CON-1). Enter the console address and the Protect Integration API key, and save each.
3. Press **Check certificate**. The SHA-256 fingerprint appears; compare it with the console's own and press **Trust this certificate** (CON-3).
4. Press **Test connection**. Protect should report its `applicationVersion` (7.3.74 on the development console). Then press **Connect**.
5. Open **Cameras**. Every adopted camera should be listed with its name, model, state, an Audio badge where the mic is on, and a thumbnail.
6. Unplug one camera (or disable its port) and watch its row: within 10 s the state should read offline and the thumbnail should be replaced by the placeholder. Plug it back in and the row should recover on its own, fetching a new thumbnail with no interaction.

Anything that regresses here is a P1 bug, not a Phase 2 task.

---

## Phase 2 — Streaming core & performance
VIEW-5, CELL-1, NFR-2…5, NFR-7

| # | Task |
|---|---|
| P2.1 | `streams/go2rtcManager.ts`: spawn on a free loopback port, health check, restart on crash, clean shutdown |
| P2.2 | `streams/registry.ts`: on-demand `ensureStream(cameraId, quality)` → GET/POST RTSPS for that quality only, register `<cameraId>_<quality>` in go2rtc, refresh on camera changes (QUAL-8). `src/shared/quality.ts`: `Quality` type + `resolveQuality()` with unit tests |
| P2.3 | `player/` React `<LivePlayer cameraId quality muted>` (quality is a prop, never a constant) with a seamless swap when `quality` changes (QUAL-6): MSE, reconnect, stall detection, offline placeholder |
| P2.4 | Temporary hard-coded 3×3 + 4×3 grid that fills and reflows with the window (replaced in P3.2 by the letterboxed View layout, VIEW-5/7) |
| P2.5 | Perf harness: 10 streams for 30 min **at each of low, medium and high**. Record CPU, GPU, RAM and latency on both OSes into `docs/perf-results.md`, so the quality defaults are based on measurements |

**Carried from P2.3 into P2.4 — fixed in P2.4** (two defects found by `/code-review` on the P2.3 branch, deferred by the user on 2026-11-14 because they are best fixed once the player runs in a real grid, where the timings are observable rather than guessed):

- **An R7 codec-unsupported verdict is machine-wide and terminal.** It is set from whichever layer failed and then disables any further `ensureStream`, so when the still-healthy visible stream later loses its socket no replacement is requested: the cell keeps a frozen frame with no message and no recovery. The fix is to scope the verdict to the quality that failed — a codec is a property of one stream, and Enhanced Encoding is per camera (R7), so a `high` that will not decode must not poison a `low` that does. *Fixed: verdicts are per quality and the player falls back to the last quality that played (SPEC §5.3).*
- **A layer that attaches but never paints hangs on "Connecting…" with no retry.** go2rtc's `{type:'error'}` handshake reply is dropped, the socket stays open so the reconnect path cannot fire, and the stall detector is inert until a first frame has been seen. NFR-7 and gate G2 want recovery here: surface go2rtc's error, and give a layer a bounded window to paint before closing it and retrying on the existing backoff (P0.5 measured a first frame at 0.28–0.65 s). *Fixed: go2rtc's error is surfaced as a fixed "Stream could not start" (its text is never shown), and a layer that has not painted within `FIRST_FRAME_TIMEOUT_MS` = 10 s of visible time (hidden-window time does not count) is retried; P2.5 re-measures that window.*

**Gate G2:** NFR-2/4/5 met, and 30-minute runs show no memory growth. Streams recover by themselves after go2rtc is killed or the network drops. **If this fails → evaluate the libmpv fallback (ARCHITECTURE §1) before Phase 3.**

---

## Phase 3 — Views, fill mode & zoom
VIEW-1…7, FILL-1…3, ZOOM-1…3, CELL-3/4, QUAL-1…7

| # | Task |
|---|---|
| P3.1 | View model + store (Zustand), persisted through IPC to config: spanning cells, per-View `aspect` and `gap`, schemaVersion 2 migration, pure layout geometry (`src/shared/viewLayout.ts`) |
| P3.2 | View switcher (sidebar), keyboard 1–9, remember the last View. Renders the active View with the letterboxed layout (VIEW-5/7), replacing the P2.4 temp grid. The P2.5 harness, which today clicks the smallest temp-grid preset with room for `min(cameras, 10)` cameras, picks a View instead |
| P3.3 | View editor: name, layout preset/custom, assign cameras per cell (picker + drag/drop), merge/split cells, aspect, gap, fit mode |
| P3.4 | Cell overlay (name, controls, auto-hide) |
| P3.5 | Fill mode with low→high seamless swap, Esc/back |
| P3.6 | Zoom/pan component (wheel, pinch, drag, 100% reset) |
| P3.7 | Quality selection: settings defaults, View `gridQuality`/`fillQuality` in the editor, per-cell picker in the overlay, fill-mode picker with "save as default" (QUAL-1…7) |
| P3.8 | UI polish: icons and action colours on buttons app-wide (shared inline-SVG icon set, button variants); View switcher's New / Edit pinned to the bottom of the pane; View editor layout — settings grouped with more spacing, actions placed by what they act on (View list: New / Duplicate / Delete; header: Close; a save bar under the canvas: Discard / Save; selection toolbar: Merge / Split / Clear) |

**Gate G3:** build three Views from scratch, restart the app, and they come back. Changing a cell between Low/Med/High swaps without a black frame and persists. Fill/zoom/back works smoothly at 60 fps UI. A View with a 2×2 cell and an 8 px gap keeps 16:9 unit cells, centred, when the window is resized to very wide and very tall.

**G3 outcome: PASSED on 2026-11-15.** The console and on-screen checks were run by the user (the build machine cannot reach the console, the G1 split); the geometry half runs on every build.

| G3 item | Result |
|---|---|
| Three Views built from scratch come back after a restart | **Pass**, verified on the console with a throwaway profile (steps below) |
| A cell changed between Low/Med/High swaps without a black frame, and the choice persists | **Pass**, verified on the console. The swap is the player's two-layer handover (QUAL-6, `playerMachine` tests); the pick saves through `setViews` |
| Fill / zoom / back is smooth at 60 fps UI | **Pass**, verified on the console |
| 2×2 cell + 8 px gap keeps 16:9 unit cells, centred, very wide and very tall | **Pass**: `viewLayout.test.ts` "G3: 3×3 with a 2×2 cell and an 8 px gap…" (4000×600, 600×4000, 1600×1000), and checked on screen by resizing the window |

**How to run the console checks** (a throwaway profile, so the real Views are untouched):

1. `npm run build`, then `npx electron . --user-data-dir=/tmp/vp-g3` (Windows: `--user-data-dir=%TEMP%\vp-g3`). Set up the console as in G1 steps 2–4 and **Connect**.
2. **Three Views.** On Live, "Create a View" (View 1). In the switcher, "New View" twice; in each, pick a different layout (e.g. "1 + 5" with an 8 px gap, and 4×3), drag cameras in, set a name, **Save**. Quit the app (Cmd+Q / close) and start it with the same command: all three Views are listed in order with their cameras and layout, and the app opens on the last View shown.
3. **Cell quality.** Hover a cell, open its quality picker and choose High, then Medium, then Low. Each change: the picture never goes black or shows "Connecting…"; the badge changes when the new stream shows. Restart: the cell still plays (and its picker shows) the last choice. "View default (…)" clears it.
4. **Fill / zoom / back at 60 fps.** Open DevTools (View → Toggle Developer Tools, or Cmd+Opt+I / Ctrl+Shift+I) → Performance → record. Click a cell to fill, wheel-zoom in, drag to pan, press 100%, then Esc. Stop: the frames track stays at ~16.7 ms with no long red frames during the transitions. In fill, also try the fill quality picker and "Save for this View"; after Esc and re-fill, the saved quality is used.
5. **Letterbox.** On the "1 + 5" View with the 8 px gap, drag the window very wide, then very tall: unit cells stay 16:9, the grid stays centred with even bars, and the gaps stay 8 px.


---

## Phase 4 — Multi-camera cells
CELL-2

| # | Task |
|---|---|
| P4.1 | `cellScheduler.ts` pure reducer (rotate, triggers incl. `ring` priority, smart-type filter, hold measured from event `end`, 60 s stale-event timeout) + exhaustive unit tests |
| P4.2 | Wire Protect events → renderer event bus → scheduler + View-editor inspector controls for the CELL-2 cell settings (rotate interval, motion switch, triggers, smart-type filter, hold) |
| P4.3 | Overlay position indicator, manual next/prev (the motion badge moved to the MVP backlog, user decision 2026-11-15). Review changes (2026-11-16): back control into the strip and strip order, quality badge only where there is no picker, "Save" / "Default (X)" labels, per-View Show camera names (VIEW-8) |
| P4.4 | Optional pre-warm of the next rotation camera. Review decisions (2026-11-16): no pre-warm under a filled cell or at zero size; a two-camera cell still reopens its outgoing camera as the next pre-warm (one stream per cell kept); no pre-warm from a missing camera's placeholder (MVP backlog); no perf re-run (the harness has no rotating cells) |
| P4.5 | Camera list loads all at once (CAM-1, QUAL-7; user request 2026-11-16). When the Cameras tab is opened or Refresh is pressed, show a loading progress (e.g. "Loading 7 / 18") and fetch the inventory, every snapshot and every RTSPS feed state in parallel, as far as main's shared rate limiter allows (there is no bulk endpoint: snapshots and `rtsps-stream` are per camera). Populate the list only once everything has settled; a camera whose snapshot or feed state fails still shows, with its placeholder or `streams unknown`. On Refresh the current list stays until the new data is in, then is swapped at once. The cards stay in the current grid. Feeds are still created on demand by cells (QUAL-8); no camera editor. SPEC QUAL-7 updated to match |

**Gate G4:** a cell with 4 cameras rotates every 10 s. Walking in front of camera 3 switches to it within 2 s and holds for 15 s after motion stops.

---

## Phase 5 — Audio, doors & screen layout
AUD-1…3, VIEW-3, DOOR-0…6, plus the requirements P5.6…P5.8 add to SPEC (Doors screen, emergency status, polling settings, navigation)

| # | Task |
|---|---|
| P5.1 | Single-active-audio controller, volume in fill mode, `M` mute-all. User decisions (2026-11-16): a camera change in the unmuted cell (rotation, step, trigger, camera missing) mutes it, so audio never follows a cell onto another camera; one app-wide volume, session only, 100% on launch, slider only while filled; `M` mutes all and is not a toggle (no-op with nothing unmuted), ignored while typing, with Ctrl/Cmd/Alt and on repeat, Live screen only. Review decisions (2026-11-16): the mute toggle shows only while the camera is connected, and a heard camera going offline is muted; filling a cell mutes every other cell; no mute on package-channel cells; switching off the heard camera's mic mutes it. Audio/video offset seen in-app matches Protect's own web app (camera-side), not pursued |
| P5.2 | Camera snapshots in the View editor (VIEW-3; user request 2026-11-17). A camera dropped (or picked) into a cell shows that camera's snapshot in the cell, behind its chip, so the user can see what it looks at; opening an existing View in the editor fills every cell with a camera the same way. The thumbnails the Cameras tab loads (CAM-1, P4.5) move from `CameraList`'s local reducer into a shared renderer store, so the editor shows a cached image at once when one exists, of any age, and fetches only the cameras that have none, through the same `snapshot` IPC and main's shared rate limiter (R9), default quality (never `highQuality`), never on a timer, and no stream is opened (QUAL-8). A multi-camera cell shows the camera at the head of its list, a package ref (`<id>:package`) its package channel (`channel=package`), and an offline camera, a failed snapshot or a missing camera keeps the text-only cell with its label. A fetch the editor makes lands in the shared store, so the Cameras tab can reuse it too; Refresh on that tab still refetches everything. SPEC VIEW-3 updated to match. Review decisions (2026-11-17): the editor fetches the snapshot only, no feed-state GET (the Cameras tab fills a missing feed state itself); a failed or unavailable snapshot is retried once each time the editor opens, never in a loop; the editor leaves a camera to a Cameras-tab load in flight; re-opening the Cameras tab keeps the cached grid up while it reloads, like Refresh. User request (2026-11-17): the camera palette marks each entry whose exact ref heads at least one cell of the draft with a green check mark (first built as an "In use" pill, replaced at the user's request), live with the draft, still draggable; the editor's selection toolbar puts Merge / Split / Clear cameras at the far left with the selected-cell count after them (user request 2026-11-17) |
| P5.3 | "Enable UniFi Access" switch (DOOR-0) + token field + Access base URL override, then door link settings (camera → door), all hidden while disabled. The switch, token field and API-root override already existed from P1.4/P1.6 and matched DOOR-0 unchanged. Added: `vp:doors/list` (DOOR-1; `disabled` with no Access call while off, otherwise one `GET /doors` that moves the Access status like Test connection, and a read that finishes after the console block changed leaves the new endpoint's status alone) and `vp:doors/links` (DOOR-2; the whole camera → door map, no default, persisted to `doorLinks`, no Access call, allowed while Access is off). A Door links card in Settings, mounted only while the saved switch is on and keyed on the Access endpoint, pin and token-stored flag (a change discards the list and rereads); reads the doors once per visit plus Refresh doors / Retry, never on a timer. Laid out as **door cards with the cameras inside**, wrapping horizontally: an Add door dropdown + Add button (loaded doors without a card, no-hub label kept) opens an empty card, which is session state only until a camera is in it (and stays, emptied, after its last camera is unlinked, until removed or Settings is left; pruned when a loaded list lacks its door); each card lists its cameras with a ✕ to unlink, an Add camera dropdown + Add button of the cameras linked to no door (a move between doors is unlink then add — user decision 2026-11-17: Add camera lists unlinked cameras only), and a Remove door ✕ that unlinks all its cameras in one save. Dropdowns never act on `change` (an arrow key on a closed select fires it on Windows/Linux; user decision 2026-11-17: dropdown + Add). One save at a time; controls stay focusable during a save, and a ✕ that removes its own row or card moves focus to the Add camera or Add door dropdown. Links are never pruned: unknown doors keep a card ("Unknown door (<id>)", no Add camera), cameras missing from the inventory show by id ("not loaded yet" while it is empty), and while the list is loading, failed or empty the cards show by door id with only removal enabled; fix hints for `pin-required` / `auth` / `not-configured`. Card building is pure (`features/settings/doorLinks.ts`) and unit-tested. SPEC DOOR-1/DOOR-2 and §6.1 updated. First built as a per-camera list of selects, replaced at the user's request (2026-11-17: too long with many cameras). User request (2026-11-17): Settings cleanup — shorter help text, certificate and connection folded into Console, door links last, stream quality pickers side by side, section sidebar. User decision (2026-11-17): Settings' Disconnect button removed (it closed only the Protect live-update feeds; video kept playing), so connect-on-launch is cleared only by changing the key or the address |
| P5.4 | Press-and-hold unlock control + result toast + `unlock.log`. User decisions (2026-11-18): **pointer-only** 1 s hold (holding Space/Enter on the focused button does not unlock, DOOR-4); the door is named by its **camera** (no extra Access call for the door name); the button shows only while the camera is **connected and streaming**, in grid and fill, **bottom centre** of the cell, icon only (a door; open door when unlocked) with a tooltip, a 41 px rounded rectangle, **always visible** (not only on hover; follow-up 2026-11-18); **neutral when locked, green when unlocked**. `vp:doors/unlock` takes the cell's camera ref, main resolves the door from `doorLinks` (package ref → doorbell's link) and sends one `PUT …/unlock`, never retried; every attempt, refusals included, is a JSON line in `<userData>/logs/unlock.log` (1 MiB → `unlock.log.1`). Shared `ui/Toast` for the result. Until P5.5 the button shows green for 5 s after the app's own successful unlock |
| P5.5 | **Live door lock state on the official Access API** (user requests 2026-11-18; expanded the same day from "show the real lock state"). (1) Ubiquiti's official Access API document is vendored in `docs/reference/` (`access-api-reference-v4.2.16.pdf`, with the door, lock-state and notification parts extracted to `access-endpoints-v4.2.16.md`), replacing the community sources behind P0.4/P1.4. (2) The Access client and the mock cover the documented door API: `GET /doors`, `GET /doors/{id}`, `PUT …/unlock`, `GET`/`PUT …/lock_rule`, `GET`/`PUT /doors/settings/emergency`, with the error mapping corrected against the document; the lock-rule and emergency PUTs are client-only, with no UI and no caller (DOOR-3/4). (3) The notifications WebSocket (`…/devices/notifications`) as a self-healing subscription, and in the mock (hand-rolled, no new dependency). (4) DOOR-6: a door-state monitor in main reads `GET /doors` while the Live screen shows a linked door: every 5 s with the socket open, 2 s for the first minute without it, at once on any frame or after the app's own unlock, 1 s apart while a door is unlocked (up to 30 s); pushed to the renderer as `doorStates`; the unlock button is green while the relay reads `unlock` and neutral when locked or unknown. Decision (2026-11-18): **WebSocket as a hint plus polling**, not webhooks (they would need the console to connect into the app), because the document defines no relock event and nothing that carries the relay. Review decisions (2026-11-18): routine polls are not logged; the Access status turns to `error` on the second failed read in a row; a rejected token is retried every 60 s and any successful Access call restarts the watching; the socket opens only after a read has worked; a failed start-watching call from the Live screen is retried. Replaces P5.4's 5 s green stand-in. SPEC DOOR-3, DOOR-6, §5.2, §6.1 and R3 updated. Carries the G5 gate evidence as the gate stood then; P5.8 re-runs it with the additions below |
| P5.6 | **Doors screen** (user request 2026-11-18). A "Doors" button in the header nav beside "Cameras", shown only while the saved Access switch is on (DOOR-0: no button, no screen and no Access call while it is off). (1) **Door list:** every Access door, not only linked ones, with its name, lock state (relay) and door position, live through the P5.5 door-state monitor, which now also watches while this screen is open; a door with no hub is listed with unlock and lock disabled and the reason. (2) **Unlock and lock per door:** unlock is `PUT /doors/{id}/unlock`; lock is `PUT /doors/{id}/lock_rule` with `lock_now` (always; review decision below), and the temporary rules `keep_unlock`, `keep_lock` and `custom` minutes are offered from the same control. Every action needs explicit interaction (the 1 s pointer hold or a `ConfirmDialog` naming the door and the action), is sent once and never retried, and is a line in `unlock.log` (DOOR-3/4/5). (3) **Current rule or schedule:** each door shows what is controlling it from `GET /doors/{id}/lock_rule` (`schedule`, `keep_lock`, `keep_unlock`, `custom`, `lock_early`, with `ended_time` where given), e.g. "On an unlock schedule until 6:00 PM". The extracted reference gives the rule type and end time only; the task checks the full PDF for a schedule's name and hours and shows them if they are documented. (4) **Emergency:** lockdown and evacuation, read from `GET /doors/settings/emergency` and set with `PUT`, shown as a banner on the screen while either is on; turning one on or off goes through a `ConfirmDialog` that says it applies to every door (evacuation unlocks them all), and is logged. (5) **Polling settings:** the intervals P5.5 hard-codes (with the socket, without it, while a door is unlocked, and the new lock-rule and emergency reads) become persisted settings on this screen, validated to safe bounds in main and applied without a restart; P5.5's values are the defaults. (6) **Door links move here** from Settings (DOOR-2): each door shows its linked cameras, with add and remove on the door itself; the Settings Door links card is removed and `features/settings/doorLinks.ts` is reused or moved. The layout of links, actions and state on one door is designed in the task and shown to the user before it is built out. Needs deciding at the start of the task: unlocking a door with no linked camera means the renderer names a **door id** (today it names a camera and main resolves the door, DOOR-4), so main must check the id against the door list it last read; and the lock-rule and emergency reads are one call per door per poll, so they run on their own slower interval. The mock already serves every endpoint used. SPEC DOOR-1…6, §5.2 and §6.1 updated; new requirement IDs for the screen, emergency and polling settings. **Built (2026-11-18).** User decisions (2026-11-18): **door cards** — one card per Access door, wrapping, with everything about the door on its card (state, rule, actions, linked cameras) and the Polling card below; **a confirm dialog for every action on the Doors screen, unlock included, and no press-and-hold there** (the cell's unlock keeps its 1 s pointer hold); **Lockdown / Evacuation buttons in the screen header**, with a banner and "End …" while one is on. PDF check (item 3): the official document gives no name or hours for a door's unlock schedule — `GET /doors/{id}/lock_rule` answers only `type` and `ended_time`, and the PDF's §5 schedules are access-policy schedules — so a card shows the rule type and end time only. Coordinator decisions (2026-11-18): DOOR-4 amended — a cell still sends only a camera ref, while the Doors screen sends a door id that main accepts only if it is in the door list main itself last read from the current endpoint while that screen is open (otherwise `not-found`, no Access call); `lock` is always sent as `lock_now`; a door with no hub is refused for every action (`bad-request`, no call); the polling settings are `accessPolling` in seconds, defaults 5 / 2 / 1 / 30 (with the socket, without it, while unlocked, details), bounds 2–60, 1–30, 1–10, 10–600, validated in main, an out-of-range persisted value falling back to its default, no `schemaVersion` bump; the details reads (each door's lock rule, one after the other, plus the emergency status) run only while the Doors screen is open, every `detailsSec`, and at once after the app's own action and on a relay change or a new door (a door action or a relay change reads only the doors it touched and the emergency status; a timed round, a changed list, a recovery and an emergency change read everything); lockdown and evacuation cannot both be requested; every door and emergency action is a line in `unlock.log`, with the key order extended to `time, action, cameraRef, cameraName, doorId, doorName, minutes, lockdown, evacuation, result, errorKind, message`; a link change on a card saves at once without a dialog (as in P5.3); the Door links card is removed from Settings, which keeps its Console and Streams groups; the "Doors" nav button shows only while the saved Access switch is on. Added: `vp:doors/screen`, `vp:doors/action`, `vp:doors/emergency`, `vp:doors/polling` and the `doorsScreen` push; `access/doorDetailsMonitor.ts`, driven by the door-state monitor, which now has two watchers (the Live screen and the Doors screen); `features/doors/` in the renderer, with `features/settings/doorLinks.ts` moved there; the shared `.banner` primitive (the Cameras screen's banner, now also the lockdown and read-failure banners); and one mock-only route, `POST /__mock/doors/{id}/schedule`, because the API cannot create an unlock schedule and a `schedule` rule had to be shown. Review decisions (2026-11-18): Lock always sends `lock_now`, never `reset` / `lock_early` chosen from main's last read of the rule, which can be out of date (what `lock_now` does to the rest of the day's schedule on hardware is for OS-1); main refuses a door action while its door list is stale (`unavailable`, no Access call, logged), an emergency change staying allowed with the screen closed or the list stale; `vp:doors/list` and everything behind it is removed (Test connection keeps its own door read); the read-failure warning shows from the second failed read in a row, with the stale state; a read in flight when the token or a certificate changes cannot repopulate the door list; failed reads are never closer together than the baseline interval; details reads are scoped (a door action or a relay change reads only the doors it touched plus the emergency status, the rest read everything); `doorId` is capped at 200 characters. Not verified on screen (no Protect console on the development network, so the camera inventory was empty): linking a camera on a door card, the unknown-door cards, and the failure and outcome-unknown toasts. SPEC DOOR-0…6, CON-1, §5.2, §6, §6.1 and R3 updated; DOOR-7 (Doors screen), DOOR-8 (emergency) and DOOR-9 (polling settings) added; ARCHITECTURE §2 and §4, `docs/spikes/P0.4-access-mock.md` §7 and CLAUDE.md's UI conventions updated. **User feedback on the PR (2026-11-19):** a door with no hub shows only its name and the "no door hub" line (no lock chip, buttons, rule control or Add camera); the confirm button names the action without the door; the lock state is a padlock alone at the card's top right (green = unlocked, amber = locked, the word "Unknown" otherwise); Apply and Add are blue only while they can act, and linked cameras are blue-tinted chips; the door position text and "No cameras linked" are gone; the rule line is under the rule dropdown; the door name always keeps two lines; the Polling card is a column with the help to the right of each input and the three door-state intervals grouped as "Lock states", collapsible, titled "Settings" with a gear icon and pinned to the bottom of the screen, opening upwards; the cards of a row are the same height |
| P5.7 | **Stream settings move to the Cameras tab** (user request 2026-11-18). The Streams card (app-wide default grid and fill quality, QUAL-1) leaves Settings and sits on the Cameras screen; same `setStreams` IPC, same save-on-change behaviour and error line, no change to what is stored. SPEC CON-1 (Settings layout) and QUAL-1 updated |
| P5.8 | **Settings is the console connection only, behind a settings button** (user request 2026-11-18). After P5.6 and P5.7 Settings holds just the Console group: address, API key, the Enable UniFi Access switch with its token and API URL, certificate, connection; the section sidebar goes if one group no longer needs it. "Settings" stops being a tab of the header nav and becomes an icon button (a gear, added to `ui/icons.tsx`, with `aria-label` and `title` "Settings") at the end of the header; a first run with no console set still opens Settings. Before changing it, grep `tests/` and `scripts/perf/` for anything that finds the Settings tab by its text and update it in the same change (CLAUDE.md UI conventions, which are updated too). SPEC CON-1 updated. Carries the G5 gate evidence, as the last task of the phase. **Built (2026-11-19).** Coordinator decisions: the section sidebar is removed (Settings is one left-aligned column (the Console controls straight on the screen, no card; user feedback on the PR 2026-11-19) — the keystore warning when needed, then Console — scrolling with the body, the app version at its foot; `settingsSections.ts`, `GroupTitle.tsx` and their test deleted); the gear is an icon-only header button **after the connection badges**, styled as a nav button (`.app__navButton--icon`) with `aria-current` and the active look while Settings shows, through the same guarded screen switch; `GearIcon` already existed in `ui/icons.tsx`, so no icon was added. Nothing in `tests/` or `scripts/` found the Settings tab by its text. No change to main, IPC or stored settings |

**Gate G5:** unmuting a second cell mutes the first. With Access disabled, no door UI shows and no Access calls are made. With Access enabled against the mock, unlocking from a camera cell unlocks the right mock door, and the attempt is logged. Added with P5.6…P5.8 (user request 2026-11-18): with Access disabled there is no Doors button either. Against the mock, the Doors screen lists every door with its lock state, unlocks and locks the right door, shows a door's current rule or schedule, sets and clears lockdown and evacuation, and links a camera to a door, with each door action logged. Changing a polling interval changes the read cadence without a restart. Settings holds only the console connection and opens from its own button.

**G5 outcome: PASSED on 2026-11-19.** The user verified every gate item on screen against the Access mock (the build machine cannot reach the console, the G1/G3 split). Real Access hardware is still unverified: OS-1 and OS-2 stay open.

---

## Phase 6 — Hardening & prototype packaging
NFR-6…10

| # | Task |
|---|---|
| P6.1 | Sleep/wake + network-change recovery. `powerSaveBlocker` while a View is visible |
| P6.2 | Rotating app log. Redact secrets |
| P6.3 | electron-builder: unsigned DMG (arm64) + NSIS (x64) bundling the right go2rtc binary. Document the first-run Gatekeeper/SmartScreen bypass in README |
| P6.4 | Playwright-Electron smoke test (launch, connect with mocked API, render a view) |
| P6.5 | Prototype review: write `docs/PROTOTYPE_REVIEW.md` (what worked, perf numbers, decisions for MVP) |

**Gate G6:** run the installer over an older build and data is kept. The app runs for 8 hours unattended with no intervention.

---

## On-site verification (deployment location)
Things that can only be checked where the real Access hardware is. Run these before relying on the Access feature there.

| # | Check |
|---|---|
| OS-1 | With a real Access token, run `npm run spike:access` against the site console (doors list, then one confirmed unlock of an agreed test door). Confirm base URL/port, auth and response shapes against `docs/reference/access-endpoints-v4.2.16.md`. The spike also reads one door's lock rule and the emergency status, and listens on the notifications WebSocket: record which events arrive for the confirmed unlock, for a card or PIN unlock at the reader, and on relock (DOOR-6 depends on polling if none do). For DOOR-7's Lock: send `lock_now` to a door that is inside its unlock schedule and note whether the schedule resumes later that day, the next day, or not at all. Note the HTTP status sent with an error code, and any 429. Correct SPEC §5.2, the mock and the fixtures wherever they differ |
| OS-2 | In the app: enable Access, link each camera to its door, and unlock each linked door once from its cell (G5 against real hardware) |

---

## MVP backlog (after prototype review)
Code signing + notarization · import Protect Live Views · Cloud Connector remote control/unlock · badge-in camera pop-up · auto-update (electron-updater) · two-way talk · multi-monitor / kiosk / launch at login · view import/export · door-link auto-suggest · PTZ · smart-detect type filters for auto-switch (person/vehicle only) · motion badge on cells · pre-warm when rotating off a missing camera's placeholder (P4.4 review, user decision 2026-11-16).

## Working agreements for agents
- **One task per branch and PR** (`view-protect/<task-id>-<slug>`). Each task goes through: subagent implementation → `/code-review` → fixes (decisions needing the user go to the user) → commit, push, PR → user merges → next task. The full workflow is in `/CLAUDE.md`. Commits reference task and requirement IDs.
- Never commit secrets, real hostnames, or unsanitized fixtures (camera names are fine; strip MACs, IPs, tokens).
- Update `SPEC.md` when behaviour changes, and record perf numbers in `docs/perf-results.md`.
