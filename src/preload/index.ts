// contextBridge: exposes typed, validated window.viewProtect API.
// P0.1: only the app version. IPC-backed methods arrive in P1.5.
import { contextBridge } from 'electron'
import { BRIDGE_KEY, type ViewProtectApi } from '@shared/ipc'

// __APP_VERSION__ is replaced at build time with package.json's version (electron.vite.config.ts).
const api: ViewProtectApi = Object.freeze({ version: __APP_VERSION__ })

contextBridge.exposeInMainWorld(BRIDGE_KEY, api)
