# View Protect — Architecture & Stack Decision

## 1. Stack (decision)

| Layer | Choice | Why |
|---|---|---|
| App shell | **Electron** (latest stable) | Ships its own Chromium, so video decode behaves the same on Windows and macOS: hardware H.264/H.265 through MSE. Agents know it well. Packaging and auto-update are mature |
| Language | **TypeScript** everywhere (strict) | One language across main, preload and renderer |
| Build | **electron-vite** | Fast dev loop and HMR, with separate main/preload/renderer builds |
| UI | **React** + **Zustand** (state) + CSS Modules | Simple. Grid layout is plain CSS Grid |
| Video gateway | **go2rtc** bundled binary (sidecar) | Proven with Protect RTSPS (Home Assistant and Frigate use it). Turns RTSPS into MSE over WebSocket. One upstream connection per stream. Handles H.265 + AAC. Reconnects on its own |
| Player | go2rtc's `video-rtc` MSE player (vendored) wrapped in a React component | Low latency, plain `<video>` element, so mute and volume are trivial |
| Validation | **zod** | Config schema plus IPC payload validation |
| API types | **openapi-typescript** from the vendored official contract (`docs/reference/`) | Types match the console's API version exactly |
| Secrets | Electron **safeStorage** | Keychain / DPAPI with no native module |
| Packaging | **electron-builder** → DMG (mac arm64), NSIS (win x64) | Can add electron-updater later for MVP auto-update |
| Tests | **Vitest** (unit), **Playwright for Electron** (smoke) | |

### Alternatives considered
- **Tauri + go2rtc**: smaller binary, but it uses the OS webview. WebView2 HEVC support depends on the system HEVC extension and the GPU, and WKWebView behaves differently. Two video engines to debug, so rejected.
- **Flutter + media_kit (libmpv)**: the best raw decode performance and it plays RTSPS directly. The ecosystem is weaker for agent-built work, and per-cell overlay UI is harder. **Kept as the fallback** if the Electron/MSE path fails the Phase 0 or Phase 2 performance gates.
- **.NET Avalonia + LibVLCSharp**: works, but LibVLC multi-view performance and the overlay compositing (airspace) problems make it riskier.

## 2. Process model

```
┌──────────────────────── Electron app ─────────────────────────┐
│                                                                │
│  MAIN (Node)                                                   │
│   ├─ protect/   Integration API REST client + WS subscribers   │
│   ├─ access/    Access API client, notifications WS, door state│
│   ├─ streams/   go2rtc lifecycle + stream registry             │
│   ├─ config/    JSON store (zod, migrations)                   │
│   ├─ secrets/   safeStorage wrapper                            │
│   ├─ tls/       TOFU cert pinning (undici Agent)               │
│   ├─ connection.ts  inventory, device feed, status (CON-5)     │
│   ├─ power.ts   display-sleep blocker, wake/network recovery   │
│   └─ ipc/       typed handlers (contract in src/shared)        │
│            ▲  contextBridge (typed, validated)                 │
│  PRELOAD ──┘                                                   │
│            ▼                                                   │
│  RENDERER (React, sandboxed)                                   │
│   ├─ views/ grid, cell, fill mode, zoom                        │
│   ├─ player/ MSE player ──ws://127.0.0.1:<port>/api/ws──┐      │
│   ├─ doors/ door cards, actions, links, polling         │      │
│   ├─ cameras/ camera list, stream defaults              │      │
│   └─ settings/ connection                               │      │
└─────────────────────────────────────────────────────────┼──────┘
                                                          │
                     go2rtc (child process, loopback only)│
                       ▲  RTSPS (one upstream per stream) │
                       │                                  │
              UDM SE ── Protect 7.3.74 (Integration API, RTSPS :7441)
                     └─ Access 4.3.24 (Developer API)
```

### Key rules
1. **Secrets never reach the renderer.** The renderer asks main for things like "stream URL for camera X, quality low". Main hands back a *loopback go2rtc URL* and never the RTSPS URL or key.
2. **go2rtc binds to `127.0.0.1` on a random free port.** Main writes its config into the userData dir at launch. The API and WebRTC listeners are turned off except for the loopback HTTP/WS listener.
3. **Stream naming:** `<cameraId>_<quality>` for `high`, `medium`, `low` (and `package`). Main registers a go2rtc stream (`PUT /api/streams`) **the first time a quality is requested** (QUAL-8), creating the Protect RTSPS URL first if it's missing. go2rtc only opens the upstream while a consumer is attached, so registered-but-unused qualities cost nothing.
4. **Events:** main holds the Protect `/subscribe/events` and `/subscribe/devices` sockets, opened together by `connect()` (called by the user, or once at launch by `connectOnLaunch()` when a previous session connected and the Protect key and address have not changed since, SPEC CON-4) and closed together on a credential or console change and on shutdown; there is no user Disconnect (removed 2026-11-17). It pushes trimmed, typed payloads to the renderer over IPC: `cameraEvent` (a `CameraEvent` for each `motion`, `smartDetect*` or `ring` message on the events feed, repeats included: the cell scheduler is idempotent on `(id, end)`), `cameraState` (a camera's `state` from the devices feed), `cameras` (the re-read inventory), `connection` (CON-5 status) and `streamRuntime` (go2rtc up/down).
   - Only the devices feed drives the Protect connection status. The events feed's errors and reconnects are logged and never change the badge, and a repeated `connect()` reopens an events feed that stopped by itself (for example on a rejected key), even if that connect's inventory re-read fails. When the devices feed stops by itself, the events feed is stopped with it, so the next `connect()` opens both fresh.
   - The inventory is **not** rebuilt from the device feed. `GET /v1/cameras` stays the authority and is re-read after every connect, reconnect and add/remove, because the feed sends no initial state and its message shapes are unverified (SPEC R11). The feed is used for the one thing it states plainly: a camera's `state`.
   - Every IPC call answers `{ ok, value | error }` rather than throwing, and every mutating call answers with the whole app state. SPEC §6.1 says why.
   - **Door state (P5.5, DOOR-6; two watchers since P5.6)** is the one Access feed. `access/doorStateMonitor.ts` (pure, clock and I/O injected) reads `GET /doors` on a timer and at once on a hint — any frame of the Access notifications WebSocket (`access/notifications.ts`, a self-healing subscription like the Protect ones, on the Access pin and Bearer token), the socket reopening, or the app's own unlock, door action or emergency change answering. The socket is never the source of truth: the API has no relock event. There is one read loop and one socket, and two independent reasons to run them: the Live screen watching a View with a linked door (`vp:doors/watch`; the linked doors' states go out as `doorStates`), and the Doors screen being open (`vp:doors/screen`; every door the console lists is tracked, and one whole `doorsScreen` state goes out: the list, whether it is stale, the rules, the emergency status and why nothing can be read). The connection manager runs the monitor only while Access is on, a token is stored and at least one of the two wants it, and restarts it when the console block, the token, a certificate or the links change. The read intervals come from the saved `accessPolling` settings (DOOR-9), read at every scheduling decision and re-armed on a save.
   - **Details (P5.6, DOOR-7/8).** `access/doorDetailsMonitor.ts` (pure, like the monitor that drives it) reads what `GET /doors` does not carry — each door's lock rule and the emergency status of all doors — only while the Doors screen is open and a door read has worked. A round is one request after the other, never in parallel and never two rounds at once, because it costs a request per door against an undocumented rate limit (SPEC §5.2). For the same reason only the timed rounds, a changed list, a recovery and an emergency change read everything; a door action or a relay change reads only the doors it touched plus the emergency status (`DoorDetailsScope`, merged when coalesced). Its failures mean "unknown" and never reach the Access status.
   - **The last-read door list is what a door id is checked against.** A cell's unlock names a camera and main resolves the door from the saved links. A Doors screen action has to name a door id, so main acts only on an id in the list the monitor itself last read from the current endpoint while that screen is open (`knownDoor`); the list is dropped on a stop, on a halt, when the screen closes and when the token or a certificate changes (SPEC DOOR-4). A read that was already in flight when the token or certificate changed cannot bring it back: the list stays unknown until a read started afterwards answers.
   - **Reading never writes; writes are never automatic.** Both monitors only send GETs. The three door-changing PUTs (`…/unlock`, `…/lock_rule`, `/doors/settings/emergency`) are sent by the connection manager alone (`unlockDoor`, `doorAction`, `setDoorEmergency`): one PUT per action the user confirmed, never retried, never from a timer or an event, each attempt a line in `unlock.log` (DOOR-3/4/5).
   - **Recovery after sleep or a network change (P6.2, NFR-7).** `power.ts` (pure, Electron injected) turns `powerMonitor` `resume` and a settled change in the machine's network addresses into one `recover(reason)`, at least 5 s apart. `index.ts` sends it to `ConnectionManager.recover()`, which calls `reconnectNow()` on the Protect feeds and the Access socket and `recoverNow()` on the door-state monitor (every reconnect still goes through the rate limiter), starts go2rtc again only if it is `failed`, and pushes `recover` to the renderer, where each player cuts its own backoff short. Recovery starts nothing that was stopped for good, and only reads. The same module holds the one `prevent-display-sleep` blocker (NFR-8), driven by `vp:power/viewVisible` from the Live grid and released on reload, crash, close and quit.
5. **The cell logic is pure.** The rotation/motion scheduler is a pure reducer in `src/renderer/src/features/cells/cellScheduler.ts`, so it can be unit-tested.
6. **Snapshots are one renderer cache** (P5.2). `state/thumbnailsStore.ts` is a small zustand store holding the Cameras tab's thumbnail sheet and load (P4.5), its RTSPS feed states (QUAL-7), and the package-channel snapshots the View editor shows (CAM-4, VIEW-3). It only applies the pure reducers in `state/camerasStore.ts`, owns the request-id counter, and folds every change of `appStore`'s inventory into the cache once, whether or not a screen is mounted (CAM-2/3). The Cameras tab and the View editor both read it and both fetch into it through the same `snapshot` IPC (so main's one rate limiter, R9); a camera is marked in flight before it is fetched, which is what stops the two screens asking twice. It holds bytes only: object URLs are made and revoked by `ui/SnapshotImage.tsx`, the one component that renders them.

## 3. Streaming details
- Every player asks for its quality from `src/shared/quality.ts`, which has one function per chain: `resolveGridQuality()` (cell → view → settings) and `resolveFillQuality()` (view → settings). Two functions rather than one, because the chains differ in length and a single entry point would need a mode flag or a nullable cell argument — both silently mis-callable. Nothing in the app hard-codes a quality. When the effective quality changes, or on entering fill mode, a second player attaches to the new stream, and the old one stays visible until the new one fires its first `playing` event.
- Many cells showing the same camera share one go2rtc upstream, so that costs nothing extra.
- Multi-camera cells keep **only the visible camera's player attached**, except for a short **pre-warm** before a rotation step (P4.4): 2 s (`PREWARM_LEAD_MS`) before the step, the cell mounts a second, hidden player (`opacity: 0`, so Chromium keeps decoding; muted, no pointer) for the camera the step will show, at the quality it will play at. The scheduler says which camera and when (`upcomingRotation`), `schedulerSet.ts` turns that into per-slot targets, and `useCellSchedulers` re-reads them on a timer. At the step, that same player becomes the visible one: the players are a keyed list under the zoom layer, keyed by camera id, so React keeps the pre-warmed instance rather than remounting, and there is no reconnect. Only timed rotation is pre-warmed. Trigger switches can't be foreseen, manual steps are the user's, and a filled cell is pinned. The cost is one extra stream per rotating cell for about 2 s of each interval.
- **Audio** (P5.1; AUD-1/2/3) is one renderer store, `state/audioStore.ts`: at most one active source, named as a View, a slot and the camera that slot showed when unmuted, plus the session-only volume (never in the config). Which cameras have audio is the store-free `features/audio/cameraAudio.ts`, shared with the camera list and the slot builder. Its rules are pure functions; `<GridView>` reads it, tells each cell whether it is the source, and after every render that rebuilds the slots lets the store drop a source no longer on screen (another camera, missing, mic off, offline, another View, or another slot filled), so audio never follows a cell onto another camera. Unmounting the grid mutes everything. `muted` and `volume` are plain `<video>` properties on the player's visible layer, applied without a rebuild, so neither ever reconnects; hidden layers (pre-warm, QUAL-6's incoming layer) are always muted.
- Protect RTSPS uses a self-signed cert. Main builds go2rtc sources with go2rtc's no-verify RTSPS scheme, **only for the pinned console host**. (Phase 0 confirms the exact scheme and URL rewriting, e.g. removing `?enableSrtp`.)

## 4. Persistence
`<userData>` is `<appData>/View Protect`, kept by name when the app became OverWatch (P6.1, SPEC BRAND-5): `src/main/branding.ts` sets it before `ready`, unless `--user-data-dir` is given.

- `<userData>/config.json`: views, door links, the Access polling intervals (`accessPolling`, DOOR-9), UI prefs (schema in SPEC §6)
- `<userData>/secrets.bin`: safeStorage-encrypted `{ protectApiKey, accessToken }`
- `<userData>/logs/`: app log (rotating; not built yet) and `unlock.log` (P5.4, DOOR-5: JSON Lines, one line per unlock attempt and, since P5.6, per Doors screen door action and emergency change, with an `action` key saying which; rotated to `unlock.log.1` above 1 MiB; `src/main/access/unlockLog.ts`)
- `<userData>/go2rtc.yaml`: generated on every launch. Never hand-edited

## 5. Updating
Prototype: build a new installer and run it over the old one. User data in `userData` survives. MVP: electron-updater with a GitHub Releases or local-folder feed, plus signing.
