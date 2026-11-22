import { z } from "zod";
import { eq } from "drizzle-orm";
import { route, parseBody } from "@/lib/api/handler";
import { generatePlain } from "@/lib/providers/ai";
import { schema, withUser } from "@/lib/db/client";

export const POST = route(async ({ req, user }) => {
  const { message } = await parseBody(req, z.object({ message: z.string().trim().min(1).max(4000) }));
  const [profile] = await withUser(user.id, (tx) => tx.select().from(schema.profiles).where(eq(schema.profiles.id, user.id)));
  const { text, provider, model } = await generatePlain({
    system: `You are the assistant inside VIRAL OS, a creator platform with sections: Overview, AI Research, Trend Radar, Keyword Explorer, Competitor Intelligence, Content Studio, AI Script Writer, Thumbnail Lab, Video Analyzer, Publishing Center, Automation Workflows, Content Calendar, Analytics, Experiments, AI Agents, Media Library, Settings.
Answer concisely and practically. Point the user to the right section when relevant. You cannot see their analytics here; never invent numbers about their account.
Creator niche: ${profile?.niche ?? "not set"}.`,
    prompt: message,
    maxTokens: 1500,
  });
  return { text, provider, model };
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
