import { z } from "zod";

export const PROJECT_STATUSES = ["idea", "research", "scripting", "production", "editing", "ready", "published", "archived"] as const;
export const CONTENT_FORMATS = ["Short-form video", "Long-form YouTube video", "Reels", "TikTok", "YouTube Shorts", "Carousel", "Image post", "Educational content", "Marketing content", "Storytelling", "Product promotion", "Tutorial", "Podcast clips", "Faceless videos"] as const;

export const projectSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).default("idea"),
  format: z.enum(CONTENT_FORMATS).default("Short-form video"),
  platforms: z.array(z.enum(["youtube", "tiktok", "instagram"])).default([]),
  audience: z.string().max(300).nullable().optional(),
  language: z.string().max(40).default("en"),
  tone: z.string().max(60).nullable().optional(),
  referenceLinks: z.array(z.string().url("Reference links must be valid URLs")).max(20).default([]),
  assetIds: z.array(z.string().uuid()).max(100).default([]),
  notes: z.string().max(20000).nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
});
export type ProjectInput = z.infer<typeof projectSchema>;
