import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { createBrief, createPersonas, generateIdeas, listRuns, researchNiche } from "@/lib/services/research";

const body = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("niche"), niche: z.string().trim().min(2).max(200), audience: z.string().max(300).optional(), platforms: z.array(z.string()).min(1).default(["YouTube", "TikTok", "Instagram"]), language: z.string().default("English") }),
  z.object({ mode: z.literal("ideas"), niche: z.string().trim().min(2).max(200), audience: z.string().max(300).optional(), count: z.number().int().min(1).max(15).default(8), focus: z.string().max(300).optional() }),
  z.object({ mode: z.literal("personas"), niche: z.string().trim().min(2).max(200), audience: z.string().max(300).optional() }),
  z.object({ mode: z.literal("brief"), ideaId: z.string().uuid() }),
]);

export const GET = route(async ({ req, user }) => listRuns(user.id, req.nextUrl.searchParams.get("kind") ?? undefined));

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, body);
  switch (b.mode) {
    case "niche":
      return researchNiche(user.id, b);
    case "ideas":
      return generateIdeas(user.id, b);
    case "personas":
      return createPersonas(user.id, b);
    case "brief":
      return createBrief(user.id, b.ideaId);
  }
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
