# OverWatch

A desktop app for macOS and Windows that shows your UniFi Protect cameras live, in grid layouts you design. It can also unlock UniFi Access doors.

OverWatch talks straight to your UniFi console over your local network, using Ubiquiti's official Protect Integration API. It has no cloud service, no account and no telemetry.

> OverWatch is a personal project, not a Ubiquiti product. It is for live viewing: for recordings, the timeline and exports, use the Protect app.

## Features

- **Views:** named camera grids you lay out yourself. A camera can span several cells, and the grid scales to fill the window.
- **Live video** from every camera in a View at once, with stream quality chosen per cell.
- **Fill and zoom:** click a camera to fill the window, and use digital zoom to look closer.
- **Rotating cells:** a cell can cycle through several cameras on a timer, switch to a camera when it sees motion, or both.
- **Audio:** listen to one camera at a time.
- **Doors (optional):** with UniFi Access, unlock the door linked to a camera from its cell. The Doors screen shows every door's lock state and lock rules, and lockdown and evacuation.
- **Focus mode** hides everything but the video.

## Requirements

- macOS on Apple silicon, or Windows 10/11 (x64)
- A UniFi console running **UniFi Protect** (built against Protect 7.3), on the same network or reached over a VPN
- A Protect **Integration API key**, created in Protect under *Integrations*
- For doors: **UniFi Access** and an Access API token

## Install

Download the installer for your platform from the releases: `OverWatch-<version>-arm64.dmg` for macOS, `OverWatch-<version>-x64.exe` for Windows.

The builds aren't code-signed yet, so the first launch needs one extra step:

- **macOS:** open the app once, then go to *System Settings → Privacy & Security* and choose **Open Anyway**.
- **Windows:** when SmartScreen appears, choose **More info → Run anyway**.

Installing a newer version over an older one keeps your Views and settings.

## First run

OverWatch opens on Settings:

1. Enter your console's address and your Protect API key.
2. Accept the console's certificate. OverWatch shows its fingerprint and remembers it, and warns you if it ever changes.
3. Press **Connect**, then create your first View.

A full getting-started guide is coming.

## Privacy and security

- Your API key and token are encrypted with the operating system's keystore (Keychain on macOS, DPAPI on Windows). They are never stored in plain text and never shown again once saved.
- OverWatch connects only to your console. Video is relayed by a bundled [go2rtc](https://github.com/AlexxIT/go2rtc) that listens on this computer only.
- Every door unlock needs you to press a button, and each attempt is written to a local log.

## Building from source

You need Node 24 or later.

```bash
npm install
npm run fetch:go2rtc   # download go2rtc for this machine
npm run dev            # run the app
npm run dist           # build the installers into dist/
```

To work on the code, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The design docs are [docs/SPEC.md](docs/SPEC.md) (requirements), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (architecture) and [docs/DEV_PLAN.md](docs/DEV_PLAN.md) (plan). Inside the code the project is called *View Protect*.
