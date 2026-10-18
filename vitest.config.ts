import { defineConfig } from 'vitest/config';

/**
 * Real-Postgres tests: each test FILE gets a freshly migrated test database
 * schema (see test/setup.ts) and files run one at a time, so race and count
 * assertions stay deterministic.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
