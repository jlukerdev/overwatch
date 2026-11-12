# CLAUDE.md — View Protect

This app is built and maintained by agents. Read `docs/SPEC.md`, `docs/ARCHITECTURE.md` and `docs/DEV_PLAN.md` before changing anything.

## Ground rules
- Work one DEV_PLAN task at a time using the workflow below. Don't start a phase until the previous phase's gate has passed. Reference requirement IDs (e.g. `CELL-2`) in commits.
- **The Protect API contract lives in `docs/reference/protect-openapi-v7.3.74.json`.** Check it before calling any endpoint, and use the generated types.
- **Official Protect Integration API only.** Never use the private Protect API or username/password login.
- **Secrets stay in main.** The renderer never sees API keys, tokens or RTSPS URLs. It only gets loopback go2rtc stream names/URLs.
- Never disable TLS verification globally. Use the pinned agent in `src/main/tls/`.
- go2rtc listens on `127.0.0.1` only.
- Validate every IPC payload with the zod schemas in `src/shared/ipc.ts`.
- Door unlock must always need explicit user interaction (DOOR-3/4). Never automate it.
- Fixtures must be sanitized: no IPs, MACs, tokens or keys.
- Spike secrets come from `.env.local` (gitignored). Never hard-code them.

## Workflow for each work unit (one DEV_PLAN task, e.g. `P0.1`)
Follow these steps in order for **every** task. Do not batch several tasks into one branch or PR.

1. **Branch.** The base branch is **`feature/view-protect`**. Pull it to get its latest, then create a new branch for the task from it: `view-protect/<task-id>-<slug>` (e.g. `view-protect/p0.1-scaffold`).
2. **Implement with subagents.** The main agent plans and coordinates the task. The implementation work goes to subagents (e.g. one for code, one for tests or fixtures). The main agent combines their results and checks them: build, lint and tests must pass.
3. **Review.** When implementation is done, run the `/code-review` skill on the branch's changes.
   - Apply the recommended fixes that are clear-cut correctness or quality fixes.
   - **Ask the user for approval** on any finding that changes scope, behaviour, the spec, architecture, security posture, or that you're unsure about. List each with the trade-off and your recommendation, and wait for the answer before changing it.
   - Re-run build, lint and tests after the fixes.
4. **Commit, push, PR.** Commit (message references the task ID and requirement IDs), push the branch, and open a PR into `feature/view-protect` (never `main`). The PR description includes: the task, what changed, test/gate evidence, review findings with what was done about each one (fixed / deferred / user decision), and anything left open.
5. **Wait for merge.** Stop and tell the user the PR is ready. **Do not start the next task until the user has approved and merged the PR.** After the merge, pull `feature/view-protect` and go to step 1 for the next task.

Merging `feature/view-protect` into `main` is the user's call. Agents never open or merge PRs into `main`.

Phase gates (`G0`…`G6`) still apply. The last task of a phase includes the gate evidence in its PR, and the next phase doesn't start until that PR is merged.

## Conventions
- TypeScript strict. Keep logic that has no UI (e.g. `cellScheduler.ts`) pure and unit-tested.
- Feature folders in `src/renderer/src/features/`. Shared types in `src/shared/`.
- If behaviour changes, update `docs/SPEC.md` in the same change.
- Perf-related changes: re-run the P2.5 harness and update `docs/perf-results.md`.
