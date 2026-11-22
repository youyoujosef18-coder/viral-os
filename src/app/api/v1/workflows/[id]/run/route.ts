import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { startWorkflowRun } from "@/lib/services/automation";
import { notFound } from "@/lib/api/errors";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  const [wf] = await withUser(user.id, (tx) => tx.select().from(schema.workflows).where(eq(schema.workflows.id, params.id)));
  if (!wf) throw notFound("Workflow");
  const run = await startWorkflowRun(user.id, wf.id, "manual");
  const [fresh] = await withUser(user.id, (tx) => tx.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id)));
  return fresh;
}, { rateLimit: { bucket: "workflow-run", limit: 60, windowSeconds: 3600 } });
