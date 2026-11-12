// GENERATED FILE: DO NOT EDIT.
// Source contract: docs/reference/protect-openapi-v7.3.74.json
// Generator: openapi-typescript (see the devDependency pin in package.json).
// Regenerate with `npm run gen:protect-types`; `npm run check:protect-types` detects drift.
// App code imports from ./types.ts, which applies the documented contract-drift overrides.

export interface paths {
    "/v1/meta/info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get application information
         * @description Get generic information about the Protect application
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            applicationVersion: components["schemas"]["protectVersion"];
                        };
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/viewers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get viewer details
         * @description Get detailed information about a specific viewer
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of viewer */
                    id: components["schemas"]["viewerId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["viewer"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch viewer settings
         * @description Patch the settings for a specific viewer
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of viewer */
                    id: components["schemas"]["viewerId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        liveview?: components["schemas"]["liveviewId"] | null;
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["viewer"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/viewers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all viewers
         * @description Get detailed information about all viewers
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["viewer"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/liveviews/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get live view details
         * @description Get detailed information about a specific live view
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of liveview */
                    id: components["schemas"]["liveviewId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["liveview"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch live view configuration
         * @description Patch the configuration about a specific live view
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of liveview */
                    id: components["schemas"]["liveviewId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["liveview"];
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["liveview"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/liveviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all live views
         * @description Get detailed information about all live views
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["liveview"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Create live view
         * @description Create a new live view
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["liveview"];
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["liveview"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscribe/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get update messages about devices
         * @description A WebSocket subscription which broadcasts all changes happening to Protect-managed hardware devices
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["deviceEvent"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscribe/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Protect event messages
         * @description A WebSocket subscription that broadcasts Protect events
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["eventAdd"] | components["schemas"]["eventUpdate"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/ptz/patrol/start/{slot}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start a camera PTZ patrol
         * @description Start a camera PTZ patrol
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                    /** @description The slot number (0-4) of the patrol that is currently running, or null if no patrol is running */
                    slot: components["schemas"]["activePatrolSlotString"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The camera PTZ patrol was started successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/ptz/patrol/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop active camera PTZ patrol
         * @description Stop active camera PTZ patrol
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The camera PTZ patrol was stopped successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/ptz/goto/{slot}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move PTZ camera to preset
         * @description Adjust the PTZ camera position to a specified preset
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                    /** @description Which slot this preset belongs to (-1 home preset, >=0 other presets). */
                    slot: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The PTZ camera was moved to the given preset successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/alarm-manager/webhook/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a webhook to the alarm manager
         * @description Send a webhook to the alarm manager to trigger configured alarms
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description User defined string used to trigger only specific alarms. Alarm should be configured with the same ID to be triggered. */
                    id: components["schemas"]["alarmTriggerId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Webhook was sent to alarm manager successfully */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bad request response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["idRequiredError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/arm-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all arm profiles
         * @description Get a list of all arm profiles. Only available when using local alarm manager.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["armProfile"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Create arm profile
         * @description Create a new arm profile. Only available when using local alarm manager.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: components["schemas"]["armProfileName"];
                        automations: components["schemas"]["automations"];
                        schedules: components["schemas"]["schedules"];
                        recordEverything: components["schemas"]["recordEverything"];
                        activationDelay: components["schemas"]["activationDelay"];
                    };
                };
            };
            responses: {
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["armProfile"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/arm-profiles/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set current arm profile
         * @description Set the current arm profile to be used when enabling the arm alarm. Only available when using local alarm manager.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        armProfileId: components["schemas"]["armProfileId"];
                    };
                };
            };
            responses: {
                /** @description Arm profile settings updated successfully */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/arm-profiles/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete arm profile
         * @description Delete an arm profile by ID. Only available when using local alarm manager.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of armProfile */
                    id: components["schemas"]["armProfileId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Arm profile deleted successfully */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * Update arm profile
         * @description Update an existing arm profile. Only available when using local alarm manager.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of armProfile */
                    id: components["schemas"]["armProfileId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["armProfileName"];
                        automations?: components["schemas"]["automations"];
                        schedules?: components["schemas"]["schedules"];
                        recordEverything?: components["schemas"]["recordEverything"];
                        activationDelay?: components["schemas"]["activationDelay"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["armProfile"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/arm-profiles/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable arm alarm
         * @description Enable the arm alarm feature using the currently selected arm profile. Only available when using local alarm manager.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Arm alarm enabled successfully */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/arm-profiles/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable arm alarm
         * @description Disable the arm alarm feature. Only available when using local alarm manager.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Arm alarm disabled successfully */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/lights/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get light details
         * @description Get detailed information about a specific light
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of light */
                    id: components["schemas"]["lightId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["light"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch light settings
         * @description Patch the settings for a specific light
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of light */
                    id: components["schemas"]["lightId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        isLightForceEnabled?: components["schemas"]["isLightForceEnabled"];
                        lightModeSettings?: components["schemas"]["lightModeSettings"];
                        lightDeviceSettings?: components["schemas"]["lightDeviceSettings"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["light"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/lights": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all lights
         * @description Get detailed information about all lights
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["light"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get camera details
         * @description Get detailed information about a specific camera
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["camera"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch camera settings
         * @description Patch the settings for a specific camera
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description The name of the device. */
                        name?: string;
                        /**
                         * osdSettings
                         * @description On Screen Display settings.
                         */
                        osdSettings?: {
                            isNameEnabled?: components["schemas"]["osdIsNameEnabled"];
                            isDateEnabled?: components["schemas"]["osdIsDateEnabled"];
                            isLogoEnabled?: components["schemas"]["osdIsLogoEnabled"];
                            isDebugEnabled?: components["schemas"]["osdIsDebugEnabled"];
                            overlayLocation?: components["schemas"]["osdOverlayLocation"];
                        };
                        /**
                         * ledSettings
                         * @description LED settings.
                         */
                        ledSettings?: {
                            isEnabled?: components["schemas"]["ledIsEnabled"];
                            welcomeLed?: components["schemas"]["ledWelcomeLed"];
                            floodLed?: components["schemas"]["ledFloodLed"];
                        };
                        /** @description Message that's set on the LCD screen (for doorbells and/or other devices with LCD screens). To upload image assets for the LCD screen, use the `/files/{fileType}` endpoint. */
                        lcdMessage?: components["schemas"]["lcdMessage"];
                        micVolume?: components["schemas"]["micVolume"];
                        videoMode?: components["schemas"]["videoMode"];
                        /**
                         * @description High Dynamic Range (HDR) mode setting.
                         * @enum {unknown}
                         */
                        hdrType?: "auto" | "on" | "off";
                        /**
                         * smartDetectSettings
                         * @description Smart detection settings for the camera.
                         */
                        smartDetectSettings?: {
                            objectTypes?: components["schemas"]["objectTypes"];
                            audioTypes?: components["schemas"]["audioTypes"];
                        };
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["camera"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/cameras": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all cameras
         * @description Get detailed information about all cameras
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["camera"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/rtsps-stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get RTSPS streams for camera
         * @description Returns existing RTSPS stream URLs for camera
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["existingRtspsStreams"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Create RTSPS streams for camera
         * @description Returns RTSPS stream URLs for specified quality levels
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        qualities: components["schemas"]["createdQualities"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["createdRtspsStreams"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        /**
         * Delete camera RTSPS stream
         * @description Remove the RTSPS stream for a specified camera
         */
        delete: {
            parameters: {
                query: {
                    /** @description The array of quality levels for the RTSPS streams to be removed. All qualities (high, medium, low) are available for all cameras. The package quality is only available for cameras with hasPackageCamera: true. */
                    qualities: components["schemas"]["removedQualities"];
                };
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description RTSPS stream successfully removed */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get camera snapshot
         * @description Get a snapshot image from a specific camera. Use channel=package for cameras with a package camera (hasPackageCamera: true).
         */
        get: {
            parameters: {
                query?: {
                    /** @description Camera channel to capture snapshot from. Use "package" for cameras with a package camera (hasPackageCamera: true). */
                    channel?: components["schemas"]["snapshotChannel"];
                    /** @description Whether to force 1080P or higher resolution snapshot */
                    highQuality?: components["schemas"]["forceHighQuality"];
                };
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Camera snapshot */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "image/jpeg": string;
                    };
                };
                /** @description The camera is offline or not reachable. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/disable-mic-permanently": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Permanently disable camera microphone
         * @description Disable the microphone for a specific camera. This action cannot be undone unless the camera is reset.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["camera"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/cameras/{id}/talkback-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create talkback session for camera
         * @description Returns the talkback stream URL and audio configuration for a specific camera
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of camera */
                    id: components["schemas"]["cameraId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["talkbackSession"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sensors/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get sensor details
         * @description Get detailed information about a specific sensor
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of sensor */
                    id: components["schemas"]["sensorId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["sensor"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch sensor settings
         * @description Patch the settings for a specific sensor
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of sensor */
                    id: components["schemas"]["sensorId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        lightSettings?: components["schemas"]["lightSettings"];
                        humiditySettings?: components["schemas"]["humiditySettings"];
                        temperatureSettings?: components["schemas"]["temperatureSettings"];
                        motionSettings?: components["schemas"]["motionSettings"];
                        glassBreakSettings?: components["schemas"]["glassBreakSettings"];
                        /** @enum {string} */
                        scheduleMode?: "always" | "when_armed";
                        armProfileIds?: string[] | null;
                        hasCustomSensitivityWhenArmed?: boolean;
                        alarmSettings?: components["schemas"]["alarmSettings"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["sensor"];
                    };
                };
                /** @description This operation is not supported for this sensor */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/sensors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all sensors
         * @description Get detailed information about all sensors
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["sensor"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sirens/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get siren details
         * @description Get detailed information about a specific siren
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of siren */
                    id: components["schemas"]["sirenId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["siren"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch siren settings
         * @description Patch the settings for a specific siren
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of siren */
                    id: components["schemas"]["sirenId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        volume?: components["schemas"]["sirenVolume"];
                        ledSettings?: components["schemas"]["sirenLedSettingsExternal"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["siren"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/sirens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all sirens
         * @description Get detailed information about all sirens
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["siren"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sirens/{id}/play": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Play siren
         * @description Activate the siren alarm for the specified duration. The siren status will be tracked and can be stopped early using the stop endpoint.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of siren */
                    id: components["schemas"]["sirenId"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Duration of the siren activation in seconds. Defaults to 5 seconds. */
                        duration?: components["schemas"]["sirenDurationSeconds"];
                    };
                };
            };
            responses: {
                /** @description The siren was activated successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sirens/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop siren
         * @description Stop an active siren.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of siren */
                    id: components["schemas"]["sirenId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The siren was stopped successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sirens/{id}/test-sound": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test siren sound
         * @description Test the siren sound for 5 seconds at the specified volume.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of siren */
                    id: components["schemas"]["sirenId"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description The volume for testing the siren sound. Defaults to the configured device volume. */
                        volume?: components["schemas"]["sirenVolume"];
                    };
                };
            };
            responses: {
                /** @description The siren sound test was initiated successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/fobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get fob details
         * @description Get detailed information about a specific fob
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of fob */
                    id: components["schemas"]["fobId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["fob"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch fob settings
         * @description Patch the settings for a specific fob
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of fob */
                    id: components["schemas"]["fobId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["fob"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/fobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all fobs
         * @description Get detailed information about all fobs
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["fob"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/relays/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get relay details
         * @description Get detailed information about a specific relay
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of relay */
                    id: components["schemas"]["relayId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["relay"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch relay settings
         * @description Patch the settings for a specific relay
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of relay */
                    id: components["schemas"]["relayId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        /**
                         * relayLedSettings
                         * @description Status LED settings.
                         */
                        ledSettings?: {
                            isEnabled?: components["schemas"]["relayLedIsEnabled"];
                        };
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["relay"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/relays": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all relays
         * @description Get detailed information about all relays
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["relay"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/relays/{id}/outputs/{outputId}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Activate relay output
         * @description Control a relay output state. Use "state" to set a specific state (on/off), or omit to toggle. When state is "on", you can optionally provide "pulseDuration" to auto-turn off after the specified milliseconds.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of relay */
                    id: components["schemas"]["relayId"];
                    /** @description Output channel ID (0 or 1) */
                    outputId: number;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /**
                         * @description Desired output state. If omitted, toggles the current state.
                         * @enum {string}
                         */
                        state?: "on" | "off";
                        /** @description Auto-off duration in milliseconds (only applies when state is "on"). If greater than 0, the output auto-turns off after the specified duration. */
                        pulseDuration?: number;
                    };
                };
            };
            responses: {
                /** @description The relay output activation was initiated successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description The relay is offline or not reachable. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/speakers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get speaker details
         * @description Get detailed information about a specific speaker
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of speaker */
                    id: components["schemas"]["speakerId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["speaker"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch speaker settings
         * @description Patch the settings for a specific speaker
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of speaker */
                    id: components["schemas"]["speakerId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                        volume?: components["schemas"]["speakerVolume"];
                        micVolume?: components["schemas"]["speakerMicVolume"];
                        isMicEnabled?: components["schemas"]["speakerIsMicEnabled"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["speaker"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/speakers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all speakers
         * @description Get detailed information about all speakers
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["speaker"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/speakers/{id}/test-sound": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test speaker sound
         * @description Test the speaker sound at the specified volume.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of speaker */
                    id: components["schemas"]["speakerId"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description The volume for testing the speaker sound. Defaults to the configured device volume. */
                        volume?: components["schemas"]["speakerVolume"];
                    };
                };
            };
            responses: {
                /** @description The speaker sound test was initiated successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/bridges/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get bridge details
         * @description Get detailed information about a specific bridge
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of bridge */
                    id: components["schemas"]["bridgeId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["bridge"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch bridge settings
         * @description Patch the settings for a specific bridge
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of bridge */
                    id: components["schemas"]["bridgeId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["bridge"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/bridges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all bridges
         * @description Get detailed information about all bridges
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["bridge"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/link-stations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get link station details
         * @description Get detailed information about a specific link station (non-alarm hub gateways)
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of linkStation */
                    id: components["schemas"]["linkStationId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch link station settings
         * @description Patch the settings for a specific link station
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of linkStation */
                    id: components["schemas"]["linkStationId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/link-stations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all link stations
         * @description Get detailed information about all link stations (non-alarm hub gateways)
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/alarm-hubs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get alarm hub details
         * @description Get detailed information about a specific alarm hub
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of linkStation */
                    id: components["schemas"]["linkStationId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch alarm hub settings
         * @description Patch the settings for a specific alarm hub
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of linkStation */
                    id: components["schemas"]["linkStationId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: components["schemas"]["name"];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/alarm-hubs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all alarm hubs
         * @description Get detailed information about all alarm hubs
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["linkStation"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/alarm-hubs/{id}/outputs/{outputId}/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Trigger alarm hub output
         * @description Trigger an alarm hub output channel. Can be used to turn on/off connected devices like sirens, lights, or other actuators.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of linkStation */
                    id: components["schemas"]["linkStationId"];
                    /** @description Output channel ID (0 or 1) */
                    outputId: number;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /**
                         * @description Set to true to turn on, false to turn off. If omitted, toggles the current state.
                         * @example true
                         */
                        enable?: boolean;
                        /**
                         * @description Delay in milliseconds before the output activates
                         * @example 0
                         */
                        delay?: number;
                        /**
                         * @description Duration in milliseconds to keep the output active. 0 means indefinite until manually turned off.
                         * @example 5000
                         */
                        duration?: number;
                    };
                };
            };
            responses: {
                /** @description The output trigger was initiated successfully. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description The alarm hub is offline or not reachable. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/nvrs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get NVR details
         * @description Get detailed information about the NVR
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["nvr"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/files/{fileType}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get device asset files
         * @description Get a list of all device asset files
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Device asset file type */
                    fileType: components["schemas"]["assetFileType"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Device asset list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["fileSchema"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Upload device asset file
         * @description Upload a new device asset file
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Device asset file type */
                    fileType: components["schemas"]["assetFileType"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": string;
                };
            };
            responses: {
                /** @description Processed and persisted device asset */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["fileSchema"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chimes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get chime details
         * @description Get detailed information about a specific chime
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of chime */
                    id: components["schemas"]["chimeId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["chime"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch chime settings
         * @description Patch the settings for a specific chime
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of chime */
                    id: components["schemas"]["chimeId"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description The name of the device. */
                        name?: string;
                        /** @description The list of (doorbell-only) cameras which this chime is paired to. */
                        cameraIds?: components["schemas"]["cameraId"][];
                        /** @description List of custom ringtone settings for (doorbell-only) cameras paired to this chime. */
                        ringSettings?: components["schemas"]["ringSettings"][];
                    };
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["chime"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/chimes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all chimes
         * @description Get detailed information about all chimes
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["chime"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get user details
         * @description Get detailed information about a specific Protect user.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of user */
                    id: components["schemas"]["userId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["user"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all users
         * @description Get all Protect users. Users are filtered based on access permissions.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["user"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ulp-users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get identity user details
         * @description Get detailed information about a specific UniFi Identity user.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The primary key of ulpUser */
                    id: components["schemas"]["ulpUserId"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ulpUser"];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ulp-users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get all identity users
         * @description Get all UniFi Identity users with enrolled credentials (NFC cards, fingerprints).
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ulpUser"][];
                    };
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/pos/cameras/{id}/transactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ingest a POS transaction
         * @description Records a point of sale transaction as a camera event so the transaction details can be overlaid on recorded footage. Requires write access to the target camera. Footage capture is best-effort: the overlay only appears where the target camera was recording the transaction window (e.g. cameras in detections or adaptive recording modes), and a backdated timestamp may fall outside retained footage. A 200 response confirms the event was recorded, not that video exists for the window.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["posTransactionRequest"];
                };
            };
            responses: {
                /** @description Success response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["posTransactionResponse"];
                    };
                };
                /** @description A transaction with the same externalId for this camera is already being processed; retry shortly. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Error response */
                default: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["genericError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * protectVersion
         * @description Protect application version
         * @example 1.0.0
         */
        protectVersion: string;
        /**
         * posTransactionRequest
         * @description A POS transaction to overlay on camera footage
         */
        posTransactionRequest: {
            /**
             * @description Transaction type
             * @enum {unknown}
             */
            type: "sale" | "refund";
            /** @description Caller-supplied transaction id, unique per camera. Used for best-effort idempotency within a short window (in-memory, per-process; it resets on restart, so a retry after a restart or after the window elapses may create a duplicate event). */
            externalId: string;
            /** @description Transaction total amount */
            amount: number;
            /** @description Uppercase ISO 4217 currency code, e.g. USD */
            currency?: string;
            /** @description Purchased line items */
            lineItems?: {
                /** @description Line item title */
                title: string;
                /** @description Line item quantity */
                quantity: number;
            }[];
            location?: {
                /** @description Location or register identifier */
                id: string;
                /** @description Human-readable location or register name */
                name?: string;
            };
            /** @description Payment method names */
            paymentTypes?: string[];
            /** @description Transaction time in epoch milliseconds. Must be within the last 24 hours and no more than 5 minutes ahead of server time; out-of-range values are rejected. A value within the allowed skew is clamped to now. */
            timestamp?: number;
        };
        /**
         * posTransactionResponse
         * @description Result of POS transaction ingestion
         */
        posTransactionResponse: {
            /** @description True when a new event was created; false when an event with the same externalId was already ingested (eventId echoes the existing one). Idempotency is best-effort - see the externalId description. */
            created: boolean;
            /** @description Id of the created (or previously created) event */
            eventId?: string;
        } & {
            [key: string]: unknown;
        };
        /** genericError */
        genericError: {
            /**
             * @description Error message
             * @example Unexpected API error occurred
             */
            error: string;
            /**
             * @description Name of the error
             * @example API_ERROR
             */
            name: string;
            /**
             * @description An optional nested cause for the parent error
             * @example {
             *       "error": "Unexpected functionality error",
             *       "name": "UNKNOWN_ERROR"
             *     }
             */
            cause?: {
                [key: string]: unknown;
            };
        };
        /**
         * viewerId
         * @description The primary key of viewer
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        viewerId: string;
        /** viewer */
        viewer: {
            id: components["schemas"]["viewerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "viewer";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            liveview: components["schemas"]["liveviewId"] | null;
            streamLimit: components["schemas"]["streamLimit"];
        };
        /**
         * viewerModelKey
         * @description The model key of the viewer
         * @constant
         */
        viewerModelKey: "viewer";
        /**
         * deviceState
         * @description Connection state of the device.
         * @example CONNECTED
         * @example CONNECTING
         * @example DISCONNECTED
         * @enum {string}
         */
        deviceState: "CONNECTED" | "CONNECTING" | "DISCONNECTED";
        /**
         * name
         * @description The name of the device.
         * @example Front Door
         * @example Office Entrance
         * @example Server Room
         */
        name: string;
        /**
         * deviceType
         * @description The device model name.
         * @example UVC Micro
         */
        deviceType: string | null;
        /**
         * deviceGuid
         * @description Stable identifier for the device model.
         * @example 6b8fdd7c-7e4c-4156-bb39-be05ca855491
         */
        deviceGuid: string | null;
        /**
         * mac
         * @description The primary MAC address of the device.
         * @example 24A43C3DFEB9
         * @example D021F98B6AED
         */
        mac: string;
        /**
         * liveviewId
         * @description The primary key of liveview
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        liveviewId: string;
        /**
         * streamLimit
         * @description Count of maximum supported parallel live streams.
         * @example 1
         * @example 16
         */
        streamLimit: number;
        /** liveview */
        liveview: {
            id: components["schemas"]["liveviewId"];
            modelKey: components["schemas"]["liveviewModelKey"];
            /** @description The name of this live view. */
            name: string;
            /** @description Whether this live view is the default one for all viewers. */
            isDefault: boolean;
            /** @description Whether this live view is global and available system-wide to all users */
            isGlobal: boolean;
            owner: components["schemas"]["userId"];
            /**
             * @description The number of slots this live view contains. Which as a consequence also affects the layout of the live view.
             * @example 9
             * @example 4
             */
            layout: number;
            /** @description List of cameras visible in each given slot. And cycling settings for each slot if it has multiple cameras listed. */
            slots: {
                cameras: components["schemas"]["cameraId"][];
                /**
                 * @description Whether to switch to next camera in slot based on motion events or a strict time interval
                 * @enum {string}
                 */
                cycleMode: "motion" | "time";
                /**
                 * @description How long should each camera stream be shown for in seconds until we cycle to the next camera
                 * @example 10
                 * @example 30
                 */
                cycleInterval: number;
            }[];
        };
        /**
         * liveviewModelKey
         * @description The model key of the liveview
         * @constant
         */
        liveviewModelKey: "liveview";
        /**
         * userId
         * @description The primary key of user
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        userId: string;
        /**
         * cameraId
         * @description The primary key of camera
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        cameraId: string;
        /** @description Device(s) which was created, updated or deleted */
        deviceEvent: (components["schemas"]["deviceAdd"] | components["schemas"]["deviceUpdate"] | components["schemas"]["deviceRemove"]) | (components["schemas"]["devicesAdd"] | components["schemas"]["devicesBulkUpdate"] | components["schemas"]["devicesBulkRemove"]);
        /** deviceAdd */
        deviceAdd: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "add";
            item: components["schemas"]["device"];
        };
        device: components["schemas"]["nvr"] | components["schemas"]["camera"] | components["schemas"]["chime"] | components["schemas"]["light"] | components["schemas"]["viewer"] | components["schemas"]["speaker"] | components["schemas"]["bridge"] | components["schemas"]["sensor"] | components["schemas"]["siren"] | components["schemas"]["fob"] | components["schemas"]["relay"] | components["schemas"]["aiProcessor"] | components["schemas"]["aiPort"] | components["schemas"]["linkStation"];
        /** nvr */
        nvr: {
            id: components["schemas"]["nvrId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "nvr";
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["nvrType"];
            guid: components["schemas"]["nvrGuid"];
            mac: components["schemas"]["mac"];
            doorbellSettings: components["schemas"]["doorbellSettings"];
            armMode: components["schemas"]["nvrArmMode"];
        };
        /**
         * nvrId
         * @description The primary key of nvr
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        nvrId: string;
        /**
         * nvrModelKey
         * @description The model key of the nvr
         * @constant
         */
        nvrModelKey: "nvr";
        /**
         * nvrType
         * @description The NVR model name.
         * @example UNVR-PRO
         * @example UDM-PRO
         * @example UNKNOWN
         */
        nvrType: string;
        /**
         * nvrGuid
         * @description GUID of the NVR
         */
        nvrGuid: string | null;
        /** doorbellSettings */
        doorbellSettings: {
            /**
             * @description Default text to display on the LCD screen.
             * @example WELCOME
             */
            defaultMessageText?: string;
            /**
             * @description Default timeout for resetting LCD screen to the default message.
             * @example 60000
             */
            defaultMessageResetTimeoutMs?: number;
            /**
             * @description A list of custom doorbell messages.
             * @example [
             *       "Do Not Disturb",
             *       "Leave Package at Door"
             *     ]
             * @example []
             */
            customMessages?: string[];
            /** @description A list of custom doorbell images for client preview. */
            customImages?: {
                /** @example 34225b30-fe6a-11af-1690-29424bd911c2.png.gif */
                preview: string;
                /** @example 34225b30-fe6a-11af-1690-29424bd911c2.png */
                sprite: string;
            }[];
        };
        /** nvrArmMode */
        nvrArmMode: {
            /** @enum {string} */
            status: "arming" | "armed" | "breach" | "disabled";
            armProfileId: string | null;
            armedAt: number | null;
            willBeArmedAt: number | null;
            breachDetectedAt: number | null;
            breachEventCount: number;
            breachTriggerEventId: string | null;
            breachEventId: string | null;
        };
        /** camera */
        camera: {
            id: components["schemas"]["cameraId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "camera";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            isMicEnabled: components["schemas"]["isMicEnabled"];
            osdSettings: components["schemas"]["osdSettings"];
            ledSettings: components["schemas"]["ledSettings"];
            lcdMessage: components["schemas"]["lcdMessageUnion"];
            micVolume: components["schemas"]["micVolume"];
            activePatrolSlot: components["schemas"]["activePatrolSlot"] | null;
            videoMode: components["schemas"]["videoMode"];
            hdrType: components["schemas"]["hdrType"];
            featureFlags: components["schemas"]["cameraFeatureFlags"];
            smartDetectSettings: components["schemas"]["smartDetectSettings"];
            hasPackageCamera: components["schemas"]["hasPackageCamera"];
        };
        /**
         * cameraModelKey
         * @description The model key of the camera
         * @constant
         */
        cameraModelKey: "camera";
        /**
         * isMicEnabled
         * @description Whether or not the microphone on camera is enabled
         */
        isMicEnabled: boolean;
        /**
         * osdSettings
         * @description On Screen Display settings.
         */
        osdSettings: {
            isNameEnabled: components["schemas"]["osdIsNameEnabled"];
            isDateEnabled: components["schemas"]["osdIsDateEnabled"];
            isLogoEnabled: components["schemas"]["osdIsLogoEnabled"];
            isDebugEnabled: components["schemas"]["osdIsDebugEnabled"];
            overlayLocation: components["schemas"]["osdOverlayLocation"];
        };
        /**
         * osdIsNameEnabled
         * @description Whether to show the name in the OSD.
         */
        osdIsNameEnabled: boolean;
        /**
         * osdIsDateEnabled
         * @description Whether to show the date in the OSD.
         */
        osdIsDateEnabled: boolean;
        /**
         * osdIsLogoEnabled
         * @description Whether to show the logo in the bottom right corner.
         */
        osdIsLogoEnabled: boolean;
        /**
         * osdIsDebugEnabled
         * @description Whether debug info is enabled.
         */
        osdIsDebugEnabled: boolean;
        /**
         * osdOverlayLocation
         * @description The location of the overlay on the screen.
         * @example bottomRight
         * @example topLeft
         * @enum {string}
         */
        osdOverlayLocation: "topLeft" | "topMiddle" | "topRight" | "bottomLeft" | "bottomMiddle" | "bottomRight";
        /**
         * ledSettings
         * @description LED settings.
         */
        ledSettings: {
            isEnabled: components["schemas"]["ledIsEnabled"];
            welcomeLed: components["schemas"]["ledWelcomeLed"];
            floodLed: components["schemas"]["ledFloodLed"];
        };
        /**
         * ledIsEnabled
         * @description Indicates whether the status LED is enabled.
         */
        ledIsEnabled: boolean;
        /**
         * ledWelcomeLed
         * @description Indicates whether the welcome LED is enabled.
         */
        ledWelcomeLed: boolean;
        /**
         * ledFloodLed
         * @description Indicates whether the flood LED is enabled.
         */
        ledFloodLed: boolean;
        /** lcdMessageUnion */
        lcdMessageUnion: {
            /** @enum {string} */
            type?: "LEAVE_PACKAGE_AT_DOOR" | "DO_NOT_DISTURB" | "CUSTOM_MESSAGE" | "IMAGE";
            /** @description UNIX timestamp when doorbell message should be removed (if not set then `nvr.doorbellSettings.defaultMessageResetTimeoutMs` is used, if set to `null` then interpreted as "forever") */
            resetAt?: number | null;
            text?: string;
        };
        /**
         * micVolume
         * @description Mic volume: a number from 0-100.
         * @example 50
         * @example 100
         */
        micVolume: number;
        /**
         * activePatrolSlot
         * @description The slot number (0-4) of the patrol that is currently running, or null if no patrol is running
         * @example 0
         * @example 1
         * @example 2
         * @example 3
         * @example 4
         */
        activePatrolSlot: number;
        /**
         * videoMode
         * @description Current video mode of the camera
         * @example highFps
         * @example default
         * @enum {string}
         */
        videoMode: "default" | "highFps" | "sport" | "slowShutter" | "lprReflex" | "lprNoneReflex";
        /**
         * hdrType
         * @description High Dynamic Range (HDR) mode setting.
         * @example auto
         * @example off
         * @enum {string}
         */
        hdrType: "auto" | "on" | "off";
        /** cameraFeatureFlags */
        cameraFeatureFlags: {
            /** @description Whether camera support full HD or higher resolution snapshot */
            supportFullHdSnapshot: boolean;
            /** @description Whether the camera supports High Dynamic Range mode */
            hasHdr: boolean;
            /** @description What smart detection object types do the camera support. */
            smartDetectTypes: ("person" | "vehicle" | "package" | "licensePlate" | "face" | "animal")[];
            /** @description What smart detection audio types do the camera support. */
            smartDetectAudioTypes: ("alrmSmoke" | "alrmCmonx" | "alrmSiren" | "alrmBabyCry" | "alrmSpeak" | "alrmBark" | "alrmBurglar" | "alrmCarHorn" | "alrmGlassBreak")[];
            /** @description A list of supported video modes by the camera */
            videoModes: ("default" | "highFps" | "homekit" | "sport" | "slowShutter" | "lprReflex" | "lprNoneReflex")[];
            /** @description Whether the camera has a microphone */
            hasMic: boolean;
            /** @description Whether the camera has LED status */
            hasLedStatus: boolean;
            /** @description Whether the camera has a speaker to support talkback */
            hasSpeaker: boolean;
        };
        /**
         * smartDetectSettings
         * @description Smart detection settings for the camera.
         */
        smartDetectSettings: {
            objectTypes: components["schemas"]["objectTypes"];
            audioTypes: components["schemas"]["audioTypes"];
        };
        /** objectTypes */
        objectTypes: ("person" | "vehicle" | "package" | "licensePlate" | "face" | "animal")[];
        /** audioTypes */
        audioTypes: ("alrmSmoke" | "alrmCmonx" | "alrmSiren" | "alrmBabyCry" | "alrmSpeak" | "alrmBark" | "alrmBurglar" | "alrmCarHorn" | "alrmGlassBreak")[];
        /**
         * hasPackageCamera
         * @description Whether the camera has a package camera.
         */
        hasPackageCamera: boolean;
        /** chime */
        chime: {
            id: components["schemas"]["chimeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "chime";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            /** @description The list of (doorbell-only) cameras which this chime is paired to. */
            cameraIds: components["schemas"]["cameraId"][];
            /** @description List of custom ringtone settings for (doorbell-only) cameras paired to this chime. */
            ringSettings: components["schemas"]["ringSettings"][];
        };
        /**
         * chimeId
         * @description The primary key of chime
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        chimeId: string;
        /**
         * chimeModelKey
         * @description The model key of the chime
         * @constant
         */
        chimeModelKey: "chime";
        /** ringSettings */
        ringSettings: {
            /** @description Which paired (doorbell-only) camera do these settings refer to. */
            cameraId: components["schemas"]["cameraId"];
            /**
             * @description How many times should the ringtone be repeated
             * @example 3
             * @example 1
             */
            repeatTimes: number;
            /** @description The ID of the ringtone that should be played when the (doorbell-only) camera is rung. */
            ringtoneId: components["schemas"]["ringtoneId"];
            /**
             * @description How loud should the ringtone be played. 0 being silent and 100 the loudest.
             * @example 100
             * @example 80
             */
            volume: number;
        };
        /**
         * ringtoneId
         * @description The primary key of ringtone
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        ringtoneId: string;
        /** light */
        light: {
            id: components["schemas"]["lightId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "light";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            lightModeSettings: components["schemas"]["lightModeSettings"];
            lightDeviceSettings: components["schemas"]["lightDeviceSettings"];
            isDark: components["schemas"]["isDark"];
            isLightOn: components["schemas"]["isLightOn"];
            isLightForceEnabled: components["schemas"]["isLightForceEnabled"];
            lastMotion: components["schemas"]["lastMotion"];
            isPirMotionDetected: components["schemas"]["isPirMotionDetected"];
            /** @description Which camera is configured to be paired to this light. */
            camera: components["schemas"]["cameraId"] | null;
        };
        /**
         * lightId
         * @description The primary key of light
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        lightId: string;
        /**
         * lightModelKey
         * @description The model key of the light
         * @constant
         */
        lightModelKey: "light";
        /**
         * lightModeSettings
         * @description Settings for when and how your light gets activated
         */
        lightModeSettings: {
            mode?: components["schemas"]["lightMode"];
            enableAt?: components["schemas"]["enableAt"];
        };
        /**
         * lightMode
         * @description When will floodlight turn on.
         */
        lightMode: "always" | "motion" | "off";
        /**
         * enableAt
         * @description At what time is the lighting mode relevant and acted upon (this has no effect when mode is off).
         */
        enableAt: "fulltime" | "dark";
        /**
         * lightDeviceSettings
         * @description Hardware settings for light device.
         */
        lightDeviceSettings: {
            /** @description Turn on/off floodlight status LED indicator. */
            isIndicatorEnabled?: boolean;
            /**
             * @description How long the light stays on after a motion event in milliseconds.
             * @example 30000
             * @example 15000
             */
            pirDuration?: number;
            /**
             * @description How sensitive is the PIR to motion (0-100)%.
             * @example 50
             * @example 80
             */
            pirSensitivity?: number;
            /**
             * @description Brightness level of the main LED (1-6).
             * @example 6
             * @example 3
             */
            ledLevel?: number;
        };
        /**
         * isDark
         * @description Whether the light is currently sensing that it's in a dark scene.
         */
        isDark: boolean;
        /**
         * isLightOn
         * @description Whether the light has its main LED currently enabled.
         */
        isLightOn: boolean;
        /**
         * isLightForceEnabled
         * @description Whether the light has its main LED currently force-enabled.
         */
        isLightForceEnabled: boolean;
        /**
         * lastMotion
         * @description Unix timestamp of the last time the PIR motion-detection was triggered.
         * @example 1445408038748
         */
        lastMotion: number | null;
        /**
         * isPirMotionDetected
         * @description Whether the light PIR is currently detecting motion
         */
        isPirMotionDetected: boolean;
        /** speaker */
        speaker: {
            id: components["schemas"]["speakerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "speaker";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            volume: components["schemas"]["speakerVolume"];
            micVolume: components["schemas"]["speakerMicVolume"];
            isMicEnabled: components["schemas"]["speakerIsMicEnabled"];
            speakerState: components["schemas"]["speakerState"];
            featureFlags: components["schemas"]["speakerFeatureFlags"];
        };
        /**
         * speakerId
         * @description The primary key of speaker
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        speakerId: string;
        /**
         * speakerModelKey
         * @description The model key of the speaker
         * @constant
         */
        speakerModelKey: "speaker";
        /**
         * speakerVolume
         * @description Speaker volume: a number from 0-100.
         * @example 80
         */
        speakerVolume: number;
        /**
         * speakerMicVolume
         * @description Mic volume: a number from 0-100.
         * @example 80
         */
        speakerMicVolume: number;
        /**
         * speakerIsMicEnabled
         * @description Whether or not the microphone on the speaker is enabled.
         * @example true
         */
        speakerIsMicEnabled: boolean;
        /**
         * speakerState
         * @description Real-time state of Speaker
         */
        speakerState: {
            status: components["schemas"]["speakerStateStatus"];
            mode: components["schemas"]["speakerStateMode"];
        };
        /**
         * speakerStateStatus
         * @description Current status of the speaker
         * @example idle
         * @enum {string}
         */
        speakerStateStatus: "idle" | "streaming" | "playing" | "tts_playing" | "uploading";
        /**
         * speakerStateMode
         * @description Current mode of the speaker
         * @example listen
         * @enum {string}
         */
        speakerStateMode: "listen" | "talk";
        /**
         * speakerFeatureFlags
         * @description Feature flags of the speaker
         */
        speakerFeatureFlags: {
            hasMic: components["schemas"]["speakerFeatureFlagsHasMic"];
        };
        /**
         * speakerFeatureFlagsHasMic
         * @description Whether the device has a microphone.
         * @example true
         * @example false
         */
        speakerFeatureFlagsHasMic: boolean;
        /** bridge */
        bridge: {
            id: components["schemas"]["bridgeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "bridge";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            platform: components["schemas"]["bridgePlatform"];
            clients: components["schemas"]["bridgeClients"];
            maxClients: components["schemas"]["bridgeMaxClients"];
        };
        /**
         * bridgeId
         * @description The primary key of bridge
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        bridgeId: string;
        /**
         * bridgeModelKey
         * @description The model key of the bridge
         * @constant
         */
        bridgeModelKey: "bridge";
        /**
         * bridgePlatform
         * @description The bridge platform
         * @example mt7621
         * @example mt7622
         */
        bridgePlatform: string | null;
        /**
         * bridgeClients
         * @description Array of IoT devices mac that bridge is reserving for
         * @example [
         *       "AABBCCDDEEFF",
         *       "112233445566"
         *     ]
         * @example []
         */
        bridgeClients: string[];
        /**
         * bridgeMaxClients
         * @description The max acceptable client number of a V2 bridge. V1 bridge does not support this feature.
         * @example 7
         * @example 0
         */
        bridgeMaxClients: number;
        /** sensor */
        sensor: {
            id: components["schemas"]["sensorId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "sensor";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            mountType: components["schemas"]["sensorMountType"];
            batteryStatus: components["schemas"]["batteryStatus"];
            featureFlags?: components["schemas"]["sensorFeatureFlags"];
            stats: components["schemas"]["sensorStats"];
            lightSettings: components["schemas"]["lightSettings"];
            humiditySettings: components["schemas"]["humiditySettings"];
            temperatureSettings: components["schemas"]["temperatureSettings"];
            isOpened: components["schemas"]["sensorIsOpened"];
            openStatusChangedAt: components["schemas"]["sensorOpenStatusChangedAt"];
            isMotionDetected: components["schemas"]["sensorIsMotionDetected"];
            motionDetectedAt: components["schemas"]["sensorMotionDetectedAt"];
            motionSettings: components["schemas"]["motionSettings"];
            glassBreakSettings: components["schemas"]["glassBreakSettings"];
            scheduleMode: components["schemas"]["sensorScheduleMode"];
            armProfileIds: components["schemas"]["sensorArmProfileIds"];
            hasCustomSensitivityWhenArmed: components["schemas"]["sensorHasCustomSensitivityWhenArmed"];
            alarmTriggeredAt: components["schemas"]["sensorAlarmTriggeredAt"];
            alarmSettings: components["schemas"]["alarmSettings"];
            leakDetectedAt: components["schemas"]["sensorLeakDetectedAt"];
            externalLeakDetectedAt: components["schemas"]["sensorExternalLeakDetectedAt"];
            leakSettings: components["schemas"]["leakSettings"];
            tamperingDetectedAt: components["schemas"]["tamperingDetectedAt"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        };
        /**
         * sensorId
         * @description The primary key of sensor
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        sensorId: string;
        /**
         * sensorModelKey
         * @description The model key of the sensor
         * @constant
         */
        sensorModelKey: "sensor";
        /**
         * sensorMountType
         * @description Mounting type of the sensor.
         * @example door
         * @example none
         * @enum {string}
         */
        sensorMountType: "door" | "window" | "garage" | "leak" | "none";
        /**
         * batteryStatus
         * @description [DEPRECATED] Use wirelessConnectionState.batteryStatus instead. Battery status.
         */
        batteryStatus: {
            /**
             * @description Battery charge level from 0 to 100 (%).
             * @example 95
             * @example 50
             */
            percentage?: number | null;
            /** @description Low battery charge level flag. */
            isLow?: boolean;
        };
        /**
         * sensorFeatureFlags
         * @description Sensor feature flags.
         */
        sensorFeatureFlags: {
            /** @description Matches `stats.temperature` and `temperatureSettings`. */
            temperature?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches `stats.humidity` and `humiditySettings`. */
            humidity?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches `stats.light` and `lightSettings`. */
            light?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches motion state and `motionSettings`. */
            motion?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches leak state and `leakSettings`. */
            waterLeak?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches entry/door-window/garage open state (`isOpened`). */
            open?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches tamper detection (`tamperingDetectedAt`). */
            tamper?: components["schemas"]["sensorIntegrationFeatureCapability"];
            /** @description Matches smoke / CO alarm surfaces (`alarmSettings`, `alarmTriggeredAt`). */
            smoke?: components["schemas"]["sensorIntegrationFeatureCapability"];
        };
        /**
         * sensorIntegrationFeatureCapability
         * @description Capability slice for integration responses: how many channels the device provides for one domain (see `channelCount`).
         */
        sensorIntegrationFeatureCapability: {
            /**
             * @description If a capability key is absent (`undefined`), the capability should be treated as not supported. When present, a positive value indicates how many independent channels of that measurement or input the sensor exposes. For example, two temperature probes would report as two channels.
             * @example 1
             * @example 2
             */
            channelCount: number;
        };
        /**
         * sensorStats
         * @description Sensor statistics.
         */
        sensorStats: {
            /** @description Ambient light value (Lux). */
            light?: {
                value?: components["schemas"]["sensorValue"] | null;
                status?: components["schemas"]["sensorStatus"];
            };
            /** @description Relative humidity value (%). */
            humidity?: {
                value?: components["schemas"]["sensorValue"] | null;
                status?: components["schemas"]["sensorStatus"];
            };
            /** @description Temperature value (Celsius). */
            temperature?: {
                value?: components["schemas"]["sensorValue"] | null;
                status?: components["schemas"]["sensorStatus"];
            };
        };
        /**
         * sensorValue
         * @description Decimal value of the metric measured by the sensor
         * @example 22.5
         * @example 65
         */
        sensorValue: number;
        /**
         * sensorStatus
         * @description What range does the measured metric fall into
         * @example high
         * @enum {string}
         */
        sensorStatus: "neutral" | "low" | "safe" | "high" | "unknown";
        /**
         * lightSettings
         * @description Ambient light sensor settings.
         */
        lightSettings: {
            /** @description Enable ambient light sensor. */
            isEnabled?: boolean;
            /**
             * @description Ambient light threshold detection hysteresis margin (Lux). Read-only value decided by sensor implementation.
             * @example 10
             */
            margin?: number;
            /**
             * @description Ambient light interrupt threshold low level from 1 to 503192 (Lux).
             * @example 20
             */
            lowThreshold?: number | null;
            /**
             * @description Ambient light interrupt threshold high level from 1 to 503192 (Lux).
             * @example 100
             */
            highThreshold?: number | null;
        };
        /**
         * humiditySettings
         * @description Relative humidity sensor settings.
         */
        humiditySettings: {
            /** @description Enable relative humidity sensor. */
            isEnabled?: boolean;
            /**
             * @description Humidity threshold detection hysteresis margin (%). Read-only value decided by sensor implementation.
             * @example 1
             */
            margin?: number;
            /**
             * @description Humidity low level threshold from 1 to 99 (%).
             * @example 30
             */
            lowThreshold?: number | null;
            /**
             * @description Humidity high level threshold from 1 to 99 (%).
             * @example 80
             */
            highThreshold?: number | null;
        };
        /**
         * temperatureSettings
         * @description Temperature sensor settings.
         */
        temperatureSettings: {
            /** @description Enable temperature sensor. */
            isEnabled?: boolean;
            /**
             * @description Temperature threshold detection hysteresis margin (C). Read-only value decided by sensor implementation.
             * @example 0.1
             */
            margin?: number;
            /**
             * @description Temperature low level threshold from -39 to 124 (C).
             * @example 20
             */
            lowThreshold?: number | null;
            /**
             * @description Temperature high level threshold from -39 to 124 (C).
             * @example 25
             */
            highThreshold?: number | null;
        };
        /**
         * sensorIsOpened
         * @description Whether the door/window/garage is opened.
         */
        sensorIsOpened: boolean | null;
        /**
         * sensorOpenStatusChangedAt
         * @description Unix timestamp when the door/window/garage was last opened or closed, nullable.
         * @example 1445408038748
         */
        sensorOpenStatusChangedAt: number | null;
        /**
         * sensorIsMotionDetected
         * @description Whether sensor is currently detecting the motion.
         */
        sensorIsMotionDetected: boolean;
        /**
         * sensorMotionDetectedAt
         * @description Unix timestamp when the last motion was detected.
         * @example 1445408038748
         */
        sensorMotionDetectedAt: number | null;
        /**
         * motionSettings
         * @description Motion sensor settings.
         */
        motionSettings: {
            /** @description Enable motion sensor. */
            isEnabled?: boolean;
            /**
             * @description Motion sensitivity (0-100) used when system is not armed or when no armed override is set.
             * @example 50
             * @example 100
             */
            sensitivity?: number;
            /**
             * @description Motion sensitivity (0-100) used when the system is armed and `hasCustomSensitivityWhenArmed` is true on the sensor.
             * @example 50
             */
            sensitivityWhenArmed?: number;
        };
        /**
         * glassBreakSettings
         * @description Glass break sensor settings.
         */
        glassBreakSettings: {
            /** @description Enable glass break sensor. */
            isEnabled?: boolean;
            /**
             * @description Glass break sensitivity (0-100) used when system is not armed or when no armed override is set.
             * @example 25
             */
            sensitivity?: number;
            /**
             * @description Glass break sensitivity (0-100) used when the system is armed and `hasCustomSensitivityWhenArmed` is true on the sensor.
             * @example 50
             */
            sensitivityWhenArmed?: number;
        };
        /**
         * sensorScheduleMode
         * @description When armed-mode detection runs: `always` or only `when_armed`. Applies to both glass break and motion together.
         * @enum {string}
         */
        sensorScheduleMode: "always" | "when_armed";
        /**
         * sensorArmProfileIds
         * @description When `scheduleMode` is `when_armed`, restricts armed-mode detection to these arm profile ids. Empty or null = all profiles.
         */
        sensorArmProfileIds: string[] | null;
        /**
         * sensorHasCustomSensitivityWhenArmed
         * @description When true, glass break and motion both use their respective `sensitivityWhenArmed` value while the system is armed.
         */
        sensorHasCustomSensitivityWhenArmed: boolean;
        /**
         * sensorAlarmTriggeredAt
         * @description Unix timestamp when the smoke or carbon monoxide alarm was triggered, nullable.
         * @example 1445408038748
         */
        sensorAlarmTriggeredAt: number | null;
        /**
         * alarmSettings
         * @description Smoke and carbon monoxide alarm sensor settings.
         */
        alarmSettings: {
            /** @description Enable smoke and carbon monoxide alarm sensor. */
            isEnabled?: boolean;
        };
        /**
         * sensorLeakDetectedAt
         * @description Unix timestamp when the sensor detected a water leak, nullable.
         * @example 1445408038748
         */
        sensorLeakDetectedAt: number | null;
        /**
         * sensorExternalLeakDetectedAt
         * @description Unix timestamp when the sensor detected an external water leak, nullable.
         * @example 1445408038748
         */
        sensorExternalLeakDetectedAt: number | null;
        /**
         * leakSettings
         * @description Leak sensor settings.
         */
        leakSettings: {
            /** @description Enable internal water leak detection. */
            isInternalEnabled?: boolean;
            /** @description Enable external water leak detection. */
            isExternalEnabled?: boolean;
        };
        /**
         * tamperingDetectedAt
         * @description Unix timestamp when the sensor detected tampering, nullable.
         * @example 1445408038748
         */
        tamperingDetectedAt: number | null;
        /**
         * wirelessConnectionState
         * @description Wireless connection state including signal quality, battery status, and bridge connection.
         */
        wirelessConnectionState: {
            signalState: components["schemas"]["signalState"];
            batteryStatus: components["schemas"]["wirelessBatteryStatus"];
            bridge: components["schemas"]["wirelessBridgeId"];
        };
        /**
         * signalState
         * @description Signal state.
         */
        signalState: {
            signalQuality: components["schemas"]["signalQuality"];
            signalStrength: components["schemas"]["signalStrength"];
        };
        /**
         * signalQuality
         * @description Percent representation of Bluetooth signal strength.
         * @example 85
         */
        signalQuality: number | null;
        /**
         * signalStrength
         * @description dBm value of Bluetooth signal strength.
         * @example -45
         */
        signalStrength: number | null;
        /**
         * wirelessBatteryStatus
         * @description Battery status.
         */
        wirelessBatteryStatus: {
            percentage: components["schemas"]["wirelessBatteryPercentage"];
            isLow: components["schemas"]["wirelessBatteryIsLow"];
        };
        /**
         * wirelessBatteryPercentage
         * @description Battery charge level from 0 to 100 (%).
         * @example 95
         * @example 50
         */
        wirelessBatteryPercentage: number | null;
        /**
         * wirelessBatteryIsLow
         * @description Low battery charge level flag.
         */
        wirelessBatteryIsLow: boolean;
        /**
         * wirelessBridgeId
         * @description The ID of the bridge this device is connected through.
         */
        wirelessBridgeId: components["schemas"]["bridgeId"] | null;
        /** siren */
        siren: {
            id: components["schemas"]["sirenId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "siren";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            volume: components["schemas"]["sirenVolume"];
            ledSettings: components["schemas"]["sirenLedSettingsExternal"];
            sirenStatus: components["schemas"]["sirenStatus"];
            connectionType: components["schemas"]["sirenConnectionType"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        };
        /**
         * sirenId
         * @description The primary key of siren
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        sirenId: string;
        /**
         * sirenModelKey
         * @description The model key of the siren
         * @constant
         */
        sirenModelKey: "siren";
        /**
         * sirenVolume
         * @description Volume: a number from 1-100.
         * @example 80
         * @example 50
         */
        sirenVolume: number;
        /**
         * sirenLedSettingsExternal
         * @description Status LED settings.
         */
        sirenLedSettingsExternal: {
            isEnabled: components["schemas"]["sirenLedIsEnabled"];
        };
        /**
         * sirenLedIsEnabled
         * @description Enable status LED.
         * @example true
         */
        sirenLedIsEnabled: boolean;
        /**
         * sirenStatus
         * @description Status of the siren
         */
        sirenStatus: {
            isActive: components["schemas"]["sirenStatusIsActive"];
            activatedAt: components["schemas"]["sirenStatusActivatedAt"];
            duration: components["schemas"]["sirenStatusDuration"];
        };
        /**
         * sirenStatusIsActive
         * @description Whether the siren is active.
         * @example true
         * @example false
         */
        sirenStatusIsActive: boolean;
        /**
         * sirenStatusActivatedAt
         * @description Timestamp when the siren was activated.
         * @example 1445408038748
         */
        sirenStatusActivatedAt: number | null;
        /** sirenStatusDuration */
        sirenStatusDuration: components["schemas"]["sirenDuration"] | null;
        /**
         * sirenDuration
         * @description Duration of the siren activation in milliseconds.
         * @example 5000
         * @example 10000
         * @example 20000
         * @example 30000
         */
        sirenDuration: 5000 | 10000 | 20000 | 30000;
        /**
         * sirenConnectionType
         * @description The connection type of the siren.
         * @example lora
         * @example ucp4
         * @enum {string}
         */
        sirenConnectionType: "ucp4" | "lora";
        /** fob */
        fob: {
            id: components["schemas"]["fobId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "fob";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            awayState: components["schemas"]["fobAwayState"];
            buttonLabels: components["schemas"]["fobButtonLabels"];
            featureFlags: components["schemas"]["fobFeatureFlags"];
            armControlSettings: components["schemas"]["fobArmControlSettings"];
            keypadSettings: components["schemas"]["fobKeypadSettings"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        };
        /**
         * fobId
         * @description The primary key of fob
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        fobId: string;
        /**
         * fobModelKey
         * @description The model key of the fob
         * @constant
         */
        fobModelKey: "fob";
        /**
         * fobAwayState
         * @description Fob presence/away state.
         * @example ONLINE
         * @example DEVICE_LOST
         * @enum {string}
         */
        fobAwayState: "ONLINE" | "RECENTLY_SEEN" | "NO_RECENT_HEARTBEAT" | "DEVICE_LOST";
        /**
         * fobButtonLabels
         * @description Label style applied when this fob is rendered in button selection lists.
         * @example securityActions
         * @enum {string}
         */
        fobButtonLabels: "securityActions" | "positionHint";
        /**
         * fobFeatureFlags
         * @description Feature flags for the fob.
         * @example {
         *       "buttons": [
         *         "arm",
         *         "disarm",
         *         "panic"
         *       ],
         *       "hasKeypad": false
         *     }
         */
        fobFeatureFlags: {
            buttons: components["schemas"]["fobButtons"];
            /** @description Whether the device has a PIN keypad. */
            hasKeypad: boolean;
        };
        /**
         * fobButtons
         * @description Available button types on the fob.
         * @example [
         *       "arm",
         *       "disarm",
         *       "panic"
         *     ]
         */
        fobButtons: ("function" | "alarmHubButton" | "arm" | "disarm" | "night" | "panic" | "left" | "right" | "input1" | "input2" | "main")[];
        /**
         * fobArmControlSettings
         * @description Which external arm profiles this fob may arm and disarm, per mode button.
         */
        fobArmControlSettings: {
            /** @description Whether this fob may arm and disarm external arm profiles. */
            enabled: boolean;
            /** @description External arm profile armed by the Arm button, and disarmed by the Disarm button. */
            armProfileId: string | null;
            /** @description External arm profile armed by the Night button, and disarmed by the Disarm button. */
            nightProfileId: string | null;
        };
        /**
         * fobKeypadSettings
         * @description On-device keypad feedback settings. Only meaningful when featureFlags.hasKeypad.
         */
        fobKeypadSettings: {
            /** @description Whether a keypress beeps. */
            beepEnabled: boolean;
            /** @description Keypress beep volume, 0-100%. */
            beepVolume: number;
        };
        /** relay */
        relay: {
            id: components["schemas"]["relayId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "relay";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            ledSettings: components["schemas"]["relayLedSettings"];
            outputs: components["schemas"]["relayOutputs"];
            inputs: components["schemas"]["relayInputs"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        };
        /**
         * relayId
         * @description The primary key of relay
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        relayId: string;
        /**
         * relayModelKey
         * @description The model key of the relay
         * @constant
         */
        relayModelKey: "relay";
        /**
         * relayLedSettings
         * @description Status LED settings.
         */
        relayLedSettings: {
            isEnabled: components["schemas"]["relayLedIsEnabled"];
        };
        /**
         * relayLedIsEnabled
         * @description Enable status LED.
         * @example true
         */
        relayLedIsEnabled: boolean;
        /** relayOutputs */
        relayOutputs: components["schemas"]["relayOutput"][];
        /**
         * relayOutput
         * @description Relay output channels.
         */
        relayOutput: {
            id: components["schemas"]["relayOutputId"];
            name: components["schemas"]["relayOutputName"];
            type: components["schemas"]["relayOutputType"];
            delay: components["schemas"]["relayOutputDelay"];
            pulseDuration: components["schemas"]["relayOutputPulseDuration"];
            state: components["schemas"]["relayOutputState"];
            rebootState: components["schemas"]["relayOutputRebootState"];
        };
        /**
         * relayOutputId
         * @description The channel index of the relay output.
         * @example 0
         */
        relayOutputId: number;
        /**
         * relayOutputName
         * @description User-friendly name for this relay output.
         * @example Garage Door
         */
        relayOutputName: string | null;
        /**
         * relayOutputType
         * @description The type of device connected to this relay output.
         * @example garageDoor
         * @enum {string|null}
         */
        relayOutputType: "garageDoor" | "gate" | "valve" | "siren" | "custom" | null;
        /**
         * relayOutputDelay
         * @description Server-side delay in milliseconds before activation (0 = no delay, null = use default).
         * @example 0
         */
        relayOutputDelay: number | null;
        /**
         * relayOutputPulseDuration
         * @description Auto-off duration in milliseconds (0 = permanent on until manually turned off, null = use default).
         * @example 1000
         */
        relayOutputPulseDuration: number | null;
        /**
         * relayOutputState
         * @description The current state of the relay output.
         * @example off
         * @enum {string|null}
         */
        relayOutputState: "on" | "off" | "offOtp" | null;
        /**
         * relayOutputRebootState
         * @description The state the relay output should be set to after a reboot/power cycle.
         * @example off
         * @enum {string}
         */
        relayOutputRebootState: "restore" | "on" | "off";
        /** relayInputs */
        relayInputs: components["schemas"]["relayInput"][];
        /**
         * relayInput
         * @description Relay input channels.
         */
        relayInput: {
            id: components["schemas"]["relayInputId"];
            name: components["schemas"]["relayInputName"];
            state: components["schemas"]["relayInputState"];
            actionTrigger: components["schemas"]["relayInputActionTrigger"];
            actionType: components["schemas"]["relayInputActionType"];
            actionOutputId: components["schemas"]["relayInputActionOutputId"];
        };
        /**
         * relayInputId
         * @description The channel index of the relay input.
         * @example 0
         */
        relayInputId: number;
        /**
         * relayInputName
         * @description User-friendly name for this relay input.
         * @example Door Sensor
         */
        relayInputName: string | null;
        /**
         * relayInputState
         * @description The current state of the relay input.
         * @example off
         * @enum {string|null}
         */
        relayInputState: "on" | "off" | null;
        /**
         * relayInputActionTrigger
         * @description The trigger event that activates the action.
         * @example switchedOn
         * @enum {string|null}
         */
        relayInputActionTrigger: "switchedOn" | "switchedOff" | null;
        /**
         * relayInputActionType
         * @description The type of action to perform when triggered.
         * @example toggleOutput
         * @enum {string|null}
         */
        relayInputActionType: "setOutputOn" | "setOutputOff" | "toggleOutput" | "followInput" | null;
        /**
         * relayInputActionOutputId
         * @description The index of the output to control when triggered.
         * @example 0
         */
        relayInputActionOutputId: number | null;
        /** aiProcessor */
        aiProcessor: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiprocessor";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
        };
        /**
         * deviceId
         * @description The primary key of device
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        deviceId: string;
        /**
         * aiprocessorModelKey
         * @description The model key of the aiprocessor
         * @constant
         */
        aiprocessorModelKey: "aiprocessor";
        /** aiPort */
        aiPort: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiport";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
        };
        /**
         * aiportModelKey
         * @description The model key of the aiport
         * @constant
         */
        aiportModelKey: "aiport";
        /** linkStation */
        linkStation: {
            id: components["schemas"]["linkStationId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "linkstation";
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            isAlarmHub: components["schemas"]["linkStationIsAlarmHub"];
            ledSettings: components["schemas"]["linkStationLedSettings"];
            lastEvent: components["schemas"]["linkStationLastEvent"];
            alarmHub?: components["schemas"]["alarmHubStatus"];
            threadState: components["schemas"]["linkStationThreadState"];
        };
        /**
         * linkStationId
         * @description The primary key of linkStation
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        linkStationId: string;
        /**
         * linkstationModelKey
         * @description The model key of the linkstation
         * @constant
         */
        linkstationModelKey: "linkstation";
        /**
         * linkStationIsAlarmHub
         * @description Whether the linkstation is an alarm hub.
         */
        linkStationIsAlarmHub: boolean;
        /**
         * linkStationLedSettings
         * @description Status LED settings.
         */
        linkStationLedSettings: {
            isEnabled: components["schemas"]["linkStationLedIsEnabled"];
        };
        /**
         * linkStationLedIsEnabled
         * @description Whether the status LED is enabled.
         */
        linkStationLedIsEnabled: boolean;
        /**
         * linkStationLastEvent
         * @description Timestamp when any last event was detected.
         * @example 1445408038748
         */
        linkStationLastEvent: number | null;
        /**
         * alarmHubStatus
         * @description Alarm hub status and configuration. Only present when isAlarmHub is true.
         */
        alarmHubStatus: {
            /** @enum {string} */
            armed: "on" | "off";
            battery?: {
                /** @enum {string} */
                charging?: "on" | "off";
                /** @enum {string} */
                connection?: "connected" | "disconnected";
                voltage?: number;
                /** @enum {string} */
                batteryStatus?: "ok" | "low" | "critical";
            };
            /** @enum {string} */
            buckboost: "on" | "off";
            connector?: {
                emergency?: {
                    /** @enum {string} */
                    "+": "connected" | "disconnected";
                    /** @enum {string} */
                    "-": "connected" | "disconnected";
                };
                "12v"?: {
                    [key: string]: {
                        /** @enum {string} */
                        "+": "connected" | "disconnected";
                        /** @enum {string} */
                        "-": "connected" | "disconnected";
                    };
                };
                relay?: {
                    [key: string]: {
                        /** @enum {string} */
                        com: "connected" | "disconnected";
                        /** @enum {string} */
                        nc: "connected" | "disconnected";
                        /** @enum {string} */
                        no: "connected" | "disconnected";
                    };
                };
                tb?: {
                    [key: string]: {
                        /** @enum {string} */
                        "+": "connected" | "disconnected";
                        /** @enum {string} */
                        "-": "connected" | "disconnected";
                    };
                };
                /** @enum {string} */
                battery?: "connected" | "disconnected";
                /** @enum {string} */
                poeout?: "connected" | "disconnected";
            };
            cover?: {
                distance?: number;
                /** @enum {string} */
                status?: "open" | "close";
            };
            /** @enum {string} */
            deviceTamperStatus?: "tampered" | "restored";
            currentMeterChannelStatus: {
                [key: string]: {
                    /** @enum {string} */
                    criticalAlarm: "normal" | "alert";
                    criticalThreshold: number;
                    value: number;
                    /** @enum {string} */
                    warningAlarm: "normal" | "alert";
                    warningThreshold: number;
                };
            };
            currentMeterStatus: {
                [key: string]: {
                    /** @enum {string} */
                    critical: "normal" | "alert";
                    /** @enum {string} */
                    efuse: "normal" | "warning" | "fault";
                    /** @enum {string} */
                    enable: "on" | "off";
                    /** @enum {string} */
                    powerValid: "normal" | "alert";
                    /** @enum {string} */
                    timingControl: "normal" | "alert";
                    /** @enum {string} */
                    warning: "normal" | "alert";
                };
            };
            inputPower?: {
                /** @enum {string} */
                bt?: "low" | "high";
                /** @enum {string} */
                typ1?: "low" | "high";
                /** @enum {string} */
                typ2?: "low" | "high";
            };
            poeout?: {
                /** @enum {string} */
                connection?: "connected" | "disconnected";
                /** @enum {string} */
                powerSupply?: "on" | "off";
            };
            powerMeter: {
                [key: string]: {
                    /** @enum {string} */
                    alarm: "normal" | "alert";
                    current: number;
                    /** @enum {string} */
                    efuse: "normal" | "warning" | "fault";
                    /** @enum {string} */
                    enable: "on" | "off";
                    power: number;
                    powerThreshold: number;
                    voltage: number;
                };
            };
            output: {
                [key: string]: {
                    /** @enum {string} */
                    enable: "on" | "off";
                    /** @enum {string} */
                    active: "on" | "off";
                    /** @enum {string} */
                    status: "wet" | "dry";
                    delay?: number;
                    duration?: number;
                    name?: string;
                };
            };
            input: {
                [key: string]: {
                    /** @enum {string} */
                    enable: "on" | "off";
                    type: "no" | "nc";
                    eolr: number;
                    resistor: number;
                    /** @enum {string} */
                    status: "normal" | "alarm" | "fault" | "short" | "cut";
                    trigger: number;
                    name?: string;
                    /** @enum {string} */
                    inputType?: "MOTION" | "ENTRY" | "SMOKE" | "GLASS_BREAK" | "EMERGENCY_BUTTON";
                    allowedArmingProfiles?: string[];
                    /** @enum {string} */
                    triggerWhenDisarmed?: "on" | "off";
                    /** @enum {string} */
                    triggerOnCurrentArmingProfile?: "on" | "off";
                    lastTriggeredAt?: number | null;
                    cameraId?: string | null;
                    powerReset?: boolean;
                };
            };
            inputTerminalStatus?: {
                [key: string]: {
                    /** @enum {string} */
                    plusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                    /** @enum {string} */
                    minusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                    /** @enum {string} */
                    terminalStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short" | "partially-connected";
                    /** @enum {string} */
                    idleSubState?: "open" | "closed";
                };
            };
            outputTerminalStatus?: {
                [key: string]: {
                    pins: {
                        /** @enum {string} */
                        no: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                        /** @enum {string} */
                        com: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                        /** @enum {string} */
                        nc: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                    };
                    /** @enum {string} */
                    statusLabel: "disabled" | "off" | "active";
                    /** @enum {string} */
                    mode: "dry-contact" | "powered-12v";
                    /** @enum {string} */
                    efuseAlert: "none" | "high-current" | "over-current";
                    wiredPins: ("+" | "-" | "nc" | "no" | "com")[];
                };
            };
            emergencyTerminalStatus?: {
                /** @enum {string} */
                plusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                /** @enum {string} */
                minusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                /** @enum {string} */
                terminalStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short" | "partially-connected";
                /** @enum {string} */
                idleSubState?: "open" | "closed";
            } | null;
            auxiliaryPowerTerminalStatus?: {
                [key: string]: {
                    /** @enum {string} */
                    plusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                    /** @enum {string} */
                    minusPinStatus: "disabled" | "idle" | "not-connected" | "tamper" | "triggered" | "cut" | "short";
                    /** @enum {string} */
                    status: "not-connected" | "partially-connected" | "connected";
                    currentMa?: number;
                    loadPercent?: number;
                };
            };
        };
        /**
         * linkStationThreadState
         * @description Thread mesh runtime state. Populated only on Thread-capable gateway SKUs.
         */
        linkStationThreadState: {
            network: components["schemas"]["linkStationThreadNetwork"] | null;
        };
        /**
         * linkStationThreadNetwork
         * @description Latest Thread network status reported by the gateway.
         */
        linkStationThreadNetwork: {
            /** @enum {string} */
            status: "ready" | "error";
            /** @enum {string|null} */
            role: "disabled" | "detached" | "child" | "router" | "leader" | null;
            networkName: string | null;
            channel: number | null;
            panId: string | null;
            extendedPanId: string | null;
            joinedDeviceCount: number;
            errorReason: string | null;
            /** @description Wall-clock unix-epoch milliseconds when the gateway last refreshed this status. */
            lastUpdatedAt: number;
        };
        /** deviceUpdate */
        deviceUpdate: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "update";
            item: components["schemas"]["devicePartialWithReference"];
        };
        devicePartialWithReference: components["schemas"]["nvrPartialWithReference"] | components["schemas"]["cameraPartialWithReference"] | components["schemas"]["chimePartialWithReference"] | components["schemas"]["lightPartialWithReference"] | components["schemas"]["viewerPartialWithReference"] | components["schemas"]["speakerPartialWithReference"] | components["schemas"]["bridgePartialWithReference"] | components["schemas"]["sensorPartialWithReference"] | components["schemas"]["sirenPartialWithReference"] | components["schemas"]["fobPartialWithReference"] | components["schemas"]["relayPartialWithReference"] | components["schemas"]["aiProcessorPartialWithReference"] | components["schemas"]["aiPortPartialWithReference"] | components["schemas"]["linkStationPartialWithReference"];
        /** nvrPartialWithReference */
        nvrPartialWithReference: {
            id: components["schemas"]["nvrId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "nvr";
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["nvrType"];
            guid?: components["schemas"]["nvrGuid"];
            mac?: components["schemas"]["mac"];
            doorbellSettings?: components["schemas"]["doorbellSettings"];
            armMode?: components["schemas"]["nvrArmMode"];
        };
        /** cameraPartialWithReference */
        cameraPartialWithReference: {
            id: components["schemas"]["cameraId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "camera";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            isMicEnabled?: components["schemas"]["isMicEnabled"];
            osdSettings?: components["schemas"]["osdSettings"];
            ledSettings?: components["schemas"]["ledSettings"];
            lcdMessage?: components["schemas"]["lcdMessageUnion"];
            micVolume?: components["schemas"]["micVolume"];
            activePatrolSlot?: components["schemas"]["activePatrolSlot"] | null;
            videoMode?: components["schemas"]["videoMode"];
            hdrType?: components["schemas"]["hdrType"];
            featureFlags?: components["schemas"]["cameraFeatureFlags"];
            smartDetectSettings?: components["schemas"]["smartDetectSettings"];
            hasPackageCamera?: components["schemas"]["hasPackageCamera"];
        };
        /** chimePartialWithReference */
        chimePartialWithReference: {
            id: components["schemas"]["chimeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "chime";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            /** @description The list of (doorbell-only) cameras which this chime is paired to. */
            cameraIds?: components["schemas"]["cameraId"][];
            /** @description List of custom ringtone settings for (doorbell-only) cameras paired to this chime. */
            ringSettings?: components["schemas"]["ringSettings"][];
        };
        /** lightPartialWithReference */
        lightPartialWithReference: {
            id: components["schemas"]["lightId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "light";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            lightModeSettings?: components["schemas"]["lightModeSettings"];
            lightDeviceSettings?: components["schemas"]["lightDeviceSettings"];
            isDark?: components["schemas"]["isDark"];
            isLightOn?: components["schemas"]["isLightOn"];
            isLightForceEnabled?: components["schemas"]["isLightForceEnabled"];
            lastMotion?: components["schemas"]["lastMotion"];
            isPirMotionDetected?: components["schemas"]["isPirMotionDetected"];
            /** @description Which camera is configured to be paired to this light. */
            camera?: components["schemas"]["cameraId"] | null;
        };
        /** viewerPartialWithReference */
        viewerPartialWithReference: {
            id: components["schemas"]["viewerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "viewer";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            liveview?: components["schemas"]["liveviewId"] | null;
            streamLimit?: components["schemas"]["streamLimit"];
        };
        /** speakerPartialWithReference */
        speakerPartialWithReference: {
            id: components["schemas"]["speakerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "speaker";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            volume?: components["schemas"]["speakerVolume"];
            micVolume?: components["schemas"]["speakerMicVolume"];
            isMicEnabled?: components["schemas"]["speakerIsMicEnabled"];
            speakerState?: components["schemas"]["speakerState"];
            featureFlags?: components["schemas"]["speakerFeatureFlags"];
        };
        /** bridgePartialWithReference */
        bridgePartialWithReference: {
            id: components["schemas"]["bridgeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "bridge";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            platform?: components["schemas"]["bridgePlatform"];
            clients?: components["schemas"]["bridgeClients"];
            maxClients?: components["schemas"]["bridgeMaxClients"];
        };
        /** sensorPartialWithReference */
        sensorPartialWithReference: {
            id: components["schemas"]["sensorId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "sensor";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            mountType?: components["schemas"]["sensorMountType"];
            batteryStatus?: components["schemas"]["batteryStatus"];
            featureFlags?: components["schemas"]["sensorFeatureFlags"];
            stats?: components["schemas"]["sensorStats"];
            lightSettings?: components["schemas"]["lightSettings"];
            humiditySettings?: components["schemas"]["humiditySettings"];
            temperatureSettings?: components["schemas"]["temperatureSettings"];
            isOpened?: components["schemas"]["sensorIsOpened"];
            openStatusChangedAt?: components["schemas"]["sensorOpenStatusChangedAt"];
            isMotionDetected?: components["schemas"]["sensorIsMotionDetected"];
            motionDetectedAt?: components["schemas"]["sensorMotionDetectedAt"];
            motionSettings?: components["schemas"]["motionSettings"];
            glassBreakSettings?: components["schemas"]["glassBreakSettings"];
            scheduleMode?: components["schemas"]["sensorScheduleMode"];
            armProfileIds?: components["schemas"]["sensorArmProfileIds"];
            hasCustomSensitivityWhenArmed?: components["schemas"]["sensorHasCustomSensitivityWhenArmed"];
            alarmTriggeredAt?: components["schemas"]["sensorAlarmTriggeredAt"];
            alarmSettings?: components["schemas"]["alarmSettings"];
            leakDetectedAt?: components["schemas"]["sensorLeakDetectedAt"];
            externalLeakDetectedAt?: components["schemas"]["sensorExternalLeakDetectedAt"];
            leakSettings?: components["schemas"]["leakSettings"];
            tamperingDetectedAt?: components["schemas"]["tamperingDetectedAt"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        };
        /** sirenPartialWithReference */
        sirenPartialWithReference: {
            id: components["schemas"]["sirenId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "siren";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            volume?: components["schemas"]["sirenVolume"];
            ledSettings?: components["schemas"]["sirenLedSettingsExternal"];
            sirenStatus?: components["schemas"]["sirenStatus"];
            connectionType?: components["schemas"]["sirenConnectionType"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        };
        /** fobPartialWithReference */
        fobPartialWithReference: {
            id: components["schemas"]["fobId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "fob";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            awayState?: components["schemas"]["fobAwayState"];
            buttonLabels?: components["schemas"]["fobButtonLabels"];
            featureFlags?: components["schemas"]["fobFeatureFlags"];
            armControlSettings?: components["schemas"]["fobArmControlSettings"];
            keypadSettings?: components["schemas"]["fobKeypadSettings"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        };
        /** relayPartialWithReference */
        relayPartialWithReference: {
            id: components["schemas"]["relayId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "relay";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            ledSettings?: components["schemas"]["relayLedSettings"];
            outputs?: components["schemas"]["relayOutputs"];
            inputs?: components["schemas"]["relayInputs"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        };
        /** aiProcessorPartialWithReference */
        aiProcessorPartialWithReference: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiprocessor";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
        };
        /** aiPortPartialWithReference */
        aiPortPartialWithReference: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiport";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
        };
        /** linkStationPartialWithReference */
        linkStationPartialWithReference: {
            id: components["schemas"]["linkStationId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "linkstation";
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            isAlarmHub?: components["schemas"]["linkStationIsAlarmHub"];
            ledSettings?: components["schemas"]["linkStationLedSettings"];
            lastEvent?: components["schemas"]["linkStationLastEvent"];
            alarmHub?: components["schemas"]["alarmHubStatus"];
            threadState?: components["schemas"]["linkStationThreadState"];
        };
        /** deviceRemove */
        deviceRemove: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "remove";
            item: components["schemas"]["deviceReference"];
        };
        deviceReference: components["schemas"]["nvrReference"] | components["schemas"]["cameraReference"] | components["schemas"]["chimeReference"] | components["schemas"]["lightReference"] | components["schemas"]["viewerReference"] | components["schemas"]["speakerReference"] | components["schemas"]["bridgeReference"] | components["schemas"]["sensorReference"] | components["schemas"]["sirenReference"] | components["schemas"]["fobReference"] | components["schemas"]["relayReference"] | components["schemas"]["aiProcessorReference"] | components["schemas"]["aiPortReference"] | components["schemas"]["linkStationReference"];
        /** nvrReference */
        nvrReference: {
            id: components["schemas"]["nvrId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "nvr";
        };
        /** cameraReference */
        cameraReference: {
            id: components["schemas"]["cameraId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "camera";
        };
        /** chimeReference */
        chimeReference: {
            id: components["schemas"]["chimeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "chime";
        };
        /** lightReference */
        lightReference: {
            id: components["schemas"]["lightId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "light";
        };
        /** viewerReference */
        viewerReference: {
            id: components["schemas"]["viewerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "viewer";
        };
        /** speakerReference */
        speakerReference: {
            id: components["schemas"]["speakerId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "speaker";
        };
        /** bridgeReference */
        bridgeReference: {
            id: components["schemas"]["bridgeId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "bridge";
        };
        /** sensorReference */
        sensorReference: {
            id: components["schemas"]["sensorId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "sensor";
        };
        /** sirenReference */
        sirenReference: {
            id: components["schemas"]["sirenId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "siren";
        };
        /** fobReference */
        fobReference: {
            id: components["schemas"]["fobId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "fob";
        };
        /** relayReference */
        relayReference: {
            id: components["schemas"]["relayId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "relay";
        };
        /** aiProcessorReference */
        aiProcessorReference: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiprocessor";
        };
        /** aiPortReference */
        aiPortReference: {
            id: components["schemas"]["deviceId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "aiport";
        };
        /** linkStationReference */
        linkStationReference: {
            id: components["schemas"]["linkStationId"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modelKey: "linkstation";
        };
        /** devicesAdd */
        devicesAdd: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "add";
            item: components["schemas"]["deviceBulk"];
        };
        deviceBulk: {
            id: components["schemas"]["nvrId"] | components["schemas"]["nvrId"][];
            modelKey: components["schemas"]["nvrModelKey"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["nvrType"];
            guid: components["schemas"]["nvrGuid"];
            mac: components["schemas"]["mac"];
            doorbellSettings: components["schemas"]["doorbellSettings"];
            armMode: components["schemas"]["nvrArmMode"];
        } | {
            id: components["schemas"]["cameraId"] | components["schemas"]["cameraId"][];
            modelKey: components["schemas"]["cameraModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            isMicEnabled: components["schemas"]["isMicEnabled"];
            osdSettings: components["schemas"]["osdSettings"];
            ledSettings: components["schemas"]["ledSettings"];
            lcdMessage: components["schemas"]["lcdMessageUnion"];
            micVolume: components["schemas"]["micVolume"];
            activePatrolSlot: components["schemas"]["activePatrolSlot"] | null;
            videoMode: components["schemas"]["videoMode"];
            hdrType: components["schemas"]["hdrType"];
            featureFlags: components["schemas"]["cameraFeatureFlags"];
            smartDetectSettings: components["schemas"]["smartDetectSettings"];
            hasPackageCamera: components["schemas"]["hasPackageCamera"];
        } | {
            id: components["schemas"]["chimeId"] | components["schemas"]["chimeId"][];
            modelKey: components["schemas"]["chimeModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            /** @description The list of (doorbell-only) cameras which this chime is paired to. */
            cameraIds: components["schemas"]["cameraId"][];
            /** @description List of custom ringtone settings for (doorbell-only) cameras paired to this chime. */
            ringSettings: components["schemas"]["ringSettings"][];
        } | {
            id: components["schemas"]["lightId"] | components["schemas"]["lightId"][];
            modelKey: components["schemas"]["lightModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            lightModeSettings: components["schemas"]["lightModeSettings"];
            lightDeviceSettings: components["schemas"]["lightDeviceSettings"];
            isDark: components["schemas"]["isDark"];
            isLightOn: components["schemas"]["isLightOn"];
            isLightForceEnabled: components["schemas"]["isLightForceEnabled"];
            lastMotion: components["schemas"]["lastMotion"];
            isPirMotionDetected: components["schemas"]["isPirMotionDetected"];
            /** @description Which camera is configured to be paired to this light. */
            camera: components["schemas"]["cameraId"] | null;
        } | {
            id: components["schemas"]["viewerId"] | components["schemas"]["viewerId"][];
            modelKey: components["schemas"]["viewerModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            liveview: components["schemas"]["liveviewId"] | null;
            streamLimit: components["schemas"]["streamLimit"];
        } | {
            id: components["schemas"]["speakerId"] | components["schemas"]["speakerId"][];
            modelKey: components["schemas"]["speakerModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            volume: components["schemas"]["speakerVolume"];
            micVolume: components["schemas"]["speakerMicVolume"];
            isMicEnabled: components["schemas"]["speakerIsMicEnabled"];
            speakerState: components["schemas"]["speakerState"];
            featureFlags: components["schemas"]["speakerFeatureFlags"];
        } | {
            id: components["schemas"]["bridgeId"] | components["schemas"]["bridgeId"][];
            modelKey: components["schemas"]["bridgeModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            platform: components["schemas"]["bridgePlatform"];
            clients: components["schemas"]["bridgeClients"];
            maxClients: components["schemas"]["bridgeMaxClients"];
        } | {
            id: components["schemas"]["sensorId"] | components["schemas"]["sensorId"][];
            modelKey: components["schemas"]["sensorModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            mountType: components["schemas"]["sensorMountType"];
            batteryStatus: components["schemas"]["batteryStatus"];
            featureFlags?: components["schemas"]["sensorFeatureFlags"];
            stats: components["schemas"]["sensorStats"];
            lightSettings: components["schemas"]["lightSettings"];
            humiditySettings: components["schemas"]["humiditySettings"];
            temperatureSettings: components["schemas"]["temperatureSettings"];
            isOpened: components["schemas"]["sensorIsOpened"];
            openStatusChangedAt: components["schemas"]["sensorOpenStatusChangedAt"];
            isMotionDetected: components["schemas"]["sensorIsMotionDetected"];
            motionDetectedAt: components["schemas"]["sensorMotionDetectedAt"];
            motionSettings: components["schemas"]["motionSettings"];
            glassBreakSettings: components["schemas"]["glassBreakSettings"];
            scheduleMode: components["schemas"]["sensorScheduleMode"];
            armProfileIds: components["schemas"]["sensorArmProfileIds"];
            hasCustomSensitivityWhenArmed: components["schemas"]["sensorHasCustomSensitivityWhenArmed"];
            alarmTriggeredAt: components["schemas"]["sensorAlarmTriggeredAt"];
            alarmSettings: components["schemas"]["alarmSettings"];
            leakDetectedAt: components["schemas"]["sensorLeakDetectedAt"];
            externalLeakDetectedAt: components["schemas"]["sensorExternalLeakDetectedAt"];
            leakSettings: components["schemas"]["leakSettings"];
            tamperingDetectedAt: components["schemas"]["tamperingDetectedAt"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["sirenId"] | components["schemas"]["sirenId"][];
            modelKey: components["schemas"]["sirenModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            volume: components["schemas"]["sirenVolume"];
            ledSettings: components["schemas"]["sirenLedSettingsExternal"];
            sirenStatus: components["schemas"]["sirenStatus"];
            connectionType: components["schemas"]["sirenConnectionType"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["fobId"] | components["schemas"]["fobId"][];
            modelKey: components["schemas"]["fobModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            awayState: components["schemas"]["fobAwayState"];
            buttonLabels: components["schemas"]["fobButtonLabels"];
            featureFlags: components["schemas"]["fobFeatureFlags"];
            armControlSettings: components["schemas"]["fobArmControlSettings"];
            keypadSettings: components["schemas"]["fobKeypadSettings"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["relayId"] | components["schemas"]["relayId"][];
            modelKey: components["schemas"]["relayModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            ledSettings: components["schemas"]["relayLedSettings"];
            outputs: components["schemas"]["relayOutputs"];
            inputs: components["schemas"]["relayInputs"];
            wirelessConnectionState: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiprocessorModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiportModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
        } | {
            id: components["schemas"]["linkStationId"] | components["schemas"]["linkStationId"][];
            modelKey: components["schemas"]["linkstationModelKey"];
            state: components["schemas"]["deviceState"];
            name: components["schemas"]["name"] | null;
            type: components["schemas"]["deviceType"];
            guid: components["schemas"]["deviceGuid"];
            mac: components["schemas"]["mac"];
            isAlarmHub: components["schemas"]["linkStationIsAlarmHub"];
            ledSettings: components["schemas"]["linkStationLedSettings"];
            lastEvent: components["schemas"]["linkStationLastEvent"];
            alarmHub?: components["schemas"]["alarmHubStatus"];
            threadState: components["schemas"]["linkStationThreadState"];
        };
        /** devicesBulkUpdate */
        devicesBulkUpdate: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "update";
            item: components["schemas"]["deviceBulkPartialWithReference"];
        };
        deviceBulkPartialWithReference: {
            id: components["schemas"]["nvrId"] | components["schemas"]["nvrId"][];
            modelKey: components["schemas"]["nvrModelKey"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["nvrType"];
            guid?: components["schemas"]["nvrGuid"];
            mac?: components["schemas"]["mac"];
            doorbellSettings?: components["schemas"]["doorbellSettings"];
            armMode?: components["schemas"]["nvrArmMode"];
        } | {
            id: components["schemas"]["cameraId"] | components["schemas"]["cameraId"][];
            modelKey: components["schemas"]["cameraModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            isMicEnabled?: components["schemas"]["isMicEnabled"];
            osdSettings?: components["schemas"]["osdSettings"];
            ledSettings?: components["schemas"]["ledSettings"];
            lcdMessage?: components["schemas"]["lcdMessageUnion"];
            micVolume?: components["schemas"]["micVolume"];
            activePatrolSlot?: components["schemas"]["activePatrolSlot"] | null;
            videoMode?: components["schemas"]["videoMode"];
            hdrType?: components["schemas"]["hdrType"];
            featureFlags?: components["schemas"]["cameraFeatureFlags"];
            smartDetectSettings?: components["schemas"]["smartDetectSettings"];
            hasPackageCamera?: components["schemas"]["hasPackageCamera"];
        } | {
            id: components["schemas"]["chimeId"] | components["schemas"]["chimeId"][];
            modelKey: components["schemas"]["chimeModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            /** @description The list of (doorbell-only) cameras which this chime is paired to. */
            cameraIds?: components["schemas"]["cameraId"][];
            /** @description List of custom ringtone settings for (doorbell-only) cameras paired to this chime. */
            ringSettings?: components["schemas"]["ringSettings"][];
        } | {
            id: components["schemas"]["lightId"] | components["schemas"]["lightId"][];
            modelKey: components["schemas"]["lightModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            lightModeSettings?: components["schemas"]["lightModeSettings"];
            lightDeviceSettings?: components["schemas"]["lightDeviceSettings"];
            isDark?: components["schemas"]["isDark"];
            isLightOn?: components["schemas"]["isLightOn"];
            isLightForceEnabled?: components["schemas"]["isLightForceEnabled"];
            lastMotion?: components["schemas"]["lastMotion"];
            isPirMotionDetected?: components["schemas"]["isPirMotionDetected"];
            /** @description Which camera is configured to be paired to this light. */
            camera?: components["schemas"]["cameraId"] | null;
        } | {
            id: components["schemas"]["viewerId"] | components["schemas"]["viewerId"][];
            modelKey: components["schemas"]["viewerModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            liveview?: components["schemas"]["liveviewId"] | null;
            streamLimit?: components["schemas"]["streamLimit"];
        } | {
            id: components["schemas"]["speakerId"] | components["schemas"]["speakerId"][];
            modelKey: components["schemas"]["speakerModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            volume?: components["schemas"]["speakerVolume"];
            micVolume?: components["schemas"]["speakerMicVolume"];
            isMicEnabled?: components["schemas"]["speakerIsMicEnabled"];
            speakerState?: components["schemas"]["speakerState"];
            featureFlags?: components["schemas"]["speakerFeatureFlags"];
        } | {
            id: components["schemas"]["bridgeId"] | components["schemas"]["bridgeId"][];
            modelKey: components["schemas"]["bridgeModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            platform?: components["schemas"]["bridgePlatform"];
            clients?: components["schemas"]["bridgeClients"];
            maxClients?: components["schemas"]["bridgeMaxClients"];
        } | {
            id: components["schemas"]["sensorId"] | components["schemas"]["sensorId"][];
            modelKey: components["schemas"]["sensorModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            mountType?: components["schemas"]["sensorMountType"];
            batteryStatus?: components["schemas"]["batteryStatus"];
            featureFlags?: components["schemas"]["sensorFeatureFlags"];
            stats?: components["schemas"]["sensorStats"];
            lightSettings?: components["schemas"]["lightSettings"];
            humiditySettings?: components["schemas"]["humiditySettings"];
            temperatureSettings?: components["schemas"]["temperatureSettings"];
            isOpened?: components["schemas"]["sensorIsOpened"];
            openStatusChangedAt?: components["schemas"]["sensorOpenStatusChangedAt"];
            isMotionDetected?: components["schemas"]["sensorIsMotionDetected"];
            motionDetectedAt?: components["schemas"]["sensorMotionDetectedAt"];
            motionSettings?: components["schemas"]["motionSettings"];
            glassBreakSettings?: components["schemas"]["glassBreakSettings"];
            scheduleMode?: components["schemas"]["sensorScheduleMode"];
            armProfileIds?: components["schemas"]["sensorArmProfileIds"];
            hasCustomSensitivityWhenArmed?: components["schemas"]["sensorHasCustomSensitivityWhenArmed"];
            alarmTriggeredAt?: components["schemas"]["sensorAlarmTriggeredAt"];
            alarmSettings?: components["schemas"]["alarmSettings"];
            leakDetectedAt?: components["schemas"]["sensorLeakDetectedAt"];
            externalLeakDetectedAt?: components["schemas"]["sensorExternalLeakDetectedAt"];
            leakSettings?: components["schemas"]["leakSettings"];
            tamperingDetectedAt?: components["schemas"]["tamperingDetectedAt"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["sirenId"] | components["schemas"]["sirenId"][];
            modelKey: components["schemas"]["sirenModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            volume?: components["schemas"]["sirenVolume"];
            ledSettings?: components["schemas"]["sirenLedSettingsExternal"];
            sirenStatus?: components["schemas"]["sirenStatus"];
            connectionType?: components["schemas"]["sirenConnectionType"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["fobId"] | components["schemas"]["fobId"][];
            modelKey: components["schemas"]["fobModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            awayState?: components["schemas"]["fobAwayState"];
            buttonLabels?: components["schemas"]["fobButtonLabels"];
            featureFlags?: components["schemas"]["fobFeatureFlags"];
            armControlSettings?: components["schemas"]["fobArmControlSettings"];
            keypadSettings?: components["schemas"]["fobKeypadSettings"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["relayId"] | components["schemas"]["relayId"][];
            modelKey: components["schemas"]["relayModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            ledSettings?: components["schemas"]["relayLedSettings"];
            outputs?: components["schemas"]["relayOutputs"];
            inputs?: components["schemas"]["relayInputs"];
            wirelessConnectionState?: components["schemas"]["wirelessConnectionState"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiprocessorModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiportModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
        } | {
            id: components["schemas"]["linkStationId"] | components["schemas"]["linkStationId"][];
            modelKey: components["schemas"]["linkstationModelKey"];
            state?: components["schemas"]["deviceState"];
            name?: components["schemas"]["name"] | null;
            type?: components["schemas"]["deviceType"];
            guid?: components["schemas"]["deviceGuid"];
            mac?: components["schemas"]["mac"];
            isAlarmHub?: components["schemas"]["linkStationIsAlarmHub"];
            ledSettings?: components["schemas"]["linkStationLedSettings"];
            lastEvent?: components["schemas"]["linkStationLastEvent"];
            alarmHub?: components["schemas"]["alarmHubStatus"];
            threadState?: components["schemas"]["linkStationThreadState"];
        };
        /** devicesBulkRemove */
        devicesBulkRemove: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "remove";
            item: components["schemas"]["deviceBulkReference"];
        };
        deviceBulkReference: {
            id: components["schemas"]["nvrId"] | components["schemas"]["nvrId"][];
            modelKey: components["schemas"]["nvrModelKey"];
        } | {
            id: components["schemas"]["cameraId"] | components["schemas"]["cameraId"][];
            modelKey: components["schemas"]["cameraModelKey"];
        } | {
            id: components["schemas"]["chimeId"] | components["schemas"]["chimeId"][];
            modelKey: components["schemas"]["chimeModelKey"];
        } | {
            id: components["schemas"]["lightId"] | components["schemas"]["lightId"][];
            modelKey: components["schemas"]["lightModelKey"];
        } | {
            id: components["schemas"]["viewerId"] | components["schemas"]["viewerId"][];
            modelKey: components["schemas"]["viewerModelKey"];
        } | {
            id: components["schemas"]["speakerId"] | components["schemas"]["speakerId"][];
            modelKey: components["schemas"]["speakerModelKey"];
        } | {
            id: components["schemas"]["bridgeId"] | components["schemas"]["bridgeId"][];
            modelKey: components["schemas"]["bridgeModelKey"];
        } | {
            id: components["schemas"]["sensorId"] | components["schemas"]["sensorId"][];
            modelKey: components["schemas"]["sensorModelKey"];
        } | {
            id: components["schemas"]["sirenId"] | components["schemas"]["sirenId"][];
            modelKey: components["schemas"]["sirenModelKey"];
        } | {
            id: components["schemas"]["fobId"] | components["schemas"]["fobId"][];
            modelKey: components["schemas"]["fobModelKey"];
        } | {
            id: components["schemas"]["relayId"] | components["schemas"]["relayId"][];
            modelKey: components["schemas"]["relayModelKey"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiprocessorModelKey"];
        } | {
            id: components["schemas"]["deviceId"] | components["schemas"]["deviceId"][];
            modelKey: components["schemas"]["aiportModelKey"];
        } | {
            id: components["schemas"]["linkStationId"] | components["schemas"]["linkStationId"][];
            modelKey: components["schemas"]["linkstationModelKey"];
        };
        /** eventAdd */
        eventAdd: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "add";
            item: components["schemas"]["event"];
        };
        event: components["schemas"]["ringEvent"] | components["schemas"]["sensorExtremeValueEvent"] | components["schemas"]["sensorWaterLeakEvent"] | components["schemas"]["sensorTamperEvent"] | components["schemas"]["sensorBatteryLowEvent"] | components["schemas"]["sensorAlarmEvent"] | components["schemas"]["sensorVapeEvent"] | components["schemas"]["sensorOpenEvent"] | components["schemas"]["sensorClosedEvent"] | components["schemas"]["sensorSmokeTestEvent"] | components["schemas"]["sensorSmokeBatteryLowEvent"] | components["schemas"]["sensorSmokeNeedsCleaningEvent"] | components["schemas"]["sensorSmokeFaultEvent"] | components["schemas"]["sensorCoFaultEvent"] | components["schemas"]["sensorSmokeEndOfLifeEvent"] | components["schemas"]["sensorMotionEvent"] | components["schemas"]["sensorButtonPressedEvent"] | components["schemas"]["lightMotionEvent"] | components["schemas"]["cameraMotionEvent"] | components["schemas"]["cameraSmartDetectAudioEvent"] | components["schemas"]["cameraSmartDetectZoneEvent"] | components["schemas"]["cameraSmartDetectLineEvent"] | components["schemas"]["cameraSmartDetectLoiterEvent"] | components["schemas"]["relayInputChangedEvent"] | components["schemas"]["cameraDigitalInputChangedEvent"] | components["schemas"]["alarmHubMotionEvent"] | components["schemas"]["alarmHubEntryOpenedEvent"] | components["schemas"]["alarmHubEntryClosedEvent"] | components["schemas"]["alarmHubSmokeEvent"] | components["schemas"]["alarmHubGlassBreakEvent"] | components["schemas"]["alarmHubButtonPressEvent"] | components["schemas"]["alarmHubTamperEvent"] | components["schemas"]["alarmHubDeviceTamperEvent"] | components["schemas"]["alarmHubRelaySwitchedEvent"] | components["schemas"]["alarmHubBatteryLowEvent"] | components["schemas"]["alarmHubBatteryConnectedEvent"] | components["schemas"]["nfcCardScannedEvent"] | components["schemas"]["fingerprintIdentifiedEvent"];
        /**
         * ringEvent
         * @description A device ring button has been pressed
         */
        ringEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "ring";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * eventId
         * @description The primary key of event
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        eventId: string;
        /**
         * eventModelKey
         * @description The model key of the event
         * @constant
         */
        eventModelKey: "event";
        /**
         * sensorExtremeValueEvent
         * @description The value of a metric measured by a sensor has gone in or out of range
         */
        sensorExtremeValueEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorExtremeValues";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description Name of the metric measured by the sensor
                 * @example {
                 *       "text": "temperature"
                 *     }
                 */
                sensorType: {
                    /** @enum {string} */
                    text: "temperature" | "light" | "humidity" | "aqi" | "vape" | "tvoc" | "pm1p0" | "pm2p5" | "pm4p0" | "pm10p0" | "nox" | "co2" | "voc";
                };
                sensorValue: {
                    text: components["schemas"]["sensorValue"];
                };
                status: {
                    text: components["schemas"]["sensorStatus"];
                };
            };
        };
        /**
         * sensorWaterLeakEvent
         * @description Water leak in the given mount point has started or ended
         */
        sensorWaterLeakEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorWaterLeak";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                sensorMountType: {
                    text: components["schemas"]["sensorMountType"];
                };
            };
        };
        /**
         * sensorTamperEvent
         * @description Sensor has started or finished being tampered with
         */
        sensorTamperEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorTamper";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorBatteryLowEvent
         * @description Sensor battery level is getting low
         */
        sensorBatteryLowEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorBatteryLow";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description Decimal value of the available sensor battery percentage
                 * @example {
                 *       "number": 95
                 *     }
                 */
                sensorBatteryPercentage: {
                    number: number;
                };
            };
        };
        /**
         * sensorAlarmEvent
         * @description Sensor has started or finished enduring an alarming state
         */
        sensorAlarmEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorAlarm";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description A type of sensor alarm
                 * @example {
                 *       "text": "CO"
                 *     }
                 */
                alarmType: {
                    /** @enum {string} */
                    text: "smoke" | "CO" | "glassBreak" | "sensorButtonPress" | "tamper" | "short" | "cut";
                };
            };
        };
        /**
         * sensorVapeEvent
         * @description Sensor has detected vape
         */
        sensorVapeEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorVape";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorOpenEvent
         * @description Sensor in a given mount type has entered an open state
         */
        sensorOpenEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorOpened";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                sensorMountType: {
                    text: components["schemas"]["sensorMountType"];
                };
            };
        };
        /**
         * sensorClosedEvent
         * @description Sensor in a given mount type has entered a closed state
         */
        sensorClosedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorClosed";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                sensorMountType: {
                    text: components["schemas"]["sensorMountType"];
                };
            };
        };
        /**
         * sensorSmokeTestEvent
         * @description Smoke detector test has been initiated
         */
        sensorSmokeTestEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorSmokeTest";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /** @enum {string} */
                source?: "remote" | "local";
            };
        };
        /**
         * sensorSmokeBatteryLowEvent
         * @description Smoke/CO detector internal battery is low (replacement required)
         */
        sensorSmokeBatteryLowEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorSmokeBatteryLow";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorSmokeNeedsCleaningEvent
         * @description Smoke sensor requires cleaning
         */
        sensorSmokeNeedsCleaningEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorSmokeNeedsCleaning";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorSmokeFaultEvent
         * @description Smoke sensor fault detected
         */
        sensorSmokeFaultEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorSmokeFault";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorCoFaultEvent
         * @description CO sensor fault detected
         */
        sensorCoFaultEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorCoFault";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorSmokeEndOfLifeEvent
         * @description Smoke/CO detector has reached end of service life
         */
        sensorSmokeEndOfLifeEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorSmokeEndOfLife";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorMotionEvent
         * @description Sensor has started or finished detecting motion
         */
        sensorMotionEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorMotion";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * sensorButtonPressedEvent
         * @description A sensor button has been pressed
         */
        sensorButtonPressedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sensorButtonPressed";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description The button that was pressed
                 * @example {
                 *       "text": "alarmHubButton"
                 *     }
                 */
                button: {
                    /** @enum {string} */
                    text: "function" | "alarmHubButton" | "arm" | "disarm" | "night" | "panic" | "left" | "right" | "input1" | "input2" | "main";
                };
            };
        };
        /**
         * lightMotionEvent
         * @description Floodlight has encountered motion
         */
        lightMotionEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "lightMotion";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            device: components["schemas"]["deviceId"];
        };
        /**
         * cameraMotionEvent
         * @description Camera has started or finished detecting motion
         */
        cameraMotionEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "motion";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * cameraSmartDetectAudioEvent
         * @description Camera has started or finished a smart audio-based detection
         */
        cameraSmartDetectAudioEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "smartAudioDetect";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            smartDetectTypes: ("alrmSmoke" | "alrmCmonx" | "alrmSiren" | "alrmBabyCry" | "alrmSpeak" | "alrmBark" | "alrmBurglar" | "alrmCarHorn" | "alrmGlassBreak")[] | null;
        };
        /**
         * cameraSmartDetectZoneEvent
         * @description Camera has started or finished a smart video-based zone detection
         */
        cameraSmartDetectZoneEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "smartDetectZone";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            smartDetectTypes: ("person" | "vehicle" | "package" | "licensePlate" | "face" | "animal")[] | null;
        };
        /**
         * cameraSmartDetectLineEvent
         * @description Camera has started or finished a smart video-based line detection
         */
        cameraSmartDetectLineEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "smartDetectLine";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            smartDetectTypes: ("person" | "vehicle" | "package" | "licensePlate" | "face" | "animal")[] | null;
        };
        /**
         * cameraSmartDetectLoiterEvent
         * @description Camera has started or finished a smart video-based loiter detection
         */
        cameraSmartDetectLoiterEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "smartDetectLoiterZone";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            smartDetectTypes: ("person" | "vehicle" | "package" | "licensePlate" | "face" | "animal")[] | null;
        };
        /**
         * relayInputChangedEvent
         * @description A relay input has changed state (circuit opened or closed)
         */
        relayInputChangedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "relayInputChanged";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description The state of the relay input circuit
                 * @example {
                 *       "text": "circuitOpen"
                 *     }
                 */
                inputState: {
                    /** @enum {string} */
                    text: "circuitClosed" | "circuitOpen";
                };
                /**
                 * @description The channel index of the relay input
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                inputChannel: {
                    text: string;
                };
            };
        };
        /**
         * cameraDigitalInputChangedEvent
         * @description An ONVIF camera digital input has changed state (circuit opened or closed)
         */
        cameraDigitalInputChangedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "cameraDigitalInputChanged";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: {
                /**
                 * @description The state of the relay input circuit
                 * @example {
                 *       "text": "circuitOpen"
                 *     }
                 */
                inputState: {
                    /** @enum {string} */
                    text: "circuitClosed" | "circuitOpen";
                };
                /**
                 * @description The ONVIF token of the camera digital input
                 * @example {
                 *       "text": "AlarmIn_0"
                 *     }
                 */
                inputToken?: {
                    text: string;
                };
                /**
                 * @description The channel index of the relay input
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                inputChannel?: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubMotionEvent
         * @description Alarm hub motion input has been triggered
         */
        alarmHubMotionEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubMotion";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubEntryOpenedEvent
         * @description Alarm hub entry sensor has opened
         */
        alarmHubEntryOpenedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubEntryOpened";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubEntryClosedEvent
         * @description Alarm hub entry sensor has closed
         */
        alarmHubEntryClosedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubEntryClosed";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubSmokeEvent
         * @description Alarm hub smoke detector has been triggered
         */
        alarmHubSmokeEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubSmoke";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description A type of sensor alarm
                 * @example {
                 *       "text": "CO"
                 *     }
                 */
                alarmType: {
                    /** @enum {string} */
                    text: "smoke" | "CO" | "glassBreak" | "sensorButtonPress" | "tamper" | "short" | "cut";
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubGlassBreakEvent
         * @description Alarm hub glass break detector has been triggered
         */
        alarmHubGlassBreakEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubGlassBreak";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description A type of sensor alarm
                 * @example {
                 *       "text": "CO"
                 *     }
                 */
                alarmType: {
                    /** @enum {string} */
                    text: "smoke" | "CO" | "glassBreak" | "sensorButtonPress" | "tamper" | "short" | "cut";
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubButtonPressEvent
         * @description Alarm hub emergency button has been pressed
         */
        alarmHubButtonPressEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubButtonPress";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description The button that was pressed
                 * @example {
                 *       "text": "alarmHubButton"
                 *     }
                 */
                button: {
                    /** @enum {string} */
                    text: "function" | "alarmHubButton" | "arm" | "disarm" | "night" | "panic" | "left" | "right" | "input1" | "input2" | "main";
                };
                /**
                 * @description A type of sensor alarm
                 * @example {
                 *       "text": "CO"
                 *     }
                 */
                alarmType: {
                    /** @enum {string} */
                    text: "smoke" | "CO" | "glassBreak" | "sensorButtonPress" | "tamper" | "short" | "cut";
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubTamperEvent
         * @description Alarm hub input has been tampered with
         */
        alarmHubTamperEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubTamper";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The alarm hub input pin channel
                 * @example {
                 *       "text": "0"
                 *     }
                 */
                pin: {
                    text: string;
                };
                /**
                 * @description The status of the alarm hub input
                 * @example {
                 *       "text": "alarm"
                 *     }
                 */
                status: {
                    text: string;
                };
                /**
                 * @description A type of sensor alarm
                 * @example {
                 *       "text": "CO"
                 *     }
                 */
                alarmType: {
                    /** @enum {string} */
                    text: "smoke" | "CO" | "glassBreak" | "sensorButtonPress" | "tamper" | "short" | "cut";
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the input
                 * @example {
                 *       "text": "Front Door Sensor"
                 *     }
                 */
                deviceName: {
                    text: string;
                };
            };
        };
        /**
         * alarmHubDeviceTamperEvent
         * @description Alarm hub device tamper status has changed
         */
        alarmHubDeviceTamperEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubDeviceTamper";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata?: {
                /**
                 * @description The physical tamper state of the alarm hub
                 * @example {
                 *       "text": "tampered"
                 *     }
                 */
                status: {
                    /** @enum {string} */
                    text: "tampered" | "restored";
                };
                /**
                 * @description The device ID of the alarm hub
                 * @example {
                 *       "text": "69a83414037dec03e4009a3c"
                 *     }
                 */
                deviceId: {
                    text: string;
                };
                /**
                 * @description The configured name of the alarm hub
                 * @example {
                 *       "text": "Alarm Hub"
                 *     }
                 */
                deviceName?: {
                    text: string;
                };
                userName?: string;
            };
        };
        /**
         * alarmHubRelaySwitchedEvent
         * @description Alarm hub relay output has been switched
         */
        alarmHubRelaySwitchedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubRelaySwitched";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * alarmHubBatteryLowEvent
         * @description Alarm hub battery level is low
         */
        alarmHubBatteryLowEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubBatteryLow";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * alarmHubBatteryConnectedEvent
         * @description Alarm hub battery has been connected
         */
        alarmHubBatteryConnectedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "alarmHubBatteryConnected";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
        };
        /**
         * nfcCardScannedEvent
         * @description An NFC card was scanned at a device
         */
        nfcCardScannedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "nfcCardScanned";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: components["schemas"]["nfcMetadata"];
        };
        /** nfcMetadata */
        nfcMetadata: {
            nfc: {
                /**
                 * @description The unique id of the UniFi Identity user. Matches the id field of the corresponding UlpUser. Matches the ucoreUserId field of the corresponding Protect User. Null if the credential was not recognized.
                 * @example a1b2c3d4-e5f6-7890-abcd-ef1234567890
                 * @example null
                 */
                ulpId: string | null;
            };
        };
        /**
         * fingerprintIdentifiedEvent
         * @description A fingerprint was scanned at a device
         */
        fingerprintIdentifiedEvent: {
            id: components["schemas"]["eventId"];
            modelKey: components["schemas"]["eventModelKey"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "fingerprintIdentified";
            /**
             * @description Unix timestamp of the start time of the event.
             * @example 1445408038748
             * @example 1741267544209
             */
            start: number;
            /**
             * @description Unix timestamp of the end time of the event.
             * @example 1445408048748
             * @example 1741267554209
             */
            end?: number | null;
            device: components["schemas"]["deviceId"];
            metadata: components["schemas"]["fingerprintMetadata"];
        };
        /** fingerprintMetadata */
        fingerprintMetadata: {
            fingerprint: {
                /**
                 * @description The unique id of the UniFi Identity user. Matches the id field of the corresponding UlpUser. Matches the ucoreUserId field of the corresponding Protect User. Null if the credential was not recognized.
                 * @example a1b2c3d4-e5f6-7890-abcd-ef1234567890
                 * @example null
                 */
                ulpId: string | null;
            };
        };
        /** eventUpdate */
        eventUpdate: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "update";
            item: components["schemas"]["event"];
        };
        /**
         * activePatrolSlotString
         * @description The slot number (0-4) of the patrol that is currently running, or null if no patrol is running
         * @example 0
         * @example 1
         * @example 2
         * @example 3
         * @example 4
         */
        activePatrolSlotString: string;
        /**
         * alarmTriggerId
         * @description User defined string used to trigger only specific alarms. Alarm should be configured with the same ID to be triggered.
         * @example AnyRandomString
         */
        alarmTriggerId: string;
        /** idRequiredError */
        idRequiredError: {
            /**
             * @description Error message
             * @example 'id' is required
             */
            error: string;
            /**
             * @description Name of the error
             * @example BAD_REQUEST
             */
            name: string;
            /**
             * @description An optional nested cause for the parent error
             * @example {
             *       "error": "Unexpected functionality error",
             *       "name": "UNKNOWN_ERROR"
             *     }
             */
            cause?: {
                [key: string]: unknown;
            };
        };
        /** armProfile */
        armProfile: {
            id: components["schemas"]["armProfileId"];
            name: components["schemas"]["armProfileName"];
            automations: components["schemas"]["automations"];
            creator: components["schemas"]["userId"] | null;
            schedules: components["schemas"]["schedules"];
            recordEverything: components["schemas"]["recordEverything"];
            activationDelay: components["schemas"]["activationDelay"];
            createdAt: components["schemas"]["createdAt"];
            updatedAt: components["schemas"]["updatedAt"];
        };
        /**
         * armProfileId
         * @description The primary key of armProfile
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        armProfileId: string;
        /**
         * armProfileName
         * @description Name of the arm profile.
         * @example Arm Profile
         */
        armProfileName: string;
        /**
         * automations
         * @description List of automation IDs associated with this arm profile.
         */
        automations: components["schemas"]["automationId"][];
        /**
         * automationId
         * @description The primary key of automation
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        automationId: string;
        /**
         * schedules
         * @description List of arm schedules.
         */
        schedules: components["schemas"]["armSchedule"][];
        /** armSchedule */
        armSchedule: {
            start: components["schemas"]["armScheduleStart"];
            end: components["schemas"]["armScheduleEnd"];
        };
        /**
         * armScheduleStart
         * @description Cron expression for the start time.
         * @example 0 0 * * *
         */
        armScheduleStart: string;
        /**
         * armScheduleEnd
         * @description Cron expression for the end time.
         * @example 0 0 * * *
         */
        armScheduleEnd: string;
        /**
         * recordEverything
         * @description Whether to record everything when this arm profile is active.
         * @example true
         * @example false
         */
        recordEverything: boolean;
        /**
         * activationDelay
         * @description Activation delay in milliseconds. Allowed values: 0 (none), 60000 (1 min), 300000 (5 min), 600000 (10 min).
         */
        activationDelay: 0 | 60000 | 300000 | 600000;
        /**
         * createdAt
         * @description Arm profile creation time.
         */
        createdAt: number;
        /**
         * updatedAt
         * @description Arm profile update time.
         */
        updatedAt: number;
        /** lcdMessage */
        lcdMessage: {
            /** @constant */
            type: "DO_NOT_DISTURB";
            /** @description UNIX timestamp when doorbell message should be removed (if not set then `nvr.doorbellSettings.defaultMessageResetTimeoutMs` is used, if set to `null` then interpreted as "forever") */
            resetAt?: number | null;
        } | {
            /** @constant */
            type: "LEAVE_PACKAGE_AT_DOOR";
            /** @description UNIX timestamp when doorbell message should be removed (if not set then `nvr.doorbellSettings.defaultMessageResetTimeoutMs` is used, if set to `null` then interpreted as "forever") */
            resetAt?: number | null;
        } | {
            /** @constant */
            type: "CUSTOM_MESSAGE";
            /** @description UNIX timestamp when doorbell message should be removed (if not set then `nvr.doorbellSettings.defaultMessageResetTimeoutMs` is used, if set to `null` then interpreted as "forever") */
            resetAt?: number | null;
            /**
             * @description The custom text message to show on the doorbell
             * @example Hello world!
             */
            text: string;
        } | {
            /** @constant */
            type: "IMAGE";
            /** @description UNIX timestamp when doorbell message should be removed (if not set then `nvr.doorbellSettings.defaultMessageResetTimeoutMs` is used, if set to `null` then interpreted as "forever") */
            resetAt?: number | null;
            /**
             * @description The ID of the custom image to show on the doorbell
             * @example 34225b30-fe6a-11af-1690-29424bd911c2.png
             */
            text: string;
        };
        /**
         * createdQualities
         * @description Array of quality levels of RTSPS streams. All qualities (high, medium, low) are available for all cameras. The package quality is only available for cameras with hasPackageCamera: true.
         * @example [
         *       "high",
         *       "medium"
         *     ]
         */
        createdQualities: components["schemas"]["channelQuality"][];
        /**
         * channelQuality
         * @enum {string}
         */
        channelQuality: "high" | "medium" | "low" | "package";
        /**
         * createdRtspsStreams
         * @description The RTSPS stream URLs for the camera
         * @example {
         *       "high": "rtsps://192.168.1.1:7441/5nPr7RCmueGTKMP7?enableSrtp",
         *       "medium": "rtsps://192.168.1.1:7441/AbUgnDb5IqIEMidk?enableSrtp"
         *     }
         */
        createdRtspsStreams: {
            /** Format: uri */
            high?: string;
            /** Format: uri */
            medium?: string;
            /** Format: uri */
            low?: string;
            /** Format: uri */
            package?: string;
        };
        /**
         * removedQualities
         * @description The array of quality levels for the RTSPS streams to be removed. All qualities (high, medium, low) are available for all cameras. The package quality is only available for cameras with hasPackageCamera: true.
         * @example [
         *       "high",
         *       "medium"
         *     ]
         */
        removedQualities: components["schemas"]["channelQuality"][] | components["schemas"]["channelQuality"];
        /**
         * existingRtspsStreams
         * @description The RTSPS stream URLs for the camera. All qualities (high, medium, low) are available for all cameras. The package quality is only available for cameras with hasPackageCamera: true.
         * @example {
         *       "high": "rtsps://192.168.1.1:7441/5nPr7RCmueGTKMP7?enableSrtp",
         *       "medium": "rtsps://192.168.1.1:7441/AbUgnDb5IqIEMidk?enableSrtp",
         *       "low": null,
         *       "package": null
         *     }
         */
        existingRtspsStreams: {
            /** Format: uri */
            high?: string | null;
            /** Format: uri */
            medium?: string | null;
            /** Format: uri */
            low?: string | null;
            /** Format: uri */
            package?: string | null;
        };
        /**
         * channel
         * @description Camera channel to capture snapshot from. Use "package" for cameras with a package camera (hasPackageCamera: true).
         * @enum {string}
         */
        snapshotChannel: "main" | "package";
        /**
         * forceHighQuality
         * @description Whether to force 1080P or higher resolution snapshot
         * @enum {string}
         */
        forceHighQuality: "true" | "false";
        /**
         * talkbackSession
         * @description Talkback session information
         * @example {
         *       "url": "rtp://192.168.1.123:7004",
         *       "codec": "opus",
         *       "samplingRate": 24000,
         *       "bitsPerSample": 16
         *     }
         */
        talkbackSession: {
            url: components["schemas"]["talkbackStreamUrl"];
            codec: components["schemas"]["talkbackStreamCodec"];
            samplingRate: components["schemas"]["talkbackStreamSamplingRate"];
            bitsPerSample: components["schemas"]["talkbackStreamBitsPerSample"];
        };
        /**
         * talkbackStreamUrl
         * Format: uri
         * @description Talkback stream URL
         * @example rtp://192.168.1.123:7004
         */
        talkbackStreamUrl: string;
        /**
         * talkbackStreamCodec
         * @description Audio format to use.
         * @example opus
         * @example aac
         */
        talkbackStreamCodec: string;
        /**
         * talkbackStreamSamplingRate
         * @description Sampling Rate.
         * @example 24000
         * @example 22050
         */
        talkbackStreamSamplingRate: number;
        /**
         * talkbackStreamBitsPerSample
         * @description Bits per sample.
         * @example 16
         */
        talkbackStreamBitsPerSample: number;
        /**
         * sirenDurationSeconds
         * @description Duration of the siren activation in seconds.
         * @example 5
         * @example 10
         * @example 20
         * @example 30
         */
        sirenDurationSeconds: 5 | 10 | 20 | 30;
        /**
         * assetFileType
         * @description Device asset file type
         * @enum {string}
         */
        assetFileType: "animations";
        /** fileSchema */
        fileSchema: {
            name: components["schemas"]["fileName"];
            type: components["schemas"]["assetFileType"];
            originalName?: components["schemas"]["fileOriginalName"];
            path: components["schemas"]["filePath"];
        };
        /**
         * fileName
         * @description Unique ID for the asset file
         * @example 34225b30-fe6a-11af-1690-29424bd911c2.png
         */
        fileName: string;
        /**
         * fileOriginalName
         * @description Original filename of the uploaded file
         * @example welcome-animation.png
         */
        fileOriginalName: string;
        /**
         * filePath
         * @description Path to the file on the filesystem
         * @example /data/animations/34225b30-fe6a-11af-1690-29424bd911c2.png
         */
        filePath: string;
        /** user */
        user: {
            id: components["schemas"]["userId"];
            /**
             * @description The user name (first-name + last-name).
             * @example John Doe
             */
            name: string;
            /**
             * @description The user first-name.
             * @example John
             */
            firstName: string | null;
            /**
             * @description The user last-name.
             * @example Doe
             */
            lastName: string | null;
            /**
             * @description The user email.
             * @example john.doe@example.com
             */
            email: string | null;
            /**
             * @description The unique id of the UniFi Identity user. Matches the id field of the corresponding UlpUser.
             * @example a1b2c3d4-e5f6-7890-abcd-ef1234567890
             */
            ucoreUserId: string | null;
            modelKey: components["schemas"]["userModelKey"];
        };
        /**
         * userModelKey
         * @description The model key of the user
         * @constant
         */
        userModelKey: "user";
        /**
         * ulpUserId
         * @description The primary key of ulpUser
         * @example 66d025b301ebc903e80003ea
         * @example 672094f900e26303e800062a
         */
        ulpUserId: string;
        /** ulpUser */
        ulpUser: {
            id: components["schemas"]["ulpUserId"];
            /**
             * @description The first name of ulp user
             * @example John
             */
            firstName: string;
            /**
             * @description The last name of ulp user
             * @example Doe
             */
            lastName: string;
            /**
             * @description Fullname of ulp user
             * @example John Doe
             */
            fullName: string;
            /**
             * @description Email of ulp user, empty string when none is set in UniFi Identity
             * @example john.doe@example.com
             * @example
             */
            email: string;
            /**
             * @description Active status of ulp user
             * @example ACTIVE
             * @enum {string}
             */
            status: "ACTIVE" | "DEACTIVATED";
            modelKey: components["schemas"]["ulpUserModelKey"];
        };
        /**
         * ulpUserModelKey
         * @description The model key of the ulpUser
         * @constant
         */
        ulpUserModelKey: "ulpUser";
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
