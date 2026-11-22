import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { assetKinds, generateAssets } from "@/lib/services/scripts";

export const POST = route(async ({ req }) => {
  const b = await parseBody(req, z.object({ kind: z.enum(assetKinds), topic: z.string().trim().min(3).max(500), platform: z.string().max(40).default("YouTube"), language: z.string().max(40).default("English") }));
  return { items: await generateAssets(b.kind, b.topic, b.platform, b.language) };
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
