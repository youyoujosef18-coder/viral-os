import { route } from "@/lib/api/handler";
import { retryTarget } from "@/lib/services/publishing";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  await retryTarget(user.id, params.id);
  return { ok: true };
});
