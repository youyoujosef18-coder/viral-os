import { route } from "@/lib/api/handler";
import { requestRender } from "@/lib/services/clipping";

export const POST = route<{ id: string }>(async ({ user, params }) => requestRender(user.id, params.id), { rateLimit: { bucket: "clips-render", limit: 120, windowSeconds: 3600 } });
