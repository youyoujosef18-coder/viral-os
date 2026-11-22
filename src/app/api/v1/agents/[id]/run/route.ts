import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { runAgent } from "@/lib/services/agents";

export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const { input } = await parseBody(req, z.object({ input: z.string().trim().min(1).max(20000) }));
  return runAgent(user.id, params.id, input);
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
