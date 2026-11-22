import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ user, params }) => {
  const [row] = await withUser(user.id, (tx) => tx.select().from(schema.videoAnalyses).where(eq(schema.videoAnalyses.id, params.id)));
  if (!row) throw notFound("Analysis");
  return row;
});
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.videoAnalyses).where(eq(schema.videoAnalyses.id, params.id)).returning());
  if (!rows.length) throw notFound("Analysis");
  return { ok: true };
});
