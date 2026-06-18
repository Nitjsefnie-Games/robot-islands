import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'client',
          // Characterization golden replays (#124) run in the client project so
          // golden drift fails `npm test` instead of rotting in a manual script.
          include: ['src/**/*.test.ts', 'characterization/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['server/src/**/*.test.ts'],
          globalSetup: ['./server/src/test-setup.ts'],
          // Mirrors server/vitest.config.ts (globalSetup + serial) — Vitest
          // projects don't inherit it; keep these two in sync.
          // Server suites truncate shared tables and migrate/drop schema, so they
          // must not race each other against the single test database.
          fileParallelism: false,
        },
      },
    ],
  },
});
