// P1.3/P1.4 (CON-3, SPEC §6, P0.4 §4): the adapter that binds P1.2's pin registry to P1.1's config
// store. It is small but it is the piece that decides *where* a pin is kept, and a pin kept
// somewhere nothing reads again is worse than no pin at all: the next certificate would be trusted
// without the user ever being asked.
import { ConsoleConfigSchema, type ConsoleConfig } from '@shared/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessEndpoint, protectEndpoint } from '../../src/main/console/endpoints'
import { createConfigPinStore } from '../../src/main/tls/configPinStore'
import { createPinRegistry } from '../../src/main/tls/pinning'

const FP_A =
  '7B:12:B7:0C:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5'
const FP_B =
  '0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9'

/** A store over a `console` block the test can read back, like main's live config. */
function storeOver(initial: Partial<ConsoleConfig>) {
  let current = ConsoleConfigSchema.parse({ host: '192.0.2.10', ...initial })
  const setConsole = vi.fn((next: ConsoleConfig) => {
    current = next
  })
  const store = createConfigPinStore({ getConsole: () => current, setConsole })
  return {
    store,
    setConsole,
    get console() {
      return current
    },
    /** Simulates the user editing Settings while the registry is alive. */
    edit(patch: Partial<ConsoleConfig>) {
      current = { ...current, ...patch }
    },
  }
}

let fixture: ReturnType<typeof storeOver>

beforeEach(() => {
  fixture = storeOver({})
})

describe('createConfigPinStore', () => {
  it('reads each endpoint from its own field', () => {
    fixture.edit({ certFingerprint: FP_A, accessCertFingerprint: FP_B })
    expect(fixture.store.get(protectEndpoint(fixture.console).hostPort)).toBe(FP_A)
    expect(fixture.store.get(accessEndpoint(fixture.console).hostPort)).toBe(FP_B)
  })

  it('reads null while nothing is pinned yet (CON-3 first run)', () => {
    expect(fixture.store.get(protectEndpoint(fixture.console).hostPort)).toBeNull()
    expect(fixture.store.get(accessEndpoint(fixture.console).hostPort)).toBeNull()
  })

  it('writes the console pin to certFingerprint and nothing else', () => {
    fixture.store.set(protectEndpoint(fixture.console).hostPort, FP_A)
    expect(fixture.setConsole).toHaveBeenCalledTimes(1)
    expect(fixture.console.certFingerprint).toBe(FP_A)
    expect(fixture.console.accessCertFingerprint).toBeNull()
  })

  it('writes the Access pin to accessCertFingerprint and nothing else', () => {
    fixture.store.set(accessEndpoint(fixture.console).hostPort, FP_B)
    expect(fixture.console.accessCertFingerprint).toBe(FP_B)
    expect(fixture.console.certFingerprint).toBeNull()
  })

  it('does not save when the pin is already the stored one', () => {
    // Saving on every read-back would rewrite config.json for nothing on each connect.
    fixture.edit({ certFingerprint: FP_A })
    fixture.store.set(protectEndpoint(fixture.console).hostPort, FP_A)
    expect(fixture.setConsole).not.toHaveBeenCalled()
  })

  it('refuses an endpoint config.json has nowhere to keep', () => {
    // Silently dropping it would leave the registry believing the pin was stored.
    expect(() => {
      fixture.store.set('198.51.100.7:443', FP_A)
    }).toThrow(/Refusing to store a TLS pin/)
    expect(fixture.setConsole).not.toHaveBeenCalled()
    expect(fixture.store.get('198.51.100.7:443')).toBeNull()
  })

  it('treats the console pin as the single pin when both endpoints are the same host:port', () => {
    // SPEC §5.2: on newer firmware Access may answer behind the console proxy on 443. One
    // endpoint presents one certificate, so there is one pin and `certFingerprint` is it.
    const proxied = storeOver({ accessBaseUrl: 'https://192.0.2.10/proxy/access/api/v1/developer' })
    const protect = protectEndpoint(proxied.console)
    expect(accessEndpoint(proxied.console).hostPort).toBe(protect.hostPort)
    proxied.store.set(protect.hostPort, FP_A)
    expect(proxied.console.certFingerprint).toBe(FP_A)
    expect(proxied.console.accessCertFingerprint).toBeNull()
    expect(proxied.store.get(protect.hostPort)).toBe(FP_A)
  })

  it('reads nothing and stores nothing while no console host is set (CON-1)', () => {
    // `get` must not throw here: the registry asks before the user has typed a host.
    const empty = storeOver({ host: '' })
    expect(empty.store.get('192.0.2.10:443')).toBeNull()
    expect(() => {
      empty.store.set('192.0.2.10:443', FP_A)
    }).toThrow(/Refusing to store a TLS pin/)
  })

  it('follows a host change without being rebuilt', () => {
    fixture.edit({ host: 'udm.local', certFingerprint: FP_A })
    expect(fixture.store.get('udm.local:443')).toBe(FP_A)
    // The old address is no longer this console, so its pin is not ours to report.
    expect(fixture.store.get('192.0.2.10:443')).toBeNull()
  })
})

describe('with the real pin registry (CON-3 end to end)', () => {
  it('accepts a first pin into config.json and reads it back', () => {
    const registry = createPinRegistry(fixture.store)
    const protect = protectEndpoint(fixture.console)
    expect(registry.pinnedFingerprint(protect.host, protect.port)).toBeNull()
    registry.acceptPin(protect.host, protect.port, FP_A)
    expect(fixture.console.certFingerprint).toBe(FP_A)
    expect(registry.pinnedFingerprint(protect.host, protect.port)).toBe(FP_A)
  })

  it('keeps the two endpoints apart', () => {
    const registry = createPinRegistry(fixture.store)
    const protect = protectEndpoint(fixture.console)
    const access = accessEndpoint(fixture.console)
    registry.acceptPin(protect.host, protect.port, FP_A)
    registry.acceptPin(access.host, access.port, FP_B)
    expect(fixture.console.certFingerprint).toBe(FP_A)
    expect(fixture.console.accessCertFingerprint).toBe(FP_B)
    expect(registry.pinnedFingerprint(access.host, access.port)).toBe(FP_B)
  })

  it('refuses to replace a pin except through repin (CON-3)', () => {
    const registry = createPinRegistry(fixture.store)
    const protect = protectEndpoint(fixture.console)
    registry.acceptPin(protect.host, protect.port, FP_A)
    expect(() => {
      registry.acceptPin(protect.host, protect.port, FP_B)
    }).toThrow(/already pinned to a different certificate/)
    expect(fixture.console.certFingerprint).toBe(FP_A)
    registry.repin(protect.host, protect.port, FP_B)
    expect(fixture.console.certFingerprint).toBe(FP_B)
  })

  it('lets the user recover from a corrupt stored pin with repin', () => {
    // A hand-edited config.json: `get` must not read as "unpinned", or the next certificate would
    // be trusted silently.
    fixture.edit({ certFingerprint: 'not-a-fingerprint' })
    const registry = createPinRegistry(fixture.store)
    const protect = protectEndpoint(fixture.console)
    expect(() => registry.pinnedFingerprint(protect.host, protect.port)).toThrow(
      /not a SHA-256 fingerprint/,
    )
    registry.repin(protect.host, protect.port, FP_A)
    expect(fixture.console.certFingerprint).toBe(FP_A)
  })
})
