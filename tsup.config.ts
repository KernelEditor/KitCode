import { defineConfig } from 'tsup'
import { execFileSync } from 'node:child_process'

function buildCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'development'
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  
  
  banner: { js: '#!/usr/bin/env node' },
  define: { __KITCODE_COMMIT__: JSON.stringify(buildCommit()) },
})
