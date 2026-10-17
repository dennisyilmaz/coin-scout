import { TtlCache } from "./cache.js";

const cache = new TtlCache(5_000);
const inflight = new Map<string, Promise<unknown>>();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.name = "HttpError";
  }
}

export async function getJson<T>(
  url: string,
  options: { ttlMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const ttl = options.ttlMs ?? 0;
  if (ttl > 0) {
    const cached = cache.get<T>(url);
    if (cached !== undefined) return cached;
  }
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const promise = request<T>(url, options.timeoutMs ?? 15_000)
    .then((value) => {
      if (ttl > 0) cache.set(url, value, ttl);
      return value;
    })
    .finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

async function request<T>(url: string, timeoutMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as T;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 2) throw new HttpError(response.status, url, text.slice(0, 300));
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}
