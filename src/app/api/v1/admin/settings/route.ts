import { z } from "zod";
import { ownerRoute } from "@/lib/api/owner";
import { parseBody } from "@/lib/api/handler";
import { SIGNUP_MODES, getSignupMode, ownerEmails, setSignupMode } from "@/lib/services/admin";

export const GET = ownerRoute(async () => ({ signupMode: await getSignupMode(), ownerEmails: ownerEmails() }));

export const PATCH = ownerRoute(async ({ req, user }) => {
  const { signupMode } = await parseBody(req, z.object({ signupMode: z.enum(SIGNUP_MODES) }));
  return setSignupMode(user.id, signupMode);
});
