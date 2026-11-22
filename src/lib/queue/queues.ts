import { Queue, type JobsOptions } from "bullmq";
import { redisConnectionOptions } from "./redis";

export const QUEUE_NAMES = {
  publish: "vos-publish",
  sync: "vos-sync",
  automation: "vos-automation",
  maintenance: "vos-maintenance",
  clips: "vos-clips",
} as const;

export type PublishJob = { targetId: string; mode: "publish" | "poll" };
export type SyncJob =
  | { kind: "connection"; connectionId: string; userId: string }
  | { kind: "trends"; userId: string; region: string }
  | { kind: "competitor"; competitorId: string; userId: string };
export type AutomationJob = { workflowId: string; userId: string; runId: string };
export type ClipQueueJob = { kind: "analyze"; jobId: string } | { kind: "render"; clipId: string };

type G = { __viralQueues?: Map<string, Queue> };
const g = globalThis as unknown as G;

export function getQueue(name: (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]): Queue | null {
  const connection = redisConnectionOptions();
  if (!connection) return null;
  g.__viralQueues ??= new Map();
  let q = g.__viralQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    g.__viralQueues.set(name, q);
  }
  return q;
}

export const isQueueConfigured = () => redisConnectionOptions() !== null;

/**
 * Enqueue a publish job. jobId makes enqueueing idempotent: the same target
 * cannot have two pending jobs of the same mode. Postgres remains the source of
 * truth, and the worker's reconciler re-enqueues anything that was lost.
 */
export async function enqueuePublish(job: PublishJob, delayMs = 0) {
  const q = getQueue(QUEUE_NAMES.publish);
  if (!q) return false;
  const opts: JobsOptions = {
    jobId: `${job.mode}-${job.targetId}-${Math.floor((Date.now() + delayMs) / 60000)}`,
    delay: Math.max(0, delayMs),
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 1, // retry policy is implemented in the publishing service (persisted in Postgres)
  };
  await q.add(job.mode, job, opts);
  return true;
}

export async function enqueueSync(job: SyncJob) {
  const q = getQueue(QUEUE_NAMES.sync);
  if (!q) return false;
  const key = job.kind === "connection" ? job.connectionId : job.kind === "competitor" ? job.competitorId : `${job.userId}-${job.region}`;
  await q.add(job.kind, job, {
    jobId: `${job.kind}-${key}-${Math.floor(Date.now() / 60000)}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  });
  return true;
}

export async function enqueueAutomation(job: AutomationJob) {
  const q = getQueue(QUEUE_NAMES.automation);
  if (!q) return false;
  await q.add("run", job, { jobId: `run-${job.runId}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 });
  return true;
}

/** Clip analysis/render jobs (CPU heavy, consumed with low concurrency). Postgres remains the source of truth. */
export async function enqueueClip(job: ClipQueueJob) {
  const q = getQueue(QUEUE_NAMES.clips);
  if (!q) return false;
  const key = job.kind === "analyze" ? job.jobId : job.clipId;
  await q.add(job.kind, job, { jobId: `${job.kind}-${key}-${Date.now()}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 });
  return true;
}
