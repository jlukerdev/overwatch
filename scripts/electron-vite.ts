// Runs electron-vite with an environment that cannot make Electron start as plain Node.
//
// `ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as a Node interpreter: `app` is
// undefined and the app dies with `Cannot read properties of undefined (reading 'isPackaged')`.
// VS Code's integrated terminals inherit the variable from the extension host, so `npm run dev`
// fails there and nowhere else, which is a confusing way to lose an afternoon. The P0.5 video spike
// hit the same thing on Windows and strips the variable in its own launcher
// (`scripts/spikes/video-spike/lib.ts`, `childEnv()`); its write-up asks for the app's dev scripts
// to be checked for it in Phase 1 (docs/spikes/P0.5-video.md, "Windows run").
//
// Usage: `node scripts/electron-vite.ts <dev|build|preview> [args…]`
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/electron-vite.ts <dev|build|preview> [args…]')
  process.exit(2)
}

const env = { ...process.env }
// Delete, don't blank: Electron treats any non-empty value as "run as Node", and an empty string
// is safe but leaves a confusing variable in the child's environment.
delete env.ELECTRON_RUN_AS_NODE

// Resolved through the package's own `bin` entry: electron-vite's `exports` map does not expose
// the bin path, so `require.resolve('electron-vite/bin/…')` is refused. `./package.json` is
// exported, which gives a stable anchor. Not node_modules/.bin, which is a shell shim (a .cmd on
// Windows) and cannot be handed to `process.execPath`.
const pkgPath = require.resolve('electron-vite/package.json')
const pkg = require(pkgPath) as { bin?: Record<string, string | undefined> }
const binEntry = pkg.bin?.['electron-vite']
if (binEntry === undefined) {
  console.error("electron-vite's package.json has no `bin.electron-vite` entry; cannot start it.")
  process.exit(1)
}
const bin = join(dirname(pkgPath), binEntry)
const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', env })

child.on('exit', (code, signal) => {
  // Pass the child's outcome through, so `npm run dev` still fails the way the tool failed.
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
child.on('error', (err: unknown) => {
  console.error('Failed to start electron-vite:', err)
  process.exit(1)
})
