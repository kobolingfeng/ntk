#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distCli = join(__dirname, '..', 'dist', 'cli.js');

// Prefer pre-compiled dist/ for faster startup (~300ms saved vs tsx transpile)
if (existsSync(distCli)) {
  await import(distCli);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/cli.ts');
}
