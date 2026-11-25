I'm sharing info for a personal open-source project for anyone that may be interested or find this useful.

Brochure: https://jlukerdev.github.io/overwatch/brochure.html

GitHub: https://github.com/jlukerdev/overwatch  
User guide: https://jlukerdev.github.io/overwatch/guide.html

OverWatch is an open-source desktop app for macOS and Windows that shows your UniFi Protect cameras live, in grid layouts you design yourself. It can also unlock UniFi Access doors.

- Views: named camera grids you lay out yourself, with cameras that span several cells.
- Live video from every camera in a View at once, with stream quality set per cell.
- Fill and zoom: click a camera to fill the window, then zoom in digitally.
- Rotating cells: cycle through several cameras on a timer, jump to a camera on motion, or both.
- Doors (optional): with UniFi Access, unlock a door from its camera's cell, and see lock state, lock rules, lockdown and evacuation. Unlocking always takes a deliberate click.
- Focus mode hides everything but the video, and you can listen to one camera's audio at a time.
- RTSP cameras: no UniFi console? Add any camera by its RTSP address.

It talks straight to your console over your local network using Ubiquiti's official Protect Integration API. There is no cloud service, no account and no telemetry.

OverWatch is a personal project. It has only been tested on current (as of Nov 2026) versions of UniFi Protect and UniFi Access. It was 100% developed using Claude Code (Opus 5.5 and Fable) using a defined spec, architecture and phased development plan.
