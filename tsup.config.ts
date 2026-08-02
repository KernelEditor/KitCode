import { defineConfig } from 'tsup'

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
  // Runtime deps stay external and are resolved from node_modules.
  // Only our own `src/**` files get bundled together.
  banner: { js: '#!/usr/bin/env node' },
})
