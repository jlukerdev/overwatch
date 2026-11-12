# View Protect

A desktop app for Windows and macOS that shows live UniFi Protect cameras in named, auto-scaling grid Views. It uses the official Protect **Integration API**, and it can unlock the UniFi Access door linked to a camera. For personal, local-LAN use only.

**Status:** Prototype. Phase 0 (spikes) is next.

| Doc | Purpose |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Requirements (IDs used throughout), data model, external APIs, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack decision, process model, streaming pipeline |
| [docs/DEV_PLAN.md](docs/DEV_PLAN.md) | Phased prototype plan with gates |
| [CLAUDE.md](CLAUDE.md) | Rules for coding agents working in this folder |

## Stack
Electron · TypeScript · electron-vite · React + Zustand · go2rtc sidecar (RTSPS → MSE) · zod · electron-builder · Vitest/Playwright

## Repository layout

```
view-protect/
├─ docs/                      spec, architecture, dev plan, perf results
├─ resources/
│  ├─ bin/<platform>-<arch>/  go2rtc binaries (gitignored; scripts/fetch-go2rtc.mjs)
│  └─ icons/
├─ scripts/
│  ├─ fetch-go2rtc.mjs        pinned download + checksum
│  └─ spikes/                 Phase 0 throwaway scripts (read .env.local)
├─ src/
│  ├─ main/                   Electron main process (Node) — owns all secrets & network
│  │  ├─ protect/             Integration API REST + websocket subscriptions
│  │  ├─ access/              Access API (doors, unlock) + unlock log
│  │  ├─ streams/             go2rtc lifecycle + stream registry
│  │  ├─ config/              config.json store, zod schema, migrations
│  │  ├─ secrets/             safeStorage
│  │  ├─ tls/                 TOFU cert pinning
│  │  ├─ ipc/                 IPC handlers
│  │  ├─ power.ts, logger.ts, index.ts
│  ├─ preload/                typed contextBridge API
│  ├─ shared/                 IPC contract + domain models (main ⇄ renderer)
│  └─ renderer/               React UI (sandboxed)
│     └─ src/
│        ├─ features/         grid, cells, fill, zoom, door, settings, viewEditor, viewSwitcher
│        ├─ player/           LivePlayer (go2rtc MSE) + vendored player
│        └─ state/            Zustand stores + event bus
└─ tests/
   ├─ unit/  e2e/
   └─ fixtures/{protect,access}/   sanitized API captures
```

`package.json`, tsconfig, the electron-vite and electron-builder configs, and lint configs are created in **P0.1**, with current package versions, when the app is scaffolded.

## Getting started (after P0.1)
```bash
npm install
```
```bash
npm run fetch:go2rtc
```
```bash
npm run dev
```

## Installing prototype builds
Prototype builds are unsigned. On macOS, right-click the app → Open the first time. On Windows, choose SmartScreen → "More info" → "Run anyway". Installing a newer build over an older one keeps your Views and settings.
