# View Protect — Prototype Development Plan

Phases run in order. Each one ends with a **gate**: a check you can demo or measure. A phase isn't done until its gate passes on **both macOS and Windows** (unless marked otherwise). Requirement IDs refer to `SPEC.md`.

---

## Phase 0 — Spikes & foundation (go/no-go)
**Goal:** prove the risky assumptions before building UI.

| # | Task |
|---|---|
| P0.1 | Scaffold the Electron + electron-vite + React + TS app in this folder, following the structure in `README.md`. Strict tsconfig, ESLint + Prettier, Vitest |
| P0.2 | `scripts/fetch-go2rtc.mjs`: download the pinned go2rtc release for each platform/arch into `resources/bin/<platform>-<arch>/`, check the SHA-256, mark executable |
| P0.3 | API spike (`scripts/spikes/`): against the UDM SE, exercise `meta/info`, `cameras`, `rtsps-stream` (GET/POST low+high), `snapshot`, the events WS and the devices WS. Save **sanitized** sample responses to `tests/fixtures/protect/` |
| P0.4 | Access spike: `GET /doors` and `PUT /doors/{id}/unlock` against a test door. Confirm the port and auth path on 4.3.24. Save sanitized fixtures |
| P0.5 | Video spike: hard-coded go2rtc config with one Enhanced Encoding camera → MSE player in a bare Electron window |
| P0.6 | Fix SPEC §5 with what you verified |

**Gate G0:**
- One H.265 camera plays with audio in Electron on macOS **and** Windows, with hardware decode confirmed.
- Unlock works.

If H.265 fails on Windows, pick a fallback from SPEC R1 before continuing.

---

## Phase 1 — Connection & camera inventory
CON-1…5, CAM-1…3

| # | Task |
|---|---|
| P1.1 | `secrets/` (safeStorage) and `config/` store with zod schema + migrations |
| P1.2 | `tls/` TOFU pinning: fetch the fingerprint, accept dialog, pinned undici Agent used by every client |
| P1.3 | `protect/client.ts` REST client with typed models from the fixtures. `protect/subscriptions.ts` WS with reconnect + backoff |
| P1.4 | `access/client.ts` (doors list and unlock) |
| P1.5 | Typed IPC contract (`src/shared/ipc.ts`) and preload bridge |
| P1.6 | Settings screen: host, key, token, Test connection, status indicator |
| P1.7 | Camera list screen with snapshots and live online state |

**Gate G1:** a fresh install connects, pins the cert and lists all cameras. Unplugging a camera shows it offline within 10 s. Unit tests pass for the clients (fixtures), config and migrations.

---

## Phase 2 — Streaming core & performance
VIEW-5, CELL-1, NFR-2…5, NFR-7

| # | Task |
|---|---|
| P2.1 | `streams/go2rtcManager.ts`: spawn on a free loopback port, health check, restart on crash, clean shutdown |
| P2.2 | `streams/registry.ts`: fetch/create RTSPS URLs, register `_low`/`_high` streams, refresh on camera changes |
| P2.3 | `player/` React `<LivePlayer stream quality muted>`: MSE, reconnect, stall detection, offline placeholder |
| P2.4 | Temporary hard-coded 3×3 + 4×3 grid that fills and reflows with the window |
| P2.5 | Perf harness: 10 streams for 30 min. Record CPU, GPU, RAM and latency on both OSes into `docs/perf-results.md` |

**Gate G2:** NFR-2/4/5 met, and 30-minute runs show no memory growth. Streams recover by themselves after go2rtc is killed or the network drops. **If this fails → evaluate the libmpv fallback (ARCHITECTURE §1) before Phase 3.**

---

## Phase 3 — Views, fill mode & zoom
VIEW-1…6, FILL-1…3, ZOOM-1…3, CELL-3/4

| # | Task |
|---|---|
| P3.1 | View model + store (Zustand), persisted through IPC to config |
| P3.2 | View switcher (sidebar), keyboard 1–9, remember the last View |
| P3.3 | View editor: name, layout preset/custom, assign cameras per cell (picker + drag/drop), fit mode |
| P3.4 | Cell overlay (name, controls, auto-hide) |
| P3.5 | Fill mode with low→high seamless swap, Esc/back |
| P3.6 | Zoom/pan component (wheel, pinch, drag, 100% reset) |

**Gate G3:** build three Views from scratch, restart the app, and they come back. Fill/zoom/back works smoothly at 60 fps UI.

---

## Phase 4 — Multi-camera cells
CELL-2

| # | Task |
|---|---|
| P4.1 | `cellScheduler.ts` pure reducer (rotate, motion, hold, priority) + exhaustive unit tests |
| P4.2 | Wire Protect events → renderer event bus → scheduler |
| P4.3 | Overlay position indicator, manual next/prev, motion badge |
| P4.4 | Optional pre-warm of the next rotation camera |

**Gate G4:** a cell with 4 cameras rotates every 10 s. Walking in front of camera 3 switches to it within 2 s and holds for 15 s after motion stops.

---

## Phase 5 — Audio & door unlock
AUD-1…3, DOOR-1…5

| # | Task |
|---|---|
| P5.1 | Single-active-audio controller, volume in fill mode, `M` mute-all |
| P5.2 | Door link settings (camera → door) |
| P5.3 | Press-and-hold unlock control + result toast + `unlock.log` |

**Gate G5:** unmuting a second cell mutes the first. Unlocking from a camera cell opens the right door, and the attempt is logged.

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

## MVP backlog (after prototype review)
Code signing + notarization · auto-update (electron-updater) · two-way talk · multi-monitor / kiosk / launch at login · spanning cells · view import/export · door-link auto-suggest · PTZ · smart-detect type filters for auto-switch (person/vehicle only).

## Working agreements for agents
- One phase per branch: `view-protect/p<N>-<slug>`. Commits reference requirement IDs.
- Never commit secrets, real hostnames, or unsanitized fixtures (camera names are fine; strip MACs, IPs, tokens).
- Update `SPEC.md` when behaviour changes, and record perf numbers in `docs/perf-results.md`.
