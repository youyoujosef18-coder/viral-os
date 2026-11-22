import { route, parseBody } from "@/lib/api/handler";
import { createPost, listPosts, postInputSchema } from "@/lib/services/publishing";
import { logActivity } from "@/lib/services/activity";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from"), to = sp.get("to");
  return listPosts(user.id, { status: sp.get("status") ?? undefined, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, limit: Number(sp.get("limit") ?? 200) });
});

export const POST = route(async ({ req, user }) => {
  const body = await parseBody(req, postInputSchema);
  const post = await createPost(user.id, body);
  await logActivity(user.id, { action: "post.created", entityType: "post", entityId: post.id, summary: `Created post "${post.title}"` });
  return post;
});
