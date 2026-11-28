import { route } from "./handler";
import { requireOwner } from "../services/admin";
import type { SessionUser } from "../auth/session";
import type { NextRequest } from "next/server";

/** route() plus a server-side owner check on every request: normal users get 403 before any work runs. */
export function ownerRoute<P extends Record<string, string> = Record<string, string>>(
  handler: (ctx: { req: NextRequest; user: SessionUser; params: P }) => Promise<unknown>,
  options?: Parameters<typeof route>[1],
) {
  return route<P>(async (ctx) => {
    await requireOwner(ctx.user.id);
    return handler(ctx);
  }, options);
}
