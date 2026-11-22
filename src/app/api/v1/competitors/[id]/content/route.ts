import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { ApiError, notFound } from "@/lib/api/errors";
import { randomUUID } from "node:crypto";

/** Manual content logging for TikTok/Instagram competitors (no official public-profile API). Stored as user input. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ title: z.string().trim().min(1).max(300), url: z.string().url().optional(), publishedAt: z.string().datetime({ offset: true }).optional(), views: z.number().int().min(0).optional(), likes: z.number().int().min(0).optional(), comments: z.number().int().min(0).optional(), durationSeconds: z.number().int().min(0).optional() }));
  return withUser(user.id, async (tx) => {
    const [c] = await tx.select().from(schema.competitors).where(eq(schema.competitors.id, params.id));
    if (!c) throw notFound("Competitor");
    if (c.platform === "youtube") throw new ApiError(400, "YouTube competitors are refreshed automatically from the official API.", "unsupported");
    const [row] = await tx.insert(schema.competitorContent).values({ userId: user.id, competitorId: c.id, externalId: b.url ?? `manual-${randomUUID()}`, title: b.title, publishedAt: b.publishedAt ? new Date(b.publishedAt) : null, viewCount: b.views ?? null, likeCount: b.likes ?? null, commentCount: b.comments ?? null, durationSeconds: b.durationSeconds ?? null, description: "Entered manually by user" }).returning();
    return row;
  });
});
