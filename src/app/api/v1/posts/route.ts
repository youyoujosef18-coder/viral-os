import { z } from "zod";
import { route, parseBody, parseQuery } from "@/lib/api/handler";
import { createPost, listPosts, postInputSchema } from "@/lib/services/publishing";
import { logActivity } from "@/lib/services/activity";

const listQuery = z.object({
  status: z.string().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const GET = route(async ({ req, user }) => {
  const q = parseQuery(req, listQuery);
  return listPosts(user.id, q);
});

export const POST = route(async ({ req, user }) => {
  const body = await parseBody(req, postInputSchema);
  const post = await createPost(user.id, body);
  await logActivity(user.id, { action: "post.created", entityType: "post", entityId: post.id, summary: `Created post "${post.title}"` });
  return post;
});
