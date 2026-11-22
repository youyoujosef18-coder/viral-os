import { and, desc, eq, or } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

/**
 * Fill variant metrics from synced platform snapshots (verified data). A variant's `reference`
 * may be the content id or its URL. Variants without a match keep their manual metrics.
 */
export const POST = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, async (tx) => {
    const [exp] = await tx.select().from(schema.experiments).where(eq(schema.experiments.id, params.id));
    if (!exp) throw notFound("Experiment");
    const report: { variant: string; matched: boolean }[] = [];
    const variants = [];
    for (const v of exp.variants) {
      if (!v.reference) {
        variants.push(v);
        report.push({ variant: v.label, matched: false });
        continue;
      }
      const ytId = /[?&]v=([\w-]{11})/.exec(v.reference)?.[1] ?? /youtu\.be\/([\w-]{11})/.exec(v.reference)?.[1];
      const [snap] = await tx
        .select()
        .from(schema.metricSnapshots)
        .where(and(eq(schema.metricSnapshots.scope, "content"), or(eq(schema.metricSnapshots.externalId, ytId ?? v.reference), eq(schema.metricSnapshots.url, v.reference))))
        .orderBy(desc(schema.metricSnapshots.capturedAt))
        .limit(1);
      if (snap) {
        const m = snap.metrics;
        const views = m.views ?? m.reach ?? 0;
        variants.push({ ...v, metrics: { ...m, engagement_rate: views ? ((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0)) / views : 0 } });
        report.push({ variant: v.label, matched: true });
      } else {
        variants.push(v);
        report.push({ variant: v.label, matched: false });
      }
    }
    const [row] = await tx.update(schema.experiments).set({ variants, updatedAt: new Date() }).where(eq(schema.experiments.id, exp.id)).returning();
    return { experiment: row, report };
  }),
);
