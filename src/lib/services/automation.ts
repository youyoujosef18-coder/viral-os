import { and, eq, sql, inArray, lte } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { serviceDb, schema } from "../db/client";
import type { WorkflowStep, WorkflowTrigger } from "../db/schema";
import { enqueueAutomation, enqueueSync } from "../queue/queues";
import { notify } from "./notifications";
import { logger } from "../logger";

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
}

export function validateCron(cron: string, timezone: string): string | null {
  try {
    nextCronRun(cron, timezone);
    if (cron.trim().split(/\s+/).length !== 5) return "Use a 5-field cron expression (minute hour day month weekday).";
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Create a run row and dispatch it (queue when available, inline otherwise). */
export async function startWorkflowRun(userId: string, workflowId: string, triggeredBy: string) {
  const [run] = await serviceDb().insert(schema.workflowRuns).values({ userId, workflowId, status: "queued", triggeredBy }).returning();
  const queued = await enqueueAutomation({ workflowId, userId, runId: run.id });
  if (!queued) await executeWorkflowRun(run.id); // no Redis: run inline so automations still work
  return run;
}

/** Fire event-based workflows (post_published, post_failed, trend_alert). */
export async function emitAutomationEvent(userId: string, event: { type: "post_published" | "post_failed" | "trend_alert"; platform?: string; watchlistId?: string }) {
  try {
    const flows = await serviceDb()
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.userId, userId), eq(schema.workflows.enabled, true), sql`${schema.workflows.trigger}->>'type' = ${event.type}`));
    for (const wf of flows) {
      const trig = wf.trigger as WorkflowTrigger & { platform?: string; watchlistId?: string };
      if (trig.platform && event.platform && trig.platform !== event.platform) continue;
      if (trig.watchlistId && event.watchlistId && trig.watchlistId !== event.watchlistId) continue;
      await startWorkflowRun(userId, wf.id, `event:${event.type}`);
    }
  } catch (err) {
    logger.error("Automation event dispatch failed", { err: (err as Error).message });
  }
}

/** Called every minute by the worker: start due scheduled workflows and compute their next run. */
export async function dispatchScheduledWorkflows() {
  const db = serviceDb();
  const due = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.enabled, true), sql`${schema.workflows.trigger}->>'type' = 'schedule'`, lte(schema.workflows.nextRunAt, new Date())));
  for (const wf of due) {
    const trig = wf.trigger as Extract<WorkflowTrigger, { type: "schedule" }>;
    const next = nextCronRun(trig.cron, trig.timezone);
    // Advance next_run_at first (compare-and-set) so two workers never start the same run.
    const claimed = await db
      .update(schema.workflows)
      .set({ nextRunAt: next, lastRunAt: new Date() })
      .where(and(eq(schema.workflows.id, wf.id), eq(schema.workflows.nextRunAt, wf.nextRunAt!)))
      .returning({ id: schema.workflows.id });
    if (claimed.length) await startWorkflowRun(wf.userId, wf.id, "schedule");
  }
  return due.length;
}

type StepRunner = (userId: string, step: WorkflowStep) => Promise<string>;
const runners: Partial<Record<WorkflowStep["type"], StepRunner>> = {};

/** Steps that depend on heavier services register lazily to avoid import cycles. */
export function registerStepRunner(type: WorkflowStep["type"], fn: StepRunner) {
  runners[type] = fn;
}

async function runStep(userId: string, step: WorkflowStep): Promise<string> {
  switch (step.type) {
    case "notify":
      await notify(userId, { type: "info", title: step.title, body: step.body });
      return "Notification sent";
    case "sync_analytics": {
      const conns = await serviceDb().select().from(schema.platformConnections).where(and(eq(schema.platformConnections.userId, userId), eq(schema.platformConnections.status, "active")));
      if (!conns.length) return "No active connected accounts to sync";
      for (const c of conns) {
        const queued = await enqueueSync({ kind: "connection", connectionId: c.id, userId });
        if (!queued) {
          const { syncConnection } = await import("./analytics");
          await syncConnection(c.id);
        }
      }
      return `Analytics sync started for ${conns.length} account(s)`;
    }
    case "retry_failed_posts": {
      const failed = await serviceDb()
        .select({ id: schema.postTargets.id })
        .from(schema.postTargets)
        .where(and(eq(schema.postTargets.userId, userId), eq(schema.postTargets.status, "failed")));
      const { retryTarget } = await import("./publishing");
      for (const f of failed) await retryTarget(userId, f.id);
      return `Re-queued ${failed.length} failed target(s)`;
    }
    default: {
      const fn = runners[step.type];
      if (!fn) throw new Error(`Step "${step.type}" is not available in this process`);
      return fn(userId, step);
    }
  }
}

export async function executeWorkflowRun(runId: string) {
  const db = serviceDb();
  const [run] = await db.update(schema.workflowRuns).set({ status: "running", startedAt: new Date() }).where(and(eq(schema.workflowRuns.id, runId), inArray(schema.workflowRuns.status, ["queued"]))).returning();
  if (!run) return null;
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId));
  const log: { at: string; step: string; message: string; ok: boolean }[] = [];
  let error: string | null = null;
  if (!wf) error = "Workflow was deleted";
  else {
    await ensureRunnersRegistered();
    for (const [i, step] of wf.steps.entries()) {
      try {
        const message = await runStep(run.userId, step);
        log.push({ at: new Date().toISOString(), step: `${i + 1}. ${step.type}`, message, ok: true });
      } catch (err) {
        error = (err as Error).message;
        log.push({ at: new Date().toISOString(), step: `${i + 1}. ${step.type}`, message: error, ok: false });
        break;
      }
    }
  }
  await db.update(schema.workflowRuns).set({ status: error ? "failed" : "succeeded", log, error, finishedAt: new Date() }).where(eq(schema.workflowRuns.id, runId));
  if (wf) await db.update(schema.workflows).set({ lastRunAt: new Date() }).where(eq(schema.workflows.id, wf.id));
  if (error && wf) await notify(run.userId, { type: "error", title: `Automation "${wf.name}" failed`, body: error, link: "/automation" });
  return { status: error ? "failed" : "succeeded", log };
}

let registered = false;
async function ensureRunnersRegistered() {
  if (registered) return;
  registered = true;
  const [{ refreshTrends }, { generateIdeas }, { runAgent }] = await Promise.all([import("./trends"), import("./research"), import("./agents")]);
  registerStepRunner("refresh_trends", async (userId, step) => {
    const s = step as Extract<WorkflowStep, { type: "refresh_trends" }>;
    const r = await refreshTrends(userId, s.region ?? "US");
    return `Retrieved ${r.count} trending videos (${r.alerts} watchlist alert(s))`;
  });
  registerStepRunner("generate_ideas", async (userId, step) => {
    const s = step as Extract<WorkflowStep, { type: "generate_ideas" }>;
    const r = await generateIdeas(userId, { niche: s.niche, count: s.count });
    return `Generated ${r.ideas.length} scored ideas`;
  });
  registerStepRunner("run_agent", async (userId, step) => {
    const s = step as Extract<WorkflowStep, { type: "run_agent" }>;
    const r = await runAgent(userId, s.agentId, s.input);
    return `Agent finished (${r.output?.length ?? 0} chars)`;
  });
}
