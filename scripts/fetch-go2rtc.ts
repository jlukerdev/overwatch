// Download the pinned go2rtc release into resources/bin/<platform>-<arch>/ (P0.2).
// Node 24 runs this file directly (type stripping): erasable TypeScript syntax only.
//
//   node scripts/fetch-go2rtc.ts                 host platform/arch only
//   node scripts/fetch-go2rtc.ts --all           every target in the manifest (in parallel)
//   node scripts/fetch-go2rtc.ts --target win32-x64 [--target ...]
//   node scripts/fetch-go2rtc.ts --force         re-download even if the install is current
//
// Each zip is streamed to a per-target temp dir and its SHA-256 is checked against
// scripts/go2rtc.manifest.json BEFORE anything is extracted. Only the expected binary is then
// extracted with the system `tar` (bsdtar: macOS, Windows 10+) and moved into place.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Go2rtcTarget } from './lib/go2rtc.ts'
import {
  MARKER_FILE,
  assertSha256,
  assetUrl,
  describeRenameError,
  errorCode,
  formatMarker,
  outputBinaryName,
  parseCliArgs,
  resolveTargets,
  shouldSkip,
  targetId,
  validateManifest,
} from './lib/go2rtc.ts'

const execFileAsync = promisify(execFile)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'scripts', 'go2rtc.manifest.json')
const BIN_ROOT = join(ROOT, 'resources', 'bin')
const DOWNLOAD_TIMEOUT_MS = 120_000
const TAR_TIMEOUT_MS = 60_000

const USAGE = 'Usage: node scripts/fetch-go2rtc.ts [--all | --target <platform-arch> ...] [--force]'

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  const manifest = validateManifest(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')))
  const targets = resolveTargets(manifest, options, process.platform, process.arch)

  // Each target has its own temp dir and output folder, so they can run side by side.
  const results = await Promise.allSettled(
    targets.map((t) => fetchTarget(manifest.version, t, options.force)),
  )
  const failures = results.flatMap((r, i) => {
    const t = targets[i]
    if (r.status === 'fulfilled' || !t) return []
    return [`${targetId(t.platform, t.arch)}: ${message(r.reason)}`]
  })
  if (failures.length > 0) {
    console.error(`fetch-go2rtc: ${String(failures.length)} target(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
  }
}

async function fetchTarget(version: string, target: Go2rtcTarget, force: boolean): Promise<void> {
  const id = targetId(target.platform, target.arch)
  const log = (msg: string): void => {
    console.log(`[${id}] ${msg}`)
  }
  const outDir = join(BIN_ROOT, id)
  const binPath = join(outDir, outputBinaryName(target.platform))
  const markerPath = join(outDir, MARKER_FILE)

  if (force) {
    log('--force: refetching')
  } else {
    const decision = shouldSkip(await readOptional(markerPath), version, await fileSha256(binPath))
    if (decision.skip) {
      log(`go2rtc ${version} already installed and verified, skipping (use --force to refetch)`)
      return
    }
    log(`refetching: ${decision.reason}`)
  }

  const url = assetUrl(version, target.asset)
  const tmp = await mkdtemp(join(tmpdir(), `go2rtc-${id}-`))
  try {
    const zipPath = join(tmp, target.asset)
    log(`downloading ${url}`)
    const actual = await download(url, zipPath)
    assertSha256(actual, target.sha256, target.asset)
    log(`zip sha256 ok ${actual}`)

    // Only after the checksum passes: extract just the expected entry.
    const extractDir = join(tmp, 'extract')
    await mkdir(extractDir)
    await extractEntry(zipPath, extractDir, target.binary)
    const extracted = join(extractDir, ...target.binary.split('/'))
    const info = await lstat(extracted).catch(() => undefined)
    if (!info?.isFile()) {
      throw new Error(`${target.asset} did not contain a regular file "${target.binary}"`)
    }
    const binarySha256 = await fileSha256(extracted)
    if (binarySha256 === undefined) throw new Error(`Could not hash ${extracted}`)

    await mkdir(outDir, { recursive: true })
    // Drop the marker first so an interrupted install is never treated as current.
    await rm(markerPath, { force: true })
    await rm(join(outDir, 'VERSION'), { force: true }) // pre-marker format
    // Copy next to the destination, then rename, so a crash never leaves a half binary.
    const partial = `${binPath}.partial`
    try {
      await copyFile(extracted, partial)
      if (target.platform !== 'win32') await chmod(partial, 0o755)
      try {
        await rename(partial, binPath)
      } catch (err) {
        throw describeRenameError(err, binPath)
      }
    } catch (err) {
      await rm(partial, { force: true })
      throw err
    }
    // Marker last: it marks the target as complete and records what was installed.
    await writeFile(markerPath, formatMarker({ version, binarySha256 }))
    log(`installed ${binPath} (sha256 ${binarySha256})`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Extracts only `entry` from `zipPath` into `destDir` using the system bsdtar. */
async function extractEntry(zipPath: string, destDir: string, entry: string): Promise<void> {
  const tar = tarCommand()
  try {
    await execFileAsync(tar, ['-xf', zipPath, '-C', destDir, entry], {
      timeout: TAR_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      throw new Error(
        `"${tar}" was not found. The fetch needs the system tar (bsdtar), which ships with ` +
          'macOS and Windows 10 1803+.',
        { cause: err },
      )
    }
    const stderr = isStderrError(err) ? err.stderr.trim() : ''
    throw new Error(`tar failed to extract "${entry}": ${stderr || message(err)}`, { cause: err })
  }
}

/** On Windows, use the bundled bsdtar directly so GNU tar from Git/MSYS (no zip support) is never picked. */
function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar'
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function isStderrError(err: unknown): err is { stderr: string } {
  return (
    typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string'
  )
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined
    throw err
  }
}

/** SHA-256 of a regular file, or undefined if it is missing or not a regular file. */
async function fileSha256(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Streams `url` to `dest` (following redirects) and returns the SHA-256 hex of the bytes. */
async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${String(res.status)} ${res.statusText} for ${url}`)
  }
  const hash = createHash('sha256')
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), hasher, createWriteStream(dest))
  return hash.digest('hex')
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

main().catch((err: unknown) => {
  console.error(`fetch-go2rtc: ${message(err)}`)
  process.exitCode = 1
})
