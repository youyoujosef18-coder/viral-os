import { route } from "@/lib/api/handler";
import { duplicatePost } from "@/lib/services/publishing";

export const POST = route<{ id: string }>(async ({ user, params }) => duplicatePost(user.id, params.id));
