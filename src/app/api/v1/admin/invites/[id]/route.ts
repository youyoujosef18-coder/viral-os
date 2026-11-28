import { ownerRoute } from "@/lib/api/owner";
import { revokeInvite } from "@/lib/services/admin";

export const DELETE = ownerRoute<{ id: string }>(async ({ user, params }) => revokeInvite(user.id, params.id));
