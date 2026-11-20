// P1.6 (CON-1…5, DOOR-0, SPEC §6): the Settings screen's decisions, tested where they live.
//
// The components around these functions cannot be tested here — the project has no jsdom and no
// testing-library (vitest.config.mts: node environment) — which is the reason every rule about what
// a console form may save sits in settingsForm.ts instead of in an onClick. These tests are
// therefore the only place the CON-1 validation, the dirty rule and the CON-3 fingerprint
// formatting are checked at all.
import { SettingsSchema, type Settings } from '@shared/models'
import type { CertInfo, EndpointStatus, SecretsStored } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import {
  consoleDraftFrom,
  consoleInputFrom,
  consoleSignature,
  describeCert,
  describeEndpointStatus,
  formatFingerprint,
  isConsoleDirty,
  type ConsoleDraft,
  type ConsoleField,
} from '../../src/renderer/src/features/settings/settingsForm'

const settingsWith = (console: Partial<Settings['console']> = {}): Settings =>
  SettingsSchema.parse({ console: { host: '192.0.2.10', ...console } })

const draftWith = (overrides: Partial<ConsoleDraft> = {}): ConsoleDraft => ({
  host: '192.0.2.10',
  accessEnabled: false,
  accessBaseUrl: '',
  protectApiKey: '',
  accessToken: '',
  ...overrides,
})

const NO_SECRETS: SecretsStored = { protectApiKey: false, accessToken: false, rtspUrls: {} }
const BOTH_SECRETS: SecretsStored = { protectApiKey: true, accessToken: true, rtspUrls: {} }

describe('consoleDraftFrom', () => {
  it('seeds the three saved fields and nothing else', () => {
    const draft = consoleDraftFrom(
      settingsWith({
        accessEnabled: true,
        accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer',
      }),
    )
    expect(draft).toEqual({
      host: '192.0.2.10',
      accessEnabled: true,
      accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer',
      protectApiKey: '',
      accessToken: '',
    })
  })

  it('leaves the secret fields empty even though credentials are stored (CON-2)', () => {
    // There is no channel that reads a secret back, so there is nothing to seed them from.
    const draft = consoleDraftFrom(settingsWith())
    expect(draft.protectApiKey).toBe('')
    expect(draft.accessToken).toBe('')
  })

  it('turns a derived Access base URL into an empty field (SPEC §6)', () => {
    expect(consoleDraftFrom(settingsWith({ accessBaseUrl: null })).accessBaseUrl).toBe('')
  })
})

describe('consoleInputFrom', () => {
  it.each<[string, ConsoleDraft, SecretsStored, ConsoleField, RegExp]>([
    [
      'a host that something else needs',
      draftWith({ host: '  ', accessEnabled: true, accessToken: 'tok' }),
      NO_SECRETS,
      'host',
      /console IP or host name/,
    ],
    [
      'a host cleared while a key is already stored',
      draftWith({ host: '' }),
      BOTH_SECRETS,
      'host',
      /console IP or host name/,
    ],
    [
      'a host cleared while a key is being typed',
      draftWith({ host: '', protectApiKey: 'abc' }),
      NO_SECRETS,
      'host',
      /console IP or host name/,
    ],
    [
      'an https:// prefix in the bare-host field',
      draftWith({ host: 'https://udm.local' }),
      NO_SECRETS,
      'host',
      /without .*https:\/\/|no https:\/\//,
    ],
    [
      'an http:// console, which would send the key in clear',
      draftWith({ host: 'http://udm.local' }),
      NO_SECRETS,
      'host',
      /Only https/,
    ],
    ['any other scheme', draftWith({ host: 'ftp://udm.local' }), NO_SECRETS, 'host', /Only https/],
    [
      'an Access base URL that is not a URL',
      draftWith({ accessEnabled: true, accessBaseUrl: 'not a url' }),
      BOTH_SECRETS,
      'accessBaseUrl',
      /full Access API root/,
    ],
    [
      'an http Access base URL (CON-2)',
      draftWith({ accessEnabled: true, accessBaseUrl: 'http://127.0.0.1:12445/api/v1/developer' }),
      BOTH_SECRETS,
      'accessBaseUrl',
      /full Access API root/,
    ],
    [
      'Access switched on with no token anywhere',
      draftWith({ accessEnabled: true }),
      NO_SECRETS,
      'accessToken',
      /needs an API token/,
    ],
  ])('refuses %s', (_label, draft, stored, field, message) => {
    const result = consoleInputFrom(draft, stored)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[field]).toMatch(message)
  })

  it.each<[string, ConsoleDraft, SecretsStored]>([
    ['a bare address', draftWith(), NO_SECRETS],
    ['an address with a port', draftWith({ host: 'udm.local:8443' }), NO_SECRETS],
    ['an IPv6 literal, which main parses', draftWith({ host: '[2001:db8::1]' }), NO_SECRETS],
    ['a fresh install with nothing filled in at all (CON-1)', draftWith({ host: '' }), NO_SECRETS],
    [
      'Access switched on with a token already in the keystore (DOOR-0)',
      draftWith({ accessEnabled: true }),
      { protectApiKey: true, accessToken: true, rtspUrls: {} },
    ],
    [
      'Access switched on with a token being typed',
      draftWith({ accessEnabled: true, accessToken: 'tok' }),
      NO_SECRETS,
    ],
  ])('accepts %s', (_label, draft, stored) => {
    expect(consoleInputFrom(draft, stored).ok).toBe(true)
  })

  it('trims the host and keeps the port, leaving the syntax to main', () => {
    const result = consoleInputFrom(draftWith({ host: '  udm.local:8443  ' }), NO_SECRETS)
    expect(result).toEqual({
      ok: true,
      input: { host: 'udm.local:8443', accessEnabled: false, accessBaseUrl: null },
    })
  })

  it('sends an empty Access base URL as null, i.e. "derive it" (SPEC §6)', () => {
    const result = consoleInputFrom(draftWith({ accessBaseUrl: '   ' }), NO_SECRETS)
    expect(result.ok && result.input.accessBaseUrl).toBe(null)
  })

  it('reports every bad field at once, so Save does not fix them one at a time', () => {
    const result = consoleInputFrom(
      draftWith({ host: 'http://udm.local', accessEnabled: true, accessBaseUrl: 'nope' }),
      NO_SECRETS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(['accessBaseUrl', 'accessToken', 'host'])
  })
})

describe('isConsoleDirty', () => {
  const saved = settingsWith({
    accessEnabled: true,
    accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer',
  })

  it.each<[string, Partial<ConsoleDraft>, boolean]>([
    ['the draft it was seeded from', {}, false],
    ['whitespace around an unchanged host', { host: '  192.0.2.10  ' }, false],
    ['a changed host', { host: '192.0.2.11' }, true],
    ['Access switched off', { accessEnabled: false }, true],
    [
      'a changed Access base URL',
      { accessBaseUrl: 'https://127.0.0.1:12446/api/v1/developer' },
      true,
    ],
    ['an Access base URL cleared back to derived', { accessBaseUrl: '' }, true],
    // Secrets have their own Save button and their own channel (`setSecret`), so typing a key must
    // not light up the console Save button.
    ['a typed API key', { protectApiKey: 'abc' }, false],
    ['a typed Access token', { accessToken: 'tok' }, false],
  ])('%s → %s', (_label, overrides, expected) => {
    const draft = { ...consoleDraftFrom(saved), ...overrides }
    expect(isConsoleDirty(draft, saved)).toBe(expected)
  })

  it('still sees an Access base URL edit after Access is switched off (DOOR-0)', () => {
    // Turning Access off hides the field but keeps the value: DOOR-0 says a saved token and the
    // door links come back when it is re-enabled, and the base URL belongs to the same set.
    const base = settingsWith({ accessEnabled: true, accessBaseUrl: null })
    const draft = {
      ...consoleDraftFrom(base),
      accessEnabled: false,
      accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer',
    }
    expect(isConsoleDirty(draft, base)).toBe(true)
  })

  it('is not dirty when Access is off in both the draft and the saved config', () => {
    const off = settingsWith({ accessEnabled: false, accessBaseUrl: null })
    expect(isConsoleDirty(consoleDraftFrom(off), off)).toBe(false)
  })
})

describe('consoleSignature', () => {
  it('changes when a saved console field changes', () => {
    const before = consoleSignature(settingsWith())
    expect(consoleSignature(settingsWith())).toBe(before)
    expect(consoleSignature(settingsWith({ host: '192.0.2.11' }))).not.toBe(before)
    expect(consoleSignature(settingsWith({ accessEnabled: true }))).not.toBe(before)
    expect(
      consoleSignature(settingsWith({ accessBaseUrl: 'https://127.0.0.1:12445/api/v1/developer' })),
    ).not.toBe(before)
  })

  it('ignores a fingerprint, so pinning a certificate does not reset a half-typed form', () => {
    expect(consoleSignature(settingsWith({ certFingerprint: 'AA:BB' }))).toBe(
      consoleSignature(settingsWith()),
    )
  })
})

describe('formatFingerprint', () => {
  const digest = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'

  it.each<[string, string, string]>([
    [
      'groups colon-separated octets in fours',
      digest,
      'AB:CD:EF:01  23:45:67:89  AB:CD:EF:01  23:45:67:89',
    ],
    ['uppercases what the console lower-cased', 'ab:cd:ef:01', 'AB:CD:EF:01'],
    ['accepts a bare hex digest', 'abcdef0123', 'AB:CD:EF:01  23'],
    ['leaves a short group alone', 'AB:CD:EF', 'AB:CD:EF'],
    ['tolerates surrounding whitespace', '  AB:CD  ', 'AB:CD'],
    ['has nothing to show for an empty pin', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(formatFingerprint(input)).toBe(expected)
  })

  it('keeps every octet, because this is what the user compares (CON-3)', () => {
    expect(formatFingerprint(digest).replace(/[^0-9A-F]/g, '')).toBe(digest.replace(/:/g, ''))
  })
})

describe('describeCert', () => {
  const cert = (overrides: Partial<CertInfo> = {}): CertInfo => ({
    hostPort: '192.0.2.10:443',
    fingerprint256: 'AB:CD',
    subjectCommonName: 'udm.local',
    issuerCommonName: 'Ubiquiti Inc.',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
    selfSigned: true,
    ...overrides,
  })

  it('names the console, who issued it, how long it is good for and whether it signed itself', () => {
    expect(describeCert(cert())).toBe(
      'subject udm.local · issued by Ubiquiti Inc. · valid 2026-01-01 to 2027-01-01 · self-signed',
    )
  })

  it('says so when a name is missing rather than rendering "null"', () => {
    expect(describeCert(cert({ subjectCommonName: null, issuerCommonName: null }))).toContain(
      'no subject name · no issuer name',
    )
  })

  it('distinguishes a CA-signed certificate', () => {
    expect(describeCert(cert({ selfSigned: false }))).toContain('signed by a certificate authority')
  })

  it('passes an unparseable date through instead of showing "Invalid Date"', () => {
    expect(describeCert(cert({ validFrom: 'whenever' }))).toContain('valid whenever to 2027-01-01')
  })
})

describe('describeEndpointStatus', () => {
  const status = (overrides: Partial<EndpointStatus> = {}): EndpointStatus => ({
    endpoint: 'protect',
    phase: 'idle',
    hostPort: '192.0.2.10:443',
    pinned: true,
    credentialStored: true,
    version: null,
    error: null,
    updatedAt: 0,
    ...overrides,
  })

  it('reads as a checklist of the three things that can be missing (CON-5)', () => {
    expect(describeEndpointStatus(status())).toBe(
      '192.0.2.10:443 · certificate accepted · credential stored',
    )
    expect(
      describeEndpointStatus(status({ hostPort: null, pinned: false, credentialStored: false })),
    ).toBe('no address yet · certificate not accepted yet · no credential stored')
  })

  it('adds the version once a probe has reported one (CON-4)', () => {
    expect(describeEndpointStatus(status({ version: '6.4.21' }))).toContain('version 6.4.21')
  })
})
