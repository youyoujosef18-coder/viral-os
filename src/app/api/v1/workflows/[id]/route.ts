import { eq } from "drizzle-orm";
import { route, parsePatch, requireChanges } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { workflowSchema } from "@/lib/validation/automation";
import { nextCronRun, workflowRefs } from "@/lib/services/automation";
import { assertOwnedIn } from "@/lib/services/ownership";
import type { WorkflowTrigger } from "@/lib/db/schema";
import { notFound } from "@/lib/api/errors";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await parsePatch(req, workflowSchema);
  requireChanges(b);
  const [row] = await withUser(user.id, async (tx) => {
    const [current] = await tx.select().from(schema.workflows).where(eq(schema.workflows.id, params.id)).for("update");
    if (!current) return [];
    await assertOwnedIn(tx, workflowRefs(b));
    // Recompute the next run when the schedule changes or the workflow is switched back on,
    // so re-enabling never fires immediately for a time that passed while it was off.
    const trigger = (b.trigger ?? current.trigger) as WorkflowTrigger;
    const turningOn = b.enabled === true && !current.enabled;
    const extra = b.trigger || turningOn ? { nextRunAt: trigger.type === "schedule" ? nextCronRun(trigger.cron, trigger.timezone) : null } : {};
    return tx.update(schema.workflows).set({ ...b, ...extra, updatedAt: new Date() }).where(eq(schema.workflows.id, params.id)).returning();
  });
  if (!row) throw notFound("Workflow");
  return row;
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.workflows).where(eq(schema.workflows.id, params.id)).returning());
  if (!rows.length) throw notFound("Workflow");
  return { ok: true };
});
