import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAppUrl } from '../../src/main/navigation'

const appRoot = resolve('/opt/view-protect/resources/app.asar/out')
const rendererIndexPath = join(appRoot, 'renderer', 'index.html')
const indexUrl = pathToFileURL(rendererIndexPath).href
const packaged = { rendererIndexPath }
const dev = { devUrl: 'http://localhost:5173', rendererIndexPath }

describe('isAppUrl (dev)', () => {
  it('allows the dev server origin', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/some/route?x=1#y', dev)).toBe(true)
  })

  it('rejects other origins', () => {
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl('http://127.0.0.1:5173/', dev)).toBe(false)
    expect(isAppUrl('https://example.com/', dev)).toBe(false)
    expect(isAppUrl(indexUrl, dev)).toBe(false)
  })
})

describe('isAppUrl (packaged)', () => {
  it('allows the renderer index.html, ignoring hash and query', () => {
    expect(isAppUrl(indexUrl, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}#/settings`, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}?view=1`, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}?view=1#/live`, packaged)).toBe(true)
  })

  it('rejects other file: paths', () => {
    expect(isAppUrl(pathToFileURL(join(appRoot, 'renderer', 'other.html')).href, packaged)).toBe(
      false,
    )
    expect(isAppUrl(pathToFileURL(join(appRoot, 'main', 'index.js')).href, packaged)).toBe(false)
    expect(isAppUrl(pathToFileURL(resolve('/etc/passwd')).href, packaged)).toBe(false)
  })

  it('rejects path traversal', () => {
    const base = pathToFileURL(join(appRoot, 'renderer')).href
    expect(isAppUrl(`${base}/../renderer/../../../../etc/passwd`, packaged)).toBe(false)
    expect(isAppUrl(`${base}/%2e%2e/%2e%2e/etc/passwd`, packaged)).toBe(false)
    expect(isAppUrl(`${base}/..%2F..%2Fetc%2Fpasswd`, packaged)).toBe(false)
  })

  it('allows a traversal that resolves back to index.html', () => {
    const base = pathToFileURL(join(appRoot, 'renderer')).href
    expect(isAppUrl(`${base}/../renderer/index.html`, packaged)).toBe(true)
  })

  it('rejects http(s) URLs', () => {
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false)
    expect(isAppUrl('https://example.com/index.html', packaged)).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(isAppUrl('', packaged)).toBe(false)
    expect(isAppUrl('not a url', packaged)).toBe(false)
    expect(isAppUrl('file://', packaged)).toBe(false)
    expect(isAppUrl('http://', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', { devUrl: 'not a url', rendererIndexPath })).toBe(
      false,
    )
  })
})
