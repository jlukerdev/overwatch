import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
  },
  test: {
    // Two homes, one runner. `tests/unit` is main/preload/shared code, typechecked by
    // tsconfig.node.json; `tests/renderer` is renderer code, which needs the DOM lib and so is
    // typechecked by tsconfig.web.json (P1.5). Both run in the node environment: what is tested
    // there is pure logic, and the components stay thin on purpose (CLAUDE.md).
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'out/**', 'dist/**'],
    environment: 'node',
  },
})
