import { z } from "zod";
import { ownerRoute } from "@/lib/api/owner";
import { parseBody } from "@/lib/api/handler";
import { deleteUser, getUser, setDisabled } from "@/lib/services/admin";

export const GET = ownerRoute<{ id: string }>(async ({ user, params }) => getUser(user.id, params.id));

export const PATCH = ownerRoute<{ id: string }>(async ({ req, user, params }) => {
  const { disabled } = await parseBody(req, z.object({ disabled: z.boolean() }));
  return setDisabled(user.id, params.id, disabled);
});

export const DELETE = ownerRoute<{ id: string }>(async ({ req, user, params }) => {
  const { confirmEmail } = await parseBody(req, z.object({ confirmEmail: z.string().min(1, "Type the account's email to confirm") }));
  return deleteUser(user.id, params.id, confirmEmail);
});
