import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const GET = route(async ({ user }) => {
  const [profile] = await withUser(user.id, (tx) => tx.select().from(schema.profiles).where(eq(schema.profiles.id, user.id)));
  if (!profile) throw notFound("Profile");
  return profile;
});

const patch = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone").optional(),
  niche: z.string().trim().max(200).nullable().optional(),
  defaultLanguage: z.string().max(40).optional(),
  dashboardLayout: z.array(z.string().max(40)).max(30).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = route(async ({ req, user }) => {
  const body = await parseBody(req, patch);
  const [p] = await withUser(user.id, (tx) => tx.update(schema.profiles).set({ ...body, updatedAt: new Date() }).where(eq(schema.profiles.id, user.id)).returning());
  return p;
});
