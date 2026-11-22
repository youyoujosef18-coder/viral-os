import { z } from "zod";
import { validateCron } from "../services/automation";

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), cron: z.string().trim().min(9).max(100), timezone: z.string().default("UTC") }).superRefine((t, ctx) => {
    const err = validateCron(t.cron, t.timezone);
    if (err) ctx.addIssue({ code: "custom", message: `Invalid schedule: ${err}`, path: ["cron"] });
  }),
  z.object({ type: z.literal("post_published"), platform: z.enum(["youtube", "tiktok", "instagram"]).optional() }),
  z.object({ type: z.literal("post_failed"), platform: z.enum(["youtube", "tiktok", "instagram"]).optional() }),
  z.object({ type: z.literal("trend_alert"), watchlistId: z.string().uuid().optional() }),
  z.object({ type: z.literal("manual") }),
]);

export const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), title: z.string().trim().min(1).max(120), body: z.string().max(500).optional() }),
  z.object({ type: z.literal("sync_analytics") }),
  z.object({ type: z.literal("refresh_trends"), region: z.string().length(2).optional() }),
  z.object({ type: z.literal("generate_ideas"), niche: z.string().trim().min(2).max(200), count: z.number().int().min(1).max(15) }),
  z.object({ type: z.literal("run_agent"), agentId: z.string().uuid(), input: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("retry_failed_posts") }),
]);

export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1, "Add at least one step").max(20),
});
