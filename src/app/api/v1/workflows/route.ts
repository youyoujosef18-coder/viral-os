import { desc } from "drizzle-orm";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { workflowSchema } from "@/lib/validation/automation";
import { nextCronRun } from "@/lib/services/automation";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.workflows).orderBy(desc(schema.workflows.createdAt))));

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, workflowSchema);
  const nextRunAt = b.trigger.type === "schedule" ? nextCronRun(b.trigger.cron, b.trigger.timezone) : null;
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.workflows).values({ userId: user.id, ...b, description: b.description ?? null, nextRunAt }).returning());
  return row;
});
