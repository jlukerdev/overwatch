import type { ViewProtectApi } from '@shared/ipc'

declare global {
  interface Window {
    readonly viewProtect: ViewProtectApi
  }
}

export {}
