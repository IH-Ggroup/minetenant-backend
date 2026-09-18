import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests-ts/**/*.test.{ts,mjs}'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
