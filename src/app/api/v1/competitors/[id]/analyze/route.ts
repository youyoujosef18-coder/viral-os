import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { analyzeCompetitor } from "@/lib/services/competitors";
import { schema, withUser } from "@/lib/db/client";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  const [p] = await withUser(user.id, (tx) => tx.select({ niche: schema.profiles.niche }).from(schema.profiles).where(eq(schema.profiles.id, user.id)));
  return analyzeCompetitor(user.id, params.id, p?.niche ?? undefined);
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
