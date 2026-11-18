# UniFi Access API Documentation (doors, lock state and notifications)

> Extract of Ubiquiti's official **UniFi Access API Documentation**, the PDF downloaded from the console (Access > Settings > General > Advanced > API Token > Download API documentation). The full document is vendored next to this file as [`access-api-reference-v4.2.16.pdf`](access-api-reference-v4.2.16.pdf); its newest change-log entry is v4.2.16. Section numbers (§) below are the PDF's.
>
> This file covers only what View Protect uses: listing doors, reading and controlling their lock state, and push notifications. Users, visitors, policies, credentials, door groups, devices, system logs and Identity are in the PDF and not used by the app.
>
> **Documented, not yet run against hardware.** The development network has no Access. Everything here is what the document says; on-site check OS-1 is what confirms the console behaves this way. Where the document contradicts itself, this file says so.

## Basics (§1, §2)

- **Host:** `https://<console>:12445`, HTTPS only. "The server certificate is self-generated and untrusted" (§2.6).
- **Base path:** `/api/v1/developer`.
- **Auth:** `Authorization: Bearer <token>` on every request, the WebSocket upgrade included (§2.7, §11.1). Tokens are created in Access > Settings > General > Advanced > API Token, with a name, a validity period and permission scopes; the token is shown once.
- **Requirements:** Access 1.9.1 or later. "The API is not available after upgrading to Identity Enterprise" (`CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED`).
- **Rate limiting:** 429 exists; no limit and no `Retry-After` is documented.

### Permission scopes used

| Scope | Needed for |
|---|---|
| `view:space` | `GET /doors`, `GET /doors/:id`, `GET /doors/:id/lock_rule`, `GET /doors/settings/emergency` |
| `edit:space` | `PUT /doors/:id/unlock`, `PUT /doors/:id/lock_rule`, `PUT /doors/settings/emergency` |
| `view:device` | The notifications WebSocket |
| `view:webhook` / `edit:webhook` | Webhook endpoints (not used by the app) |

### Response envelope (§2.8)

```json
{ "code": "SUCCESS", "msg": "success", "data": {} }
```

`code` is `SUCCESS` or an error code; `msg` describes the error; `data` is the payload.

### HTTP status codes (§2.2)

| Status | Meaning |
|---|---|
| 200 | Everything worked as expected |
| 400 | Bad request, often a missing required parameter |
| 401 | The request lacks a valid API token |
| 402 | Request failed: the parameters were valid but the request failed for some reason |
| 403 | The API token does not have the necessary permissions |
| 429 | Too many requests in a short amount of time |
| 500, 502, 503, 504 | Something went wrong on UniFi Access's end |

The document does **not** say which HTTP status goes with which error code.

### Error codes relevant to doors (§2.4)

| Code | Message |
|---|---|
| `CODE_PARAMS_INVALID` | The provided parameters are invalid |
| `CODE_SYSTEM_ERROR` | An error occurred on the server's end |
| `CODE_RESOURCE_NOT_FOUND` | The requested resource was not found |
| `CODE_OPERATION_FORBIDDEN` | The requested operation is not allowed |
| `CODE_AUTH_FAILED` | Authentication failed |
| `CODE_ACCESS_TOKEN_INVALID` | The provided access token is invalid |
| `CODE_UNAUTHORIZED` | You are not allowed to perform this action |
| `CODE_NOT_EXISTS` | The requested item does not exist |
| `CODE_SPACE_DEVICE_BOUND_LOCATION_NOT_FOUND` | The device's location was not found |
| `CODE_DEVICE_DEVICE_VERSION_NOT_FOUND` | The firmware version is up to date |
| `CODE_DEVICE_DEVICE_VERSION_TOO_OLD` | The firmware version is too old. Please update to the latest version |
| `CODE_DEVICE_DEVICE_BUSY` | The camera is currently in use |
| `CODE_DEVICE_DEVICE_NOT_FOUND` | The device was not found |
| `CODE_DEVICE_DEVICE_OFFLINE` | The device is currently offline |
| `CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED` | The API is not available after upgrading to Identity Enterprise |
| `CODE_DEVICE_API_NOT_SUPPORTED` | The API is currently not available for this device |

The full list (users, policies, credentials, holidays, webhooks) is in the PDF §2.4.

## Doors

### The door object (§7.7, §7.8)

| Field | Type | Description |
|---|---|---|
| `id` | String | Identity ID of the door |
| `name` | String | Name of the door |
| `full_name` | String | Full name, e.g. `UNVR - 1F - Main Door` |
| `floor_id` | String | Identity ID of the floor |
| `type` | String | Type of the door (`door` in every sample) |
| `is_bind_hub` | String in the table, **boolean in every sample** | Whether the door is bound to a hub device. "It can only be used for remote opening if it's bound" |
| `door_lock_relay_status` | String | `enum {lock, unlock}` |
| `door_position_status` | String | DPS: `open` or `close`. "A null value means that no device is connected"; the §7.7 sample sends `""` |

### `GET /doors` — Fetch All Doors (§7.8)

Scope `view:space`. No parameters, no pagination. `data` is an array of door objects.

```json
{
  "code": "SUCCESS",
  "data": [
    {
      "door_lock_relay_status": "unlock",
      "door_position_status": "open",
      "floor_id": "23c5db06-b59b-494d-94f1-23e88fbe4909",
      "full_name": "UNVR - 2F - A2 Door",
      "id": "0ed545f8-2fcd-4839-9021-b39e707f6aa9",
      "is_bind_hub": true,
      "name": "A2 Door",
      "type": "door"
    }
  ],
  "msg": "success"
}
```

### `GET /doors/:id` — Fetch Door (§7.7)

Scope `view:space`. `data` is one door object.

### `PUT /doors/:id/unlock` — Remote Door Unlocking (§7.9)

Scope `edit:space`. (Some "Related API" columns in the PDF call this `/doors/:id/remote_unlock`; the endpoint definition and its sample are `/unlock`.)

Query parameters, all optional:

| Parameter | Description |
|---|---|
| `reader_id` | Displays the greeting message only on the device with this ID |
| `entry_method` | Double-driveway mode: `in` or `out` (v4.2.16) |
| `control_cmd` | UA Hub Gate three-button mode: `open`, `close`, `stop` (v4.2.16) |

Body, optional (v3.3.21):

| Field | Type | Description |
|---|---|---|
| `actor_id` | String | Custom actor ID shown in system logs and webhooks. Required if `actor_name` is given |
| `actor_name` | String | Custom actor name. Required if `actor_id` is given |
| `extra` | Object (map) | Passthrough data, echoed as-is in webhook notifications |

With neither `actor_id` nor `actor_name`, the system uses the API token's name as the actor.

```json
{ "code": "SUCCESS", "data": "success", "msg": "success" }
```

### `PUT /doors/:id/lock_rule` — Set Temporary Door Locking Rule (§7.10)

Scope `edit:space`. Access 1.24.6 or later.

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | yes | String | `enum {keep_lock, keep_unlock, custom, reset, lock_early, lock_now}` |
| `interval` | no | Integer | Duration in **minutes**, when `type` is `custom` |

- `keep_lock`: set the door to the "keep locked" state.
- `keep_unlock`: set the door to the "keep unlocked" state.
- `custom`: unlock for `interval` minutes.
- `reset`: restore a **temporary** unlock (e.g. "Unlock for 1 Hour") to its original locked state. Not for ending an unlock schedule early.
- `lock_early`: the door is on an unlock **schedule**; end today's scheduled unlock now (e.g. at 3 PM for a 9 AM–6 PM schedule).
- `lock_now`: terminate both the unlock schedule and any temporary unlock at once.

```json
{ "code": "SUCCESS", "data": "success", "msg": "success" }
```

### `GET /doors/:id/lock_rule` — Fetch Door Locking Rule (§7.11)

Scope `view:space`. Access 1.24.6 or later.

| Field | Type | Description |
|---|---|---|
| `type` | String | `enum {schedule, keep_lock, keep_unlock, custom, lock_early}`. `schedule`: the door is currently in an unlock schedule |
| `ended_time` | Integer | End time of the rule (Unix seconds) |

```json
{ "code": "SUCCESS", "data": { "ended_time": 1708673342, "type": "custom" }, "msg": "success" }
```

What it answers for a door with no rule at all is not documented.

### `PUT /doors/settings/emergency` — Set Door Emergency Status (§7.12)

Scope `edit:space`. Access 1.24.6 or later. Applies to **all doors**.

| Field | Type | Description |
|---|---|---|
| `lockdown` | Boolean | `true` keeps the doors locked |
| `evacuation` | Boolean | `true` keeps the doors unlocked |

Both `false` restores the initial state. Response `data` is `"success"`.

### `GET /doors/settings/emergency` — Fetch Door Emergency Status (§7.13)

Scope `view:space`. Access 1.24.6 or later.

```json
{ "code": "SUCCESS", "data": { "evacuation": true, "lockdown": false }, "msg": "success" }
```

## Push notifications

### WebSocket — `GET /devices/notifications` (§11.1)

`wss://<console>:12445/api/v1/developer/devices/notifications`, scope `view:device`, Access 1.20.11 or later. Same host, port and Bearer header as REST:

```
wscat --no-check -c wss://192.168.1.1:12445/api/v1/developer/devices/notifications \
  -H "Authorization: Bearer <token>" -H "Upgrade: websocket" -H "Connection: Upgrade"
```

"This API enables you to fetch notifications, such as doorbell notifications." The document shows three payloads and does not say the list is complete. Every frame is `{ event, receiver_id, event_object_id, save_to_history, data }`.

**`access.remote_view`** — a doorbell rings. `data` has `request_id`, `device_id`, `device_type`, `device_name`, `door_name`, `floor_name`, `controller_id`, `connected_uah_id`, `in_or_out`, `create_time`, `reason_code`, `door_guard_ids`, `room_id`, `host_device_mac`, plus `channel` and `token`.

**`access.remote_view.change`** — doorbell status change. `data` is `{ reason_code, remote_call_request_id }`:

| `reason_code` | Meaning |
|---|---|
| 105 | Doorbell timed out |
| 106 | An admin rejected to unlock a door |
| 107 | An admin successfully unlocked a door |
| 108 | A visitor canceled a doorbell |
| 400 | Doorbell was answered by another admin |

**`access.data.device.remote_unlock`** — remote door unlock by an admin. `event_object_id` is the hub's device ID; `data.unique_id` is the **door ID**:

```json
{
  "event": "access.data.device.remote_unlock",
  "receiver_id": "",
  "event_object_id": "<hub device id>",
  "save_to_history": false,
  "data": {
    "unique_id": "5d600936-8618-4f2d-a1b7-d786865b70ba",
    "name": "Door 236b",
    "up_id": "913a35bc-66c9-4293-a617-846dd2e285ed",
    "timezone": "",
    "location_type": "door",
    "extra_type": "",
    "full_name": "UDR-ML - 1F - Door 236b",
    "level": 0,
    "work_time": "[]",
    "work_time_id": "",
    "extras": {
      "uah-input_state_dps": "off",
      "uah-wiring_state_dps-neg": "off",
      "uah-wiring_state_dps-pos": "off"
    }
  }
}
```

**Not documented on this socket:** any relock event, any payload carrying `door_lock_relay_status`, and whether an unlock by card, PIN, face or schedule is pushed at all. A client that needs the relay state reads it with `GET /doors` or `GET /doors/:id`.

### Webhooks (§11.2–§11.7) — not used by the app

The console POSTs JSON to an HTTP(S) endpoint the client registers (`GET` / `POST /webhooks/endpoints`, `PUT` / `DELETE /webhooks/endpoints/:id`; Access 2.2.10 or later), with a `Signature: t=<unix>,v1=<hex>` header where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")` and a 5-second timeout. Using them means the app accepting inbound connections from the console, which View Protect does not do.

| Event | Triggered |
|---|---|
| `access.doorbell.incoming` | A doorbell rings |
| `access.doorbell.completed` | A doorbell event is accepted, declined or canceled |
| `access.doorbell.incoming.REN` | A doorbell activated by a Request-to-Enter button |
| `access.device.dps_status` | The door position sensor changed (`object.status`: `open` / `close`) |
| `access.door.unlock` | **All** door unlock events (`object.authentication_type`: NFC, PIN_CODE, CALL, …; `object.result`) |
| `access.device.emergency_status` | Emergency mode changed (`object.mode`: `lockdown` / `evacuation`, `object.value`) |
| `access.unlock_schedule.activate` / `.deactivate` | An unlock schedule became active / inactive (3.3.10) |
| `access.temporary_unlock.start` / `.end` | A temporary unlock started / ended (3.3.10) |
| `access.visitor.status.changed` | A visitor's status changed (3.3.10) |

There is no relock webhook either.
