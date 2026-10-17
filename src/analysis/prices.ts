import { TtlCache, TTL } from "../util/cache.js";
import { round } from "../util/format.js";
import { getJson } from "../util/http.js";

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SOL_ALIASES = new Set(["SOL", "So11111111111111111111111111111111111111111", WSOL]);

const BUCKET_SECONDS = 300;
const SEARCH_WIDTH_SECONDS = 3_600;
const POINTS_PER_REQUEST = 60;
const PARALLEL_REQUESTS = 4;
const MISSING = -1;

const cache = new TtlCache(50_000);

export function priceKey(mint: string): string {
  return `solana:${SOL_ALIASES.has(mint) ? WSOL : mint}`;
}

export function bucketOf(ts: number): number {
  return Math.round(ts / BUCKET_SECONDS) * BUCKET_SECONDS;
}

export class PriceBook {
  constructor(
    private readonly prices: Map<string, number>,
    readonly errors: string[] = [],
  ) {}

  at(mint: string, ts: number): number | null {
    return this.prices.get(`${priceKey(mint)}@${bucketOf(ts)}`) ?? null;
  }

  usd(mint: string, ts: number, amount: number): number | null {
    const price = this.at(mint, ts);
    return price === null ? null : round(price * amount, 2);
  }
}

interface LlamaBatch {
  coins: Record<string, { prices?: Array<{ timestamp: number; price: number }> }>;
}

export async function historicalPrices(
  points: Array<{ mint: string; ts: number }>,
): Promise<PriceBook> {
  const prices = new Map<string, number>();
  const missing = new Map<string, Set<number>>();

  for (const { mint, ts } of points) {
    if (!ts) continue;
    const key = priceKey(mint);
    const bucket = bucketOf(ts);
    const cached = cache.get<number>(`${key}@${bucket}`);
    if (cached === undefined) {
      const set = missing.get(key) ?? new Set<number>();
      set.add(bucket);
      missing.set(key, set);
    } else if (cached !== MISSING) {
      prices.set(`${key}@${bucket}`, cached);
    }
  }

  const errors: string[] = [];
  const fetchChunk = async (chunk: Record<string, number[]>) => {
    const url = `https://coins.llama.fi/batchHistorical?coins=${encodeURIComponent(
      JSON.stringify(chunk),
    )}&searchWidth=${SEARCH_WIDTH_SECONDS}`;
    try {
      const body = await getJson<LlamaBatch>(url, { timeoutMs: 20_000 });
      for (const [key, buckets] of Object.entries(chunk)) {
        const returned = body.coins?.[key]?.prices ?? [];
        for (const bucket of buckets) {
          const price = nearest(returned, bucket);
          cache.set(
            `${key}@${bucket}`,
            price ?? MISSING,
            price === null ? 3_600_000 : TTL.immutable,
          );
          if (price !== null) prices.set(`${key}@${bucket}`, price);
        }
      }
    } catch (error) {
      errors.push(
        `DefiLlama price lookup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  const chunks = chunkRequests(missing);
  for (let i = 0; i < chunks.length; i += PARALLEL_REQUESTS) {
    await Promise.all(chunks.slice(i, i + PARALLEL_REQUESTS).map(fetchChunk));
  }

  return new PriceBook(prices, errors);
}

function chunkRequests(missing: Map<string, Set<number>>): Array<Record<string, number[]>> {
  const chunks: Array<Record<string, number[]>> = [];
  let current: Record<string, number[]> = {};
  let size = 0;
  for (const [key, buckets] of missing) {
    for (const bucket of buckets) {
      if (size >= POINTS_PER_REQUEST) {
        chunks.push(current);
        current = {};
        size = 0;
      }
      (current[key] ??= []).push(bucket);
      size++;
    }
  }
  if (size > 0) chunks.push(current);
  return chunks;
}

function nearest(points: Array<{ timestamp: number; price: number }>, ts: number): number | null {
  let best: { timestamp: number; price: number } | null = null;
  for (const point of points) {
    if (Math.abs(point.timestamp - ts) > SEARCH_WIDTH_SECONDS) continue;
    if (!best || Math.abs(point.timestamp - ts) < Math.abs(best.timestamp - ts)) best = point;
  }
  return best && Number.isFinite(best.price) ? best.price : null;
}
