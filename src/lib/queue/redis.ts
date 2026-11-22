import IORedis from "ioredis";
import { env } from "../env";

type G = { __viralRedis?: IORedis | null };
const g = globalThis as unknown as G;

export function redisConnectionOptions() {
  const url = env().REDIS_URL;
  if (!url) return null;
  // BullMQ requires maxRetriesPerRequest: null for blocking connections.
  return { url, maxRetriesPerRequest: null as null, enableReadyCheck: true };
}

/** Shared client for non-blocking commands (rate limiting, health checks). */
export function getRedis(): IORedis | null {
  if (g.__viralRedis !== undefined) return g.__viralRedis;
  const url = env().REDIS_URL;
  g.__viralRedis = url ? new IORedis(url, { maxRetriesPerRequest: 2, lazyConnect: false }) : null;
  g.__viralRedis?.on("error", () => {});
  return g.__viralRedis;
}

export async function closeRedis() {
  if (g.__viralRedis) await g.__viralRedis.quit().catch(() => {});
  g.__viralRedis = undefined;
}
