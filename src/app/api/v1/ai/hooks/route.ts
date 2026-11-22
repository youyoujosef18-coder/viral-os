import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { generateHooks } from "@/lib/services/scripts";

export const POST = route(async ({ req }) => {
  const b = await parseBody(req, z.object({ topic: z.string().trim().min(3).max(500), platform: z.string().max(40).default("TikTok"), language: z.string().max(40).default("English") }));
  return { hooks: await generateHooks(b.topic, b.platform, b.language) };
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
