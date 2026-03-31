/**
 * Response Cache — Memoize pipeline results for identical tasks.
 *
 * When the same task is submitted again, return cached result
 * with zero token cost. Uses content hash for matching.
 */

import { createHash } from 'node:crypto';

interface CacheEntry {
  result: string;
  depth: string;
  tokensSaved: number;
  createdAt: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;
  private hits = 0;
  private misses = 0;
  private tokensSavedByHits = 0;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  private hash(task: string, depth?: string): string {
    const normalized = `${depth ?? 'auto'}:${task.trim().toLowerCase()}`;
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  get(task: string, depth?: string): CacheEntry | null {
    const key = this.hash(task, depth);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    this.tokensSavedByHits += entry.tokensSaved;
    return entry;
  }

  set(task: string, result: string, depth: string, totalTokens: number, forceDepth?: string): void {
    const key = this.hash(task, forceDepth);

    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, {
      result,
      depth,
      tokensSaved: totalTokens,
      createdAt: Date.now(),
    });
  }

  getStats(): CacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      totalTokensSaved: this.tokensSavedByHits,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  totalTokensSaved: number;
}
