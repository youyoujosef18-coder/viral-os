import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ status: z.enum(["new", "saved", "in_production", "dismissed"]).optional(), title: z.string().trim().min(1).max(300).optional(), angle: z.string().max(4000).optional() }));
  const [row] = await withUser(user.id, (tx) => tx.update(schema.ideas).set(b).where(eq(schema.ideas.id, params.id)).returning());
  if (!row) throw notFound("Idea");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.ideas).where(eq(schema.ideas.id, params.id)).returning());
  if (!rows.length) throw notFound("Idea");
  return { ok: true };
});
