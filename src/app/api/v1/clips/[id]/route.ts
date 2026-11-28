import { route, readJson } from "@/lib/api/handler";
import { deleteClip, updateClip } from "@/lib/services/clipping";

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => updateClip(user.id, params.id, await readJson(req)));
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteClip(user.id, params.id);
  return { ok: true };
});
