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
│   ├─ access/    Access API client (doors, unlock)              │
│   ├─ streams/   go2rtc lifecycle + stream registry             │
│   ├─ config/    JSON store (zod, migrations)                   │
│   ├─ secrets/   safeStorage wrapper                            │
│   ├─ tls/       TOFU cert pinning (undici Agent)               │
│   ├─ connection.ts  inventory, device feed, status (CON-5)     │
│   └─ ipc/       typed handlers (contract in src/shared)        │
│            ▲  contextBridge (typed, validated)                 │
│  PRELOAD ──┘                                                   │
│            ▼                                                   │
│  RENDERER (React, sandboxed)                                   │
│   ├─ views/ grid, cell, fill mode, zoom                        │
│   ├─ player/ MSE player ──ws://127.0.0.1:<port>/api/ws──┐      │
│   └─ settings/ connection, door links, view editor      │      │
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
4. **Events:** main holds the Protect `/subscribe/events` and `/subscribe/devices` sockets. It sends trimmed, typed events (`motion`, `smartDetect`, `cameraState`) to the renderer over IPC.
   - The inventory is **not** rebuilt from the device feed. `GET /v1/cameras` stays the authority and is re-read after every connect, reconnect and add/remove, because the feed sends no initial state and its message shapes are unverified (SPEC R11). The feed is used for the one thing it states plainly: a camera's `state`.
   - Every IPC call answers `{ ok, value | error }` rather than throwing, and every mutating call answers with the whole app state. SPEC §6.1 says why.
5. **The cell logic is pure.** The rotation/motion scheduler is a pure reducer in `src/renderer/src/features/cells/cellScheduler.ts`, so it can be unit-tested.

## 3. Streaming details
- Every player asks for its quality from `resolveQuality()` in `src/shared/quality.ts` (cell → view → settings; fill → view → settings). Nothing in the app hard-codes a quality. When the effective quality changes, or on entering fill mode, a second player attaches to the new stream, and the old one stays visible until the new one fires its first `playing` event.
- Many cells showing the same camera share one go2rtc upstream, so that costs nothing extra.
- Multi-camera cells keep **only the visible camera's player attached**. Optional (Phase 4 tuning): pre-warm the next camera in a rotation 1–2 s before it switches, so it doesn't open on a black frame.
- Protect RTSPS uses a self-signed cert. Main builds go2rtc sources with go2rtc's no-verify RTSPS scheme, **only for the pinned console host**. (Phase 0 confirms the exact scheme and URL rewriting, e.g. removing `?enableSrtp`.)

## 4. Persistence
- `<userData>/config.json`: views, door links, UI prefs (schema in SPEC §6)
- `<userData>/secrets.bin`: safeStorage-encrypted `{ protectApiKey, accessToken }`
- `<userData>/logs/`: app log (rotating) and `unlock.log`
- `<userData>/go2rtc.yaml`: generated on every launch. Never hand-edited

## 5. Updating
Prototype: build a new installer and run it over the old one. User data in `userData` survives. MVP: electron-updater with a GitHub Releases or local-folder feed, plus signing.
