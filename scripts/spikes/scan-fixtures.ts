// Leak scan for sanitized fixtures (P0.3). Prints only PASS/FAIL per check, never the values.
//
//   node scripts/spikes/scan-fixtures.ts [dir ...]     default: tests/fixtures/protect
//
// Reads VP_CONSOLE_HOST / VP_PROTECT_API_KEY from .env.local when present.
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const envFile = join(ROOT, '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const host = (process.env.VP_CONSOLE_HOST ?? '').trim().replace(/^https?:\/\//, '')
const hostname = host.replace(/:\d+$/, '')
const apiKey = (process.env.VP_PROTECT_API_KEY ?? '').trim()

interface Check {
  name: string
  test: (text: string) => boolean
}

const checks: Check[] = [
  {
    name: 'console host',
    test: (t) => hostname.length > 0 && t.toLowerCase().includes(hostname.toLowerCase()),
  },
  { name: 'API key', test: (t) => apiKey.length > 0 && t.includes(apiKey) },
  // Alphanumeric lookarounds, not `\b`: `_` is a word character, so `\b` misses a value wrapped in
  // underscores (e.g. `reader_<mac>_<uuid>_<ts>.jpg`). Same boundaries as lib/sanitize.ts.
  {
    name: 'MAC (separated)',
    test: (t) => /(?<![0-9a-z])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}(?![0-9a-z])/i.test(t),
  },
  { name: 'MAC (bare 12-hex)', test: (t) => /(?<![0-9a-z])[0-9a-f]{12}(?![0-9a-z])/i.test(t) },
  { name: 'IPv4 address', test: (t) => /(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/.test(t) },
  {
    name: 'rtsps:// with a real host',
    test: (t) => /rtsps?:\/\/(?!console\.invalid[:/])/i.test(t),
  },
  { name: '24-hex Protect id', test: (t) => /(?<![0-9a-z])[0-9a-f]{24}(?![0-9a-z])/i.test(t) },
]

async function main(): Promise<void> {
  const dirs = process.argv.slice(2)
  const targets = dirs.length > 0 ? dirs : [join(ROOT, 'tests', 'fixtures', 'protect')]
  const files: string[] = []
  for (const d of targets) {
    for (const f of await readdir(d)) files.push(join(d, f))
  }
  let failed = false
  for (const c of checks) {
    const hits: string[] = []
    for (const f of files) {
      if (c.test(await readFile(f, 'utf8'))) hits.push(relative(ROOT, f))
    }
    failed ||= hits.length > 0
    console.log(
      `${hits.length === 0 ? 'PASS' : 'FAIL'}  ${c.name}${hits.length ? `  (${hits.join(', ')})` : ''}`,
    )
  }
  if (!hostname || !apiKey) console.log('note: host/key not set, those checks were vacuous')
  console.log(failed ? 'scan: FAIL' : `scan: PASS (${String(files.length)} files)`)
  if (failed) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`scan-fixtures: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
