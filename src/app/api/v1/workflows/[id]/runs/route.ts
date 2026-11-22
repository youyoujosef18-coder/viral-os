import { desc, eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, (tx) => tx.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, params.id)).orderBy(desc(schema.workflowRuns.createdAt)).limit(50)),
);
