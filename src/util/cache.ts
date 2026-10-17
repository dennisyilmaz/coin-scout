interface Entry {
  value: unknown;
  expires: number;
}

export class TtlCache {
  private readonly map = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(4)),
    };
  }

  clear(): void {
    this.map.clear();
  }
}

export const TTL = {
  immutable: 6 * 60 * 60 * 1000,
  asset: 30_000,
  history: 5_000,
  account: 2_000,
  supply: 15_000,
  fee: 2_000,
  none: 0,
} as const;
