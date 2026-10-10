import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { typescriptMetadataPlugin } from './test/typescript-plugin.js';

export default defineConfig({
  plugins: [tsconfigPaths(), typescriptMetadataPlugin()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
