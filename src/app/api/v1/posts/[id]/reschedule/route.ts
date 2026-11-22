import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { cancelPost, queuePost } from "@/lib/services/publishing";
import { ApiError, notFound } from "@/lib/api/errors";

const body = z.object({ scheduledAt: z.string().datetime({ offset: true }) });

/** Calendar drag & drop. Scheduled posts are re-queued at the new time; drafts just get a planned date. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const { scheduledAt } = await parseBody(req, body);
  const when = new Date(scheduledAt);
  const [post] = await withUser(user.id, (tx) => tx.select().from(schema.posts).where(eq(schema.posts.id, params.id)));
  if (!post) throw notFound("Post");
  if (post.status === "scheduled") {
    await cancelPost(user.id, post.id);
    return queuePost(user.id, post.id, { scheduledAt: when });
  }
  if (["draft", "needs_review", "ready", "cancelled"].includes(post.status)) {
    await withUser(user.id, (tx) => tx.update(schema.posts).set({ scheduledAt: when, updatedAt: new Date() }).where(eq(schema.posts.id, post.id)));
    return { status: post.status, planned: true };
  }
  throw new ApiError(409, `A ${post.status.replace(/_/g, " ")} post cannot be moved.`, "locked");
});
