import { route } from "@/lib/api/handler";
import { cancelTarget } from "@/lib/services/publishing";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  await cancelTarget(user.id, params.id);
  return { ok: true };
});
