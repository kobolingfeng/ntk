/**
 * Gain tracker — persistent pre-filter and token savings statistics.
 * Inspired by RTK's `rtk gain` command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';

interface GainEntry {
  timestamp: number;
  preFilterCharsRemoved: number;
  preFilterOriginal: number;
  totalTokens: number;
  strongTokens: number;
  cheapTokens: number;
  depth: string;
  detectedTypes: string[];
}

interface GainData {
  version: 1;
  entries: GainEntry[];
}

const GAIN_DIR = join(homedir(), '.ntk');
const GAIN_FILE = join(GAIN_DIR, 'gain.json');

function loadGainData(): GainData {
  try {
    if (existsSync(GAIN_FILE)) {
      return JSON.parse(readFileSync(GAIN_FILE, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { version: 1, entries: [] };
}

function saveGainData(data: GainData): void {
  if (!existsSync(GAIN_DIR)) {
    mkdirSync(GAIN_DIR, { recursive: true });
  }
  writeFileSync(GAIN_FILE, JSON.stringify(data, null, 2));
}

let pendingEntries: GainEntry[] = [];
let gainDebounceTimer: ReturnType<typeof setTimeout> | undefined;
const GAIN_DEBOUNCE_MS = 2000;

export function recordGain(entry: GainEntry): void {
  pendingEntries.push(entry);
  if (gainDebounceTimer) clearTimeout(gainDebounceTimer);
  gainDebounceTimer = setTimeout(flushGain, GAIN_DEBOUNCE_MS);
  if (gainDebounceTimer && typeof gainDebounceTimer === 'object' && 'unref' in gainDebounceTimer) {
    gainDebounceTimer.unref();
  }
}

function flushGain(): void {
  if (pendingEntries.length === 0) return;
  const data = loadGainData();
  data.entries.push(...pendingEntries);
  pendingEntries = [];
  // Cap entries to prevent unbounded growth in long-running usage
  if (data.entries.length > 1000) {
    data.entries = data.entries.slice(-1000);
  }
  saveGainData(data);
}

function renderBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

export function cmdGain(): void {
  const data = loadGainData();

  if (data.entries.length === 0) {
    console.log(chalk.yellow('\n  No gain data yet. Run some tasks first.\n'));
    return;
  }

  console.log(chalk.cyan.bold('\n  📈 NTK Gain Report — Cumulative Savings\n'));

  const totalEntries = data.entries.length;
  const totalPFRemoved = data.entries.reduce((s, e) => s + e.preFilterCharsRemoved, 0);
  const totalPFOrig = data.entries.reduce((s, e) => s + e.preFilterOriginal, 0);
  const totalTokens = data.entries.reduce((s, e) => s + e.totalTokens, 0);
  const totalStrong = data.entries.reduce((s, e) => s + e.strongTokens, 0);
  const totalCheap = data.entries.reduce((s, e) => s + e.cheapTokens, 0);

  const pfPct = totalPFOrig > 0 ? (totalPFRemoved / totalPFOrig) * 100 : 0;
  const cheapPct = totalTokens > 0 ? (totalCheap / totalTokens) * 100 : 0;
  const costSavingPct = totalTokens > 0 ? (1 - (totalStrong * 10 + totalCheap) / (totalTokens * 10)) * 100 : 0;

  // Summary
  console.log(chalk.white(`  Total runs: ${totalEntries}`));
  console.log(chalk.white(`  Total tokens: ${totalTokens}`));

  // Pre-filter savings
  console.log(chalk.magenta.bold('\n  🧹 Pre-filter Savings'));
  console.log(chalk.dim(`     Chars removed: ${totalPFRemoved.toLocaleString()} / ${totalPFOrig.toLocaleString()}`));
  console.log(chalk.dim(`     Reduction:     ${renderBar(pfPct)} ${pfPct.toFixed(1)}%`));

  // Cost separation
  console.log(chalk.green.bold('\n  💰 Cost Separation'));
  console.log(
    chalk.dim(
      `     Strong model:  ${totalStrong.toLocaleString()} tokens (${((totalStrong / Math.max(totalTokens, 1)) * 100).toFixed(0)}%)`,
    ),
  );
  console.log(chalk.dim(`     Cheap model:   ${totalCheap.toLocaleString()} tokens (${cheapPct.toFixed(0)}%)`));
  console.log(
    chalk.dim(
      `     Cost savings:  ${renderBar(Math.max(0, costSavingPct))} ~${Math.max(0, costSavingPct).toFixed(0)}%`,
    ),
  );

  // Depth distribution
  const depthCounts: Record<string, number> = {};
  for (const e of data.entries) {
    depthCounts[e.depth] = (depthCounts[e.depth] || 0) + 1;
  }
  console.log(chalk.blue.bold('\n  🎯 Depth Distribution'));
  for (const [depth, count] of Object.entries(depthCounts)) {
    const pct = (count / totalEntries) * 100;
    console.log(chalk.dim(`     ${depth.padEnd(10)} ${renderBar(pct, 15)} ${count} (${pct.toFixed(0)}%)`));
  }

  // Type detection distribution
  const typeCounts: Record<string, number> = {};
  for (const e of data.entries) {
    for (const t of e.detectedTypes) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }
  if (Object.keys(typeCounts).length > 0) {
    console.log(chalk.yellow.bold('\n  🔍 Output Type Detection'));
    for (const [type, count] of Object.entries(typeCounts)) {
      console.log(chalk.dim(`     ${type.padEnd(10)} ${count} detections`));
    }
  }

  // Recent entries (last 5)
  const recent = data.entries.slice(-5).reverse();
  console.log(chalk.cyan.bold('\n  📋 Recent Runs'));
  for (const e of recent) {
    const date = new Date(e.timestamp).toLocaleString();
    const pf = e.preFilterCharsRemoved > 0 ? ` pf:-${e.preFilterCharsRemoved}` : '';
    console.log(chalk.dim(`     ${date} | ${e.depth.padEnd(9)} | ${e.totalTokens}tok${pf}`));
  }

  console.log('');
}
