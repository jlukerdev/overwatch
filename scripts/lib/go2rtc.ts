// Pure helpers for scripts/fetch-go2rtc.ts (P0.2). No network, filesystem or process access
// here, so everything in this module is unit-tested in tests/unit/fetchGo2rtc.test.ts.
// Node runs this file directly (type stripping), so only erasable TypeScript syntax is allowed.
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

export const RELEASE_BASE_URL = 'https://github.com/AlexxIT/go2rtc/releases/download'

/** Per-target install marker, written last into resources/bin/<id>/. */
export const MARKER_FILE = 'go2rtc.json'

export type Go2rtcPlatform = 'darwin' | 'win32'
export type Go2rtcArch = 'arm64' | 'x64'

export interface Go2rtcTarget {
  platform: Go2rtcPlatform
  arch: Go2rtcArch
  asset: string
  sha256: string
  binary: string
}

export interface Go2rtcManifest {
  version: string
  targets: Go2rtcTarget[]
}

export interface CliOptions {
  all: boolean
  targets: string[]
  force: boolean
  help: boolean
}

export interface InstallMarker {
  version: string
  binarySha256: string
}

export type SkipDecision = { skip: true } | { skip: false; reason: string }

const PLATFORMS: ReadonlySet<string> = new Set<Go2rtcPlatform>(['darwin', 'win32'])
const ARCHES: ReadonlySet<string> = new Set<Go2rtcArch>(['arm64', 'x64'])
const SHA256_RE = /^[0-9a-f]{64}$/

function isPlatform(value: unknown): value is Go2rtcPlatform {
  return typeof value === 'string' && PLATFORMS.has(value)
}

function isArch(value: unknown): value is Go2rtcArch {
  return typeof value === 'string' && ARCHES.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `darwin-arm64` etc. Matches the resources/bin/<platform>-<arch> folder name. */
export function targetId(platform: string, arch: string): string {
  return `${platform}-${arch}`
}

/** Maps process.platform / process.arch to a supported target id, or throws. */
export function hostTargetId(platform: string, arch: string): string {
  if (!isPlatform(platform) || !isArch(arch)) {
    throw new Error(
      `Unsupported host ${platform}/${arch}. Supported: darwin|win32 on arm64|x64. ` +
        'Use --target or --all to fetch binaries for another platform.',
    )
  }
  return targetId(platform, arch)
}

/** Checks the manifest shape so a bad edit fails loudly instead of downloading garbage. */
export function validateManifest(manifest: unknown): Go2rtcManifest {
  if (!isRecord(manifest)) throw new Error('go2rtc manifest must be an object')
  const { version, targets } = manifest
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`go2rtc manifest: invalid version ${JSON.stringify(version)}`)
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('go2rtc manifest: targets must be a non-empty array')
  }
  const seen = new Set<string>()
  const out: Go2rtcTarget[] = []
  for (const t of targets as unknown[]) {
    if (!isRecord(t)) throw new Error('go2rtc manifest: each target must be an object')
    const { platform, arch, asset, sha256, binary } = t
    const id = targetId(String(platform), String(arch))
    if (!isPlatform(platform) || !isArch(arch)) {
      throw new Error(`go2rtc manifest: unsupported target ${id}`)
    }
    if (seen.has(id)) throw new Error(`go2rtc manifest: duplicate target ${id}`)
    seen.add(id)
    if (typeof asset !== 'string' || !/^[\w.-]+\.zip$/.test(asset)) {
      throw new Error(`go2rtc manifest: invalid asset for ${id}`)
    }
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new Error(`go2rtc manifest: invalid sha256 for ${id}`)
    }
    if (typeof binary !== 'string' || !isSafeEntryName(binary)) {
      throw new Error(`go2rtc manifest: invalid binary name for ${id}`)
    }
    out.push({ platform, arch, asset, sha256, binary })
  }
  return { version, targets: out }
}

export function findTarget(manifest: Go2rtcManifest, id: string): Go2rtcTarget {
  const target = manifest.targets.find((t) => targetId(t.platform, t.arch) === id)
  if (!target) {
    const known = manifest.targets.map((t) => targetId(t.platform, t.arch)).join(', ')
    throw new Error(`Unknown target "${id}". Known targets: ${known}`)
  }
  return target
}

/** The only URL the fetch script downloads from (GitHub then redirects to its CDN). */
export function assetUrl(version: string, asset: string): string {
  return `${RELEASE_BASE_URL}/${encodeURIComponent(version)}/${encodeURIComponent(asset)}`
}

/** Output file name inside resources/bin/<platform>-<arch>/. */
export function outputBinaryName(platform: Go2rtcPlatform): string {
  return platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'
}

/** Parses CLI flags: --all, --target <id> (repeatable), --force, --help. Throws on bad input. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean', default: false },
      target: { type: 'string', multiple: true, default: [] },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.all && values.target.length > 0) {
    throw new Error('Use either --all or --target, not both')
  }
  return { all: values.all, targets: values.target, force: values.force, help: values.help }
}

/** Picks the manifest targets to fetch: --all, the --target list, or the host. */
export function resolveTargets(
  manifest: Go2rtcManifest,
  options: Pick<CliOptions, 'all' | 'targets'>,
  platform: string,
  arch: string,
): Go2rtcTarget[] {
  if (options.all) return [...manifest.targets]
  const ids = options.targets.length > 0 ? options.targets : [hostTargetId(platform, arch)]
  return [...new Set(ids)].map((id) => findTarget(manifest, id))
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Throws a descriptive error when `actual` (hex) does not equal the pinned hash. */
export function assertSha256(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${label}\n  expected: ${expected}\n  actual:   ${actual}\n` +
        'The download was discarded. If go2rtc was deliberately updated, bump the manifest.',
    )
  }
}

/**
 * True for a plain relative archive entry name with no traversal. Rejects absolute paths,
 * drive letters, backslashes, `.`/`..` segments, empty segments and control characters.
 * Also keeps the name from being read as a tar option (no leading `-`).
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\:]/.test(name)) return false
  if (name.startsWith('/') || name.startsWith('-')) return false
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** The marker JSON written after a successful install. */
export function formatMarker(marker: InstallMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`
}

/**
 * Decides whether an installed target is current. `markerText` is the go2rtc.json contents
 * (undefined if missing); `actualBinarySha` is the SHA-256 of the installed binary right now
 * (undefined if it is missing or not a regular file). Skips only when the marker's version
 * matches the manifest and the binary still hashes to what was installed.
 */
export function shouldSkip(
  markerText: string | undefined,
  manifestVersion: string,
  actualBinarySha: string | undefined,
): SkipDecision {
  if (markerText === undefined) return { skip: false, reason: `no ${MARKER_FILE} marker` }
  let marker: unknown
  try {
    marker = JSON.parse(markerText)
  } catch {
    return { skip: false, reason: `${MARKER_FILE} is not valid JSON` }
  }
  if (
    !isRecord(marker) ||
    typeof marker.version !== 'string' ||
    typeof marker.binarySha256 !== 'string' ||
    !SHA256_RE.test(marker.binarySha256)
  ) {
    return { skip: false, reason: `${MARKER_FILE} is malformed` }
  }
  if (marker.version !== manifestVersion) {
    return {
      skip: false,
      reason: `installed ${marker.version} but manifest pins ${manifestVersion}`,
    }
  }
  if (actualBinarySha === undefined) return { skip: false, reason: 'binary is missing' }
  if (actualBinarySha.toLowerCase() !== marker.binarySha256) {
    return {
      skip: false,
      reason: `binary SHA-256 ${actualBinarySha} does not match recorded ${marker.binarySha256}`,
    }
  }
  return { skip: true }
}

const LOCKED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Node fs error code (`ENOENT` etc.), if any. */
export function errorCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined
  const { code } = err
  return typeof code === 'string' ? code : undefined
}

/**
 * Turns a failed rename onto `binPath` into a friendly error when the file is locked
 * (typically a running go2rtc on Windows). Other errors are returned unchanged.
 */
export function describeRenameError(err: unknown, binPath: string): unknown {
  const code = errorCode(err)
  if (code === undefined || !LOCKED_CODES.has(code)) return err
  return new Error(
    `Could not replace ${binPath} (${code}): the file is probably in use. ` +
      'Quit View Protect (and any running go2rtc process), then run the fetch again. ' +
      'The partial download was removed.',
    { cause: err },
  )
}
