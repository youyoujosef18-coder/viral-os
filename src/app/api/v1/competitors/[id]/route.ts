import { desc, eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { computeCompetitorStats } from "@/lib/services/competitors";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, async (tx) => {
    const [c] = await tx.select().from(schema.competitors).where(eq(schema.competitors.id, params.id));
    if (!c) throw notFound("Competitor");
    const content = await tx.select().from(schema.competitorContent).where(eq(schema.competitorContent.competitorId, c.id)).orderBy(desc(schema.competitorContent.publishedAt)).limit(100);
    return { ...c, content, stats: computeCompetitorStats(content) };
  }),
);

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.competitors).where(eq(schema.competitors.id, params.id)).returning());
  if (!rows.length) throw notFound("Competitor");
  return { ok: true };
});
