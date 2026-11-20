# access

Sanitized UniFi Access developer API responses and notification frames. Findings, the mock's
contract and the on-site procedure are in `docs/spikes/P0.4-access-mock.md`.

> ⚠️ **Partly captured from hardware.** The shapes follow Ubiquiti's official reference,
> `docs/reference/access-endpoints-v4.2.16.md`. The files the spike writes (`doors.json`,
> `error-unauthorized.json`, `error-not-exists.json`, `lock-rule.json`, `emergency.json`) were
> captured from a real console (OS-1); the others were not. Each file says where it came from in
> a top-level `"_source"`:
>
> - `"mock"`: captured from the local mock (`npm run mock:access`; the response carried the
>   mock-only `x-view-protect-mock: 1` header). Where the reference is silent, the content is the
>   mock's own choice (e.g. what `lock-rule.json` shows for a door with no rule).
> - `"reference"`: transcribed by hand from the official document's WebSocket samples, with every
>   id replaced by a fake one.
> - `"console"`: captured on-site (OS-1). After OS-1, replace the files with these captures.

## Files

REST files are `{ _source, request, status, response }`: `request` describes the call (method,
templated path, fake ids, body if any), `status` is the HTTP status and `response` the sanitized
body. WebSocket files are `{ _source, frame }` (some with a `_note`).

| File | Source | Written by | Shape |
|---|---|---|---|
| `doors.json` | `GET /doors` | spike | `{ code: "SUCCESS", msg, data: [door] }`. A console sends `door_position_status: "none"` for a door with no sensor, and an undocumented `extras` object |
| `unlock.json` | `PUT /doors/{id}/unlock` (only with `--unlock`, after typed confirmation) | spike | `{ code: "SUCCESS", msg, data: "success" }`. Also `relayAfterUnlock`: each relay change seen while re-reading the door (`tMs`, `relay`, `position`) |
| `error-unauthorized.json` | `GET /doors` with a made-up token | spike | Error envelope `{ code, msg }` (console: HTTP 401 `CODE_UNAUTHORIZED`) |
| `error-not-exists.json` | `GET /doors/{id}` with a made-up id | spike | Error envelope (console: HTTP **200** `CODE_NOT_EXISTS`) |
| `lock-rule.json` | `GET /doors/{id}/lock_rule`, door with **no rule** | spike | `data: { type, ended_time }`. `{ type: "", ended_time: 0 }`: undocumented, seen on a console |
| `emergency.json` | `GET /doors/settings/emergency` | spike | `data: { lockdown, evacuation }` |
| `lock-rule-custom.json` | `GET …/lock_rule` after a `custom` rule | by hand, from the mock | `data: { type: "custom", ended_time }` (Unix seconds) |
| `lock-rule-keep-unlock.json` | `GET …/lock_rule` after `keep_unlock` | by hand, from the mock | `data: { type: "keep_unlock", ended_time }` (far future) |
| `lock-rule-set.json` | `PUT /doors/{id}/lock_rule` with `{ type: "custom", interval: 60 }` | by hand, from the mock | `data: "success"` |
| `emergency-evacuation.json` | `GET /doors/settings/emergency` during an evacuation | by hand, from the mock | `data: { lockdown: false, evacuation: true }` |
| `emergency-set.json` | `PUT /doors/settings/emergency` | by hand, from the mock | `data: "success"` |
| `ws-remote-unlock.json` | Notification `access.data.device.remote_unlock` | by hand, from the reference's sample | `frame.data.unique_id` is the door id |
| `ws-doorbell.json` | Notification `access.remote_view` | by hand: the reference's field names, **placeholder values** | see its `_note` |
| `ws-doorbell-change.json` | Notification `access.remote_view.change` | by hand, from the reference | `frame.data: { reason_code, remote_call_request_id }` |

The spike (`npm run spike:access`, `scripts/spikes/access-spike.ts`) regenerates the files marked
"spike" on every run (`unlock.json` only on runs with `--unlock`): re-run it rather than
hand-editing those. A run against the mock never overwrites a file whose `_source` is `"console"`
(it prints that it skipped it); a run against a console may overwrite anything. It never sends the lock-rule or emergency `PUT`s, so the files marked "by
hand" were captured from the mock with `curl` and are **not** replaced by an on-site run; the
spike also records WebSocket frames as event and field names only (in its summary), never as a
fixture.

`tests/unit/accessTypes.test.ts` checks every file against the zod schemas in
`src/main/access/types.ts`, and fails if a JSON file is added here without a check.

## Sanitization

Spike-written files go through `scripts/spikes/lib/sanitize.ts` with the token and (on-site) the
console host as literal secrets. Door ids become `door-NNN`, floor ids `floor-NNN`, other UUIDs
`uuid-NNN`; IPs, MACs and emails are redacted, also inside paths such as a door thumbnail's
`reader_<mac>_<uuid>_<ts>.jpg`. Hand-written files follow the same conventions
(`door-001`, `uuid-001`, `hub-001`, `mac-001`, `<redacted-token>`): no IPs, no MACs or MAC-like
12-hex device ids, no tokens. Door names and `full_name` are kept: on-site, check them before
committing and rename any that are sensitive. Run `npm run spike:scan -- tests/fixtures/access`
as a leak check (the folder must be named: without an argument the scan only covers
`tests/fixtures/protect`).
