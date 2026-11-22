import { desc } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.thumbnails).orderBy(desc(schema.thumbnails.createdAt)).limit(300)));
