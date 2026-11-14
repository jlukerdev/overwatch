# Performance Results

Recorded with the P2.5 perf harness (`npm run perf`, `scripts/perf/` + `src/main/perf/`): the real app plays the temporary live grid at one quality for 30 minutes while main samples CPU, GPU, RAM and player buffer lag. These numbers are what the quality defaults (QUAL-1/3, NFR-2) are based on. Requirements: NFR-2 (streams), NFR-3 (hardware decode), NFR-4 (≤ 40 % CPU, no memory growth), NFR-5 (latency), gate G2 (no memory growth over 30 minutes).

## Results

### macOS

| Machine | Quality | Streams | CPU total % (mean / p95) | Renderer % | GPU proc % | go2rtc % | GPU util % (mean / p95) | RAM MB (mean / max) | RAM growth MB/h | Buffer lag s (mean / p95 / max) | Dropped % | Not playing (max cells / samples) | Decoder | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS 27.2.1 (arm64, Apple M5 Pro, 15 cores, 64 GB) | low | 9 | — | — | — | — | — | — | — | — | — | — | — | skipped (user decision, 2026-11-14): `medium` and `high` cost about the same CPU, so `low` sets no limit. Only a 1-min smoke run exists: about 34 % of one core, 0.98 s buffer lag |
| macOS 27.2.1 (arm64, Apple M5 Pro, 15 cores, 64 GB) | medium | 9 | 51.5 / 53.4 | 22.1 / 24.0 | 18.6 / 19.4 | 5.4 / 5.8 | 0 / 0 | 777 / 837 | 347.9 | 0.99 / 1.04 / 1.27 | 0.78 | 1 / 1 | VideoToolboxVideoDecoder (platform; gpu enabled) | 2026-11-14, 30 min |
| macOS 27.2.1 (arm64, Apple M5 Pro, 15 cores, 64 GB) | high | 9 (10 seen) | 51.4 / 55.0 | 20.7 / 22.2 | 18.0 / 19.6 | 5.8 / 6.2 | 3 / 13 | 928 / 998 | 396.0 | 0.99 / 1.04 / 1.09 | 0.86 | 1 / 2 | VideoToolboxVideoDecoder (platform; gpu enabled) | 2026-11-14, 30 min |

**Reading the macOS runs (2026-11-14):**

- **CPU (NFR-4):** about 51 % of one core at both `medium` and `high`, which is about 3.4 % of this 15-core machine. The renderer and the GPU process take about 20 % each, and go2rtc about 6 %. CPU barely changes between `medium` and `high`, because decoding is in hardware (VideoToolbox on every player, NFR-3).
- **Latency proxy (NFR-5):** buffer lag is 0.99 s mean and 1.04 s p95 at both qualities. Dropped frames are under 1 %.
- **RAM (G2) is not settled.** Nearly all of the growth is in the renderer, and it slows down over the run. Renderer RSS every 150 s:

  | Quality | 0 min | 5 min | 10 min | 15 min | 20 min | 25 min | 30 min |
  |---|---|---|---|---|---|---|---|
  | medium | 213 | 262 | 301 | 336 | 356 | 368 | 375 |
  | high | 311 | 381 | 424 | 455 | 485 | 498 | 506 |

  So the linear slope (350–400 MB/h) overstates it. Over the last 7.5 minutes it is still about 70 MB/h at `medium` and about 110 MB/h at `high`. Main, GPU, utility and go2rtc stay flat (±5 MB). 30 minutes is not long enough to tell a plateau from a slow leak.
- **Reconnects:** the camera in cell 7 (index 6) changed its `<video>` 5 times in the `high` run and once in the `medium` run, and cell 8 changed twice at `high`. That is the player retrying (NFR-7). Each time it recovered within one or two samples: "Not playing" peaked at 1 cell, in 1–2 samples. Both cameras are on a weaker Wi-Fi link, so the drops are expected; what matters is that the player recovered each time without help.
- **First frame (`FIRST_FRAME_TIMEOUT_MS` = 10 s, P2.3):** the harness does not time first frames. In these runs the user saw every cell's first frame within 10 s, so 10 s is not too tight. It is kept as is.

### Windows

| Machine | Quality | Streams | CPU total % (mean / p95) | Renderer % | GPU proc % | go2rtc % | GPU util % (mean / p95) | RAM MB (mean / max) | RAM growth MB/h | Buffer lag s (mean / p95 / max) | Dropped % | Not playing (max cells / samples) | Decoder | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Windows 11 (10.0.26200, x64, i7-1185G7 / Iris Xe, 8 cores, 16 GB) | medium | 9 | 56.9 / 64.7 | 23.1 / 26.4 | 25.8 / 29.2 | – | – | 1095 / 1199 | 614.8 | 1.00 / 1.05 / 1.18 | 0.98 | 0 / 0 | D3D11VideoDecoder (platform; gpu enabled) | 2026-11-14, 30 min |
| Windows 11 (10.0.26200, x64, i7-1185G7 / Iris Xe, 8 cores, 16 GB) | high | 9 | 60.3 / 71.6 | 24.9 / 29.6 | 26.5 / 31.2 | – | – | 1616 / 1829 | 785.0 | 1.00 / 1.05 / 1.42 | 0.84 | 1 / 1 | D3D11VideoDecoder (platform; gpu enabled) | 2026-11-14, 30 min |

The harness works on Windows with two gaps:

- **CPU and memory are measured differently.** Electron's processes use `app.getAppMetrics()` CPU × core count and working-set memory, because Windows has no `ps`. So the RAM figures can't be compared directly with the macOS RSS figures.
- **Two columns are not measured.** go2rtc's CPU and memory, and GPU utilisation, show "–". Sampling them on Windows is future work.

**Reading the Windows runs (2026-11-14):**

- **CPU (NFR-4):** about 57 % of one core at `medium` and 60 % at `high`, which is about 7–8 % of this 8-core laptop. The renderer and the GPU process take about 23–26 % each. `high` has short peaks: the total reached 120 % at most, and its p95 was 72 %. That passes NFR-4 easily, on a machine much closer to "mid-range" than the M5 Pro.
- **Decode (NFR-3):** `D3D11VideoDecoder` with the platform decoder on every player.
- **Latency proxy (NFR-5):** 1.00 s mean and 1.05 s p95 at both qualities. Dropped frames were under 1 %. One cell missed one sample at `high`.
- **RAM (G2) is not settled here either, and the GPU process is the concern.** The GPU process averages 578 MB (640 MB max) at `medium` and 1055 MB (1213 MB max) at `high`. The renderer averages 253 MB at `medium` and 294 MB at `high`. Total working set rose at about 615 MB/h at `medium` and 785 MB/h at `high`. On macOS the GPU process stayed flat at about 105–121 MB, so this growth is specific to Windows (most likely D3D11 decode surfaces or textures, not yet confirmed). The summary does not show whether it levels off. The curve is in `samples.jsonl` in each run's output folder on the laptop. On a 16 GB machine, `high` in the grid costs about 0.5 GB more than `medium`. That supports keeping the default grid quality at `low` (QUAL-1).

## Method

### What runs

- The **built** app (`npm run build`), launched by `scripts/perf/run.ts` with `VP_PERF_*` variables. Main enters perf mode only when `VP_PERF_QUALITY` is set **and** the app is not packaged; an installed build ignores the variables.
- It uses your normal profile: the API key from the OS keystore and the console and certificate pin from `config.json`. **Perf mode writes nothing to config.** The grid quality under test is applied to the settings the renderer is *shown* (in memory, `withPerfGridQuality`); the stored config is never changed, so a save during a run cannot persist it.
- Main connects to the console (an explicit, harness-only exception to CON-4, see SPEC §5.4), opens the Live screen and picks the temp-grid preset by clicking the existing buttons, so the renderer has no harness code. Background throttling is turned off for the window and display sleep is blocked for the run.
- **Streams: 9, not 10.** The dev console has 9 cameras, so runs use the 3×3 temp grid with every camera (NFR-2 asks for 10). The count is not hard-coded: the harness picks the smallest temp-grid preset with room for `min(cameras, 10)` and the grid shows the first N cameras in list order (`assignTempGridSlots`), so a console with 10 or 11 cameras gets 4×3 with 10 or 11 streams, and one with 12 or more gets 12. The "Streams" column says how many were expected, and how many `<video>` elements were actually seen if that differs.
- No fill stream. NFR-2's default load is 10 grid streams at `low` **plus one fill stream at `high`**; fill mode is Phase 3, so these runs measure the grid only.
- Each run: a warm-up (default 60 s after the grid opens, not measured), then a sample every 5 s for the duration (default 1800 s). Results go to `scripts/perf/output/<timestamp>-<quality>/` (gitignored): `samples.jsonl` (every sample), `summary.json`, and `summary.md`, whose first table row is the one to paste above.

### Columns

| Column | Meaning and how it is measured |
|---|---|
| Machine | OS version, architecture, CPU model, logical cores, RAM. |
| Streams | Camera cells expected in the grid (see above). |
| CPU total % | **100 = one core** (not machine-normalized). Sum over Electron's processes (from `app.getAppMetrics()` pids) and go2rtc (by pid). Each process's CPU is the delta of its cumulative CPU time from `ps -o time=` between samples, divided by wall time — the P0.5 method, because `getAppMetrics().cpu.percentCPUUsage` is a share of the whole machine. Mean and p95 over the samples. NFR-4's "≤ 40 %" is read against this total for a mid-range machine. |
| Renderer % / GPU proc % / go2rtc % | The same, for the renderer (`Tab`), Chromium's GPU process (on macOS `Electron Helper --type=gpu-process`), and go2rtc. Main and utility processes are in `summary.md`. |
| GPU util % | macOS only: `"Device Utilization %"` from `ioreg -r -d 1 -c IOAccelerator` (`PerformanceStatistics`), the highest accelerator, read at each sample (no sudo). It is an instantaneous reading and, as far as we know, does not include Apple silicon's separate media (decode) engine, so hardware decode itself mostly does not show up here; it reflects compositing. |
| RAM MB | Sum of RSS (`ps -o rss=`) over the same processes. RSS counts shared pages (the Electron framework) once per process, so the total overstates real use; it is comparable between runs, which is what matters here. |
| RAM growth MB/h | Least-squares slope of total RSS over the measured samples, in MB per hour. G2 wants no memory growth over 30 minutes: a slope near zero. Short runs exaggerate it (buffers still filling to the player's 15 s keep window), so only read it on full 30-minute runs. |
| Buffer lag s | **Latency proxy for NFR-5**: `buffered.end − currentTime` of each playing `<video>` (the player steers `playbackRate` towards ~1 s, SPEC §5.3), mean / p95 / max over every video and sample. It is the part of glass-to-glass latency the app controls; it excludes the camera's encode, the console's RTSPS packaging, the network, go2rtc and the display, so real latency is higher. A glass-to-glass method (P0.5's rough read was ~1.5 s ± 1 s) is out of scope for this harness. `playbackRate` is in `summary.md`. |
| Dropped % | `getVideoPlaybackQuality()` dropped / total video frames over the measured window. Counters are per `<video>` element, so each element is tracked by identity and contributes the growth of its own counters; an element created during the window (reconnect, quality swap) counts from zero, and frames from the warm-up do not count. |
| Not playing | Camera cells with no video that is unpaused, has a frame (`readyState ≥ 2`) and decoded new frames since the previous sample: the most in one sample, and how many samples had any. Each element is compared with itself in the previous sample. A sample where the page could not be read (renderer gone, script failure), or where camera cells are missing, counts every missing stream as not playing; failed reads are listed by reason in `summary.md`. Non-zero means stalls, reconnects or a broken page during the run. |
| Decoder | NFR-3, the P0.5 method: CDP `Media.playerPropertiesChanged` via the in-process `webContents.debugger` (no remote port) → `kVideoDecoderName` and `kIsPlatformVideoDecoder` (a string, parsed), plus `app.getGPUFeatureStatus().video_decode`. Expected on macOS: `VideoToolboxVideoDecoder (platform; gpu enabled)`. |
| Run | Date, measured minutes, how it ended if not completed, and the `--label`. |

Nothing recorded contains a URL, the console address, the go2rtc port or credentials, the API key or a camera name (CON-2, NFR-9). The launcher only shows the app's `[perf]` log lines unless `--verbose` is given, because the app's normal log names the console address and the go2rtc port.

## Procedure (macOS)

1. Make sure the app works normally: the console address, API key and certificate pin are set (Settings), and the cameras play in the Live screen. Quit View Protect — it allows one instance, so the harness cannot start while it is open.
2. Plug the Mac in, close other heavy apps, and keep the harness window visible and unobstructed for the whole run (an occluded window can be painted less).
3. Build once:

   ```sh
   npm run build
   ```

4. Run the three qualities, one after the other (each takes about 31 minutes):

   ```sh
   npm run perf -- --quality low
   npm run perf -- --quality medium
   npm run perf -- --quality high
   ```

   Options: `--duration <s>` (default 1800), `--warmup <s>` (60), `--interval <s>` (5), `--label <text>` (shown in the Run column), `--verbose` (show the app's full log). Ctrl+C, closing the window, quitting the app or a crashed renderer ends a run early; it still writes what it has, the Run column says how it ended, and `npm run perf` exits 1 (it exits 0 only for a completed run).
5. Each run prints its `summary.md`. Paste its table row into the macOS table above, replacing the placeholder row for that quality, and commit the doc. Keep `summary.json` if anything needs a second look.

A quick check that everything works: `npm run perf -- --quality low --duration 60 --warmup 15`.
