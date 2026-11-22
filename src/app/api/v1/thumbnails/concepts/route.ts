import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { generateConcepts } from "@/lib/services/thumbnails";

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ title: z.string().trim().min(3).max(200), topic: z.string().trim().min(3).max(500), style: z.string().max(200).optional(), projectId: z.string().uuid().nullable().optional() }));
  return generateConcepts(user.id, b);
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
