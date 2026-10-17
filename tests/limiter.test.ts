import { describe, expect, it } from "vitest";
import { AdaptiveLimiter } from "../src/util/limiter.js";
import { TtlCache } from "../src/util/cache.js";

describe("AdaptiveLimiter", () => {
  it("starts unthrottled and caps concurrency", async () => {
    const limiter = new AdaptiveLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.stats().active).toBe(2);

    let third = false;
    const pending = limiter.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);

    limiter.release();
    await pending;
    expect(third).toBe(true);
  });

  it("introduces request spacing after a throttle and decays it on success", () => {
    const limiter = new AdaptiveLimiter(16);
    expect(limiter.stats().minIntervalMs).toBe(0);

    limiter.onThrottle(0);
    const first = limiter.stats();
    expect(first.minIntervalMs).toBeGreaterThan(0);
    expect(first.concurrencyLimit).toBe(8);

    limiter.onThrottle(0);
    expect(limiter.stats().minIntervalMs).toBe(first.minIntervalMs * 2);
    expect(limiter.stats().concurrencyLimit).toBe(4);

    const throttled = limiter.stats().minIntervalMs;
    for (let i = 0; i < 15; i++) limiter.onSuccess();
    expect(limiter.stats().minIntervalMs).toBeLessThan(throttled);
    expect(limiter.stats().concurrencyLimit).toBe(5);
  });

  it("spaces a batched request by its call count", async () => {
    const limiter = new AdaptiveLimiter(8);
    limiter.onThrottle(0);
    const interval = limiter.stats().minIntervalMs;

    await limiter.acquire(10);
    const start = Date.now();
    await limiter.acquire(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(interval * 10 - 25);
  });
});

describe("TtlCache", () => {
  it("expires entries and reports hit rate", () => {
    const cache = new TtlCache(10);
    cache.set("a", 1, 50);
    expect(cache.get("a")).toBe(1);
    expect(cache.stats().hits).toBe(1);

    cache.set("b", 2, 0);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = new TtlCache(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.get("a");
    cache.set("c", 3, 1000);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
