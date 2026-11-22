import { desc } from "drizzle-orm";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { experimentSchema } from "@/lib/validation/experiments";
import { randomUUID } from "node:crypto";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.experiments).orderBy(desc(schema.experiments.createdAt))));

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, experimentSchema);
  const [row] = await withUser(user.id, (tx) =>
    tx.insert(schema.experiments).values({ userId: user.id, ...b, hypothesis: b.hypothesis ?? null, platform: b.platform ?? null, variants: b.variants.map((v) => ({ id: randomUUID(), label: v.label, value: v.value, reference: v.reference, metrics: v.metrics ?? {} })) }).returning(),
  );
  return row;
});
