import { eq } from "drizzle-orm";
import { route, parsePatch } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { workflowSchema } from "@/lib/validation/automation";
import { nextCronRun } from "@/lib/services/automation";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parsePatch(req, workflowSchema);
  const extra = b.trigger ? { nextRunAt: b.trigger.type === "schedule" ? nextCronRun(b.trigger.cron, b.trigger.timezone) : null } : {};
  const [row] = await withUser(user.id, (tx) => tx.update(schema.workflows).set({ ...b, ...extra, updatedAt: new Date() }).where(eq(schema.workflows.id, params.id)).returning());
  if (!row) throw notFound("Workflow");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.workflows).where(eq(schema.workflows.id, params.id)).returning());
  if (!rows.length) throw notFound("Workflow");
  return { ok: true };
});
