// electron-builder afterPack hook (P6.4): fails the build unless the packaged go2rtc is the one
// pinned in scripts/go2rtc.manifest.json, recorded by its go2rtc.json marker and built for the
// target's OS and CPU. So no installer can ship with a missing, stale or wrong-arch go2rtc.
// It runs before signing on purpose: macOS ad-hoc signing (identity '-') re-signs every Mach-O in
// the bundle, go2rtc included, so the shipped binary no longer hashes to the marker's value. The
// hash is checked here, on the bytes that were fetched and verified; nothing reads the marker at
// runtime. A relative `afterPack` path resolves against the cwd, so run builds through npm.
// electron-builder loads this file with require()/import() under Node 24 type stripping
// (app-builder-lib/helpers/dynamic-import.js), so only erasable TypeScript syntax is allowed and
// there must be no top-level await. resolveFunction takes the `afterPack` export or `default`.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  errorCode,
  MARKER_FILE,
  outputBinaryName,
  sha256Hex,
  targetId,
  validateManifest,
} from './lib/go2rtc.ts'
import { builderArchName, checkPackagedGo2rtc, HEADER_BYTES } from './lib/packCheck.ts'
import type { PackagedGo2rtc } from './lib/packCheck.ts'

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'go2rtc.manifest.json')

/** The parts of electron-builder's AfterPackContext this hook uses. */
export interface AfterPackContext {
  electronPlatformName: string
  arch: number
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

/** <resources>/bin inside the packaged app. */
export function packagedBinDir(context: AfterPackContext): string {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    const app = `${packager.appInfo.productFilename}.app`
    return join(appOutDir, app, 'Contents', 'Resources', 'bin')
  }
  return join(appOutDir, 'resources', 'bin')
}

async function readIfPresent<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined
    throw err
  }
}

export default async function afterPack(context: AfterPackContext): Promise<void> {
  const platform = context.electronPlatformName
  const arch = builderArchName(context.arch)
  const id = targetId(platform, arch)
  const binDir = packagedBinDir(context)
  const manifest = validateManifest(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')))

  const binPath = join(binDir, platform === 'win32' ? outputBinaryName('win32') : 'go2rtc')
  const binary = await readIfPresent(() => readFile(binPath))
  const packaged: PackagedGo2rtc = {
    binarySha256: binary === undefined ? undefined : sha256Hex(binary),
    markerText: await readIfPresent(() => readFile(join(binDir, MARKER_FILE), 'utf8')),
    header: binary?.subarray(0, HEADER_BYTES),
  }

  const problems = checkPackagedGo2rtc(manifest, platform, arch, packaged)
  if (problems.length > 0) {
    throw new Error(
      `go2rtc check failed for ${id} (${binDir}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nRun `npm run fetch:go2rtc -- --all` and build again.',
    )
  }
  console.log(
    `  • go2rtc check ok: ${id} ${manifest.version} (sha256 ${packaged.binarySha256 ?? ''})`,
  )
}
