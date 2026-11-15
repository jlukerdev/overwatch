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
| P4.3 | Overlay position indicator, manual next/prev, motion badge |
| P4.4 | Optional pre-warm of the next rotation camera |

**Gate G4:** a cell with 4 cameras rotates every 10 s. Walking in front of camera 3 switches to it within 2 s and holds for 15 s after motion stops.

---

## Phase 5 — Audio & door unlock
AUD-1…3, DOOR-0…5

| # | Task |
|---|---|
| P5.1 | Single-active-audio controller, volume in fill mode, `M` mute-all |
| P5.2 | "Enable UniFi Access" switch (DOOR-0) + token field + Access base URL override, then door link settings (camera → door), all hidden while disabled |
| P5.3 | Press-and-hold unlock control + result toast + `unlock.log` |

**Gate G5:** unmuting a second cell mutes the first. With Access disabled, no door UI shows and no Access calls are made. With Access enabled against the mock, unlocking from a camera cell unlocks the right mock door, and the attempt is logged.

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
| OS-1 | With a real Access token, run `npm run spike:access` against the site console (doors list, then one confirmed unlock of an agreed test door). Confirm base URL/port, auth and response shapes. Correct SPEC §5.2, the mock and the fixtures wherever they differ |
| OS-2 | In the app: enable Access, link each camera to its door, and unlock each linked door once from its cell (G5 against real hardware) |

---

## MVP backlog (after prototype review)
Code signing + notarization · import Protect Live Views · Cloud Connector remote control/unlock · badge-in camera pop-up · auto-update (electron-updater) · two-way talk · multi-monitor / kiosk / launch at login · view import/export · door-link auto-suggest · PTZ · smart-detect type filters for auto-switch (person/vehicle only).

## Working agreements for agents
- **One task per branch and PR** (`view-protect/<task-id>-<slug>`). Each task goes through: subagent implementation → `/code-review` → fixes (decisions needing the user go to the user) → commit, push, PR → user merges → next task. The full workflow is in `/CLAUDE.md`. Commits reference task and requirement IDs.
- Never commit secrets, real hostnames, or unsanitized fixtures (camera names are fine; strip MACs, IPs, tokens).
- Update `SPEC.md` when behaviour changes, and record perf numbers in `docs/perf-results.md`.
