import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: './coverage',
    },
  },
  resolve: {
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
