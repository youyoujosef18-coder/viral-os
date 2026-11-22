import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { deleteAsset } from "@/lib/services/media";
import { notFound } from "@/lib/api/errors";

const patch = z.object({ folder: z.string().trim().min(1).max(80).optional(), tags: z.array(z.string().trim().max(40)).max(20).optional(), filename: z.string().trim().min(1).max(180).transform((v) => v.replace(/[\u0000-\u001f\u007f/\\]/g, "_")).optional() });

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const body = await parseBody(req, patch);
  const [row] = await withUser(user.id, (tx) => tx.update(schema.mediaAssets).set(body).where(eq(schema.mediaAssets.id, params.id)).returning());
  if (!row) throw notFound("Media asset");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteAsset(user.id, params.id);
  return { ok: true };
});
