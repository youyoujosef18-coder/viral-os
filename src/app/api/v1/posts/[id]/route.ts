import { route, parseBody } from "@/lib/api/handler";
import { deletePost, getPostDetail, postInputSchema, updatePost } from "@/lib/services/publishing";

export const GET = route<{ id: string }>(async ({ user, params }) => getPostDetail(user.id, params.id));
export const PUT = route<{ id: string }>(async ({ req, user, params }) => updatePost(user.id, params.id, await parseBody(req, postInputSchema)));
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deletePost(user.id, params.id);
  return { ok: true };
});
