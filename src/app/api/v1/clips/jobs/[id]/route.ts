import { route } from "@/lib/api/handler";
import { deleteClipJob, getClipJob } from "@/lib/services/clipping";

export const GET = route<{ id: string }>(async ({ user, params }) => getClipJob(user.id, params.id));
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteClipJob(user.id, params.id);
  return { ok: true };
});
