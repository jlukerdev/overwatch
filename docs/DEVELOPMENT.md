# Development

Notes for working on OverWatch (internal name: View Protect). Coding agents start with [CLAUDE.md](../CLAUDE.md).

**Stack:** Electron · TypeScript · electron-vite · React + Zustand · go2rtc sidecar (RTSPS → MSE) · zod · electron-builder · Vitest

## Layout

```
view-protect/
├─ docs/                      spec, architecture, dev plan, perf results, API references
├─ resources/
│  ├─ bin/<platform>-<arch>/  go2rtc binaries (gitignored; npm run fetch:go2rtc)
│  └─ icons/                  icon.svg (source) → icon.png / .icns / .ico
├─ scripts/                   go2rtc fetch, type generation, icons, perf harness, Access mock, spikes
├─ src/
│  ├─ main/                   Electron main process: owns all secrets and network access
│  ├─ preload/                typed contextBridge API
│  ├─ shared/                 IPC contract + domain models (main ⇄ renderer)
│  └─ renderer/               React UI (sandboxed)
└─ tests/                     Vitest unit/renderer tests, sanitized fixtures
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload |
| `npm run build` | Typecheck and build to `out/` |
| `npm run lint` · `npm run format:check` · `npm test` | Checks that must pass before a PR |
| `npm run dist` | Fetch every go2rtc target, build, and package the installers for this OS (see [Installers](#installers)) |
| `npm run dist:mac` · `npm run dist:win` · `npm run dist:all` | The same for macOS only (arm64 + x64 DMGs), Windows only (x64 NSIS), or all three |
| `npm run perf` | Perf harness (results in `docs/perf-results.md`) |
| `npm run gen:icons` | Regenerate the app icons from `resources/icons/icon.svg` |
| `npm run gen:protect-types` | Regenerate the Protect API types |
| `npm run mock:access` | Local UniFi Access mock |

To check the UI on a clean profile: `npm run build`, then `npx electron out/main/index.js --user-data-dir=<empty dir>`.

## go2rtc

`npm run fetch:go2rtc` downloads the pinned go2rtc release for this machine into `resources/bin/<platform>-<arch>/`. It needs the system `tar` (built into macOS and Windows 10+), and it verifies the zip's SHA-256 against `scripts/go2rtc.manifest.json`. It skips a target that is already installed and unchanged.

Options (after `--`):
- `--all`: every target (darwin-arm64, darwin-x64, win32-x64, win32-arm64), in parallel
- `--target <platform>-<arch>`: one target; repeatable
- `--force`: download again

On Windows, if the binary is in use, quit OverWatch (and any go2rtc) first.

**Updating go2rtc:** in the manifest, change `version` and replace each `sha256`. Cross-check the hashes with `gh api repos/AlexxIT/go2rtc/releases/tags/<version> --jq '.assets[] | {name, digest}'`. Then run `npm run fetch:go2rtc -- --all --force`.

## Installers

`npm run dist` builds the installers into `dist/` with electron-builder (`electron-builder.yml`):

| File | For |
|---|---|
| `OverWatch-<version>-arm64.dmg` | macOS, Apple silicon |
| `OverWatch-<version>-x64.dmg` | macOS, Intel |
| `OverWatch-<version>-x64.exe` | Windows x64 (NSIS; asks per-user or all users, folder can be changed) |

- **Where to build.** A Mac builds all three (`npm run dist:all`): the DMGs need macOS, and the NSIS installer builds natively on Apple silicon through the `toolsets.nsis: '1.2.1'` bundle, so neither Wine nor Rosetta is needed. A Windows PC builds only the `.exe` (`npm run dist:win`).
- **go2rtc.** `predist` fetches every go2rtc target, and each package copies only its own `resources/bin/<platform>-<arch>/`. After packing and before signing, `scripts/after-pack.ts` (`afterPack` in `electron-builder.yml`) fails the build if the packaged go2rtc is missing, differs from the pinned version or hash, or is built for the wrong OS or CPU. macOS ad-hoc signing then re-signs the binary, so in a signed app it no longer hashes to its `go2rtc.json`; that is expected. Run builds through `npm run dist*`: the hook path is resolved against the current directory.
- **Signing.** None yet. The macOS apps are ad-hoc signed (`identity: '-'`, hardened runtime off) so Apple silicon will run them and Gatekeeper offers *Open Anyway*; without any signature macOS reports the app as damaged. The Windows files are unsigned. The first-launch steps for users are in the README.
- **Check a build.** `codesign --verify --deep --strict dist/mac-arm64/OverWatch.app` should print nothing. To launch a packaged build from a terminal started by VS Code or Claude Code, unset `ELECTRON_RUN_AS_NODE` first (`env -u ELECTRON_RUN_AS_NODE dist/mac-arm64/OverWatch.app/Contents/MacOS/OverWatch --user-data-dir=<empty dir>`), or it starts as plain Node and says "bad option".
- **Upgrade check (G6).** Install the new build over an older one: Views and settings are kept, because the `userData` folder name never changes (`src/main/branding.ts`).

## Protect API types

`src/main/protect/generated.ts` is generated from `docs/reference/protect-openapi-v7.3.74.json` and committed, so don't edit it by hand. `npm run typecheck` (and so `npm run build`) fails if it no longer matches the contract. App code imports from `src/main/protect/types.ts`, which applies the overrides for where the console differs from the contract (`docs/spikes/P0.3-protect-api.md` §6). When Protect is upgraded: vendor the new contract, update the path in `scripts/gen-protect-types.ts`, regenerate, and re-check those overrides.

The `overrides` entry in `package.json` makes openapi-typescript (whose TypeScript peer range is `^5`) use the repo's TypeScript 6. Remove it once openapi-typescript supports TypeScript 6.

## UniFi Access mock

Access is optional and off by default. The build machine has no Access hardware, so the client is developed against a local mock that follows `docs/reference/access-endpoints-v4.2.16.md`. Real hardware is still unverified (OS-1 in DEV_PLAN).

```bash
npm run mock:access
```

The mock serves `https://127.0.0.1:12445/api/v1/developer` with a self-signed certificate (needs `openssl`). It prints the certificate fingerprint and a mock token (or uses `VP_ACCESS_TOKEN`). Its fake doors are Front Door, Garage Side Door, Office and Storage Room; Storage Room's unlock always fails. Options: `--port`, `--host`, `--latency-ms`, `--fail-rate <0..1>`, `--unlock-ms`.

`npm run spike:access` checks a mock or a real console against the schemas and writes sanitized fixtures; see `docs/spikes/P0.4-access-mock.md`.

## App icons

The icon source is `resources/icons/icon.svg`. After editing it:
- Run `npm run gen:icons`; regenerating the `.icns` needs macOS.
- Commit all four files.
- Update `AppIcon` in `src/renderer/src/ui/icons.tsx`, which draws the same shapes in the header.

## Spikes

Phase 0 scripts in `scripts/spikes/` read secrets from `.env.local` (gitignored). See `docs/spikes/` for what each one proved, e.g. `npm run spike:video` (`P0.5-video.md`).
