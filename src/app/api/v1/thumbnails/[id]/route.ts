import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.thumbnails).where(eq(schema.thumbnails.id, params.id)).returning());
  if (!rows.length) throw notFound("Thumbnail");
  return { ok: true };
});
