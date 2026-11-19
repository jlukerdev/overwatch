# OverWatch (View Protect)

**OverWatch** is a desktop app for Windows and macOS that shows live UniFi Protect cameras in named, auto-scaling grid Views. It uses the official Protect **Integration API**, and it can unlock the UniFi Access door linked to a camera. For personal, local-LAN use only.

"View Protect" is the project's internal name: the repo folder, the `view-protect` package and the code use it. Everything the user sees says OverWatch (SPEC BRAND-1).

**Status:** v1.0.0 in progress. Phases 0–5 are done (gate G5 passed 2026-11-19). Phase 6 (OverWatch branding, hardening, packaging) is under way.

| Doc | Purpose |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Requirements (IDs used throughout), data model, external APIs, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack decision, process model, streaming pipeline |
| [docs/DEV_PLAN.md](docs/DEV_PLAN.md) | Phased plan with gates |
| [CLAUDE.md](CLAUDE.md) | Rules for coding agents working in this folder |

## Stack
Electron · TypeScript · electron-vite · React + Zustand · go2rtc sidecar (RTSPS → MSE) · zod · electron-builder · Vitest/Playwright

## Repository layout

```
view-protect/
├─ docs/                      spec, architecture, dev plan, perf results
├─ resources/
│  ├─ bin/<platform>-<arch>/  go2rtc binaries (gitignored; scripts/fetch-go2rtc.ts)
│  └─ icons/                  icon.svg (source) → icon.png / .icns / .ico (npm run gen:icons)
├─ scripts/
│  ├─ fetch-go2rtc.ts         pinned download + checksum (run by Node directly)
│  ├─ gen-protect-types.ts    Protect contract → src/main/protect/generated.ts
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

`npm run fetch:go2rtc` downloads the pinned go2rtc release for this machine into `resources/bin/<platform>-<arch>/`. It needs Node 24+ (the script is TypeScript, run directly by Node) and the system `tar` (bsdtar, built into macOS and Windows 10+). It checks the zip's SHA-256 against the manifest, then extracts only the go2rtc binary with `tar`. After a successful install it writes `resources/bin/<platform>-<arch>/go2rtc.json` with the installed `version` and the binary's `binarySha256`. A later run skips a target only if that marker's version matches the manifest and the binary on disk still has that hash; otherwise it says why and downloads again. Options (pass after `--`, e.g. `npm run fetch:go2rtc -- --all`):
- `--all`: every target (darwin-arm64, darwin-x64, win32-x64, win32-arm64), downloaded in parallel. If one fails the others still finish, and the command exits with an error listing the failures. `npm run dist` runs this first (`predist`), so installers always include go2rtc.
- `--target <platform>-<arch>`: one target; repeatable (multiple targets also run in parallel)
- `--force`: download again even if the installed binary is current

On Windows, if the binary can't be replaced because it is in use, quit OverWatch (and any running go2rtc) and run the fetch again.

### Updating go2rtc
The version and the SHA-256 of each release zip are pinned in `scripts/go2rtc.manifest.json`. To update, change `version`, then replace each `sha256` with the new asset's hash (download the zips from the GitHub release and run `shasum -a 256`, and cross-check with `gh api repos/AlexxIT/go2rtc/releases/tags/<version> --jq '.assets[] | {name, digest}'`). Check that the zip still contains the `binary` named in the manifest, then run `npm run fetch:go2rtc -- --all --force`.

### Protect API types
`src/main/protect/generated.ts` is generated from the vendored contract `docs/reference/protect-openapi-v7.3.74.json` with openapi-typescript (pinned exactly in `package.json`) and committed. Don't edit it by hand: run `npm run gen:protect-types` to regenerate it. `npm run check:protect-types` regenerates in memory and fails if the committed file differs, so drift between the contract and the types is caught. App code imports from `src/main/protect/types.ts`, which picks the subset the app uses and applies the contract-drift overrides found in the P0.3 spike (`docs/spikes/P0.3-protect-api.md` §6). When Protect is upgraded, vendor the new contract, update the path in `scripts/gen-protect-types.ts`, regenerate, and re-check the overrides. `npm run typecheck` (and so `npm run build`) runs `check:protect-types` first, so stale generated types fail the normal checks.

The `overrides` entry in `package.json` forces openapi-typescript's `typescript` peer dependency (declared as `^5`) to the repo's TypeScript 6 version (documented here because `package.json` can't hold comments). It's there so `npm install` doesn't fail or pull in a second TypeScript. Remove it once openapi-typescript's peer range includes TypeScript 6. Until then, `check:protect-types` guards the output: if the generator misbehaves under TypeScript 6, the regenerated types no longer match the committed file and the check fails.

### UniFi Access (optional, off by default)
Door unlock through UniFi Access is an optional feature (DOOR-0): with it off, the app makes no Access calls and shows no door UI. Access is not in Ubiquiti's official developer docs, and the development network has no Access hardware, so the client is built against a local mock of the community-documented developer API (`docs/spikes/P0.4-access-mock.md`). All Access shapes are unverified until the on-site check (OS-1 in `docs/DEV_PLAN.md`).

```bash
npm run mock:access
```

Serves `https://127.0.0.1:12445/api/v1/developer` (loopback only by default) with a self-signed certificate generated on first run into `scripts/mock-access/.cert/` (gitignored; needs the system `openssl`, or pass `--cert`/`--key`). It prints the base URL, the certificate SHA-256 and, unless `VP_ACCESS_TOKEN` is set in the environment or `.env.local`, a random mock-only token. Fake doors: Front Door, Garage Side Door, Office, and Storage Room (not bound to a hub, so unlocking it fails). An unlock holds the relay at `unlock` for 5 s. Options: `--port`, `--host`, `--latency-ms`, `--fail-rate <0..1>`, `--unlock-ms`.

```bash
VP_ACCESS_BASE_URL=https://127.0.0.1:12445/api/v1/developer VP_ACCESS_TOKEN=<mock token> npm run spike:access
```

Lists doors and checks the responses against the zod schemas in `src/main/access/types.ts`. Add `-- --unlock "Front Door"` to unlock one door after typing its name to confirm (`--yes` skips the prompt, and is refused unless the target sends the mock-only `x-view-protect-mock` header). The spike pins the certificate per host and port in `scripts/spikes/output/` and writes sanitized fixtures to `tests/fixtures/access/` marked `"_source": "mock"` (only when that header is present; otherwise `"console"`). On-site, the same script runs against the real console (OS-1).

### App icons
The app icon's source is `resources/icons/icon.svg`. After changing it, run `npm run gen:icons` to regenerate `icon.png` (1024 × 1024, the window icon), `icon.icns` (macOS bundle; needs macOS for `iconutil`) and `icon.ico` (Windows) next to it, and commit all four. electron-builder takes the `.icns` and `.ico` from `electron-builder.yml`; the app reads the PNG at runtime (SPEC BRAND-4).

### Video spike (P0.5)
`npm run spike:video` plays one camera through go2rtc (on a free `127.0.0.1` port) over MSE in a bare Electron window. It reports the codec, the decoder (hardware or not, read from the Chromium Media domain), audio, latency and CPU, then prints a Gate G0 PASS/FAIL. It needs `.env.local` (`VP_CONSOLE_HOST`, `VP_PROTECT_API_KEY`) and `npm run fetch:go2rtc`. It only makes GET calls to the console and never creates RTSPS streams. Options: `--camera <name>`, `--quality high|medium|low`, `--duration <s>`, `--list` (cameras, existing qualities and their codecs), `--keep-open`, `--bare`, `--trim-keep <s>`. Results go to `scripts/spikes/output/video-spike/` (gitignored). Findings and the Windows procedure are in `docs/spikes/P0.5-video.md`.

## Installing builds
Builds are unsigned. On macOS, right-click the app → Open the first time. On Windows, choose SmartScreen → "More info" → "Run anyway". Installing a newer build over an older one keeps your Views and settings.

### Upgrading from a View Protect build
The app was renamed OverWatch in v1.0.0. Your Views, settings and accepted certificates carry over: the data folder keeps its old name, `View Protect` (`~/Library/Application Support/View Protect` on macOS, `%APPDATA%\View Protect` on Windows), so don't delete it. Remove the old "View Protect" app or uninstall it from Windows Settings; the new one installs as OverWatch alongside it.

**macOS: enter your API key once more.** macOS keeps the key that encrypts the stored secrets in the keychain under the app's name, and that name is now "OverWatch Safe Storage". OverWatch can't read the Protect API key (or Access token) the old build saved, so it starts with them shown as not stored. Open Settings, enter the key (and token) again and save. You only do this once; the old "View Protect Safe Storage" keychain item can then be deleted in Keychain Access. On Windows nothing needs re-entering.
