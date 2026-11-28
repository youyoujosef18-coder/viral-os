import { ownerRoute } from "@/lib/api/owner";
import { createInvite, listInvites } from "@/lib/services/admin";
import { readJson } from "@/lib/api/handler";

export const GET = ownerRoute(async () => ({ items: await listInvites() }));

/** Returns the invite link once; only a hash of its token is stored. */
export const POST = ownerRoute(async ({ req, user }) => createInvite(user.id, await readJson(req)), { rateLimit: { bucket: "admin-invites", limit: 100, windowSeconds: 3600 } });
