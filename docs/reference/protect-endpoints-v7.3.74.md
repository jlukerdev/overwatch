# Protect API Documentation (v7.3.74)

> Protect API reference for version v7.3.74. For all services and latest versions, see [llms.txt](https://developer.ui.com/llms.txt).

Authentication: All APIs use API Key authentication via the `X-API-KEY` header. Generate keys at unifi.ui.com.

## Specifications
- [OpenAPI Spec](https://developer.ui.com/protect/v7.3.74/openapi.json): Machine-readable OpenAPI specification
- [Postman Collection](https://developer.ui.com/protect/v7.3.74/postman-collection.json): Postman collection for import

## Protect (v7.3.74)

**General**
- [Getting Started](https://developer.ui.com/protect/v7.3.74/gettingstarted)

**API Endpoints**

*Information about application*
- `GET /v1/meta/info` - [Get application information](https://developer.ui.com/protect/v7.3.74/get-v1metainfo)

*Viewer information & management*
- `GET /v1/viewers/{id}` - [Get viewer details](https://developer.ui.com/protect/v7.3.74/get-v1viewersid)
- `PATCH /v1/viewers/{id}` - [Patch viewer settings](https://developer.ui.com/protect/v7.3.74/patch-v1viewersid)
- `GET /v1/viewers` - [Get all viewers](https://developer.ui.com/protect/v7.3.74/get-v1viewers)

*Live view management*
- `GET /v1/liveviews/{id}` - [Get live view details](https://developer.ui.com/protect/v7.3.74/get-v1liveviewsid)
- `PATCH /v1/liveviews/{id}` - [Patch live view configuration](https://developer.ui.com/protect/v7.3.74/patch-v1liveviewsid)
- `GET /v1/liveviews` - [Get all live views](https://developer.ui.com/protect/v7.3.74/get-v1liveviews)
- `POST /v1/liveviews` - [Create live view](https://developer.ui.com/protect/v7.3.74/post-v1liveviews)

*WebSocket updates*
- `GET /v1/subscribe/devices` - [Get update messages about devices](https://developer.ui.com/protect/v7.3.74/get-v1subscribedevices)
- `GET /v1/subscribe/events` - [Get Protect event messages](https://developer.ui.com/protect/v7.3.74/get-v1subscribeevents)

*Camera PTZ control & management*
- `POST /v1/cameras/{id}/ptz/patrol/start/{slot}` - [Start a camera PTZ patrol](https://developer.ui.com/protect/v7.3.74/post-v1camerasidptzpatrolstartslot)
- `POST /v1/cameras/{id}/ptz/patrol/stop` - [Stop active camera PTZ patrol](https://developer.ui.com/protect/v7.3.74/post-v1camerasidptzpatrolstop)
- `POST /v1/cameras/{id}/ptz/goto/{slot}` - [Move PTZ camera to preset](https://developer.ui.com/protect/v7.3.74/post-v1camerasidptzgotoslot)

*Alarm manager integration*
- `POST /v1/alarm-manager/webhook/{id}` - [Send a webhook to the alarm manager](https://developer.ui.com/protect/v7.3.74/post-v1alarm-managerwebhookid)

*Arm profile management*
- `GET /v1/arm-profiles` - [Get all arm profiles](https://developer.ui.com/protect/v7.3.74/get-v1arm-profiles)
- `POST /v1/arm-profiles` - [Create arm profile](https://developer.ui.com/protect/v7.3.74/post-v1arm-profiles)
- `PATCH /v1/arm-profiles/settings` - [Set current arm profile](https://developer.ui.com/protect/v7.3.74/patch-v1arm-profilessettings)
- `PATCH /v1/arm-profiles/{id}` - [Update arm profile](https://developer.ui.com/protect/v7.3.74/patch-v1arm-profilesid)
- `DELETE /v1/arm-profiles/{id}` - [Delete arm profile](https://developer.ui.com/protect/v7.3.74/delete-v1arm-profilesid)
- `POST /v1/arm-profiles/enable` - [Enable arm alarm](https://developer.ui.com/protect/v7.3.74/post-v1arm-profilesenable)
- `POST /v1/arm-profiles/disable` - [Disable arm alarm](https://developer.ui.com/protect/v7.3.74/post-v1arm-profilesdisable)

*Light information & management*
- `GET /v1/lights/{id}` - [Get light details](https://developer.ui.com/protect/v7.3.74/get-v1lightsid)
- `PATCH /v1/lights/{id}` - [Patch light settings](https://developer.ui.com/protect/v7.3.74/patch-v1lightsid)
- `GET /v1/lights` - [Get all lights](https://developer.ui.com/protect/v7.3.74/get-v1lights)

*Camera information & management*
- `GET /v1/cameras/{id}` - [Get camera details](https://developer.ui.com/protect/v7.3.74/get-v1camerasid)
- `PATCH /v1/cameras/{id}` - [Patch camera settings](https://developer.ui.com/protect/v7.3.74/patch-v1camerasid)
- `GET /v1/cameras` - [Get all cameras](https://developer.ui.com/protect/v7.3.74/get-v1cameras)
- `POST /v1/cameras/{id}/rtsps-stream` - [Create RTSPS streams for camera](https://developer.ui.com/protect/v7.3.74/post-v1camerasidrtsps-stream)
- `DELETE /v1/cameras/{id}/rtsps-stream` - [Delete camera RTSPS stream](https://developer.ui.com/protect/v7.3.74/delete-v1camerasidrtsps-stream)
- `GET /v1/cameras/{id}/rtsps-stream` - [Get RTSPS streams for camera](https://developer.ui.com/protect/v7.3.74/get-v1camerasidrtsps-stream)
- `GET /v1/cameras/{id}/snapshot` - [Get camera snapshot](https://developer.ui.com/protect/v7.3.74/get-v1camerasidsnapshot)
- `POST /v1/cameras/{id}/disable-mic-permanently` - [Permanently disable camera microphone](https://developer.ui.com/protect/v7.3.74/post-v1camerasiddisable-mic-permanently)
- `POST /v1/cameras/{id}/talkback-session` - [Create talkback session for camera](https://developer.ui.com/protect/v7.3.74/post-v1camerasidtalkback-session)

*Sensor information & management*
- `GET /v1/sensors/{id}` - [Get sensor details](https://developer.ui.com/protect/v7.3.74/get-v1sensorsid)
- `PATCH /v1/sensors/{id}` - [Patch sensor settings](https://developer.ui.com/protect/v7.3.74/patch-v1sensorsid)
- `GET /v1/sensors` - [Get all sensors](https://developer.ui.com/protect/v7.3.74/get-v1sensors)

*Siren information & management*
- `GET /v1/sirens/{id}` - [Get siren details](https://developer.ui.com/protect/v7.3.74/get-v1sirensid)
- `PATCH /v1/sirens/{id}` - [Patch siren settings](https://developer.ui.com/protect/v7.3.74/patch-v1sirensid)
- `GET /v1/sirens` - [Get all sirens](https://developer.ui.com/protect/v7.3.74/get-v1sirens)
- `POST /v1/sirens/{id}/play` - [Play siren](https://developer.ui.com/protect/v7.3.74/post-v1sirensidplay)
- `POST /v1/sirens/{id}/stop` - [Stop siren](https://developer.ui.com/protect/v7.3.74/post-v1sirensidstop)
- `POST /v1/sirens/{id}/test-sound` - [Test siren sound](https://developer.ui.com/protect/v7.3.74/post-v1sirensidtest-sound)

*Fob information & management*
- `GET /v1/fobs/{id}` - [Get fob details](https://developer.ui.com/protect/v7.3.74/get-v1fobsid)
- `PATCH /v1/fobs/{id}` - [Patch fob settings](https://developer.ui.com/protect/v7.3.74/patch-v1fobsid)
- `GET /v1/fobs` - [Get all fobs](https://developer.ui.com/protect/v7.3.74/get-v1fobs)

*Relay information & management*
- `GET /v1/relays/{id}` - [Get relay details](https://developer.ui.com/protect/v7.3.74/get-v1relaysid)
- `PATCH /v1/relays/{id}` - [Patch relay settings](https://developer.ui.com/protect/v7.3.74/patch-v1relaysid)
- `GET /v1/relays` - [Get all relays](https://developer.ui.com/protect/v7.3.74/get-v1relays)
- `POST /v1/relays/{id}/outputs/{outputId}/activate` - [Activate relay output](https://developer.ui.com/protect/v7.3.74/post-v1relaysidoutputsoutputidactivate)

*Speaker information & management*
- `GET /v1/speakers/{id}` - [Get speaker details](https://developer.ui.com/protect/v7.3.74/get-v1speakersid)
- `PATCH /v1/speakers/{id}` - [Patch speaker settings](https://developer.ui.com/protect/v7.3.74/patch-v1speakersid)
- `GET /v1/speakers` - [Get all speakers](https://developer.ui.com/protect/v7.3.74/get-v1speakers)
- `POST /v1/speakers/{id}/test-sound` - [Test speaker sound](https://developer.ui.com/protect/v7.3.74/post-v1speakersidtest-sound)

*Bridge information & management*
- `GET /v1/bridges/{id}` - [Get bridge details](https://developer.ui.com/protect/v7.3.74/get-v1bridgesid)
- `PATCH /v1/bridges/{id}` - [Patch bridge settings](https://developer.ui.com/protect/v7.3.74/patch-v1bridgesid)
- `GET /v1/bridges` - [Get all bridges](https://developer.ui.com/protect/v7.3.74/get-v1bridges)

*Link station information & management*
- `GET /v1/link-stations/{id}` - [Get link station details](https://developer.ui.com/protect/v7.3.74/get-v1link-stationsid)
- `PATCH /v1/link-stations/{id}` - [Patch link station settings](https://developer.ui.com/protect/v7.3.74/patch-v1link-stationsid)
- `GET /v1/link-stations` - [Get all link stations](https://developer.ui.com/protect/v7.3.74/get-v1link-stations)

*Alarm hub information & management*
- `GET /v1/alarm-hubs/{id}` - [Get alarm hub details](https://developer.ui.com/protect/v7.3.74/get-v1alarm-hubsid)
- `PATCH /v1/alarm-hubs/{id}` - [Patch alarm hub settings](https://developer.ui.com/protect/v7.3.74/patch-v1alarm-hubsid)
- `GET /v1/alarm-hubs` - [Get all alarm hubs](https://developer.ui.com/protect/v7.3.74/get-v1alarm-hubs)
- `POST /v1/alarm-hubs/{id}/outputs/{outputId}/trigger` - [Trigger alarm hub output](https://developer.ui.com/protect/v7.3.74/post-v1alarm-hubsidoutputsoutputidtrigger)

*NVR information & management*
- `GET /v1/nvrs` - [Get NVR details](https://developer.ui.com/protect/v7.3.74/get-v1nvrs)

*Device asset file management*
- `POST /v1/files/{fileType}` - [Upload device asset file](https://developer.ui.com/protect/v7.3.74/post-v1filesfiletype)
- `GET /v1/files/{fileType}` - [Get device asset files](https://developer.ui.com/protect/v7.3.74/get-v1filesfiletype)

*Chime information & management*
- `GET /v1/chimes/{id}` - [Get chime details](https://developer.ui.com/protect/v7.3.74/get-v1chimesid)
- `PATCH /v1/chimes/{id}` - [Patch chime settings](https://developer.ui.com/protect/v7.3.74/patch-v1chimesid)
- `GET /v1/chimes` - [Get all chimes](https://developer.ui.com/protect/v7.3.74/get-v1chimes)

*Protect User information*
- `GET /v1/users/{id}` - [Get user details](https://developer.ui.com/protect/v7.3.74/get-v1usersid)
- `GET /v1/users` - [Get all users](https://developer.ui.com/protect/v7.3.74/get-v1users)

*UniFi Identity User information*
- `GET /v1/ulp-users/{id}` - [Get identity user details](https://developer.ui.com/protect/v7.3.74/get-v1ulp-usersid)
- `GET /v1/ulp-users` - [Get all identity users](https://developer.ui.com/protect/v7.3.74/get-v1ulp-users)

*Point of sale event ingestion*
- `POST /v1/pos/cameras/{id}/transactions` - [Ingest a POS transaction](https://developer.ui.com/protect/v7.3.74/post-v1poscamerasidtransactions)

## Optional

**Protect Ansible Modules**
- [Quick Start](https://developer.ui.com/protect/v7.3.74/quick_start.ansible)
