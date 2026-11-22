import { inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const POST = route(async ({ req, user }) => {
  const { ids } = await parseBody(req, z.object({ ids: z.array(z.string().uuid()).max(200).optional() }));
  await withUser(user.id, (tx) => tx.update(schema.notifications).set({ readAt: new Date() }).where(ids?.length ? inArray(schema.notifications.id, ids) : isNull(schema.notifications.readAt)));
  return { ok: true };
});
