import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/benchmark*.ts',
        'src/probe.ts',
        'src/test-runner.ts',
        'src/cli.ts',
        'src/cli/**',
      ],
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 10,
        statements: 10,
      },
    },
  },
});
