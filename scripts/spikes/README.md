# spikes

Phase 0 throwaway API/video spikes. Read secrets from .env.local only.

- `protect-spike.ts` (P0.3), `access-spike.ts` (P0.4)
- `video-spike/` (P0.5): `launch.ts` (Node launcher), `electron-main.ts` (bare Electron main), `renderer/` (spike page), `lib.ts` / `stats.ts` (pure helpers, unit-tested in `tests/unit/videoSpike.test.ts`). See `docs/spikes/P0.5-video.md`.
