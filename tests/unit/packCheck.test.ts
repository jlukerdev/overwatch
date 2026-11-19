import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMarker, parseMarker, sha256Hex, validateManifest } from '../../scripts/lib/go2rtc.ts'
import {
  builderArchName,
  checkPackagedGo2rtc,
  detectBinaryArch,
  type PackagedGo2rtc,
} from '../../scripts/lib/packCheck.ts'

const manifest = validateManifest(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../scripts/go2rtc.manifest.json'), 'utf8'),
  ),
)

const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c
const PE_AMD64 = 0x8664
const PE_ARM64 = 0xaa64

/** A 4096-byte buffer starting with a 64-bit little-endian Mach-O header. */
function machO(cputype: number): Uint8Array {
  const buf = new Uint8Array(4096)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, 0xfeedfacf, true)
  dv.setUint32(4, cputype, true)
  return buf
}

/** A 4096-byte buffer with an MZ stub, e_lfanew at 0x3c and a PE signature + machine. */
function pe(machine: number): Uint8Array {
  const peOffset = 0x80
  const buf = new Uint8Array(4096)
  const dv = new DataView(buf.buffer)
  buf[0] = 0x4d // M
  buf[1] = 0x5a // Z
  dv.setUint32(0x3c, peOffset, true)
  buf.set([0x50, 0x45, 0, 0], peOffset) // PE\0\0
  dv.setUint16(peOffset + 4, machine, true)
  return buf
}

const binSha = sha256Hex('go2rtc binary')

function packaged(header: Uint8Array, overrides: Partial<PackagedGo2rtc> = {}): PackagedGo2rtc {
  return {
    binarySha256: binSha,
    markerText: formatMarker({ version: manifest.version, binarySha256: binSha }),
    header,
    ...overrides,
  }
}

describe('detectBinaryArch', () => {
  it('reads Mach-O and PE CPU types', () => {
    expect(detectBinaryArch(machO(CPU_ARM64))).toEqual({
      format: 'mach-o',
      arch: 'arm64',
      machine: CPU_ARM64,
    })
    expect(detectBinaryArch(machO(CPU_X86_64))?.arch).toBe('x64')
    expect(detectBinaryArch(pe(PE_AMD64))).toEqual({ format: 'pe', arch: 'x64', machine: PE_AMD64 })
    expect(detectBinaryArch(pe(PE_ARM64))?.arch).toBe('arm64')
    expect(detectBinaryArch(pe(0x14c))).toEqual({ format: 'pe', arch: undefined, machine: 0x14c })
  })

  it('rejects anything else', () => {
    expect(detectBinaryArch(new TextEncoder().encode('#!/bin/sh\necho hi\n'))).toBeUndefined()
    expect(detectBinaryArch(new Uint8Array(0))).toBeUndefined()
    // 32-bit Mach-O magic.
    const macho32 = machO(CPU_X86_64)
    new DataView(macho32.buffer).setUint32(0, 0xfeedface, true)
    expect(detectBinaryArch(macho32)).toBeUndefined()
    // MZ whose e_lfanew points past the header, or at no PE signature.
    const farPe = pe(PE_AMD64)
    new DataView(farPe.buffer).setUint32(0x3c, 8000, true)
    expect(detectBinaryArch(farPe)).toBeUndefined()
    const noSig = pe(PE_AMD64)
    noSig[0x80] = 0
    expect(detectBinaryArch(noSig)).toBeUndefined()
  })
})

describe('builderArchName', () => {
  it('maps electron-builder Arch values', () => {
    expect(builderArchName(1)).toBe('x64')
    expect(builderArchName(3)).toBe('arm64')
    expect(builderArchName(4)).toBe('universal')
    expect(builderArchName(9)).toBe('arch(9)')
  })
})

describe('checkPackagedGo2rtc', () => {
  it.each([
    ['darwin', 'arm64', machO(CPU_ARM64)],
    ['darwin', 'x64', machO(CPU_X86_64)],
    ['win32', 'x64', pe(PE_AMD64)],
    ['win32', 'arm64', pe(PE_ARM64)],
  ])('passes a correct %s-%s package', (platform, arch, header) => {
    expect(checkPackagedGo2rtc(manifest, platform, arch, packaged(header))).toEqual([])
  })

  it('accepts an upper-case binary hash', () => {
    const p = packaged(machO(CPU_ARM64), { binarySha256: binSha.toUpperCase() })
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'arm64', p)).toEqual([])
  })

  it('rejects a target the manifest does not know', () => {
    const problems = checkPackagedGo2rtc(manifest, 'linux', 'x64', packaged(machO(CPU_X86_64)))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/linux-x64 is not a target/)
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'universal', packaged(machO(1)))[0]).toMatch(
      /darwin-universal is not a target/,
    )
  })

  it('reports a missing binary', () => {
    const p = packaged(machO(CPU_ARM64), { binarySha256: undefined, header: undefined })
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'arm64', p)).toEqual([
      'the go2rtc binary is missing',
    ])
  })

  it('reports a missing or garbled marker', () => {
    const missing = packaged(pe(PE_AMD64), { markerText: undefined })
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', missing)).toEqual([
      'no go2rtc.json marker',
    ])
    const garbled = packaged(pe(PE_AMD64), { markerText: '{not json' })
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', garbled)).toEqual([
      'go2rtc.json is not valid JSON',
    ])
    const malformed = packaged(pe(PE_AMD64), { markerText: '{"version":"v1.9.15"}' })
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', malformed)).toEqual([
      'go2rtc.json is malformed',
    ])
  })

  it('reports both a missing binary and a missing marker', () => {
    const p: PackagedGo2rtc = { binarySha256: undefined, markerText: undefined, header: undefined }
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'x64', p)).toEqual([
      'the go2rtc binary is missing',
      'no go2rtc.json marker',
    ])
  })

  it('reports a stale version', () => {
    const p = packaged(machO(CPU_ARM64), {
      markerText: formatMarker({ version: 'v1.9.14', binarySha256: binSha }),
    })
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'arm64', p)).toEqual([
      `go2rtc.json says v1.9.14 but the manifest pins ${manifest.version}`,
    ])
  })

  it('reports a binary that is not the one the marker recorded', () => {
    const other = sha256Hex('another binary')
    const p = packaged(machO(CPU_ARM64), { binarySha256: other })
    const problems = checkPackagedGo2rtc(manifest, 'darwin', 'arm64', p)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`binary SHA-256 ${other} does not match go2rtc.json`)
  })

  it('reports a binary built for the wrong CPU', () => {
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'arm64', packaged(machO(CPU_X86_64)))).toEqual([
      'the go2rtc binary is built for x64, but the target is arm64',
    ])
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', packaged(pe(PE_ARM64)))).toEqual([
      'the go2rtc binary is built for arm64, but the target is x64',
    ])
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', packaged(pe(0x14c)))).toEqual([
      'the go2rtc binary is built for unknown CPU 0x14c, but the target is x64',
    ])
  })

  it('reports a binary for the wrong OS', () => {
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', packaged(machO(CPU_X86_64)))).toEqual([
      'the go2rtc binary is a mach-o file, but win32-x64 needs pe',
    ])
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'x64', packaged(pe(PE_AMD64)))).toEqual([
      'the go2rtc binary is a pe file, but darwin-x64 needs mach-o',
    ])
  })

  it('reports a file that is not an executable at all', () => {
    const text = new TextEncoder().encode('<html>Not Found</html>')
    expect(checkPackagedGo2rtc(manifest, 'darwin', 'arm64', packaged(text))).toEqual([
      'the go2rtc binary is not a 64-bit Mach-O file',
    ])
    expect(checkPackagedGo2rtc(manifest, 'win32', 'x64', packaged(text))).toEqual([
      'the go2rtc binary is not a Windows PE file',
    ])
  })
})

describe('parseMarker', () => {
  it('returns the marker fields', () => {
    expect(parseMarker(formatMarker({ version: 'v1.9.15', binarySha256: binSha }))).toEqual({
      ok: true,
      marker: { version: 'v1.9.15', binarySha256: binSha },
    })
  })
})
