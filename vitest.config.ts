import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // PGlite instances are independent per file, so parallel files would be
    // correct — but each one loads a Postgres WASM image, and running them
    // sequentially keeps memory predictable on a free CI runner.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { LOG_LEVEL: 'silent' },
  },
});
