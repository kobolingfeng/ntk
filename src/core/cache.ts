/**
 * Response Cache — Memoize pipeline results for identical tasks.
 *
 * When the same task is submitted again, return cached result
 * with zero token cost. Uses FNV-1a hash for matching.
 * LRU eviction: accessed entries are bumped to most-recent position.
 */

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
    const normalized = `${depth ?? 'auto'}:${this.normalizeTask(task)}`;
    // FNV-1a hash — fast, sufficient collision resistance for 100-entry cache
    let h = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      h ^= normalized.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** Normalize task text for cache matching:
   *  - lowercase + trim
   *  - strip trailing punctuation (。！？.!?)
   *  - collapse multiple spaces to single space
   *  - remove common filler prefixes (帮我/请/帮忙/please/can you/could you)
   */
  private normalizeTask(task: string): string {
    return task.trim().toLowerCase()
      .replace(/[。！？.!?]+$/, '')
      .replace(/\s+/g, ' ')
      // Single-pass filler strip — `+` handles nested prefixes like "请帮我" or "please can you"
      .replace(/^(?:(?:帮我|请|帮忙|please |can you |could you )\s*)+/, '');
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

    // LRU: bump to most-recent position by reinserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    this.tokensSavedByHits += entry.tokensSaved;
    return entry;
  }

  set(task: string, result: string, depth: string, totalTokens: number, forceDepth?: string): void {
    const key = this.hash(task, forceDepth);

    // If key exists, delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict least recently used (first entry in Map insertion order)
      const lru = this.cache.keys().next().value;
      if (lru) this.cache.delete(lru);
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
    this.tokensSavedByHits = 0;
  }
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  totalTokensSaved: number;
}
