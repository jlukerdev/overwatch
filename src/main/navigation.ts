// Navigation guard: decides whether a URL is the app's own renderer. Pure, no Electron imports.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppUrlOptions {
  /** Renderer dev-server URL. Pass only in unpackaged dev runs; omit/undefined when packaged. */
  readonly devUrl?: string | undefined
  /** Absolute path of the bundled renderer `index.html`. */
  readonly rendererIndexPath: string
}

/**
 * True if `url` points at the app's own renderer.
 * - Dev (`devUrl` set): only the dev server's origin.
 * - Otherwise: only a `file:` URL that resolves to exactly `rendererIndexPath`
 *   (hash and query ignored). Any other URL, or a malformed one, is rejected.
 */
export function isAppUrl(url: string, opts: AppUrlOptions): boolean {
  try {
    const target = new URL(url)
    if (opts.devUrl) {
      return target.origin === new URL(opts.devUrl).origin
    }
    if (target.protocol !== 'file:') return false
    target.hash = ''
    target.search = ''
    return resolve(fileURLToPath(target)) === resolve(opts.rendererIndexPath)
  } catch {
    return false
  }
}
