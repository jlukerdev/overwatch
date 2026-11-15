// P1.5: the IPC contract itself (src/shared/ipc.ts) — the channel table, the `{ ok }` envelope and
// the request schemas both ends validate against.
//
// The point of testing a file of schemas is the invariants that no type can state: that no channel
// string is used twice, that the secret-key list has not drifted from main's own, that a request
// schema really does trim and default what the preload promises it does, and above all that
// **nothing shaped like a secret can appear in `AppState`** (CON-2, NFR-9) — the one rule in this
// file whose violation would be a security bug rather than a bug.
import {
  AppStateSchema,
  ConsoleInputSchema,
  AcceptCertInputSchema,
  EndpointInputSchema,
  EnsureStreamInputSchema,
  IPC,
  IPC_ERROR_KINDS,
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_EVENTS,
  ipcFail,
  ipcOk,
  ipcResultSchema,
  SECRET_KEYS,
  SecretInputSchema,
  SetLastViewInputSchema,
  SetViewsInputSchema,
  SnapshotInputSchema,
  SnapshotResultSchema,
  type AppState,
} from '@shared/ipc'
import { STREAM_QUALITIES } from '@shared/quality'
import { streamHandle } from '@shared/streams'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SECRET_KEYS as MAIN_SECRET_KEYS } from '../../src/main/secrets/secrets'

/** A fully populated state, so the walker below sees every key the schema can produce. */
function sampleState(): AppState {
  return AppStateSchema.parse({
    version: '0.1.0',
    settings: {
      console: {
        host: 'udm.local:8443',
        certFingerprint: 'AA:BB',
        accessEnabled: true,
        accessBaseUrl: 'https://udm.local:12445/api/v1/developer',
        accessCertFingerprint: 'CC:DD',
      },
      doorLinks: { 'cam-1': 'door-1' },
      views: [],
      lastViewId: null,
      streams: {},
      ui: {},
    },
    keystoreAvailable: true,
    secretsStored: { protectApiKey: true, accessToken: true },
    connection: {
      protect: { endpoint: 'protect', phase: 'connected', updatedAt: 1 },
      access: { endpoint: 'access', phase: 'disabled', updatedAt: 1 },
    },
    cameras: [{ id: 'cam-1', name: 'Driveway' }],
  })
}

describe('the channel table', () => {
  it('uses each channel string once', () => {
    const all = [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS]
    expect(new Set(all).size).toBe(all.length)
  })

  it('namespaces every channel, so nothing can collide with Electron or a dependency', () => {
    for (const channel of [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS]) {
      expect(channel.startsWith('vp:')).toBe(true)
    }
  })

  it('covers every call and event in the exported tables', () => {
    expect(IPC_CHANNELS).toHaveLength(Object.keys(IPC).length)
    expect(IPC_EVENT_CHANNELS).toHaveLength(Object.keys(IPC_EVENTS).length)
  })
})

describe('the secret-key list', () => {
  // src/shared may not import from src/main, so the two lists are written out twice. This is the
  // only thing holding them together: a key added to the keystore and not to the contract would be
  // unreachable from Settings, and the reverse would be an `invalid-request` at runtime.
  it('matches the keystore keys in src/main/secrets', () => {
    expect([...SECRET_KEYS].sort()).toEqual([...MAIN_SECRET_KEYS].sort())
  })
})

describe('the result envelope', () => {
  const schema = ipcResultSchema(z.object({ answer: z.number() }))

  it('accepts a success and a failure', () => {
    expect(schema.parse(ipcOk({ answer: 42 }))).toEqual({ ok: true, value: { answer: 42 } })
    expect(schema.parse(ipcFail('auth', 'The API key was rejected.'))).toEqual({
      ok: false,
      error: {
        kind: 'auth',
        message: 'The API key was rejected.',
        endpoint: null,
        retryable: false,
      },
    })
  })

  it('rejects a success with no value and a failure with an unknown kind', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false)
    expect(schema.safeParse({ ok: false, error: { kind: 'nope', message: 'x' } }).success).toBe(
      false,
    )
  })

  it('defaults the two optional error fields, so the renderer never reads undefined', () => {
    const failure = ipcFail('timeout', 'The console did not answer.', {
      endpoint: 'udm.local:443',
      retryable: true,
    })
    expect(failure).toEqual({
      ok: false,
      error: {
        kind: 'timeout',
        message: 'The console did not answer.',
        endpoint: 'udm.local:443',
        retryable: true,
      },
    })
  })
})

describe('request schemas', () => {
  it('trims the host but leaves its syntax to main (CON-1, SPEC §6)', () => {
    const parsed = ConsoleInputSchema.parse({
      host: '  udm.local:8443  ',
      accessEnabled: false,
      accessBaseUrl: null,
    })
    expect(parsed.host).toBe('udm.local:8443')
    // `parseConsoleHost` is the authority, so a scheme is not rejected here — main's message is.
    expect(
      ConsoleInputSchema.safeParse({
        host: 'http://udm.local',
        accessEnabled: false,
        accessBaseUrl: null,
      }).success,
    ).toBe(true)
  })

  it('allows an empty host (not configured yet) but not an empty Access base URL', () => {
    expect(
      ConsoleInputSchema.parse({ host: '', accessEnabled: false, accessBaseUrl: null }),
    ).toEqual({ host: '', accessEnabled: false, accessBaseUrl: null })
    // An emptied field is sent as `null`. `ConsoleConfigSchema` has no empty-string arm, so
    // accepting one here would pass IPC validation and then be unstorable.
    expect(
      ConsoleInputSchema.safeParse({ host: '', accessEnabled: false, accessBaseUrl: '' }).success,
    ).toBe(false)
  })

  it('rejects an Access base URL that is not an https URL (CON-2, R5)', () => {
    for (const accessBaseUrl of [
      // `new URL()` reads this as the scheme `udm.local:` plus a path, so `z.url()` alone passes it.
      'udm.local:12445',
      'http://udm.local:12445/api/v1/developer',
      'not a url',
    ]) {
      expect(
        ConsoleInputSchema.safeParse({ host: 'udm.local', accessEnabled: true, accessBaseUrl })
          .success,
        accessBaseUrl,
      ).toBe(false)
    }
    expect(
      ConsoleInputSchema.safeParse({
        host: 'udm.local',
        accessEnabled: true,
        accessBaseUrl: 'https://udm.local:12445/api/v1/developer',
      }).success,
    ).toBe(true)
  })

  it('trims a pasted credential and refuses one that is only whitespace', () => {
    // A key copied out of the console UI usually carries a trailing newline.
    expect(SecretInputSchema.parse({ key: 'protectApiKey', value: ' abc123\n' })).toEqual({
      key: 'protectApiKey',
      value: 'abc123',
    })
    expect(SecretInputSchema.safeParse({ key: 'protectApiKey', value: '   ' }).success).toBe(false)
  })

  it('rejects a credential for a key the keystore does not have', () => {
    expect(SecretInputSchema.safeParse({ key: 'rtspsUrl', value: 'x' }).success).toBe(false)
  })

  it('defaults snapshots to the small image (SPEC §5.1: highQuality=true is a 400 elsewhere)', () => {
    expect(SnapshotInputSchema.parse({ cameraId: 'cam-1' })).toEqual({
      cameraId: 'cam-1',
      highQuality: false,
    })
  })

  it('requires a fingerprint on accept, because the user accepts what they were shown (CON-3)', () => {
    expect(
      AcceptCertInputSchema.safeParse({ endpoint: 'protect', fingerprint256: '' }).success,
    ).toBe(false)
    expect(EndpointInputSchema.safeParse({ endpoint: 'nvr' }).success).toBe(false)
  })

  it('takes a camera and a stream quality for ensureStream (QUAL-8, CAM-4)', () => {
    for (const quality of STREAM_QUALITIES) {
      expect(EnsureStreamInputSchema.parse({ cameraId: 'cam-1', quality })).toEqual({
        cameraId: 'cam-1',
        quality,
      })
    }
    // A `StreamQuality`, so a doorbell's package channel is addressable — but nothing else: an
    // unvalidated quality would reach `<cameraId>_<quality>` and register a stream Protect has no
    // alias for (ARCHITECTURE §2 rule 3).
    for (const bad of [
      { cameraId: '', quality: 'low' },
      { cameraId: 'cam-1', quality: 'ultra' },
      { cameraId: 'cam-1' },
    ]) {
      expect(EnsureStreamInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('validates every View in setViews, tiling included (P3.1, SPEC §6)', () => {
    const view = (id: string, cells: unknown[]) => ({ id, name: id, cols: 2, rows: 1, cells })
    const good = view('v1', [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
    ])
    const parsed = SetViewsInputSchema.parse({ views: [good], lastViewId: 'v1' })
    // Defaults are filled in here, so main stores exactly what the contract produced.
    expect(parsed.views[0]).toMatchObject({ aspect: { w: 16, h: 9 }, gap: 0, fit: 'contain' })
    expect(SetViewsInputSchema.parse({ views: [], lastViewId: null }).views).toEqual([])

    const holey = SetViewsInputSchema.safeParse({
      views: [view('v1', [{ col: 0, row: 0 }])],
      lastViewId: null,
    })
    expect(holey.success).toBe(false)
    const spanned = SetViewsInputSchema.safeParse({
      views: [view('v1', [{ col: 0, row: 0, colSpan: 2 }])],
      lastViewId: null,
    })
    expect(spanned.success).toBe(true)
  })

  it('refuses duplicate View ids, and a lastViewId that names none of them', () => {
    const view = (id: string) => ({ id, name: id, cols: 1, rows: 1, cells: [{ col: 0, row: 0 }] })
    const dup = SetViewsInputSchema.safeParse({
      views: [view('a'), view('b'), view('a')],
      lastViewId: 'a',
    })
    expect(dup.success).toBe(false)
    if (!dup.success) {
      expect(dup.error.issues).toHaveLength(1)
      expect(dup.error.issues[0]?.path).toEqual(['views', 2, 'id'])
      expect(dup.error.issues[0]?.message).toContain('views[0]')
    }
    const dangling = SetViewsInputSchema.safeParse({ views: [view('a')], lastViewId: 'b' })
    expect(dangling.success).toBe(false)
    if (!dangling.success) expect(dangling.error.issues[0]?.path).toEqual(['lastViewId'])
    expect(SetViewsInputSchema.safeParse({ views: [view('a')], lastViewId: '' }).success).toBe(
      false,
    )
  })

  it('takes a View id or null for setLastView', () => {
    expect(SetLastViewInputSchema.parse({ viewId: 'v1' })).toEqual({ viewId: 'v1' })
    expect(SetLastViewInputSchema.parse({ viewId: null })).toEqual({ viewId: null })
    expect(SetLastViewInputSchema.safeParse({ viewId: '' }).success).toBe(false)
    expect(SetLastViewInputSchema.safeParse({}).success).toBe(false)
  })

  it('accepts undefined for the calls that take no payload', () => {
    for (const spec of [IPC.getState, IPC.testConnection, IPC.connect, IPC.listCameras]) {
      expect(spec.request.safeParse(undefined).success).toBe(true)
      expect(spec.request.safeParse({ sneaky: true }).success).toBe(false)
    }
  })
})

describe('SnapshotResultSchema', () => {
  it('takes bytes, not a string', () => {
    const ok = SnapshotResultSchema.safeParse({
      state: 'ok',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8]),
      capturedAt: 1,
    })
    expect(ok.success).toBe(true)
    // A data URL would put a megabyte of base64 on the string heap for every thumbnail.
    expect(
      SnapshotResultSchema.safeParse({
        state: 'ok',
        mimeType: 'image/jpeg',
        bytes: 'data:image/jpeg;base64,/9j/',
        capturedAt: 1,
      }).success,
    ).toBe(false)
  })

  it('carries CAM-3’s offline case as a state, not as an error', () => {
    expect(
      SnapshotResultSchema.parse({ state: 'unavailable', reason: 'The camera is offline.' }),
    ).toEqual({ state: 'unavailable', reason: 'The camera is offline.' })
  })
})

describe('event payloads', () => {
  it('parses a camera state change and refuses an empty id', () => {
    expect(
      IPC_EVENTS.cameraState.payload.parse({ cameraId: 'cam-1', state: 'DISCONNECTED' }),
    ).toEqual({ cameraId: 'cam-1', state: 'DISCONNECTED' })
    expect(
      IPC_EVENTS.cameraState.payload.safeParse({ cameraId: '', state: 'CONNECTED' }).success,
    ).toBe(false)
  })

  it('parses the whole inventory, since GET /v1/cameras stays the authority (R11)', () => {
    expect(IPC_EVENTS.cameras.payload.parse([{ id: 'cam-1' }])).toHaveLength(1)
  })

  it('tells a new go2rtc port apart from no go2rtc at all (P2.1/P2.2, gate G2)', () => {
    const payload = IPC_EVENTS.streamRuntime.payload
    expect(payload.parse({ state: 'up', port: 45678, epoch: 2 })).toEqual({
      state: 'up',
      port: 45678,
      epoch: 2,
    })
    expect(payload.parse({ state: 'down' })).toEqual({ state: 'down' })
    // No nullable port: the renderer reads which case happened instead of inferring it.
    expect(payload.safeParse({ state: 'up', port: null, epoch: 2 }).success).toBe(false)
  })
})

describe('the stream contract (CON-2, NFR-9)', () => {
  it('answers ensureStream with a loopback handle and nothing else', () => {
    const handle = streamHandle({ cameraId: 'cam-1', quality: 'low', port: 45678, epoch: 1 })
    expect(IPC.ensureStream.value.parse(handle)).toEqual(handle)
    expect(handle.wsUrl.startsWith('ws://127.0.0.1:')).toBe(true)
    // The same rule the `AppState` walker below enforces, for the one payload that is about
    // streaming: an RTSPS URL or a go2rtc credential reaching the renderer is the CON-2 violation
    // the whole main/renderer split exists to prevent.
    const forbidden = /api[-_]?key|token|secret|password|credential|rtsps?|stream[-_]?url/i
    for (const [key, value] of Object.entries(handle)) {
      expect(forbidden.test(key), key).toBe(false)
      expect(forbidden.test(String(value)), `${key}=${String(value)}`).toBe(false)
    }
  })

  it('has no release call: the player’s closed socket is the release (ARCHITECTURE §2 rule 3)', () => {
    // go2rtc opens the upstream RTSPS session only while a consumer is attached, so a release call
    // would be a second lifecycle for the renderer to get wrong — and the app never DELETEs a
    // Protect stream (QUAL-8: they may be shared with other integrations).
    for (const name of Object.keys(IPC)) {
      expect(/release|delete|destroy|stop.*stream/i.test(name), name).toBe(false)
    }
  })

  it('has a kind for the gateway being down, distinct from a camera being offline', () => {
    // Added in P2.2. A cell has to show "video unavailable, retrying" rather than CAM-3's offline
    // camera or a Settings problem; `unavailable` means the *console* said no.
    expect(IPC_ERROR_KINDS).toContain('gateway-down')
    expect(
      ipcFail('gateway-down', 'The video gateway is restarting.', { retryable: true }).ok,
    ).toBe(false)
  })
})

describe('AppState (CON-2, NFR-9)', () => {
  /** Every key path in a parsed state, so a field added with a default cannot slip through. */
  function keyPaths(value: unknown, prefix = '', depth = 0): string[] {
    if (depth > 8 || value === null || typeof value !== 'object') return []
    if (Array.isArray(value))
      return value.flatMap((item) => keyPaths(item, `${prefix}[]`, depth + 1))
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`
      return [path, ...keyPaths(child, path, depth + 1)]
    })
  }

  it('holds nothing that looks like a secret or a stream URL', () => {
    // The renderer gets booleans for "is a credential stored" and loopback go2rtc names for video
    // (P2.2). An API key, an Access token or an RTSPS URL reaching this object would be the CON-2
    // violation the whole split exists to prevent, so the guard is on the names as well as the
    // values: `secretsStored.protectApiKey` is a boolean and is allowed, a string would not be.
    const forbidden = /api[-_]?key|token|secret|password|credential|rtsps?|stream[-_]?url/i
    const state = sampleState()
    const flat: Record<string, unknown> = {}
    const collect = (value: unknown, prefix: string, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== 'object') {
        flat[prefix] = value
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          collect(item, `${prefix}[${String(i)}]`, depth + 1)
        })
        return
      }
      for (const [key, child] of Object.entries(value)) {
        collect(child, prefix === '' ? key : `${prefix}.${key}`, depth + 1)
      }
    }
    collect(state, '', 0)

    for (const [path, value] of Object.entries(flat)) {
      const leaf = path.split('.').at(-1) ?? path
      if (!forbidden.test(leaf)) continue
      // A key by one of these names is allowed only as a **boolean** — "a credential is stored",
      // "audio is available". The moment one holds a string it is carrying the thing itself.
      expect(typeof value, `${path} must be a boolean, not a value`).toBe('boolean')
    }
  })

  it('exposes the two certificate fingerprints, which are public values, not secrets (SPEC §6)', () => {
    const paths = keyPaths(sampleState())
    expect(paths).toContain('settings.console.certFingerprint')
    expect(paths).toContain('settings.console.accessCertFingerprint')
  })

  it('does not carry the schemaVersion storage envelope', () => {
    expect(keyPaths(sampleState())).not.toContain('settings.schemaVersion')
  })
})
