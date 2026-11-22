import { route } from "@/lib/api/handler";
import { createPostFromClip } from "@/lib/services/clipping";

export const POST = route<{ id: string }>(async ({ user, params }) => createPostFromClip(user.id, params.id));
