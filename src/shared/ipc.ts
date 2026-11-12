// Typed IPC contract (channels, request/response zod schemas).
// P0.1: only the startup bridge contract. Channels + zod schemas arrive in P1.5.

/** Global name the preload exposes the API under (`window.viewProtect`). */
export const BRIDGE_KEY = 'viewProtect'

/** The API the preload exposes on `window.viewProtect`. */
export interface ViewProtectApi {
  readonly version: string
}
