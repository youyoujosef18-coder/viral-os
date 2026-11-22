import { desc, eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, (tx) => tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, params.id)).orderBy(desc(schema.agentRuns.createdAt)).limit(30)),
);
