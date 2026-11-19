// Render resources/icons/icon.svg into the app icons (P6.1, OverWatch branding).
// Node 24 runs this file directly (type stripping): erasable TypeScript syntax only.
//
//   node scripts/gen-icons.ts
//
// Writes, next to icon.svg:
//   icon.png   1024 x 1024 (electron-builder's source and the window icon)
//   icon.icns  macOS, built by `iconutil` (macOS only) from a temporary .iconset
//   icon.ico   Windows, 16/24/32/48/64/128/256 px PNG entries in a hand-built ICO container
//
// There is no SVG rasteriser in the toolchain, so the script re-runs itself under Electron: a
// hidden window draws the SVG onto a canvas at each exact pixel size (Chromium rasterises the
// vector at that size, so small icons are not downscaled from 1024) and returns the PNG bytes.
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SELF = fileURLToPath(import.meta.url)
const ICONS_DIR = join(dirname(SELF), '..', 'resources', 'icons')
const SVG_PATH = join(ICONS_DIR, 'icon.svg')

/** Every pixel size any output needs. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** macOS .iconset entries: [file name, pixel size]. */
const ICONSET: [string, number][] = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

// Env var that tells the Electron child where to write the PNGs (`<dir>/<size>.png`).
const RENDER_DIR_ENV = 'VP_GEN_ICONS_OUT'

// ---------------------------------------------------------------------------------------------
// Electron side: rasterise.

async function renderInElectron(outDir: string): Promise<void> {
  const { app, BrowserWindow } = await import('electron')
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: true },
  })
  try {
    await win.loadURL('about:blank')
    const svg = await readFile(SVG_PATH, 'utf8')
    const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const script = `(async () => {
      const img = new Image()
      img.src = ${JSON.stringify(svgUrl)}
      // Rejects for invalid XML, e.g. a "--" inside an SVG comment.
      try { await img.decode() } catch (e) { throw new Error('icon.svg does not decode: ' + String(e)) }
      const out = {}
      for (const size of ${JSON.stringify(SIZES)}) {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, size, size)
        out[size] = canvas.toDataURL('image/png').split(',')[1]
      }
      return out
    })()`
    const pngs = (await win.webContents.executeJavaScript(script)) as Record<string, string>
    for (const size of SIZES) {
      const b64 = pngs[String(size)]
      if (b64 === undefined) throw new Error(`no ${String(size)} px render`)
      await writeFile(join(outDir, `${String(size)}.png`), Buffer.from(b64, 'base64'))
    }
  } finally {
    win.destroy()
  }
}

// ---------------------------------------------------------------------------------------------
// Node side: run Electron, then assemble the outputs.

function runElectron(outDir: string): Promise<void> {
  const electronBin = createRequire(import.meta.url)('electron') as string
  const env: NodeJS.ProcessEnv = { ...process.env, [RENDER_DIR_ENV]: outDir }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [SELF], { env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Electron renderer exited with code ${String(code)}`))
    })
  })
}

/** Width/height from a PNG's IHDR chunk (bytes 16..23). */
function pngSize(png: Buffer): [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

/**
 * ICO container: 6-byte ICONDIR, one 16-byte ICONDIRENTRY per image, then the PNG files as-is
 * (PNG entries are supported since Windows Vista). A width/height byte of 0 means 256.
 */
function buildIco(pngs: Buffer[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries: Buffer[] = []
  let offset = 6 + 16 * pngs.length
  for (const png of pngs) {
    const [w, h] = pngSize(png)
    const e = Buffer.alloc(16)
    e.writeUInt8(w >= 256 ? 0 : w, 0)
    e.writeUInt8(h >= 256 ? 0 : h, 1)
    e.writeUInt8(0, 2) // no palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs])
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'vp-icons-'))
  try {
    const rendered = join(work, 'png')
    await mkdir(rendered)
    await runElectron(rendered)
    const png = new Map<number, Buffer>()
    for (const size of SIZES) {
      const buf = await readFile(join(rendered, `${String(size)}.png`))
      const [w, h] = pngSize(buf)
      if (w !== size || h !== size)
        throw new Error(`${String(size)} px render is ${String(w)} x ${String(h)}`)
      png.set(size, buf)
    }
    const get = (size: number): Buffer => {
      const buf = png.get(size)
      if (buf === undefined) throw new Error(`missing ${String(size)} px render`)
      return buf
    }

    await writeFile(join(ICONS_DIR, 'icon.png'), get(1024))
    console.log('wrote resources/icons/icon.png')

    await writeFile(join(ICONS_DIR, 'icon.ico'), buildIco(ICO_SIZES.map(get)))
    console.log('wrote resources/icons/icon.ico')

    if (process.platform === 'darwin') {
      const iconset = join(work, 'icon.iconset')
      await mkdir(iconset)
      for (const [name, size] of ICONSET) await writeFile(join(iconset, name), get(size))
      await execFileAsync('iconutil', ['-c', 'icns', iconset, '-o', join(ICONS_DIR, 'icon.icns')])
      console.log('wrote resources/icons/icon.icns')
    } else {
      console.warn('skipped icon.icns: iconutil is macOS only (the committed one is kept)')
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const renderDir = process.env[RENDER_DIR_ENV]
// `process.versions.electron` is typed as always present (Electron's types); under Node it is not.
const inElectron = 'electron' in process.versions
if (inElectron && renderDir !== undefined) {
  // Electron child: render, then quit with a status the parent can read. Not awaited at the top
  // level: Electron holds back `ready` until an ESM main module has finished evaluating.
  void import('electron').then(({ app }) =>
    renderInElectron(renderDir).then(
      () => {
        app.exit(0)
      },
      (err: unknown) => {
        // executeJavaScript rejections serialise poorly; print the message explicitly.
        console.error(err instanceof Error ? err.message : err)
        app.exit(1)
      },
    ),
  )
} else {
  await main()
}
