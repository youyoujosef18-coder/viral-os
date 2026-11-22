import { route } from "@/lib/api/handler";
import { retryClipJob } from "@/lib/services/clipping";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  await retryClipJob(user.id, params.id);
  return { ok: true };
});
