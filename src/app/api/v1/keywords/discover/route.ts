import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { discoverKeywords } from "@/lib/services/keywords";

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ seed: z.string().trim().min(2).max(120), platform: z.enum(["YouTube", "TikTok", "Instagram"]).default("YouTube"), language: z.string().default("English"), listId: z.string().uuid().nullable().optional() }));
  return discoverKeywords(user.id, b);
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
