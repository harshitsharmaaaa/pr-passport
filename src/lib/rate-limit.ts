interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Small in-memory limiter. It protects a single deployment instance from
 * accidental loops; it is not a distributed rate limiter. Multi-instance
 * deployments should put a platform-level limiter in front of the API.
 */
export function rateLimit(
  key: string,
  options: { windowMs: number; max: number },
  now: number = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    if (buckets.size > 2_000) prune(now);
    return { allowed: true, remaining: options.max - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > options.max) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return {
    allowed: true,
    remaining: Math.max(0, options.max - existing.count),
    retryAfterSeconds,
  };
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > 2_000) buckets.clear();
}

export function resetRateLimits(): void {
  buckets.clear();
}