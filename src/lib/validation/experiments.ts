import { z } from "zod";

export const variantSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
  /** URL or platform content id of the published variant, used to pull real metrics. */
  reference: z.string().trim().max(300).optional(),
  metrics: z.record(z.string(), z.number().min(0)).optional(),
});

export const experimentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  hypothesis: z.string().max(1000).nullable().optional(),
  type: z.enum(["title", "thumbnail", "hook", "caption", "posting_time", "format"]),
  platform: z.enum(["youtube", "tiktok", "instagram"]).nullable().optional(),
  primaryMetric: z.enum(["views", "likes", "comments", "shares", "engagement_rate", "ctr", "avg_view_duration"]).default("views"),
  variants: z.array(variantSchema).min(2, "An experiment needs at least two variants").max(6),
});
