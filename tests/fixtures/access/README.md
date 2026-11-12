# access

Sanitized UniFi Access developer API responses from the P0.4 spike (`npm run spike:access`,
`scripts/spikes/access-spike.ts`). Findings, sources and the on-site procedure are in
`docs/spikes/P0.4-access-mock.md`.

> ⚠️ **These are mock-derived.** The development network has no Access, so every file here was
> captured from the local mock (`npm run mock:access`), whose shapes are COMMUNITY-SOURCED and
> UNVERIFIED. Each file says where it came from in a top-level `"_source"`: `"mock"` (the response
> carried the mock-only `x-view-protect-mock: 1` header) or `"console"` (captured on-site, OS-1). After OS-1, replace them with the
> `"console"` captures.

The spike regenerates these files on every run (`unlock.json` only on runs with `--unlock`).
Re-run it rather than hand-editing them.

## Files

Every file is `{ _source, request, status, response }`: `request` describes the call (method,
templated path, fake ids), `status` is the HTTP status and `response` the sanitized body.

| File | Source | Shape of `response` |
|---|---|---|
| `doors.json` | `GET /doors` | `{ code: "SUCCESS", msg, data: [door] }` |
| `unlock.json` | `PUT /doors/{id}/unlock` (only with `--unlock`, after typed confirmation) | `{ code: "SUCCESS", msg, data: "success" }`. Also `relayAfterUnlock`: each relay change seen while re-reading the door (`tMs`, `relay`, `position`) |
| `error-unauthorized.json` | `GET /doors` with a made-up token | Error envelope `{ code, msg }` (mock: HTTP 401 `CODE_ACCESS_TOKEN_INVALID`) |
| `error-not-exists.json` | `GET /doors/{id}` with a made-up id | Error envelope (mock: HTTP 404 `CODE_NOT_EXISTS`) |

`tests/unit/accessTypes.test.ts` checks every file against the zod schemas in
`src/main/access/types.ts`.

## Sanitization

Written through `scripts/spikes/lib/sanitize.ts` with the token and (on-site) the console host as
literal secrets. Door ids become `door-NNN`, floor ids `floor-NNN`, other UUIDs `uuid-NNN`; IPs,
MACs and emails are redacted. Door names and `full_name` are kept: on-site, check them before
committing and rename any that are sensitive. Run `npm run spike:scan -- tests/fixtures/access`
as a leak check.
