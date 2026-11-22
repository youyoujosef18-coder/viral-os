import { desc } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.trendWatchlists).orderBy(desc(schema.trendWatchlists.createdAt))));

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ name: z.string().trim().min(1).max(80), keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(30), region: z.string().length(2).toUpperCase().default("US"), alertsEnabled: z.boolean().default(true) }));
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.trendWatchlists).values({ userId: user.id, ...b }).returning());
  return row;
});
