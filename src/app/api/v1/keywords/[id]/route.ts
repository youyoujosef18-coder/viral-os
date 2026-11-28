import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody, requireChanges } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";
import { assertOwnedIn } from "@/lib/services/ownership";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ listId: z.string().uuid().nullable() }));
  const [row] = await withUser(user.id, async (tx) => {
    await assertOwnedIn(tx, { keywordLists: [b.listId] });
    return tx.update(schema.keywords).set(requireChanges(b)).where(eq(schema.keywords.id, params.id)).returning();
  });
  if (!row) throw notFound("Keyword");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.keywords).where(eq(schema.keywords.id, params.id)).returning());
  if (!rows.length) throw notFound("Keyword");
  return { ok: true };
});
