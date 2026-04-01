/**
 * Depth Predictor — History-based pipeline depth prediction.
 *
 * Learns from past task executions to predict the most likely
 * depth for new tasks. Like CPU branch prediction tables.
 *
 * Uses in-memory caching with lazy disk loading to minimize I/O.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PipelineDepth } from '../pipeline/types.js';

interface DepthRecord {
  pattern: string;
  depth: PipelineDepth;
  count: number;
}

interface PredictorData {
  version: 1;
  records: DepthRecord[];
}

const PREDICTOR_DIR = join(homedir(), '.ntk');
const PREDICTOR_FILE = join(PREDICTOR_DIR, 'depth-predictor.json');
const VALID_DEPTHS = new Set(['direct', 'light', 'standard', 'full']);

let memoryCache: PredictorData | null = null;
/** Index: pattern → DepthRecord[] for O(1) exact lookup */
let patternIndex: Map<string, DepthRecord[]> | null = null;
let dirty = false;
let saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
const SAVE_DEBOUNCE_MS = 2000;

function extractPattern(task: string): string {
  // Single-pass: extract up to 5 lowercase words from first 50 chars
  const limit = Math.min(task.length, 50);
  const words: string[] = [];
  let wordStart = -1;

  for (let i = 0; i <= limit; i++) {
    const c = i < limit ? task.charCodeAt(i) : 32;
    // a-z, A-Z, 0-9, _, CJK Unified Ideographs
    const isWord = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
                   (c >= 0x30 && c <= 0x39) || c === 0x5f ||
                   (c >= 0x4E00 && c <= 0x9FFF);
    if (isWord) {
      if (wordStart === -1) wordStart = i;
    } else if (wordStart !== -1) {
      words.push(task.slice(wordStart, i).toLowerCase());
      wordStart = -1;
      if (words.length >= 5) break;
    }
  }
  return words.join(' ');
}

function isValidData(data: unknown): data is PredictorData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.version !== 1 || !Array.isArray(d.records)) return false;
  return d.records.every(
    (r: unknown) =>
      r &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>).pattern === 'string' &&
      VALID_DEPTHS.has((r as Record<string, unknown>).depth as string) &&
      typeof (r as Record<string, unknown>).count === 'number',
  );
}

function loadFromDisk(): PredictorData {
  try {
    if (existsSync(PREDICTOR_FILE)) {
      const raw = JSON.parse(readFileSync(PREDICTOR_FILE, 'utf-8'));
      if (isValidData(raw)) return raw;
    }
  } catch {
    // Corrupted or invalid — start fresh
  }
  return { version: 1, records: [] };
}

function getData(): PredictorData {
  if (!memoryCache) {
    memoryCache = loadFromDisk();
    rebuildIndex(memoryCache);
  }
  return memoryCache;
}

function rebuildIndex(data: PredictorData): void {
  patternIndex = new Map();
  for (const r of data.records) {
    const list = patternIndex.get(r.pattern);
    if (list) list.push(r);
    else patternIndex.set(r.pattern, [r]);
  }
}

function saveToDisk(data: PredictorData): void {
  try {
    if (!existsSync(PREDICTOR_DIR)) mkdirSync(PREDICTOR_DIR, { recursive: true });
    const tmpFile = `${PREDICTOR_FILE}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(data));
    renameSync(tmpFile, PREDICTOR_FILE);
    dirty = false;
  } catch {
    // Non-critical
  }
}

export function recordDepth(task: string, depth: PipelineDepth): void {
  const pattern = extractPattern(task);
  const data = getData();

  const indexList = patternIndex?.get(pattern);
  const existing = indexList?.find((r) => r.depth === depth);
  if (existing) {
    existing.count++;
  } else {
    const record = { pattern, depth, count: 1 };
    data.records.push(record);
    if (patternIndex) {
      const list = patternIndex.get(pattern);
      if (list) list.push(record);
      else patternIndex.set(pattern, [record]);
    }
  }

  if (data.records.length > 500) {
    data.records.sort((a, b) => b.count - a.count);
    data.records = data.records.slice(0, 300);
    rebuildIndex(data);
  }

  dirty = true;
  scheduleSave();
}

function scheduleSave(): void {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    if (dirty && memoryCache) saveToDisk(memoryCache);
  }, SAVE_DEBOUNCE_MS);
  // Don't prevent process exit for a debounced save
  if (saveDebounceTimer && typeof saveDebounceTimer === 'object' && 'unref' in saveDebounceTimer) {
    saveDebounceTimer.unref();
  }
}

/** Flush pending depth records to disk immediately (call before process exit) */
export function flushDepthPredictor(): void {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  if (dirty && memoryCache) saveToDisk(memoryCache);
}

export function predictDepth(task: string): { depth: PipelineDepth; confidence: number } | null {
  const data = getData();
  if (data.records.length === 0) return null;

  const pattern = extractPattern(task);
  const matches = patternIndex?.get(pattern);

  if (!matches || matches.length === 0) {
    const words = pattern.split(' ');
    const partials = data.records.filter((r) => words.some((w) => w.length > 2 && r.pattern.includes(w)));

    if (partials.length === 0) return null;

    const depthCounts = new Map<PipelineDepth, number>();
    for (const p of partials) {
      depthCounts.set(p.depth, (depthCounts.get(p.depth) || 0) + p.count);
    }

    const total = partials.reduce((s, p) => s + p.count, 0);
    let best: PipelineDepth = 'direct';
    let bestCount = 0;
    for (const [depth, count] of depthCounts) {
      if (count > bestCount) {
        best = depth;
        bestCount = count;
      }
    }

    return { depth: best, confidence: bestCount / total };
  }

  const total = matches.reduce((s, m) => s + m.count, 0);
  let best: PipelineDepth = 'direct';
  let bestCount = 0;
  for (const m of matches) {
    if (m.count > bestCount) {
      best = m.depth;
      bestCount = m.count;
    }
  }

  return { depth: best, confidence: bestCount / total };
}

/** Flush any pending changes to disk (for testing/cleanup) */
export function flushPredictorCache(): void {
  if (dirty && memoryCache) {
    saveToDisk(memoryCache);
  }
}
