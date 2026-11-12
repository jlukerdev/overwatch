// Generate src/main/protect/generated.ts from the vendored Protect contract (P0.3b).
// Node 24 runs this file directly (type stripping): erasable TypeScript syntax only.
//
//   node scripts/gen-protect-types.ts           (re)write src/main/protect/generated.ts
//   node scripts/gen-protect-types.ts --check   exit 1 if the committed file is out of date
//
// The output is a pure function of the contract file and the pinned openapi-typescript version
// (exact pin in package.json), so re-running produces no diff. `--check` generates in memory and
// compares with the committed file (line endings normalized, so a CRLF checkout on Windows passes).
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_PATH = join(ROOT, 'docs', 'reference', 'protect-openapi-v7.3.74.json')
const OUTPUT_PATH = join(ROOT, 'src', 'main', 'protect', 'generated.ts')

/** Repo-relative POSIX path, so the header is identical on every platform. */
function repoPath(path: string): string {
  return relative(ROOT, path).split('\\').join('/')
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

async function generate(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(CONTRACT_PATH), { silent: true })
  const header = [
    '// GENERATED FILE: DO NOT EDIT.',
    `// Source contract: ${repoPath(CONTRACT_PATH)}`,
    '// Generator: openapi-typescript (see the devDependency pin in package.json).',
    '// Regenerate with `npm run gen:protect-types`; `npm run check:protect-types` detects drift.',
    '// App code imports from ./types.ts, which applies the documented contract-drift overrides.',
    '',
  ].join('\n')
  return normalizeEol(`${header}\n${astToString(ast).trimEnd()}\n`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => a !== '--check')
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`)
    console.error('Usage: node scripts/gen-protect-types.ts [--check]')
    process.exit(2)
  }
  const output = await generate()
  const target = repoPath(OUTPUT_PATH)

  if (args.includes('--check')) {
    let committed: string
    try {
      committed = normalizeEol(await readFile(OUTPUT_PATH, 'utf8'))
    } catch {
      console.error(`${target} is missing. Run \`npm run gen:protect-types\`.`)
      process.exit(1)
    }
    if (committed !== output) {
      console.error(
        `${target} is out of date with ${repoPath(CONTRACT_PATH)}. Run \`npm run gen:protect-types\` and commit the result.`,
      )
      process.exit(1)
    }
    console.log(`${target} is up to date.`)
    return
  }

  await writeFile(OUTPUT_PATH, output, 'utf8')
  console.log(`Wrote ${target} (${String(output.split('\n').length - 1)} lines).`)
}

await main()
