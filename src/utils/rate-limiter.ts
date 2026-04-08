export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(maxRequestsPerMinute: number) {
    if (!Number.isFinite(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
      throw new Error("maxRequestsPerMinute must be a positive number");
    }
    this.maxTokens = maxRequestsPerMinute;
    this.refillRatePerMs = maxRequestsPerMinute / 60000;
    this.tokens = this.maxTokens;
    this.lastRefillAt = Date.now();
  }

  private refill(now = Date.now()): void {
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    if (elapsedMs === 0) return;

    const toAdd = elapsedMs * this.refillRatePerMs;
    if (toAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + toAdd);
      this.lastRefillAt = now;
    }
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  async acquire(): Promise<number> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    const missing = 1 - this.tokens;
    const waitMs = Math.ceil(missing / this.refillRatePerMs);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });

    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
    } else {
      // In pathological timing cases, recurse and wait again.
      return this.acquire();
    }
    return waitMs;
  }
}

