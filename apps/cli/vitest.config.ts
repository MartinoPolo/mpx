import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      '@mpx/config': path.resolve(__dirname, '../../packages/config/src/index.ts'),
      '@mpx/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@mpx/providers': path.resolve(__dirname, '../../packages/providers/src/index.ts'),
      '@mpx/skills': path.resolve(__dirname, '../../packages/skills/src/index.ts'),
    },
  },
});
