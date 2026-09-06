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

/**
 * Drop buckets that have fully refilled and gone quiet. A refilled bucket is
 * indistinguishable from a fresh one, so forgetting it is semantically free — and the map
 * is otherwise keyed by source IP and never emptied.
 */
export function pruneRateLimits(maxIdleMs = 300_000): number {
  const cutoff = Date.now() - maxIdleMs;
  let dropped = 0;
  for (const [key, b] of buckets) {
    if (b.last < cutoff) {
      buckets.delete(key);
      dropped++;
    }
  }
  return dropped;
}
