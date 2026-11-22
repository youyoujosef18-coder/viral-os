import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { ideasFromTrend } from "@/lib/services/trends";
import { schema, withUser } from "@/lib/db/client";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  const [profile] = await withUser(user.id, (tx) => tx.select({ niche: schema.profiles.niche }).from(schema.profiles).where(eq(schema.profiles.id, user.id)));
  return ideasFromTrend(user.id, params.id, profile?.niche ?? undefined);
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
