# OverWatch — Feature Tracking

This is the one place that tracks what each version of OverWatch (internal name: View Protect) delivers. Each planned version has its own file in [`versions/`](versions/) listing its features, decisions and release check. Requirement IDs (`CELL-2`, `DOOR-7`, …) refer to [SPEC.md](SPEC.md).

v1.0.0 and v1.0.1 were built from [DEV_PLAN.md](DEV_PLAN.md), which is now a **frozen legacy document**. Do not edit it; new work is planned here.

## Versions

| Version | Status | Feature set | Summary |
|---|---|---|---|
| 1.0.0 | Released | [DEV_PLAN.md](DEV_PLAN.md) Phases 0–6 (legacy) | First release: Views, live grid, fill and zoom, multi-camera cells, audio, Access doors, OverWatch branding, installers |
| 1.0.1 | Released | [DEV_PLAN.md](DEV_PLAN.md) Phase 7, P7.1 (legacy) | Window size and position remembered (WIN-1), collapsible Display / Quality groups in the View editor (VIEW-3), separate dev data folder (BRAND-5) |
| 1.0.2 | In progress | [versions/v1.0.2.md](versions/v1.0.2.md) | RTSP stream mode (run without a UniFi console, Streams screen for RTSP feeds); Settings bars at the top of screens; View editor cell actions in the Cell pane; smooth fill zoom on Windows (ZOOM-3); brochure and user guide cover RTSP mode. Last PR (F1.0.2-11, PR #11) in review |
| 1.0.3 | Planning | [versions/v1.0.3.md](versions/v1.0.3.md) | Two-way talk; multi-monitor Views, kiosk mode and launch at login; View export / import |

Status values: **Planning** (scope being decided) → **In progress** (scope agreed, features being built) → **Released** (`package.json` at that version, installers built, release check passed).

## How a version file works

Each `versions/v<x.y.z>.md` has:

1. **Status and goal**: one line each.
2. **Features**: a table of feature IDs `F<version>-<n>` (e.g. `F1.0.2-1`), each with a title, the SPEC requirement IDs it adds or changes, and its status (Planned / In progress / Done, with the PR number).
3. **Feature details**: per feature, what it does and the user decisions that shape it.
4. **Delivery**: one PR per feature unless the file says otherwise (e.g. v1.0.1 shipped as one combined PR). The last PR of the version sets `package.json` to the new version.
5. **Release check**: what must be shown to work before the version is called released (the equivalent of the old phase gates).

When a feature changes behaviour, SPEC.md is updated in the same PR so it always describes the current app. The version file keeps the record of *what changed when*; SPEC.md does not.

## Backlog

Ideas not yet assigned to a version. Move an item into a version file when it is planned.

| Idea | Notes |
|---|---|
| Code signing and notarization | macOS is ad-hoc signed, Windows unsigned (NFR-10) |
| Auto-update | electron-updater with a GitHub Releases feed; needs signing |
| Import Protect Live Views | `GET /v1/liveviews` (SPEC §5.1) |
| Remote control / unlock through the Site Manager Cloud Connector | Video still needs LAN or VPN (SPEC §5.1) |
| Badge-in camera pop-up | Show a camera on `nfcCardScanned` / `fingerprintIdentified` at its reader |
| Door-link auto-suggest | Suggest camera → door links by name or device (DOOR-2) |
| PTZ preset and patrol buttons | The API has presets and patrols only, no continuous PTZ |
| Motion badge on cells | Per-cell motion indicator in the overlay (CELL-3) |
| Pre-warm when rotating off a missing camera's placeholder | CELL-2 pre-warm skips that case today |
| Thumbnails for RTSP streams | Grab a frame from the stream; v1.0.2 shows an icon |
| Test a stream before saving | Probe an RTSP URL from the Streams dialog |
| Motion events for RTSP cameras | e.g. ONVIF events, so multi-camera cells can switch on motion in RTSP mode |
