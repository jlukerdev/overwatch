// Binds P1.2's pin registry to P1.1's config store: the `PinStore` port, backed by the two
// fingerprint fields of SPEC §6 (`console.certFingerprint` and `console.accessCertFingerprint`).
//
// It is a separate file from pinning.ts on purpose — that module must not know about the config
// (its header says so) — and it is where the mapping from `host:port` to a config field lives,
// because that mapping is the only reason the two fields exist: **pinning is per host:port**, and
// the Access developer API answers on 12445 while Protect is behind 443 (P0.4 §4).
//
// An endpoint that is neither of those two is refused rather than stored somewhere plausible: a pin
// the app cannot find again is a pin that silently re-trusts the next certificate it sees (CON-3).
import { accessEndpoint, protectEndpoint } from '../console/endpoints'
import type { PinStore } from './pinning'
import type { ConsoleConfig } from '@shared/models'

export interface ConfigPinStoreOptions {
  /**
   * The console settings as they are now. Read on every call, so editing the host in Settings
   * changes which endpoint a pin belongs to without rebuilding the registry.
   */
  readonly getConsole: () => ConsoleConfig
  /**
   * Persists the changed console block. **Synchronous**, because `PinStore.set` is: the registry
   * commits a pin inside the user's "Trust this certificate" click (CON-3). The caller (main) is
   * what makes the write durable and what reports a failed save — this module cannot, since it has
   * no logger and no UI.
   */
  readonly setConsole: (next: ConsoleConfig) => void
}

/** Which config field holds the pin for an endpoint. */
type PinField = 'certFingerprint' | 'accessCertFingerprint'

export function createConfigPinStore(options: ConfigPinStoreOptions): PinStore {
  /**
   * Resolves an endpoint without letting an unusable config throw out of `get`/`set`. A config
   * with no host yet (CON-1) simply matches nothing, which reads as "no pin".
   */
  const hostPortOf = (resolve: (c: ConsoleConfig) => { hostPort: string }): string | null => {
    try {
      return resolve(options.getConsole()).hostPort
    } catch {
      return null
    }
  }

  /**
   * Protect wins when both endpoints are the same `host:port` — which happens if the Access API is
   * reached through the console proxy on 443 (SPEC §5.2). One endpoint presents one certificate, so
   * one pin covers it, and `certFingerprint` is that pin.
   */
  const fieldFor = (hostPort: string): PinField | null => {
    if (hostPort === hostPortOf(protectEndpoint)) return 'certFingerprint'
    if (hostPort === hostPortOf(accessEndpoint)) return 'accessCertFingerprint'
    return null
  }

  return {
    get(hostPort) {
      const field = fieldFor(hostPort)
      if (field === null) return null
      return options.getConsole()[field]
    },

    set(hostPort, fingerprint256) {
      const field = fieldFor(hostPort)
      if (field === null) {
        throw new Error(
          `Refusing to store a TLS pin for ${hostPort}: it is neither the console's Protect ` +
            'endpoint nor its Access endpoint, so config.json has nowhere to keep it and the pin ' +
            'would be lost (CON-3).',
        )
      }
      const current = options.getConsole()
      if (current[field] === fingerprint256) return
      options.setConsole({ ...current, [field]: fingerprint256 })
    },
  }
}
