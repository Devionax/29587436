/**
 * Best-effort fixed-window rate limiting for storefront endpoints.
 *
 * Counters live in process memory, so production protection is per instance:
 * several app dynos allow up to `limit * instances` requests per window. This
 * throttles accidental floods and loops, not a determined attacker. Durable
 * limits would need a shared store (Redis/Postgres); this app has neither in V1.
 */

type Bucket = {
  count: number;
  expiresAt: number;
};

const buckets = new Map<string, Bucket>();

// Bound memory: a storefront under attack with rotating keys must not grow the
// map without limit. When full, expired buckets are pruned; if that is not
// enough the map is cleared, which briefly resets counters (fail open).
const MAX_TRACKED_KEYS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) buckets.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || existing.expiresAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      prune(now);
      if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
    }
    buckets.set(key, { count: 1, expiresAt: now + windowMs });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.expiresAt - now) / 1000),
      ),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    limit,
    remaining: limit - existing.count,
    retryAfterSeconds: 0,
  };
}

// Test-only: module state must not leak between test cases.
export function resetRateLimits(): void {
  buckets.clear();
}
