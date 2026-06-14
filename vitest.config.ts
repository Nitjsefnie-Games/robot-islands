import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'client',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['server/src/**/*.test.ts'],
          globalSetup: ['./server/src/test-setup.ts'],
          // Server suites truncate shared tables and migrate/drop schema, so they
          // must not race each other against the single test database.
          fileParallelism: false,
        },
      },
    ],
  },
});
