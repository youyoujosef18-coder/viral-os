import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { saveScript, scriptContentSchema } from "@/lib/services/scripts";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ user, params }) => {
  const [row] = await withUser(user.id, (tx) => tx.select().from(schema.scripts).where(eq(schema.scripts.id, params.id)));
  if (!row) throw notFound("Script");
  return row;
});

export const PUT = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ content: scriptContentSchema, title: z.string().trim().min(1).max(200).optional(), reason: z.enum(["autosave", "edit", "restore", "ai_edit"]).default("edit") }));
  return saveScript(user.id, params.id, b.content, b.title, b.reason);
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.scripts).where(eq(schema.scripts.id, params.id)).returning());
  if (!rows.length) throw notFound("Script");
  return { ok: true };
});
