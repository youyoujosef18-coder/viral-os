import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { variantSchema } from "@/lib/validation/experiments";
import { notFound } from "@/lib/api/errors";
import { randomUUID } from "node:crypto";

const patch = z.object({
  status: z.enum(["draft", "running", "completed"]).optional(),
  hypothesis: z.string().max(1000).nullable().optional(),
  conclusion: z.string().max(4000).nullable().optional(),
  winnerVariantId: z.string().nullable().optional(),
  variants: z.array(variantSchema).min(2).max(6).optional(),
});

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, patch);
  return withUser(user.id, async (tx) => {
    const [cur] = await tx.select().from(schema.experiments).where(eq(schema.experiments.id, params.id));
    if (!cur) throw notFound("Experiment");
    const set: Partial<typeof schema.experiments.$inferInsert> = { updatedAt: new Date() };
    if (b.hypothesis !== undefined) set.hypothesis = b.hypothesis;
    if (b.conclusion !== undefined) set.conclusion = b.conclusion;
    if (b.winnerVariantId !== undefined) set.winnerVariantId = b.winnerVariantId;
    if (b.variants) set.variants = b.variants.map((v) => ({ id: v.id ?? randomUUID(), label: v.label, value: v.value, reference: v.reference, metrics: v.metrics ?? {} }));
    if (b.status) {
      set.status = b.status;
      if (b.status === "running" && !cur.startedAt) set.startedAt = new Date();
      if (b.status === "completed") set.endedAt = new Date();
    }
    const [row] = await tx.update(schema.experiments).set(set).where(eq(schema.experiments.id, params.id)).returning();
    return row;
  });
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.experiments).where(eq(schema.experiments.id, params.id)).returning());
  if (!rows.length) throw notFound("Experiment");
  return { ok: true };
});
