import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
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
        'src/api/server.ts',
        'src/mcp/server.ts',
        'src/index.ts',
        'src/pipeline/types.ts',
      ],
      thresholds: {
        lines: 35,
        functions: 35,
        branches: 30,
        statements: 35,
      },
    },
  },
});
