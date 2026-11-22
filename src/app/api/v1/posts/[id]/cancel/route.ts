import { route } from "@/lib/api/handler";
import { cancelPost } from "@/lib/services/publishing";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  await cancelPost(user.id, params.id);
  return { ok: true };
});
