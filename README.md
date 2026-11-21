# OverWatch

A desktop app for macOS and Windows that shows your UniFi Protect cameras live, in grid layouts you design. It can also unlock UniFi Access doors. Without a UniFi console, it can show any camera that has an RTSP address instead.

OverWatch talks straight to your UniFi console over your local network, using Ubiquiti's official Protect Integration API, or straight to your RTSP cameras. It has no cloud service, no account and no telemetry.

> OverWatch is a personal project, not a Ubiquiti product

<img src="docs/guide-img/live.png" width="1200" alt="The Live screen showing a View of six cameras, with the front door camera largest">

## Features

- **Views:** named camera grids you lay out yourself. A camera can span several cells, and the grid scales to fill the window.
- **Live video** from every camera in a View at once, with stream quality chosen per cell.
- **Fill and zoom:** click a camera to fill the window, and use digital zoom to look closer.
- **Rotating cells:** a cell can cycle through several cameras on a timer, switch to a camera when it sees motion, or both.
- **Audio:** listen to one camera at a time.
- **Doors (optional):** with UniFi Access, unlock the door linked to a camera from its cell. The Doors screen shows every door's lock state and lock rules, and lockdown and evacuation.
- **Focus mode** hides everything but the video.
- **RTSP streams:** no UniFi console? Add any camera by its RTSP address and use the same Views, fill, zoom and audio.

<table>
  <tr>
    <td><img width="600" src="docs/guide-img/editor.png" alt="The View editor: the grid in the middle, display and quality options and the camera list on the right."></td>
    <td><img width="600" src="docs/guide-img/fill.png" alt="The front door camera filling the window, with zoom, grid, mute, volume and quality controls at the top right."></td>
  </tr>
  <tr>
    <td align="center"><b>View editor:</b> lay out the grid and pick cameras</td>
    <td align="center"><b>Fill and zoom:</b> one camera fills the window</td>
  </tr>
  <tr>
    <td><img width="600" src="docs/guide-img/doors.png" alt="The Doors screen: a card per door with its lock state, actions and linked cameras."></td>
    <td><img width="600" src="docs/guide-img/focus.png" alt="Focus mode: four cameras fill the whole window with no header or View list."></td>
  </tr>
  <tr>
    <td align="center"><b>Doors:</b> lock state, rules, lockdown and evacuation</td>
    <td align="center"><b>Focus mode:</b> nothing but the video</td>
  </tr>
</table>

## Requirements

- A 64-bit computer running one of:
  - **macOS 12 (Monterey) or later**, on Apple silicon or Intel
  - **Windows 10 or 11**, on x64 or ARM64
- For UniFi cameras:
  - A UniFi console running **UniFi Protect** on the same network or reached over a VPN. The Protect Integration API it is built against is **v7.3.74**.
  - A Protect **Integration API key**, created in Protect under *Integrations*
- Or, for any other camera: its **RTSP address** (`rtsp://` or `rtsps://`), reachable from this computer. No UniFi console is needed.
- For doors: **UniFi Access** and an Access API token. The Access API it is built against is **v4.2.16**. Access 1.9.1 or later is required, and some features need newer: lock rules and emergency status need 1.24.6, and door-state push needs 1.20.11.

Installers are built for Apple silicon Macs, Intel Macs and Windows x64 (see below). Windows on ARM needs its own build.

## Building from source

> **Required for development.** To run OverWatch from source, run the first two commands below once (`npm install`, then `npm run fetch:go2rtc`) before `npm run dev`. The app won't start without the dependencies and the bundled go2rtc binary. Run every command from the repository root.

You need Node 24 or later.

```bash
npm install
npm run fetch:go2rtc   # download go2rtc for this machine
npm run dev            # run the app
npm run dist           # build the installers into dist/ (see docs/DEVELOPMENT.md)
```

To work on the code, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The design docs are [docs/SPEC.md](docs/SPEC.md) (requirements), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (architecture) and [docs/FEATURES.md](docs/FEATURES.md) (features by version). Inside the code the project is called *View Protect*.

## Install

Download the installer for your computer from the [latest release](https://github.com/jlukerdev/overwatch/releases/latest):

| Computer | Installer |
|---|---|
| Mac with Apple silicon (M1 or later) | `OverWatch-<version>-arm64.dmg` |
| Mac with an Intel processor | `OverWatch-<version>-x64.dmg` |
| Windows x64 | `OverWatch-<version>-x64.exe` |

Not sure which Mac you have? Choose *Apple menu → About This Mac*: it lists a **Chip** (Apple silicon) or a **Processor** (Intel).

- **macOS:** open the `.dmg` and drag OverWatch into Applications.
- **Windows:** run the `.exe` and follow the steps. It asks whether to install for you only or for everyone on the computer (that needs an administrator), and lets you choose the folder. Either way your Views and settings are kept per user.

The builds aren't code-signed yet, so the first launch needs one extra step:

- **macOS:** open OverWatch from Applications. macOS says it can't verify the app; choose **Done** (not *Move to Trash*). Then go to *System Settings → Privacy & Security*, scroll down to the message about OverWatch, choose **Open Anyway** and confirm with your password. You only do this once per version.
- **Windows:** when *Windows protected your PC* appears, choose **More info**, then **Run anyway**. Some antivirus software also asks once.

After installing a new version on a Mac, macOS may ask once whether OverWatch can use its keychain item ("OverWatch Safe Storage"). Choose **Always Allow**: that is where your API key and stream addresses are kept.

Installing a newer version over an older one keeps your Views and settings.

## First run

OverWatch opens on Settings:

1. Enter your console's address and your Protect API key.
2. Accept the console's certificate. OverWatch shows its fingerprint and remembers it, and warns you if it ever changes.
3. Press **Connect**, then create your first View.

No UniFi console? Choose **RTSP streams** at the top of Settings instead, and see below.

The [user guide](https://jlukerdev.github.io/overwatch/guide.html) walks through every screen. For an overview, see the [brochure](https://jlukerdev.github.io/overwatch/brochure.html).

## Using RTSP cameras

RTSP streams mode is for cameras that aren't on UniFi Protect: any camera, recorder or other device that gives you an RTSP or RTSPS address. It needs no UniFi console.

1. Open Settings (the gear at the top right). Under **Mode**, choose **RTSP streams**, then **Switch to RTSP streams**. Your UniFi settings, Views and door links are kept for when you switch back.
2. Press **Open Streams**, or choose **Streams** in the header.
3. Press **Add stream**. Give the camera a name under **Camera name**, then enter its address in **High quality**, **Medium quality** or **Low quality**. One address is enough. If the camera has more than one stream (a main stream and a smaller sub-stream), enter each one so big grids can use the smaller stream.
4. Press **Add stream** to save it. Then go to **Live** and press **Create a View**.

Addresses usually look like `rtsp://user:password@camera-address:554/stream`; your camera's manual or app lists its own. They are stored encrypted, like your API key, and never shown again once saved. To change one, choose **Edit** on the stream, then **Replace** or **Clear**. If a cell asks for a quality the stream has no address for, OverWatch plays the nearest one it has.

In RTSP streams mode:

- There are no Cameras or Doors screens. UniFi Access, door unlocks, motion events and camera snapshots need UniFi Protect mode.
- Video from an `rtsps://` address is encrypted, but the camera's certificate is not checked. Use cameras on a network you trust; plain `rtsp://` is not encrypted at all.
- To go back, choose **UniFi Protect** under **Mode** in Settings. Each mode keeps its own Views.

## Privacy and security

- Your API key, token and RTSP stream addresses are encrypted with the operating system's keystore (Keychain on macOS, DPAPI on Windows). They are never stored in plain text and never shown again once saved.
- OverWatch connects only to your console, or in RTSP streams mode only to the stream addresses you entered. Video is relayed by a bundled [go2rtc](https://github.com/AlexxIT/go2rtc) that listens on this computer only.
- Every door unlock needs you to press a button, and each attempt is written to a local log.

## Log files

If something goes wrong, choose **Help → Show Log Files** to open the folder with OverWatch's logs. It is in `~/Library/Application Support/View Protect/logs` on macOS and `%APPDATA%\View Protect\logs` on Windows.

- `app.log` records what the app did and any errors. It keeps itself small: older entries move to `app.log.1`, `.2` and `.3`, and the oldest are deleted.
- Your API key, token, passwords and camera stream addresses are left out of it, so you can send it to someone helping you.
- `unlock.log` is the record of every door action: each unlock, lock and emergency change, and whether it worked.
