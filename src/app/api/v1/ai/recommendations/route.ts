import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { getOverview } from "@/lib/services/analytics";
import { generateStructured } from "@/lib/providers/ai";
import { schema, withUser } from "@/lib/db/client";

const out = z.object({
  recommendations: z.array(z.object({ title: z.string(), why: z.string(), action: z.string(), section: z.enum(["research", "trends", "keywords", "competitors", "studio", "scripts", "thumbnails", "analyzer", "publishing", "automation", "calendar", "analytics", "experiments", "agents", "media", "settings"]), basedOn: z.string() })).min(1).max(5),
});

/** Next best actions grounded ONLY in the user's verified metrics and workspace state. */
export const POST = route(async ({ user }) => {
  const o = await getOverview(user.id, { days: 30 });
  const state = await withUser(user.id, async (tx) => ({
    projects: (await tx.select({ status: schema.contentProjects.status }).from(schema.contentProjects)).length,
    ideasSaved: (await tx.select({ id: schema.ideas.id }).from(schema.ideas).where(eq(schema.ideas.status, "saved"))).length,
    failedTargets: (await tx.select({ id: schema.postTargets.id }).from(schema.postTargets).where(inArray(schema.postTargets.status, ["failed", "requires_user_action", "platform_approval_required"]))).length,
    scheduled: (await tx.select({ id: schema.postTargets.id }).from(schema.postTargets).where(and(eq(schema.postTargets.status, "scheduled")))).length,
    profile: (await tx.select({ niche: schema.profiles.niche }).from(schema.profiles))[0],
  }));
  const facts = {
    connectedAccounts: o.connections.map((c) => ({ platform: c.platform, status: c.status })),
    last30Days: { views: o.kpis.views.value, previousViews: o.kpis.views.previous, engagementRate: o.kpis.engagementRate.value, audienceGrowth: o.kpis.audience.growth, postsPublished: o.kpis.postsPublished.value },
    topContent: o.top.map((t) => ({ title: t.title, platform: t.platform, views: t.metrics.views, vsMedian: t.vsMedian })),
    underperforming: o.under.map((t) => ({ title: t.title, platform: t.platform, views: t.metrics.views })),
    bestTimesUtc: o.bestTimes,
    workspace: state,
  };
  const { data, provider, model } = await generateStructured(out, {
    system: "You are a growth strategist. Recommend at most 5 concrete next actions for this creator using ONLY the facts provided. If data is missing (e.g. no connected accounts), recommend the setup step that unlocks it. Each recommendation must cite which fact it is based on in `basedOn`.",
    prompt: `Facts (verified from platform APIs and the workspace database):\n${JSON.stringify(facts, null, 2)}`,
    shapeHint: `{"recommendations":[{"title":string,"why":string,"action":string,"section":"research|trends|keywords|competitors|studio|scripts|thumbnails|analyzer|publishing|automation|calendar|analytics|experiments|agents|media|settings","basedOn":string}]}`,
  });
  return { ...data, provider, model, generatedAt: new Date().toISOString() };
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
