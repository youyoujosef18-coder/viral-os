import { desc } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ req, user }) => {
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? 50));
  return withUser(user.id, (tx) => tx.select().from(schema.activityLog).orderBy(desc(schema.activityLog.createdAt)).limit(limit));
});
