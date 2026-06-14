import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-setup.ts'],
    fileParallelism: false, // shared DB; avoid cross-file truncation races
  },
});
