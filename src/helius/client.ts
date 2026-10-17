import { Pool } from "undici";
import type { Config } from "../config.js";
import { TtlCache } from "../util/cache.js";
import { AdaptiveLimiter, sleep } from "../util/limiter.js";

export interface CallOptions {
  ttlMs?: number;
  batch?: boolean;
  timeoutMs?: number;
}

interface Pending {
  method: string;
  params: unknown;
  id: number;
  requeues: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class HeliusError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly method: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "HeliusError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_RPC_CODES = new Set([-32603, -32005, -32004, -32002]);

export class HeliusClient {
  private readonly pool: Pool;
  private readonly cache: TtlCache;
  private readonly limiter: AdaptiveLimiter;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly queue: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private requestCount = 0;
  private batchedCallCount = 0;
  private retryCount = 0;
  private batchSize: number;
  private batchSuccesses = 0;

  constructor(private readonly config: Config) {
    this.batchSize = config.maxBatchSize;
    this.pool = new Pool(config.rpcOrigin, {
      connections: config.connections,
      allowH2: config.allowH2,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      headersTimeout: config.requestTimeoutMs,
      bodyTimeout: config.requestTimeoutMs,
    });
    this.cache = new TtlCache(config.cacheMaxEntries);
    this.limiter = new AdaptiveLimiter(config.maxConcurrency);
  }

  async rpc<T>(method: string, params: unknown, options: CallOptions = {}): Promise<T> {
    const ttl = options.ttlMs ?? 0;
    const key = `${method}:${stableKey(params)}`;

    if (ttl > 0) {
      const cached = this.cache.get<T>(key);
      if (cached !== undefined) return cached;
    }

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.dispatch<T>(method, params, options)
      .then((value) => {
        if (ttl > 0) this.cache.set(key, value, ttl);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private dispatch<T>(method: string, params: unknown, options: CallOptions): Promise<T> {
    if (options.batch === false) {
      return this.sendPayload({ jsonrpc: "2.0", id: this.nextId++, method, params }, method).then(
        (results) => unwrapSingle<T>(results, method),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        method,
        params,
        id: this.nextId++,
        requeues: 0,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.batchedCallCount++;

      if (this.queue.length >= this.batchSize) {
        this.flush();
      } else if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => this.flush(), this.config.batchWindowMs);
      }
    });
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return;
    if (this.queue.length > 0) queueMicrotask(() => this.flush());

    const payload =
      batch.length === 1
        ? { jsonrpc: "2.0", id: batch[0].id, method: batch[0].method, params: batch[0].params }
        : batch.map((p) => ({ jsonrpc: "2.0", id: p.id, method: p.method, params: p.params }));

    const label = batch.length === 1 ? batch[0].method : `batch(${batch.length})`;

    this.sendPayload(payload, label, batch.length).then(
      (results) => {
        const byId = new Map<number, RpcEnvelope>();
        for (const item of results) byId.set(Number(item.id), item);
        for (const pending of batch) {
          const envelope = byId.get(pending.id);
          if (!envelope) {
            pending.reject(
              new HeliusError("No response for batched request", "no-response", pending.method),
            );
          } else if (envelope.error) {
            pending.reject(
              new HeliusError(
                envelope.error.message,
                envelope.error.code,
                pending.method,
                envelope.error.data,
              ),
            );
          } else {
            pending.resolve(envelope.result);
          }
        }
      },
      (error) => {
        const throttled = error instanceof HeliusError && Number(error.code) === 429;
        if (throttled && batch.length > 1) {
          this.shrinkBatch();
          const retryable: Pending[] = [];
          for (const pending of batch) {
            if (pending.requeues < 2) {
              pending.requeues++;
              retryable.push(pending);
            } else {
              pending.reject(error);
            }
          }
          if (retryable.length > 0) {
            this.queue.unshift(...retryable);
            this.flushTimer ??= setTimeout(() => this.flush(), this.config.batchWindowMs);
          }
          return;
        }
        for (const pending of batch) pending.reject(error);
      },
    );
  }

  private shrinkBatch(): void {
    this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
    this.batchSuccesses = 0;
  }

  private growBatch(): void {
    if (this.batchSize >= this.config.maxBatchSize) return;
    if (++this.batchSuccesses < 10) return;
    this.batchSuccesses = 0;
    this.batchSize = Math.min(this.config.maxBatchSize, this.batchSize * 2);
  }

  private async sendPayload(
    payload: unknown,
    label: string,
    cost = 1,
    timeoutMs?: number,
  ): Promise<RpcEnvelope[]> {
    const body = JSON.stringify(payload);
    const raw = await this.httpRequest(this.config.rpcPath, body, label, cost, timeoutMs);
    const parsed = JSON.parse(raw) as RpcEnvelope | RpcEnvelope[];
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    if (cost > 1) this.growBatch();

    const retryableRpc = envelopes.find(
      (e) => e.error && RETRYABLE_RPC_CODES.has(Number(e.error.code)),
    );
    if (retryableRpc && envelopes.length === 1) {
      throw new HeliusError(
        retryableRpc.error!.message,
        retryableRpc.error!.code,
        label,
        retryableRpc.error!.data,
      );
    }
    return envelopes;
  }

  private async httpRequest(
    path: string,
    body: string | undefined,
    label: string,
    cost = 1,
    timeoutMs?: number,
  ): Promise<string> {
    let lastError: unknown;
    let abortRetries = 0;
    const maxAttempts = cost > 1 ? 1 : this.config.maxRetries;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        this.retryCount++;
        await sleep(Math.min(2 ** attempt * 120, 4_000) + Math.random() * 120);
      }

      await this.limiter.acquire(cost);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        timeoutMs ?? this.config.requestTimeoutMs,
      );

      try {
        this.requestCount++;
        const response = await this.pool.request({
          path,
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });

        const text = await response.body.text();

        if (response.statusCode === 429) {
          const retryAfter = Number(response.headers["retry-after"]);
          this.limiter.onThrottle(
            Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt,
          );
          lastError = new HeliusError("Helius rate limit exceeded", 429, label, text.slice(0, 200));
          continue;
        }

        if (RETRYABLE_STATUS.has(response.statusCode)) {
          lastError = new HeliusError(
            `Helius HTTP ${response.statusCode}`,
            response.statusCode,
            label,
            text.slice(0, 200),
          );
          continue;
        }

        if (response.statusCode >= 400) {
          throw new HeliusError(
            `Helius HTTP ${response.statusCode}: ${text.slice(0, 300)}`,
            response.statusCode,
            label,
            text,
          );
        }

        this.limiter.onSuccess();
        return text;
      } catch (error) {
        if (error instanceof HeliusError && !RETRYABLE_STATUS.has(Number(error.code))) throw error;
        if (isTimeout(error) && ++abortRetries > 1) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        this.limiter.release();
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new HeliusError(String(lastError), "unknown", label);
  }

  async restGet<T>(path: string, options: CallOptions = {}): Promise<T> {
    const key = `GET:${path}`;
    const ttl = options.ttlMs ?? 0;
    if (ttl > 0) {
      const cached = this.cache.get<T>(key);
      if (cached !== undefined) return cached;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.httpRequest(this.withKey(path), undefined, path, 1, options.timeoutMs)
      .then((text) => {
        const value = JSON.parse(text) as T;
        if (ttl > 0) this.cache.set(key, value, ttl);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async restPost<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
    const payload = JSON.stringify(body);
    const key = `POST:${path}:${payload}`;
    const ttl = options.ttlMs ?? 0;
    if (ttl > 0) {
      const cached = this.cache.get<T>(key);
      if (cached !== undefined) return cached;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.httpRequest(this.withKey(path), payload, path, 1, options.timeoutMs)
      .then((text) => {
        const value = JSON.parse(text) as T;
        if (ttl > 0) this.cache.set(key, value, ttl);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  private withKey(path: string): string {
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}api-key=${this.config.apiKey}`;
  }

  metrics() {
    return {
      httpRequests: this.requestCount,
      rpcCallsQueued: this.batchedCallCount,
      retries: this.retryCount,
      currentBatchSize: this.batchSize,
      maxBatchSize: this.config.maxBatchSize,
      batchCompression:
        this.requestCount === 0
          ? 0
          : Number((this.batchedCallCount / this.requestCount).toFixed(2)),
      cache: this.cache.stats(),
      limiter: this.limiter.stats(),
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

interface RpcEnvelope {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function unwrapSingle<T>(envelopes: RpcEnvelope[], method: string): T {
  const envelope = envelopes[0];
  if (!envelope) throw new HeliusError("Empty response", "empty", method);
  if (envelope.error) {
    throw new HeliusError(envelope.error.message, envelope.error.code, method, envelope.error.data);
  }
  return envelope.result as T;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    (error as { code?: string }).code === "UND_ERR_HEADERS_TIMEOUT" ||
    (error as { code?: string }).code === "UND_ERR_BODY_TIMEOUT"
  );
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${k}:${stableKey(v)}`).join(",")}}`;
}
