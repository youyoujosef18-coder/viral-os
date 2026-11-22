import { desc, isNull, sql } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ user }) =>
  withUser(user.id, async (tx) => {
    const items = await tx.select().from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).limit(50);
    const [{ unread }] = await tx.select({ unread: sql<number>`count(*)::int` }).from(schema.notifications).where(isNull(schema.notifications.readAt));
    return { items, unread };
  }),
);
