import { z } from "zod";
import { ownerRoute } from "@/lib/api/owner";
import { CONTENT_TYPES, userContent } from "@/lib/services/admin";

/** Read-only view of a user's posts, clips or media. Every call is written to the owner access log. */
export const GET = ownerRoute<{ id: string }>(async ({ req, user, params }) => {
  const type = z.enum(CONTENT_TYPES).parse(req.nextUrl.searchParams.get("type") ?? "posts");
  return userContent(user.id, params.id, type);
});
