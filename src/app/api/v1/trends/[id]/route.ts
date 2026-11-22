import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const { saved } = await parseBody(req, z.object({ saved: z.boolean() }));
  const [row] = await withUser(user.id, (tx) => tx.update(schema.trendItems).set({ saved }).where(eq(schema.trendItems.id, params.id)).returning());
  if (!row) throw notFound("Trend");
  return row;
});
