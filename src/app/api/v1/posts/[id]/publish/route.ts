import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { queuePost } from "@/lib/services/publishing";

const body = z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable().optional() });

export const POST = route<{ id: string }>(
  async ({ req, user, params }) => {
    const b = await parseBody(req, body);
    return queuePost(user.id, params.id, { scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null });
  },
  { rateLimit: { bucket: "publish", limit: 60, windowSeconds: 3600 } },
);
