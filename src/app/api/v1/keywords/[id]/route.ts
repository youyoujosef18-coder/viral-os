import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ listId: z.string().uuid().nullable() }));
  const [row] = await withUser(user.id, (tx) => tx.update(schema.keywords).set(b).where(eq(schema.keywords.id, params.id)).returning());
  if (!row) throw notFound("Keyword");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.keywords).where(eq(schema.keywords.id, params.id)).returning());
  if (!rows.length) throw notFound("Keyword");
  return { ok: true };
});
