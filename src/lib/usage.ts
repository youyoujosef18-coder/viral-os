import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { serviceDb, schema } from "./db/client";
import { logger } from "./logger";

/**
 * Per-user usage metering for the owner console. Requests run inside `runAsUser` (see route()), and
 * background jobs call `bindUsageUser` once they know whose work they are doing. Recording never throws:
 * a metering failure must not break the feature being metered.
 */
const store = new AsyncLocalStorage<{ userId: string }>();

export function runAsUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId }, fn);
}

/** For worker code: attribute everything after this point in the current async flow to `userId`. */
export function bindUsageUser(userId: string) {
  store.enterWith({ userId });
}

export function currentUsageUser(): string | null {
  return store.getStore()?.userId ?? null;
}

export type UsageKind = "ai_call" | "youtube_units";

export async function recordUsage(kind: UsageKind, units: number, extra: { inputTokens?: number | null; outputTokens?: number | null; detail?: Record<string, unknown> } = {}) {
  const userId = currentUsageUser();
  if (!userId || !Number.isFinite(units)) return;
  try {
    await serviceDb()
      .insert(schema.usageEvents)
      .values({ userId, kind, units: Math.round(units), inputTokens: extra.inputTokens ?? null, outputTokens: extra.outputTokens ?? null, detail: extra.detail ?? {} });
  } catch (err) {
    logger.warn("usage metering failed", { kind, err: (err as Error).message });
  }
}

/**
 * YouTube Data API v3 quota cost per call, from Google's published quota table. Calls not listed cost 1.
 * videos.insert and search.list draw from their own daily call buckets; they are recorded as 1 call each
 * with the bucket name in `detail` so the console can show them separately.
 */
const DATA_API_COST: { method: string; path: RegExp; units: number; bucket?: string }[] = [
  { method: "GET", path: /\/youtube\/v3\/search$/, units: 1, bucket: "search.list" },
  { method: "GET", path: /\/youtube\/v3\/captions\/[^/]+$/, units: 200 },
  { method: "GET", path: /\/youtube\/v3\/captions$/, units: 50 },
  { method: "POST", path: /\/youtube\/v3\/thumbnails\/set$/, units: 50 },
  { method: "PUT", path: /\/youtube\/v3\/videos$/, units: 50 },
  { method: "POST", path: /\/youtube\/v3\/commentThreads$/, units: 50 },
  { method: "POST", path: /\/youtube\/v3\/comments$/, units: 50 },
];

/** Classify a finished HTTP call; returns null for anything that isn't a YouTube Data API request. */
export function youtubeCost(url: string, method = "GET"): { units: number; bucket: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const isData = /(^|\/)youtube\/v3\//.test(u.pathname) && (u.hostname === "www.googleapis.com" || u.hostname === "youtube.googleapis.com" || u.pathname.includes("/youtube/v3/"));
  if (!isData) return null;
  const m = method.toUpperCase();
  // Upload endpoints: the initial POST is the videos.insert call; chunk PUTs to the session URL are not metered.
  if (u.pathname.startsWith("/upload/")) return m === "POST" && /\/videos$/.test(u.pathname) ? { units: 1, bucket: "videos.insert" } : null;
  const hit = DATA_API_COST.find((c) => c.method === m && c.path.test(u.pathname));
  if (hit) return { units: hit.units, bucket: hit.bucket ?? "daily_units" };
  return { units: 1, bucket: "daily_units" };
}

const OWNER_TABLES = {
  post_targets: schema.postTargets,
  platform_connections: schema.platformConnections,
  clip_jobs: schema.clipJobs,
  clips: schema.clips,
  workflow_runs: schema.workflowRuns,
} as const;

/**
 * Run background work attributed to the user who owns row `id` of `table`. Keeps an existing attribution
 * (e.g. when called from a signed-in request) and runs unattributed if the row is gone.
 */
export async function meteredFor<T>(table: keyof typeof OWNER_TABLES, id: string, fn: () => Promise<T>): Promise<T> {
  if (currentUsageUser()) return fn();
  const t = OWNER_TABLES[table];
  const [row] = await serviceDb().select({ userId: t.userId }).from(t).where(eq(t.id, id)).limit(1);
  return row ? runAsUser(row.userId, fn) : fn();
}

/** Same, when the user id is already known. */
export function meteredAs<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return currentUsageUser() ? fn() : runAsUser(userId, fn);
}
