# CLAUDE.md — View Protect (OverWatch)

The app's external name is **OverWatch** (SPEC BRAND-1…5); "View Protect" is the internal and repo name. Every string the user sees — window title, header, menus, About, dialogs, errors, toasts, the Settings foot "OverWatch v<version>" — says OverWatch, in that casing. Code identifiers (`window.viewProtect`, `ViewProtectApi`, `vp:` channels, `VP_*`), the package name `view-protect` and the `userData` folder name "View Protect" stay as they are: renaming that folder would lose every user's data (`src/main/branding.ts`).

This app is built and maintained by agents. Read `docs/SPEC.md` (how the app behaves now), `docs/ARCHITECTURE.md` and `docs/FEATURES.md` (what each version delivers, with one file per planned version in `docs/versions/`) before changing anything. `docs/DEV_PLAN.md` is the frozen legacy plan that built v1.0.0 and v1.0.1: read it for history only and never edit it. Developer how-tos (commands, go2rtc, generated types, the Access mock, icons) are in `docs/DEVELOPMENT.md`; `README.md` is user-facing.

## Ground rules
- Work one feature at a time (a feature ID from a version file, e.g. `F1.0.2-1`) using the workflow below. Only build features listed in a version file whose scope the user has agreed. Reference the feature ID and requirement IDs (e.g. `CELL-2`) in commits.
- **The Protect API contract lives in `docs/reference/protect-openapi-v7.3.74.json`.** Check it before calling any endpoint, and use the generated types.
- **The Access API contract lives in `docs/reference/access-endpoints-v4.2.16.md`** (the door, lock-state and notification parts of Ubiquiti's official document, `docs/reference/access-api-reference-v4.2.16.pdf`). Check it before calling any Access endpoint. It is documented but not yet run against hardware (OS-1).
- **Official Protect Integration API only.** Never use the private Protect API or username/password login.
- **Secrets stay in main.** The renderer never sees API keys, tokens or RTSPS URLs. It only gets loopback go2rtc stream names/URLs.
- Never disable TLS verification globally. Use the pinned agent in `src/main/tls/`.
- go2rtc listens on `127.0.0.1` only.
- Validate every IPC payload with the zod schemas in `src/shared/ipc.ts`.
- Door unlock must always need explicit user interaction (DOOR-3/4). Never automate it.
- Fixtures must be sanitized: no IPs, MACs, tokens or keys.
- Spike secrets come from `.env.local` (gitignored). Never hard-code them.

## Workflow for each work unit (one feature, e.g. `F1.0.2-1`)
Follow these steps in order for **every** feature. Do not batch several features into one branch or PR unless the version file says they ship together.

1. **Branch.** Pull the latest of the repo's default branch, then create a new branch for the feature from it: `view-protect/<feature-id>-<slug>` (e.g. `view-protect/f1.0.2-1-export-views`).
2. **Implement with subagents.** The main agent plans and coordinates the feature. The implementation work goes to subagents (e.g. one for code, one for tests or fixtures). The main agent combines their results and checks them: build, lint and tests must pass.
3. **Review.** When implementation is done, run the `/code-review` skill on the branch's changes.
   - Apply the recommended fixes that are clear-cut correctness or quality fixes.
   - **Ask the user for approval** on any finding that changes scope, behaviour, the spec, architecture, security posture, or that you're unsure about. List each with the trade-off and your recommendation, and wait for the answer before changing it.
   - Re-run build, lint and tests after the fixes.
4. **Update tracking.** Set the feature's status in its version file (add the PR number once it exists), and update `docs/SPEC.md` for any behaviour change.
5. **Commit, push, PR.** Commit (message references the feature ID and requirement IDs), push the branch, and open a PR. The PR description includes: the feature, what changed, test/gate evidence, review findings with what was done about each one (fixed / deferred / user decision), and anything left open.
6. **Wait for merge.** Stop and tell the user the PR is ready. **Do not start the next feature until the user has approved and merged the PR.** After the merge, pull the default branch and go to step 1 for the next feature. Agents never merge PRs.

Each version file has a **release check**. The last PR of a version sets `package.json` to that version and includes the release-check evidence; the next version's features don't start until that PR is merged.

## Conventions
- TypeScript strict. Keep logic that has no UI (e.g. `cellScheduler.ts`) pure and unit-tested.
- Feature folders in `src/renderer/src/features/`. Shared types in `src/shared/`.
- If behaviour changes, update `docs/SPEC.md` in the same change. SPEC.md describes the current app only: no task numbers, dates or "changed from" history (that belongs in the version file). Keep a short reason where it stops a future change from undoing a deliberate choice.
- Perf-related changes: re-run the perf harness (`npm run perf`) and update `docs/perf-results.md`.

## UI conventions (renderer)
The look is defined once, in `src/renderer/src/styles.css` and `src/renderer/src/ui/`. Reuse it; do not restyle per feature.

- **Tokens only.** Colours, radius, control heights and font sizes come from the `:root` tokens in `styles.css`. Font sizes are the five `--font-xs` … `--font-xl` tokens: never write a raw `font-size`, and add a new size as a token, not a number in a feature stylesheet. Dark theme only (`color-scheme: dark`).
- **Shared primitives before new CSS.** `.button` (+ `--primary`, `--danger`, `--danger-solid`, `--ghost`, `--icon`, `--sm`), `.card`, `.field__*`, `.row`, `.badge`, `.sideItem` (any row in a sidebar), `.emptyState` (a screen with nothing to show: centred icon, title, one line, one primary action), `.banner` (+ `--warn`, `--error`: something a whole screen should know, on a line above its content, with at most one `.button--sm` action), `.checklist`, `.status`, `.spinner`, `.dialog`, `.settingsBar` (a screen's own settings: the collapsible bar pinned to the bottom, via `ui/SettingsBar`), `.disclosure` + `.disclosure__chevron` (a full-width toggle that folds a group inside a panel), `.visuallyHidden`. Feature CSS lives next to its feature and holds only what is specific to it.
- **Shared components.** `ui/StatusLine` is the one way to report an action's outcome (field validation stays under its field as `.field__error`). `ui/ConfirmDialog` (`confirmDialog()`) is the one way to ask; never `window.confirm` / `alert`, and name the action on the confirm button ("Delete View", not "OK"). `ui/SetupChecklist` for the setup steps. `ui/SnapshotImage` for camera stills. `ui/SettingsBar` for a screen's own settings (the Doors screen's polling, the Cameras screen's stream defaults). `ui/Toast` (`showToast()` from `state/toastStore.ts`) for the outcome of an action taken away from any form, e.g. an unlock from a cell; a form's outcome stays a `StatusLine`.
- **Icons** are the inline SVGs in `ui/icons.tsx` (16×16 grid, `currentColor`, decorative). Add new ones there in the same style; no icon packages or image assets. An icon-only button needs `aria-label` and `title`.
- **Over live video.** Chips sit on `--scrim`; the name chip is 28 px tall, the strip's controls 35 px (`--control-size`), buttons at least 35 × 35 px (`features/cells/cells.css`). The quality-coloured select is the one opaque chip (user decision 2026-11-16). No `backdrop-filter` and no per-frame React state over video; animate `transform` / `opacity` only.
- **States.** Every interactive element has hover, active and a visible `:focus-visible` ring (2 px `--accent`). Disabled controls are dimmed and, where it is not obvious, say why in `title`. Any animation is off or reduced under `prefers-reduced-motion`.
- **Copy.** Plain sentences a homeowner would read, sentence case, one short line of help at most. Product names exact (OverWatch, Protect, Access, API key). The certificate UI says "accepted", not "pinned".
- **Do not rename** the header nav buttons' text ("Cameras", "Doors", "Live"): the perf harness clicks them by text. Settings is not a nav button but the gear icon button at the header's end, found by its `aria-label` "Settings"; do not change that label either. Grep `tests/` and `scripts/perf/` before changing any visible string.
- **Check it on screen.** For a visual change, launch the app on a blank profile (`npm run build`, then `npx electron out/main/index.js --user-data-dir=<empty dir>`) and look at the screens you touched; say in the PR what could not be seen without a console.
