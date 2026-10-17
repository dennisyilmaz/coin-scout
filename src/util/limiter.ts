type Waiter = () => void;

const MAX_INTERVAL_MS = 1_000;
const FIRST_INTERVAL_MS = 40;
const RECOVERY_STREAK = 15;

export class AdaptiveLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private limit: number;
  private pausedUntil = 0;
  private nextSlot = 0;
  private minIntervalMs = 0;
  private successStreak = 0;
  private throttleCount = 0;

  constructor(
    private readonly maxLimit: number,
    private readonly minLimit = 1,
  ) {
    this.limit = maxLimit;
  }

  async acquire(cost = 1): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot, this.pausedUntil);
    this.nextSlot = slot + this.minIntervalMs * Math.max(1, cost);
    if (slot > now) await sleep(slot - now);

    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  onThrottle(retryAfterMs: number): void {
    this.successStreak = 0;
    this.throttleCount++;
    this.limit = Math.max(this.minLimit, Math.floor(this.limit / 2));
    this.minIntervalMs = Math.min(
      MAX_INTERVAL_MS,
      this.minIntervalMs === 0 ? FIRST_INTERVAL_MS : Math.ceil(this.minIntervalMs * 2),
    );
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs);
  }

  onSuccess(): void {
    if (this.limit >= this.maxLimit && this.minIntervalMs === 0) return;
    if (++this.successStreak < RECOVERY_STREAK) return;

    this.successStreak = 0;
    if (this.minIntervalMs > 0) {
      this.minIntervalMs = this.minIntervalMs <= 8 ? 0 : Math.floor(this.minIntervalMs * 0.8);
    }
    if (this.limit < this.maxLimit) this.limit++;
  }

  stats() {
    return {
      concurrencyLimit: this.limit,
      active: this.active,
      queued: this.waiters.length,
      minIntervalMs: this.minIntervalMs,
      throttleEvents: this.throttleCount,
      effectiveMaxRps:
        this.minIntervalMs === 0 ? null : Math.round(1000 / this.minIntervalMs),
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
