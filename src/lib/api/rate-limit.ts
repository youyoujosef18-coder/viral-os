import { getRedis } from "../queue/redis";

const memory = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

/** Drop expired in-memory windows so the map can't grow without bound. Runs at most once a minute. */
export function sweepExpired(now = Date.now()) {
  if (now - lastSweep < 60_000) return 0;
  lastSweep = now;
  let removed = 0;
  for (const [k, v] of memory) {
    if (v.resetAt < now) {
      memory.delete(k);
      removed++;
    }
  }
  return removed;
}

export const memoryLimiterSize = () => memory.size;

/**
 * Fixed-window limiter. Uses Redis when configured (shared across instances),
 * otherwise an in-process map (single instance / development).
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const redis = getRedis();
  if (redis) {
    const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, windowSeconds);
    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  }
  const now = Date.now();
  sweepExpired(now);
  const entry = memory.get(key);
  if (!entry || entry.resetAt < now) {
    memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { ok: true, remaining: limit - 1 };
  }
  entry.count += 1;
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}
