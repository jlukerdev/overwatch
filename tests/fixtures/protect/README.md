# protect

Sanitized UniFi Protect Integration API captures from the P0.3 spike (`npm run spike:protect`,
`scripts/spikes/protect-spike.ts`) against the real console running Protect 7.3.74. Findings are in
`docs/spikes/P0.3-protect-api.md`. The contract is `docs/reference/protect-openapi-v7.3.74.json`.

The spike regenerates these files on every run. Re-run it rather than hand-editing them (except
to trim).

## Files

| File | Source | Shape |
|---|---|---|
| `meta-info.json` | `GET /v1/meta/info` | Response body: `{ applicationVersion }` |
| `cameras.json` | `GET /v1/cameras` | Response body: array of all cameras. Note: real cameras without a display omit `lcdMessage`, which the contract marks required |
| `rtsps-stream.get.json` | `GET /v1/cameras/{id}/rtsps-stream` | Response body after the POST: `{ high, medium, low, package }`, each a placeholder URL or `null` |
| `rtsps-stream.post.json` | `POST /v1/cameras/{id}/rtsps-stream` | `{ request, response }`: the request body (`{ qualities }`, only the qualities GET showed as `null`) and the response (one URL per requested quality) |
| `snapshot.meta.json` | `GET /v1/cameras/{id}/snapshot` | Array of `{ request, camera, status, contentType, bytes, body? }` per call. No image data is stored. `body` is the JSON error body when the call failed |
| `devices-ws.sample.json` | WS `/v1/subscribe/devices` | **Not captured yet.** The devices socket sent no messages in 9 minutes of listening (it has no initial snapshot and only reports changes). The spike writes an array of raw messages (one per distinct `type`/`modelKey`/key set) once a device changes during a run |
| `events-ws.motion.json` | WS `/v1/subscribe/events` | `{ motion, smartDetect, ring }`. `motion` is `{ add, updates }`: the `add` message (no `end`, or `end: null`) and every `update` for that event up to and including the one that sets `end`. **`motion` is currently `null`**: no plain `motion` event was seen in 9 minutes, only `smartDetectZone`. `smartDetect` / `ring` are raw message sequences (an `add` followed by its `update`s; the console repeats the final update several times) |

## Sanitization rules

All files are written through `scripts/spikes/lib/sanitize.ts` (unit tested in
`tests/unit/sanitize.test.ts`), one sanitizer instance per run so fake ids are consistent across
every file of that run.

- **Ids** are mapped to stable fakes in first-seen order. Objects with `id` + `modelKey` get a
  prefix by kind (`camera` → `cam-001`, `event` → `evt-001`, `nvr` → `nvr-001`, other model keys
  use the model key). Any other 24-hex Protect id becomes `id-NNN`, a UUID `uuid-NNN`. A camera id
  used as an event's `device` maps to the same `cam-NNN`.
- **By key name** (camelCase/snake_case words): `mac`, `host`/`hostname`, `ip`, `url`/`uri`, `guid`,
  `token`, `email`, `owner`, `user`/`userId`, `password`, `secret`, `serial`, and anything
  containing `apikey`. MACs map to `mac-NNN`, GUIDs to `guid-NNN`, users/owners to `user-NNN`;
  everything else becomes `<redacted-<key>>`. `null` and booleans are kept.
- **By value pattern**, in any string: RTSPS/RTSP URLs → `rtsps://console.invalid:<port>/<redacted-<key>>?<query>`
  (scheme, port and query are kept, host and token are not), IPv4 → `<redacted-ip>`, MACs (bare
  12-hex or colon/dash separated) → `mac-NNN`, emails → `<redacted-email>`, 24-hex ids and UUIDs
  → mapped ids as above.
- **Literal secrets**: the API key and console host from `.env.local` are replaced wherever they
  appear (values and keys).
- Camera names, model types, versions and timestamps are kept.
- After each run, the fixtures are scanned for the console host, MAC patterns, RTSPS URLs with
  a real host, and the API key. The scan must find nothing.
