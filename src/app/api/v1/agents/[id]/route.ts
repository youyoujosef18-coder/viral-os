import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

const patch = z.object({ name: z.string().trim().min(1).max(80).optional(), role: z.string().max(60).optional(), instructions: z.string().trim().min(20).max(8000).optional(), outputFormat: z.enum(["markdown", "plain text", "bullet list", "JSON"]).optional(), temperature: z.number().min(0).max(1).optional(), enabled: z.boolean().optional() });

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, patch);
  const [row] = await withUser(user.id, (tx) => tx.update(schema.agents).set({ ...b, updatedAt: new Date() }).where(eq(schema.agents.id, params.id)).returning());
  if (!row) throw notFound("Agent");
  return row;
});
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.agents).where(eq(schema.agents.id, params.id)).returning());
  if (!rows.length) throw notFound("Agent");
  return { ok: true };
});
