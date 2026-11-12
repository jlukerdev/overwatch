# vendor

Vendored go2rtc browser player, pinned to the bundled go2rtc version (`scripts/go2rtc.manifest.json`).

| File | Source | SHA-256 |
|---|---|---|
| `video-rtc.js` (VideoRTC v1.6.0) | `https://raw.githubusercontent.com/AlexxIT/go2rtc/v1.9.15/www/video-rtc.js` | `d48ce627baf7c341a92c0f5844a3c546431f9db873ff21489671aba2ecfe64fb` |
| `LICENSE` | `https://raw.githubusercontent.com/AlexxIT/go2rtc/v1.9.15/LICENSE` | `b0dcf4855af5a72b4dfbd9117c207b330f4cc35658576a0b5351d6e2becac546` |

- **Version:** go2rtc tag `v1.9.15`. Fetched 2026-11-12 for P0.5 (`docs/spikes/P0.5-video.md`).
- **License:** MIT, Copyright (c) 2022 Alexey Khit. The full text is in `LICENSE` next to this file and must ship with the app.
- **Unmodified.** Don't edit `video-rtc.js`: subclass `VideoRTC` instead (the go2rtc way, see upstream `www/video-stream.js`, not vendored because it isn't needed). This folder is excluded from ESLint and Prettier.
- **Updating:** when go2rtc is bumped in the manifest, re-download both files from the new tag, check the hashes with `shasum -a 256` and update this table.
