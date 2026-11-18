# spikes

Phase 0 throwaway API/video spikes. Read secrets from .env.local only.

- `protect-spike.ts` (P0.3)
- `access-spike.ts` (P0.4, extended in P5.5): `npm run spike:access [-- [--listen <sec>] [--unlock "<door name>" [--yes] [--watch <sec>]]]`. Read-only by default: lists doors, probes the two error cases, reads `GET /doors/{id}/lock_rule` for one door and `GET /doors/settings/emergency`, and listens on the notifications WebSocket for a few seconds (for the whole unlock with `--unlock`), recording event and field names only. Its only write is the one confirmed `PUT /doors/{id}/unlock`; it never sends the lock-rule or emergency `PUT`s. Runs against the mock (`npm run mock:access`) or the site console (OS-1). See `docs/spikes/P0.4-access-mock.md`.
- `video-spike/` (P0.5): `launch.ts` (Node launcher), `electron-main.ts` (bare Electron main), `renderer/` (spike page), `lib.ts` / `stats.ts` (pure helpers, unit-tested in `tests/unit/videoSpike.test.ts`). See `docs/spikes/P0.5-video.md`.
