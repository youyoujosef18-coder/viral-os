import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody, requireChanges } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ alertsEnabled: z.boolean().optional(), keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(30).optional(), name: z.string().trim().min(1).max(80).optional() }));
  const [row] = await withUser(user.id, (tx) => tx.update(schema.trendWatchlists).set(requireChanges(b)).where(eq(schema.trendWatchlists.id, params.id)).returning());
  if (!row) throw notFound("Watchlist");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.trendWatchlists).where(eq(schema.trendWatchlists.id, params.id)).returning());
  if (!rows.length) throw notFound("Watchlist");
  return { ok: true };
});
