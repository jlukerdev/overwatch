# icons

OverWatch app icons (P6.1): a minimal watchtower with a lit accent-blue window and a searchlight
beam, on a dark rounded square in the app's colour tokens.

| File        | What it is                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon.svg`  | The hand-written source (viewBox 0 0 1024 1024). Edit this one only.                                                                                |
| `icon.png`  | 1024 × 1024 RGBA render: electron-builder's icon source and the window icon.                                                                         |
| `icon.icns` | macOS icon: 16, 32, 128, 256 and 512 pt at @1x and @2x (16 to 1024 px), built with `iconutil`.                                                      |
| `icon.ico`  | Windows icon: 16, 24, 32, 48, 64, 128 and 256 px, each stored as a PNG entry.                                                                       |

The tile is 824 × 824 centred on the 1024 canvas (the macOS icon safe area), so the corners and the
100 px margin are transparent and the icon matches other apps' size in the Dock.

## Regenerating

After editing `icon.svg`, run from the repo root (macOS, after `npm install`):

```sh
node scripts/gen-icons.ts
```

It starts Electron hidden, draws the SVG onto a canvas at each exact pixel size (small sizes are
rasterised from the vector, not scaled down from 1024), then writes `icon.png`, `icon.ico` (the ICO
container is assembled by the script) and `icon.icns` (via a temporary `.iconset` and `iconutil`).
The output is deterministic. On Windows or Linux it writes `icon.png` and `icon.ico` and keeps the
committed `icon.icns`, because `iconutil` is macOS only.

Keep the SVG valid XML: a `--` inside a comment stops it decoding, and the script then fails.
