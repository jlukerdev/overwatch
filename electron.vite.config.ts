import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

const CSP_ANCHOR = "default-src 'self';"

/**
 * Dev server only: Vite injects imported CSS as inline <style> tags, which the strict
 * CSP in src/renderer/index.html blocks. Relax style-src for `electron-vite dev` only;
 * production builds ship the CSP unchanged (CSS is emitted as a file there).
 */
function devInlineStyleCsp(): Plugin {
  return {
    name: 'view-protect:dev-inline-style-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!html.includes(CSP_ANCHOR)) {
        throw new Error(
          `[view-protect:dev-inline-style-csp] Expected "${CSP_ANCHOR}" in the renderer CSP ` +
            '(src/renderer/index.html). Update this plugin to match the new CSP.',
        )
      }
      return html.replace(CSP_ANCHOR, `${CSP_ANCHOR} style-src 'self' 'unsafe-inline';`)
    },
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
  },
  preload: {
    resolve: { alias: sharedAlias },
    // The preload runs with `sandbox: true`, so it cannot require() packages from
    // node_modules at runtime. Bundle everything it imports into the output.
    build: { externalizeDeps: false },
    // Exposed to the renderer as window.viewProtect.version (see src/preload/env.d.ts).
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [react(), devInlineStyleCsp()],
  },
})
