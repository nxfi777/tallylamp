import { Err } from "./errors.js";

type Bucket = { tokens: number; last: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, ratePerMin: number, burst = ratePerMin): void {
  const now = Date.now();
  const refill = ratePerMin / 60_000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + (now - b.last) * refill);
  b.last = now;
  if (b.tokens < 1) throw Err.rateLimited();
  b.tokens -= 1;
}

export function resetRateLimits(): void {
  buckets.clear();
}
