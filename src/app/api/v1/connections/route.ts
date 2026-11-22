import { desc } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { toPublicConnection } from "@/lib/services/connections";

export const GET = route(async ({ user }) => {
  const rows = await withUser(user.id, (tx) => tx.select().from(schema.platformConnections).orderBy(desc(schema.platformConnections.createdAt)));
  return rows.map(toPublicConnection);
});
