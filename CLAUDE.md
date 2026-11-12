# CLAUDE.md — View Protect

This app is built and maintained by agents. Read `docs/SPEC.md`, `docs/ARCHITECTURE.md` and `docs/DEV_PLAN.md` before changing anything.

## Ground rules
- Work one DEV_PLAN phase at a time, and don't start a phase until the previous gate has passed. Reference requirement IDs (e.g. `CELL-2`) in commits.
- **Official Protect Integration API only.** Never use the private Protect API or username/password login.
- **Secrets stay in main.** The renderer never sees API keys, tokens or RTSPS URLs. It only gets loopback go2rtc stream names/URLs.
- Never disable TLS verification globally. Use the pinned agent in `src/main/tls/`.
- go2rtc listens on `127.0.0.1` only.
- Validate every IPC payload with the zod schemas in `src/shared/ipc.ts`.
- Door unlock must always need explicit user interaction (DOOR-3/4). Never automate it.
- Fixtures must be sanitized: no IPs, MACs, tokens or keys.
- Spike secrets come from `.env.local` (gitignored). Never hard-code them.

## Conventions
- TypeScript strict. Keep logic that has no UI (e.g. `cellScheduler.ts`) pure and unit-tested.
- Feature folders in `src/renderer/src/features/`. Shared types in `src/shared/`.
- If behaviour changes, update `docs/SPEC.md` in the same change.
- Perf-related changes: re-run the P2.5 harness and update `docs/perf-results.md`.
