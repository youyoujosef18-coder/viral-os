import { desc } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.keywordLists).orderBy(desc(schema.keywordLists.createdAt))));
export const POST = route(async ({ req, user }) => {
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(1).max(80) }));
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.keywordLists).values({ userId: user.id, name }).returning());
  return row;
});
