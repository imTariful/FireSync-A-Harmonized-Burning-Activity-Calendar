/**
 * Small in-process fixed-window rate limiter for the AI routes.
 *
 * Groq calls cost money and can be slow, so every request is bounded per client and globally.
 * This is intentionally simple: one process, no shared store, no external dependency.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 2_000
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.evictIfNeeded(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }
    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true, remaining: Math.max(0, this.limit - bucket.count), retryAfterSeconds: 0 };
  }

  /** Drop expired windows so a long-running process cannot grow without bound. */
  private evictIfNeeded(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    for (const [key, window] of this.buckets) {
      if (window.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
