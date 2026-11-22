import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ req, user }) => {
  const status = req.nextUrl.searchParams.get("status");
  return withUser(user.id, (tx) => tx.select().from(schema.ideas).where(status ? eq(schema.ideas.status, status) : undefined).orderBy(desc(schema.ideas.createdAt)).limit(500));
});

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ title: z.string().trim().min(1).max(300), angle: z.string().max(2000).optional(), format: z.string().max(80).optional() }));
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.ideas).values({ userId: user.id, ...b, sourceType: "manual", scoreSource: "user_input", status: "saved" }).returning());
  return row;
});
