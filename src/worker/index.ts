/**
 * VIRAL OS background worker. Run with `npm run worker` on a persistent host (Railway, Fly, a VM).
 * - Consumes BullMQ queues (publish, sync, automation, maintenance)
 * - Registers repeatable maintenance jobs (reconcile due posts, scheduled workflows, analytics sync)
 * - Without REDIS_URL, falls back to polling Postgres every 30s so scheduled publishing still works.
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { QUEUE_NAMES, getQueue, type AutomationJob, type ClipQueueJob, type PublishJob, type SyncJob } from "../lib/queue/queues";
import { reconcileClips, renderClipRow, runClipJob } from "../lib/services/clipping";
import { redisConnectionOptions, getRedis, closeRedis } from "../lib/queue/redis";
import { findDueTargets, processTarget } from "../lib/services/publishing";
import { dispatchScheduledWorkflows, executeWorkflowRun } from "../lib/services/automation";
import { syncConnection } from "../lib/services/analytics";
import { refreshTrends } from "../lib/services/trends";
import { refreshCompetitor } from "../lib/services/competitors";
import { getValidAccessToken } from "../lib/services/connections";
import { serviceDb, schema, closeDb } from "../lib/db/client";
import { logger } from "../lib/logger";

const workers: Worker[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let upkeepTimer: NodeJS.Timeout | null = null;

/** How often schedules and the heartbeat are re-asserted (survives Redis restarts and data loss). */
export const UPKEEP_INTERVAL_MS = 60_000;

/**
 * Idempotently (re)registers the repeatable maintenance jobs. Safe to call any number of times:
 * upsertJobScheduler replaces an existing scheduler with the same id instead of adding a second one.
 */
export async function ensureSchedules() {
  const maintenance = getQueue(QUEUE_NAMES.maintenance);
  if (!maintenance) return false;
  await maintenance.upsertJobScheduler("reconcile", { every: 60_000 }, { name: "reconcile" });
  await maintenance.upsertJobScheduler("analytics-sync", { every: 6 * 3600_000 }, { name: "analytics-sync" });
  await maintenance.upsertJobScheduler("token-refresh", { every: 3600_000 }, { name: "token-refresh" });
  await maintenance.upsertJobScheduler("trend-watch", { every: 3 * 3600_000 }, { name: "trend-watch" });
  await maintenance.upsertJobScheduler("cleanup", { pattern: "17 3 * * *" }, { name: "cleanup" });
  return true;
}

export async function heartbeat() {
  await getRedis()?.set("vos:worker:heartbeat", new Date().toISOString(), "EX", 600);
}

/** Runs every minute: if Redis lost its data (restart without persistence, failover, flush), this restores it. */
async function upkeep() {
  try {
    await heartbeat();
    await ensureSchedules();
  } catch (err) {
    logger.error("worker upkeep failed", { err: (err as Error).message });
  }
}

export async function reconcile() {
  const due = await findDueTargets(25);
  for (const t of due) {
    const res = await processTarget(t.id, t.status === "processing" ? "poll" : "publish");
    logger.info("reconcile: processed target", { targetId: t.id, outcome: res.outcome });
  }
  const started = await dispatchScheduledWorkflows();
  const clips = await reconcileClips();
  return { targets: due.length, workflows: started, clips };
}

async function syncAllConnections() {
  const conns = await serviceDb().select({ id: schema.platformConnections.id }).from(schema.platformConnections).where(inArray(schema.platformConnections.status, ["active", "error"]));
  for (const c of conns) {
    try {
      await syncConnection(c.id);
    } catch (err) {
      logger.warn("analytics sync failed", { connectionId: c.id, err: (err as Error).message });
    }
  }
  return conns.length;
}

/** Proactively refresh tokens expiring within 24h so scheduled posts don't fail on expiry. */
async function refreshExpiringTokens() {
  const soon = new Date(Date.now() + 24 * 3600_000);
  const conns = await serviceDb().select().from(schema.platformConnections).where(and(eq(schema.platformConnections.status, "active"), isNotNull(schema.platformConnections.tokenExpiresAt), lt(schema.platformConnections.tokenExpiresAt, soon)));
  for (const c of conns) {
    try {
      // Force refresh by treating the token as expiring now.
      await getValidAccessToken({ ...c, tokenExpiresAt: new Date() });
    } catch (err) {
      logger.warn("token refresh failed", { connectionId: c.id, err: (err as Error).message });
    }
  }
  return conns.length;
}

async function refreshWatchedTrends() {
  const lists = await serviceDb().select({ userId: schema.trendWatchlists.userId, region: schema.trendWatchlists.region }).from(schema.trendWatchlists).where(eq(schema.trendWatchlists.alertsEnabled, true));
  const unique = [...new Map(lists.map((l) => [`${l.userId}:${l.region}`, l])).values()];
  for (const l of unique) {
    try {
      await refreshTrends(l.userId, l.region);
    } catch (err) {
      logger.warn("trend refresh failed", { userId: l.userId, err: (err as Error).message });
    }
  }
}

async function cleanup() {
  const db = serviceDb();
  await db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, new Date()));
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  await db.execute(sql`delete from notifications where read_at is not null and created_at < now() - interval '90 days'`);
}

async function start() {
  const connection = redisConnectionOptions();
  if (!connection) {
    logger.warn("REDIS_URL not set: running in Postgres polling mode (30s). Configure Redis for production.");
    const tick = async () => {
      try {
        await reconcile();
      } catch (err) {
        logger.error("poll tick failed", { err: (err as Error).stack });
      }
    };
    await tick();
    pollTimer = setInterval(tick, 30_000);
    return;
  }

  workers.push(
    new Worker<PublishJob>(QUEUE_NAMES.publish, async (job: Job<PublishJob>) => processTarget(job.data.targetId, job.data.mode), { connection, concurrency: 3 }),
    new Worker<SyncJob>(
      QUEUE_NAMES.sync,
      async (job: Job<SyncJob>) => {
        const d = job.data;
        if (d.kind === "connection") return syncConnection(d.connectionId);
        if (d.kind === "trends") return refreshTrends(d.userId, d.region);
        return refreshCompetitor(d.userId, d.competitorId);
      },
      { connection, concurrency: 2 },
    ),
    // Clipping is CPU-bound (ffmpeg): one job at a time per worker process; scale by adding workers.
    new Worker<ClipQueueJob>(QUEUE_NAMES.clips, async (job: Job<ClipQueueJob>) => (job.data.kind === "analyze" ? runClipJob(job.data.jobId) : renderClipRow(job.data.clipId)), { connection, concurrency: 1, lockDuration: 10 * 60_000 }),
    new Worker<AutomationJob>(QUEUE_NAMES.automation, async (job: Job<AutomationJob>) => executeWorkflowRun(job.data.runId), { connection, concurrency: 2 }),
    new Worker(
      QUEUE_NAMES.maintenance,
      async (job: Job) => {
        await heartbeat();
        switch (job.name) {
          case "reconcile":
            return reconcile();
          case "analytics-sync":
            return syncAllConnections();
          case "token-refresh":
            return refreshExpiringTokens();
          case "trend-watch":
            return refreshWatchedTrends();
          case "cleanup":
            return cleanup();
        }
      },
      { connection, concurrency: 1 },
    ),
  );

  for (const w of workers) {
    w.on("failed", (job, err) => logger.error("job failed", { queue: w.name, jobId: job?.id, err: err.message }));
    w.on("error", (err) => logger.error("worker error", { queue: w.name, err: err.message }));
  }

  await ensureSchedules();
  await heartbeat();
  upkeepTimer = setInterval(() => void upkeep(), UPKEEP_INTERVAL_MS);
  logger.info("VIRAL OS worker started", { queues: Object.values(QUEUE_NAMES) });
}

async function shutdown(signal: string) {
  logger.info("worker shutting down", { signal });
  if (pollTimer) clearInterval(pollTimer);
  if (upkeepTimer) clearInterval(upkeepTimer);
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeRedis();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (process.env.VOS_WORKER_NO_AUTOSTART !== "1") {
  start().catch((err) => {
    logger.error("worker failed to start", { err: (err as Error).stack });
    process.exit(1);
  });
}
