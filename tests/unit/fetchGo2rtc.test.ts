import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertSha256,
  assetUrl,
  describeRenameError,
  findTarget,
  formatMarker,
  hostTargetId,
  isSafeEntryName,
  parseCliArgs,
  resolveTargets,
  sha256Hex,
  shouldSkip,
  validateManifest,
} from '../../scripts/lib/go2rtc.ts'

const manifest = validateManifest(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../scripts/go2rtc.manifest.json'), 'utf8'),
  ),
)

describe('go2rtc manifest', () => {
  it('pins all four targets with distinct hashes', () => {
    expect(manifest.version).toMatch(/^v\d+\.\d+\.\d+$/)
    const ids = manifest.targets.map((t) => `${t.platform}-${t.arch}`).sort()
    expect(ids).toEqual(['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'])
    expect(new Set(manifest.targets.map((t) => t.sha256)).size).toBe(4)
  })

  it('rejects a malformed manifest', () => {
    expect(() => validateManifest({ version: '1.9', targets: [] })).toThrow(/version/)
    const [first] = manifest.targets
    if (!first) throw new Error('manifest has no targets')
    const bad = { ...manifest, targets: [{ ...first, sha256: 'abc' }] }
    expect(() => validateManifest(bad)).toThrow(/sha256/)
    const dup = { ...manifest, targets: [first, first] }
    expect(() => validateManifest(dup)).toThrow(/duplicate/)
  })

  it('builds only the pinned GitHub release URL', () => {
    expect(assetUrl('v1.9.15', 'go2rtc_mac_arm64.zip')).toBe(
      'https://github.com/AlexxIT/go2rtc/releases/download/v1.9.15/go2rtc_mac_arm64.zip',
    )
  })
})

describe('hostTargetId', () => {
  it('maps supported hosts', () => {
    expect(hostTargetId('darwin', 'arm64')).toBe('darwin-arm64')
    expect(hostTargetId('darwin', 'x64')).toBe('darwin-x64')
    expect(hostTargetId('win32', 'x64')).toBe('win32-x64')
    expect(hostTargetId('win32', 'arm64')).toBe('win32-arm64')
  })

  it('throws for unsupported platforms and arches', () => {
    expect(() => hostTargetId('linux', 'x64')).toThrow(/Unsupported host linux\/x64/)
    expect(() => hostTargetId('darwin', 'ia32')).toThrow(/Unsupported host/)
  })
})

describe('parseCliArgs', () => {
  it('defaults to host only, no force', () => {
    expect(parseCliArgs([])).toEqual({ all: false, targets: [], force: false, help: false })
  })

  it('parses --all, --force and repeated --target', () => {
    expect(parseCliArgs(['--all', '--force'])).toMatchObject({ all: true, force: true })
    expect(parseCliArgs(['--target', 'darwin-arm64', '--target=win32-x64']).targets).toEqual([
      'darwin-arm64',
      'win32-x64',
    ])
  })

  it('rejects unknown flags, missing values and --all with --target', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow()
    expect(() => parseCliArgs(['--target'])).toThrow()
    expect(() => parseCliArgs(['--all', '--target', 'win32-x64'])).toThrow(/either --all/)
  })
})

describe('resolveTargets', () => {
  it('uses the host by default', () => {
    const [t] = resolveTargets(manifest, { all: false, targets: [] }, 'darwin', 'arm64')
    expect(t?.asset).toBe('go2rtc_mac_arm64.zip')
  })

  it('returns everything for --all, even on an unsupported host', () => {
    expect(resolveTargets(manifest, { all: true, targets: [] }, 'linux', 'x64')).toHaveLength(4)
  })

  it('honours --target (deduplicated) and rejects unknown ids', () => {
    const picked = resolveTargets(
      manifest,
      { all: false, targets: ['win32-x64', 'win32-x64', 'win32-arm64'] },
      'darwin',
      'arm64',
    )
    expect(picked.map((t) => t.asset)).toEqual(['go2rtc_win64.zip', 'go2rtc_win_arm64.zip'])
    expect(() => findTarget(manifest, 'linux-x64')).toThrow(/Unknown target "linux-x64"/)
  })
})

describe('sha256 check', () => {
  const data = Buffer.from('go2rtc')
  const good = sha256Hex(data)

  it('accepts a matching hash (case-insensitive)', () => {
    expect(() => {
      assertSha256(good, good.toUpperCase(), 'x.zip')
    }).not.toThrow()
  })

  it('detects a mismatch', () => {
    const tampered = sha256Hex(Buffer.from('go2rtc!'))
    expect(() => {
      assertSha256(tampered, good, 'go2rtc_mac_arm64.zip')
    }).toThrow(/SHA-256 mismatch for go2rtc_mac_arm64\.zip/)
  })
})

describe('archive entry names', () => {
  it.each(['go2rtc', 'go2rtc.exe', 'dir/go2rtc'])('accepts %s', (name) => {
    expect(isSafeEntryName(name)).toBe(true)
  })

  it.each([
    '../go2rtc',
    'a/../../go2rtc',
    '/etc/passwd',
    'C:/Windows/go2rtc.exe',
    '..\\go2rtc.exe',
    'a//b',
    './go2rtc',
    '',
    'go2rtc\u0000.exe',
    '-go2rtc',
  ])('rejects %j', (name) => {
    expect(isSafeEntryName(name)).toBe(false)
  })
})

describe('shouldSkip (install marker)', () => {
  const version = 'v1.9.15'
  const binSha = sha256Hex('binary')
  const marker = formatMarker({ version, binarySha256: binSha })

  it('skips when the version and binary hash both match', () => {
    expect(shouldSkip(marker, version, binSha)).toEqual({ skip: true })
    expect(shouldSkip(marker, version, binSha.toUpperCase())).toEqual({ skip: true })
  })

  it('refetches when the manifest version differs', () => {
    expect(shouldSkip(marker, 'v1.9.16', binSha)).toEqual({
      skip: false,
      reason: 'installed v1.9.15 but manifest pins v1.9.16',
    })
  })

  it('refetches when the binary hash differs or the binary is missing', () => {
    const other = sha256Hex('tampered')
    expect(shouldSkip(marker, version, other)).toMatchObject({
      skip: false,
      reason: expect.stringMatching(/does not match recorded/) as unknown,
    })
    expect(shouldSkip(marker, version, undefined)).toEqual({
      skip: false,
      reason: 'binary is missing',
    })
  })

  it('refetches when the marker is missing or malformed', () => {
    expect(shouldSkip(undefined, version, binSha)).toEqual({
      skip: false,
      reason: 'no go2rtc.json marker',
    })
    expect(shouldSkip('v1.9.15\n', version, binSha)).toEqual({
      skip: false,
      reason: 'go2rtc.json is not valid JSON',
    })
    for (const bad of [
      '[]',
      'null',
      JSON.stringify({ version }),
      JSON.stringify({ version, binarySha256: 'abc' }),
      JSON.stringify({ version: 1, binarySha256: binSha }),
    ]) {
      expect(shouldSkip(bad, version, binSha)).toEqual({
        skip: false,
        reason: 'go2rtc.json is malformed',
      })
    }
  })
})

describe('describeRenameError', () => {
  const binPath = 'resources/bin/win32-x64/go2rtc.exe'
  const fsError = (code: string): Error => Object.assign(new Error(`${code}: rename`), { code })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('explains a locked file for %s', (code) => {
    const original = fsError(code)
    const err = describeRenameError(original, binPath)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/probably in use/)
    expect((err as Error).message).toMatch(/Quit OverWatch/)
    expect((err as Error).message).toContain(code)
    expect((err as Error).cause).toBe(original)
  })

  it('passes other errors through unchanged', () => {
    const enoent = fsError('ENOENT')
    expect(describeRenameError(enoent, binPath)).toBe(enoent)
    const plain = new Error('boom')
    expect(describeRenameError(plain, binPath)).toBe(plain)
    expect(describeRenameError('text', binPath)).toBe('text')
  })
})
