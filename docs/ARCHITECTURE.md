# OverWatch (View Protect) — Architecture

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | **Electron** | Ships its own Chromium, so video decode behaves the same on Windows and macOS: hardware H.264/H.265 through MSE |
| Language | **TypeScript** everywhere (strict) | One language across main, preload and renderer |
| Build | **electron-vite** | Fast dev loop and HMR, with separate main/preload/renderer builds |
| UI | **React** + **Zustand** (state), plain CSS: shared tokens and primitives in `styles.css` and `ui/`, feature CSS next to its feature | Grid layout is plain CSS Grid |
| Video gateway | **go2rtc** bundled binary (sidecar) | Proven with Protect RTSPS. Turns RTSPS into MSE over WebSocket, one upstream connection per stream, handles H.265 + AAC, reconnects on its own |
| Player | go2rtc's `video-rtc` MSE player (vendored, unmodified) wrapped in a React component | Low latency, plain `<video>` element, so mute and volume are trivial |
| Validation | **zod** | Config schema plus IPC payload validation |
| API types | **openapi-typescript** from the vendored official contract (`docs/reference/`) | Types match the console's API version exactly |
| Secrets | Electron **safeStorage** | Keychain / DPAPI with no native module |
| Packaging | **electron-builder** → DMG (macOS arm64 and x64, ad-hoc signed), NSIS (Windows x64, unsigned) | |
| Tests | **Vitest** (unit and renderer tests) | |

**Fallback if MSE video ever fails a platform** (e.g. H.265 on a Windows GPU, SPEC R1): have go2rtc transcode through FFmpeg, or move the player to libmpv (Flutter + media_kit was the runner-up stack for that reason). Tauri was rejected because it uses the OS webview, which gives two different video engines to debug.

## 2. Process model

```
┌───────────────────────── Electron app ─────────────────────────┐
│                                                                │
│  MAIN (Node)                                                   │
│   ├─ protect/   Integration API REST client + WS subscribers   │
│   ├─ access/    Access API client, notifications WS, door state│
│   ├─ streams/   go2rtc lifecycle, stream registry (both modes) │
│   ├─ config/    JSON store (zod, migrations), per-mode Views   │
│   ├─ secrets/   safeStorage wrapper (keys, token, RTSP URLs)   │
│   ├─ tls/       TOFU cert pinning (undici Agent)               │
│   ├─ appMode.ts mode gate: no UniFi call in RTSP mode          │
│   ├─ connection.ts  inventory, device feed, status (CON-5)     │
│   ├─ power.ts   display-sleep blocker, wake/network recovery   │
│   ├─ logger.ts  rotating app log (redacted)                    │
│   └─ ipc/       typed handlers (contract in src/shared)        │
│            ▲  contextBridge (typed, validated)                 │
│  PRELOAD ──┘                                                   │
│            ▼                                                   │
│  RENDERER (React, sandboxed)                                   │
│   ├─ features/grid, cells, fill, zoom, viewEditor, …           │
│   ├─ player/ MSE player ──ws://127.0.0.1:<port>/api/ws──┐      │
│   ├─ features/doors    doors (Protect)                  │      │
│   ├─ features/cameras  camera list (Protect)            │      │
│   ├─ features/streams  RTSP streams (RTSP)              │      │
│   └─ features/settings mode cards, console              │      │
└─────────────────────────────────────────────────────────┼──────┘
                                                          │
                     go2rtc (child process, loopback only)│
                         ▲  one upstream per stream, opened
                         │  only while a player watches it
              ┌──────────┴──────────────────┐
 Protect mode │                             │ RTSP mode
              │                             │
 UDM SE ── Protect (Integration      RTSP / RTSPS cameras
       │   API, RTSPS :7441)         (addresses the user typed,
       └─ Access (Developer          read from secrets.bin)
           API, :12445)
```

### Key rules
1. **Secrets never reach the renderer.** The renderer asks main for things like "stream for camera X, quality low". Main hands back a *loopback go2rtc stream name and URL*, never the RTSPS URL, a user-entered RTSP stream address or a key. Of a stream address it learns only which qualities have one, as booleans (`secretsStored.rtspUrls`, RTSP-2).
2. **go2rtc binds to `127.0.0.1` on a random free port**, with a per-launch API username and password. Main writes its config into `userData` at launch and deletes it once go2rtc answers (SPEC §5.3).
3. **Stream naming:** `<cameraId>_<quality>` for `high`, `medium`, `low` (and `package`, Protect only). In RTSP mode the id is the stream's (`rtsp-<uuid>`), so the name is `<streamId>_<quality>`, and the quality in it is the one actually served after RTSP-3's fallback, not the one asked for. Main registers a go2rtc stream (`PUT /api/streams`) **the first time a quality is requested** (QUAL-8): in Protect mode it creates the Protect RTSPS URL first if it is missing; in RTSP mode it reads the address from its own secrets. go2rtc only opens the upstream while a consumer is attached, so registered-but-unused qualities cost nothing.
4. **Protect events.** Main holds the Protect `/subscribe/events` and `/subscribe/devices` sockets, opened together by `connect()` (called by the user, or once at launch by `connectOnLaunch()` when SPEC CON-4 allows it) and closed together on a credential or console change and on shutdown. There is no user Disconnect. Main pushes trimmed, typed payloads to the renderer: `cameraEvent` (each `motion`, `smartDetect*` or `ring` message, repeats included; the cell scheduler is idempotent on `(id, end)`), `cameraState` (a camera's `state` from the devices feed), `cameras` (the re-read inventory), `connection` (CON-5 status) and `streamRuntime` (go2rtc up/down).
   - Only the devices feed drives the Protect connection status. The events feed's errors and reconnects are logged and never change the badge. A repeated `connect()` reopens an events feed that stopped by itself (for example on a rejected key), even if that connect's inventory re-read fails. When the devices feed stops by itself, the events feed is stopped with it, so the next `connect()` opens both fresh.
   - The inventory is **not** rebuilt from the devices feed. `GET /v1/cameras` stays the authority and is re-read after every connect, reconnect and add/remove, because the feed sends no initial state and its message shapes are unverified (SPEC R11). The feed is used for one thing: a camera's `state`.
   - Every IPC call answers `{ ok, value | error }` rather than throwing, and every mutating call answers with the whole app state (SPEC §6.1).
5. **Door state (DOOR-6)** is the one Access feed. `access/doorStateMonitor.ts` (pure, clock and I/O injected) reads `GET /doors` on a timer and at once on a hint: any frame of the Access notifications WebSocket (`access/notifications.ts`, a self-healing subscription on the Access pin and Bearer token), the socket reopening, or the app's own unlock, door action or emergency change answering. The socket is never the source of truth: the API has no relock event. There is one read loop and one socket, with two independent reasons to run them: the Live screen watching a View with a linked door (`vp:doors/watch`; the linked doors' states go out as `doorStates`), and the Doors screen being open (`vp:doors/screen`; every door the console lists is tracked, and one whole `doorsScreen` state goes out). The connection manager runs the monitor only while Access is on, a token is stored and at least one of the two wants it, and restarts it when the console block, the token, a certificate or the links change. The read intervals come from the saved `accessPolling` settings (DOOR-9), read at every scheduling decision and re-armed on a save.
   - **Details (DOOR-7/8).** `access/doorDetailsMonitor.ts` (pure) reads what `GET /doors` does not carry — each door's lock rule and the emergency status — only while the Doors screen is open and a door read has worked. A round is one request after the other, never in parallel and never two rounds at once, because it costs a request per door against an undocumented rate limit (SPEC §5.2). Only the timed rounds, a changed list, a recovery and an emergency change read everything; a door action or a relay change reads only the doors it touched plus the emergency status (`DoorDetailsScope`, merged when coalesced). Its failures mean "unknown" and never reach the Access status.
   - **The last-read door list is what a door id is checked against.** A cell's unlock names a camera and main resolves the door from the saved links. A Doors screen action names a door id, so main acts only on an id in the list the monitor itself last read from the current endpoint while that screen is open (`knownDoor`). The list is dropped on a stop, on a halt, when the screen closes and when the token or a certificate changes (DOOR-4); a read already in flight at that moment cannot bring it back.
   - **Reading never writes; writes are never automatic.** Both monitors only send GETs. The three door-changing PUTs (`…/unlock`, `…/lock_rule`, `/doors/settings/emergency`) are sent by the connection manager alone (`unlockDoor`, `doorAction`, `setDoorEmergency`): one PUT per action the user confirmed, never retried, never from a timer or an event, each attempt a line in `unlock.log` (DOOR-3/4/5).
6. **Recovery after sleep or a network change (NFR-7).** `power.ts` (pure, Electron injected) turns `powerMonitor` `resume` and a settled change in the machine's network addresses into one `recover(reason)`, at least 5 s apart. `ConnectionManager.recover()` calls `reconnectNow()` on the Protect feeds and the Access socket and `recoverNow()` on the door-state monitor (every reconnect still goes through the rate limiter), starts go2rtc again only if it is `failed`, and pushes `recover` to the renderer, where each player cuts its own backoff short. Recovery starts nothing that was stopped for good, and only reads. The same module holds the one `prevent-display-sleep` blocker (NFR-8), driven by `vp:power/viewVisible` from the Live grid and released on reload, crash, close and quit.
7. **The cell logic is pure.** The rotation/motion scheduler is a pure reducer in `src/renderer/src/features/cells/cellScheduler.ts`, so it can be unit-tested.
8. **Snapshots are one renderer cache** (Protect mode only: RTSP mode has none, RTSP-4). `state/thumbnailsStore.ts` is a small Zustand store holding the Cameras tab's thumbnail sheet and load, its RTSPS feed states (QUAL-7), and the package-channel snapshots the View editor shows (CAM-4, VIEW-3). It applies the pure reducers in `state/camerasStore.ts`, owns the request-id counter, and folds every change of `appStore`'s inventory into the cache once, whether or not a screen is mounted (CAM-2/3). The Cameras tab and the View editor both read it and both fetch into it through the same `snapshot` IPC (so main's one rate limiter, R9); a camera is marked in flight before it is fetched, which stops the two screens asking twice. It holds bytes only: object URLs are made and revoked by `ui/SnapshotImage.tsx`, the one component that renders them.
9. **Two modes (MODE-1…4).** `config.json`'s `mode` is `protect` (the default, and what an old config loads as) or `rtsp`.
   - **Protect mode** is everything above: main talks to the console's Protect Integration API and, when on, its Access API, and go2rtc pulls Protect's RTSPS streams.
   - **RTSP mode** talks to no console at all: the cameras are the streams the user typed on the Streams screen (`rtsp.streams`, ids and names only, in `config.json`; their addresses in `secrets.bin` as `rtspUrls`, RTSP-2). Main makes **no Protect or Access call of any kind** (MODE-4): every path that would send one reads the live mode first (`appMode.ts` `isRtspMode`, never cached) and refuses with `AppModeError`, mapped to `bad-request`. The connect at launch is skipped, the feeds and the door monitor stay closed, `ConnectionManager.recover()` does nothing (go2rtc and the players still recover after a wake), and the inventory pushed as `cameras` is built from the streams (`streams/rtspStreams.ts` `rtspInventory`: name order, model "RTSP stream", always `CONNECTED`, RTSP-3).
   - **Views are kept per mode** (`config/modeViews.ts`): Protect's are the top-level `views` / `lastViewId`, RTSP's are `rtsp.views` / `rtsp.lastViewId`. The renderer is shown only the active mode's pair, under the top-level names (`settingsForRenderer`), and `vp:views/*` writes go to it, so the switcher, editor and grid need no mode logic. Secrets are not per mode: one `secrets.bin` holds the Protect key, the Access token and the stream addresses side by side.
   - **Switching** is `vp:app/mode` (`ipc/handlers.ts`, one switch at a time). It saves `mode` alone — the console block, certificates, door links, both modes' Views and every secret stay as stored — then, together, `ConnectionManager.modeChanged()` and the registry's `unregisterAll()` (every go2rtc stream, in both directions, because one mode's sources fail the other mode's source check). Entering RTSP mode stops both Protect feeds and the door-state monitor, resets both statuses to `idle`, drops the Protect inventory and pushes the RTSP one. Back in Protect mode main pushes the (empty) Protect inventory and calls `connectOnLaunch()`, so it connects by itself only when CON-4's launch rule allows. go2rtc itself keeps running across a switch.
   - **The renderer is mode-aware in a few places only.** `navScreens.ts`: the header nav is Cameras, Doors (while Access is on) and Live in Protect mode, Streams and Live in RTSP mode, and a screen the mode does not have falls back to Settings. `ConnectionBadge` draws nothing in RTSP mode. `initialScreen.ts`: RTSP mode opens on Live when it has a View and a stream, otherwise on Streams. Settings shows the mode cards (`features/settings/ModePicker.tsx`) in both modes and, in RTSP mode, only a pointer to the Streams screen in place of the console settings. The Streams screen is `features/streams/` (list, Add / Edit dialog with write-only address fields, delete confirmation, and the Cameras screen's default-quality Settings bar). In RTSP mode Live has no unlock button and no Switch on events, snapshots are replaced by the camera icon, and whether a cell has sound comes from the audio codec in go2rtc's MSE handshake (`player/mseBuffer.ts` `mimeHasAudio`, `features/audio/streamAudio.ts`) instead of the camera's mic flags. A mode switch also closes the View editor and ends focus mode (`App.tsx`).

## 3. Streaming details
- Every player asks for its quality from `src/shared/quality.ts`, which has one function per chain: `resolveGridQuality()` (cell → view → settings) and `resolveFillQuality()` (view → settings). Two functions rather than one, because the chains differ in length and a single entry point would need a mode flag or a nullable cell argument — both silently mis-callable. Nothing in the app hard-codes a quality. When the effective quality changes, or on entering fill mode, a second player layer attaches to the new stream and the old one stays visible until the new one fires its first `playing` event (QUAL-6).
- Many cells showing the same camera share one go2rtc upstream, so that costs nothing extra.
- Multi-camera cells keep **only the visible camera's player attached**, except for a short **pre-warm** before a rotation step: 2 s (`PREWARM_LEAD_MS`) before the step, the cell mounts a second, hidden player (`opacity: 0`, so Chromium keeps decoding; muted, no pointer) for the camera the step will show, at the quality it will play at. The scheduler says which camera and when (`upcomingRotation`), `schedulerSet.ts` turns that into per-slot targets, and `useCellSchedulers` re-reads them on a timer. At the step, that same player becomes the visible one: the players are a keyed list under the zoom layer, keyed by camera id, so React keeps the pre-warmed instance and there is no reconnect. Only timed rotation is pre-warmed: trigger switches can't be foreseen, manual steps are the user's, and a filled cell is pinned.
- **Audio** (AUD-1/2/3) is one renderer store, `state/audioStore.ts`: at most one active source, named as a View, a slot and the camera that slot showed when unmuted, plus the session-only volume (never in the config). Which cameras have audio is the store-free `features/audio/cameraAudio.ts`, shared with the camera list and the slot builder. `<GridView>` reads the store, tells each cell whether it is the source, and after every render that rebuilds the slots lets the store drop a source no longer on screen, so audio never follows a cell onto another camera. Unmounting the grid mutes everything. `muted` and `volume` are plain `<video>` properties on the player's visible layer, applied without a rebuild; hidden layers (pre-warm, QUAL-6's incoming layer) are always muted.
- **Protect mode sources.** Protect RTSPS uses a self-signed certificate. Main builds go2rtc sources with go2rtc's no-verify `rtspx` scheme, with `?enableSrtp` stripped, **only for the pinned console host** (SPEC §5.3, R4).
- **RTSP mode sources** (RTSP-3, RTSP-5). The renderer names a stream id and a quality, never an address. The registry (`streams/registry.ts`, its RTSP branch) checks the id is in the live `rtsp.streams`, picks the served quality with `fallbackQuality()` (`src/shared/quality.ts`: the asked one, else the nearest that has an address, the lower first on a tie), reads that address from main's decrypted secrets, validates it again with `validateRtspUrl()` (`src/shared/rtsp.ts`: `rtsp://` or `rtsps://` with a host, at most 2048 characters, no whitespace or control characters, because go2rtc runs some source schemes as commands) and turns it into a source with `toRtspGo2rtcSource()`: `rtsps://` becomes `rtspx://` (TLS **without certificate verification**, since go2rtc cannot pin: SPEC R12), `?enableSrtp` is stripped, `rtsp://` is passed as is. In place of the pinned-host check, go2rtc's manager then accepts a source only if it is exactly the one the registry recorded for that stream name (`rtspSource`). A saved or deleted stream drops its registrations (`rtspStreamChanged`), so the next request reads the new address.

## 4. Persistence
`<userData>` is `<appData>/View Protect` for the packaged app and `<appData>/View Protect Dev` for an unpackaged run; `src/main/branding.ts` sets it before `ready`, unless `--user-data-dir` is given (SPEC BRAND-5). The folder name must never change: it holds every user's data.

- `<userData>/config.json`: the app `mode`, Protect mode's Views, door links, the Access polling intervals, UI prefs, and the `rtsp` block (stream ids and names, RTSP mode's Views and last View; never an address). Schema in SPEC §6
- `<userData>/secrets.bin`: safeStorage-encrypted `{ protectApiKey, accessToken, rtspUrls }`, where `rtspUrls` is `{ "<streamId>": { high?, medium?, low? } }`
- `<userData>/window-state.json`: the main window's last normal bounds (WIN-1)
- `<userData>/logs/app.log`: every main-process console line, the startup line, crashes and the renderer's warnings/errors, as `<time> <LEVEL> <message>`; rotated before 5 MiB to `app.log.1`…`.3`; written by `src/main/logger.ts`, every line passed through the redactor `src/main/log/redact.ts` first (NFR-9). Help → Show Log Files opens the folder
- `<userData>/logs/unlock.log`: JSON Lines, one line per unlock, Doors screen door action and emergency change; rotated to `unlock.log.1` above 1 MiB; `src/main/access/unlockLog.ts` (DOOR-5)
- `<userData>/go2rtc.yaml`: generated on every launch and deleted once go2rtc answers, since it can hold stream sources. Never hand-edited

## 5. Updating
Build a new installer and run it over the old one; user data in `userData` survives. Auto-update and signing are in the [backlog](FEATURES.md#backlog).
