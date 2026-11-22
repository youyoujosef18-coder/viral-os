import { route } from "@/lib/api/handler";
import { disconnect } from "@/lib/services/connections";
import { logActivity } from "@/lib/services/activity";
import { notFound } from "@/lib/api/errors";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  if (!(await disconnect(user.id, params.id))) throw notFound("Connection");
  await logActivity(user.id, { action: "connection.disconnected", entityType: "connection", entityId: params.id, summary: "Disconnected an account" });
  return { ok: true };
});
