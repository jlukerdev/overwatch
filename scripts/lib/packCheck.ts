// Pure checks for the packaged go2rtc sidecar (P6.4), run by the electron-builder afterPack hook
// in scripts/after-pack.ts. No filesystem access here: the hook reads the files and passes in
// what it found, so everything in this module is unit-tested in tests/unit/packCheck.test.ts.
// Node runs this file directly (type stripping), so only erasable TypeScript syntax is allowed.
import { MARKER_FILE, parseMarker, targetId } from './go2rtc.ts'
import type { Go2rtcArch, Go2rtcManifest } from './go2rtc.ts'

/** How many leading bytes of the binary the hook reads for checkBinaryArch. */
export const HEADER_BYTES = 4096

/** What the hook found in the packaged bin/ folder. undefined = the file is missing. */
export interface PackagedGo2rtc {
  binarySha256: string | undefined
  markerText: string | undefined
  header: Uint8Array | undefined
}

export type BinaryFormat = 'mach-o' | 'pe'

export interface BinaryArch {
  format: BinaryFormat
  /** undefined when the format is known but the CPU type is neither arm64 nor x64. */
  arch: Go2rtcArch | undefined
  /** Raw cputype (Mach-O) or machine (PE) value, for messages. */
  machine: number
}

const MACHO_MAGIC_64 = 0xfeedfacf
const MACHO_CPU_X86_64 = 0x01000007
const MACHO_CPU_ARM64 = 0x0100000c
const PE_MACHINE_AMD64 = 0x8664
const PE_MACHINE_ARM64 = 0xaa64
const PE_LFANEW_OFFSET = 0x3c

/** electron-builder's Arch enum (builder-util/out/arch.js): 1 = x64, 3 = arm64. */
export function builderArchName(arch: number): string {
  switch (arch) {
    case 1:
      return 'x64'
    case 3:
      return 'arm64'
    case 0:
      return 'ia32'
    case 2:
      return 'armv7l'
    case 4:
      return 'universal'
    default:
      return `arch(${String(arch)})`
  }
}

function view(header: Uint8Array): DataView {
  return new DataView(header.buffer, header.byteOffset, header.byteLength)
}

/**
 * Reads the executable format and CPU architecture from the first bytes of a binary: a 64-bit
 * little-endian Mach-O (cputype at offset 4) or a PE file (`MZ`, e_lfanew at 0x3c pointing at
 * `PE\0\0`, then the COFF machine field). Returns undefined for anything else.
 */
export function detectBinaryArch(header: Uint8Array): BinaryArch | undefined {
  const dv = view(header)
  if (header.byteLength >= 8 && dv.getUint32(0, true) === MACHO_MAGIC_64) {
    const cputype = dv.getUint32(4, true)
    const arch =
      cputype === MACHO_CPU_ARM64 ? 'arm64' : cputype === MACHO_CPU_X86_64 ? 'x64' : undefined
    return { format: 'mach-o', arch, machine: cputype }
  }
  if (header.byteLength >= PE_LFANEW_OFFSET + 4 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = dv.getUint32(PE_LFANEW_OFFSET, true)
    if (peOffset + 6 > header.byteLength) return undefined
    if (dv.getUint32(peOffset, false) !== 0x50450000) return undefined // "PE\0\0"
    const machine = dv.getUint16(peOffset + 4, true)
    const arch =
      machine === PE_MACHINE_AMD64 ? 'x64' : machine === PE_MACHINE_ARM64 ? 'arm64' : undefined
    return { format: 'pe', arch, machine }
  }
  return undefined
}

function hex(n: number): string {
  return `0x${n.toString(16)}`
}

/**
 * Checks the go2rtc packaged for one target. Returns every problem found (empty = ok): the target
 * is in the manifest, the binary and marker exist, the marker's version is the manifest's and its
 * recorded hash is the packaged binary's, and the binary is built for the target's OS and CPU.
 */
export function checkPackagedGo2rtc(
  manifest: Go2rtcManifest,
  platform: string,
  arch: string,
  packaged: PackagedGo2rtc,
): string[] {
  const id = targetId(platform, arch)
  const target = manifest.targets.find((t) => t.platform === platform && t.arch === arch)
  if (!target) {
    const known = manifest.targets.map((t) => targetId(t.platform, t.arch)).join(', ')
    return [`${id} is not a target in go2rtc.manifest.json (known: ${known})`]
  }

  const problems: string[] = []
  const { binarySha256, markerText, header } = packaged

  if (binarySha256 === undefined) problems.push('the go2rtc binary is missing')

  const parsed = parseMarker(markerText)
  if (!parsed.ok) {
    problems.push(parsed.reason)
  } else {
    const { marker } = parsed
    if (marker.version !== manifest.version) {
      problems.push(
        `${MARKER_FILE} says ${marker.version} but the manifest pins ${manifest.version}`,
      )
    }
    if (binarySha256 !== undefined && binarySha256.toLowerCase() !== marker.binarySha256) {
      problems.push(
        `binary SHA-256 ${binarySha256.toLowerCase()} does not match ${MARKER_FILE} ` +
          `(${marker.binarySha256})`,
      )
    }
  }

  if (binarySha256 !== undefined) {
    const wantFormat: BinaryFormat = platform === 'win32' ? 'pe' : 'mach-o'
    const found = header === undefined ? undefined : detectBinaryArch(header)
    if (!found) {
      problems.push(
        `the go2rtc binary is not a ${wantFormat === 'pe' ? 'Windows PE' : '64-bit Mach-O'} file`,
      )
    } else if (found.format !== wantFormat) {
      problems.push(`the go2rtc binary is a ${found.format} file, but ${id} needs ${wantFormat}`)
    } else if (found.arch !== arch) {
      const got = found.arch ?? `unknown CPU ${hex(found.machine)}`
      problems.push(`the go2rtc binary is built for ${got}, but the target is ${arch}`)
    }
  }

  return problems
}
