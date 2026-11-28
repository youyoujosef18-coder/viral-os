import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import { youtubePublic } from "../providers/platforms/youtube";
import { env } from "../env";
import { ApiError, NotConfiguredError, notFound } from "../api/errors";
import { generateStructured } from "../providers/ai";
import { meteredAs } from "../usage";

export async function addCompetitor(userId: string, input: { platform: "youtube" | "tiktok" | "instagram"; identifier: string; name?: string }) {
  if (input.platform !== "youtube") {
    // TikTok and Instagram do not offer an official API for arbitrary third-party profile analytics
    // to this app type, so these are tracked manually (user-entered) and clearly labeled.
    const handle = input.identifier.replace(/^.*\.com\/@?/, "").replace(/^@/, "").replace(/\/.*$/, "");
    const [row] = await withUser(userId, (tx) =>
      tx.insert(schema.competitors).values({ userId, platform: input.platform, externalId: handle, handle: `@${handle}`, name: input.name || `@${handle}` }).onConflictDoNothing().returning(),
    );
    if (!row) throw new ApiError(409, "This competitor is already tracked.", "conflict");
    return row;
  }
  if (!env().YOUTUBE_API_KEY) throw new NotConfiguredError("YouTube Data API key", "Set YOUTUBE_API_KEY to look up public channel data.");
  const ch = await youtubePublic.channel(input.identifier);
  if (!ch) throw new ApiError(404, "No YouTube channel found for that handle, URL or channel ID.", "not_found");
  const [row] = await withUser(userId, (tx) =>
    tx
      .insert(schema.competitors)
      .values({ userId, platform: "youtube", externalId: ch.id, handle: ch.handle, name: ch.name, avatarUrl: ch.avatarUrl, description: ch.description, subscriberCount: ch.subscriberCount, videoCount: ch.videoCount, viewCount: ch.viewCount, uploadsPlaylistId: ch.uploadsPlaylistId, retrievedAt: new Date() })
      .onConflictDoNothing()
      .returning(),
  );
  if (!row) throw new ApiError(409, "This competitor is already tracked.", "conflict");
  await refreshCompetitor(userId, row.id);
  return row;
}

async function refreshCompetitorUnmetered(userId: string, competitorId: string) {
  const comp = await withUser(userId, async (tx) => (await tx.select().from(schema.competitors).where(eq(schema.competitors.id, competitorId)))[0]);
  if (!comp) throw notFound("Competitor");
  if (comp.platform !== "youtube") throw new ApiError(400, "Automatic refresh is only available for YouTube competitors (official public data API).", "unsupported");
  if (!env().YOUTUBE_API_KEY) throw new NotConfiguredError("YouTube Data API key", "Set YOUTUBE_API_KEY.");
  const ch = await youtubePublic.channel(comp.externalId);
  const uploads = ch?.uploadsPlaylistId ? await youtubePublic.recentUploads(ch.uploadsPlaylistId, 50) : [];
  const now = new Date();
  await withUser(userId, async (tx) => {
    if (ch) await tx.update(schema.competitors).set({ name: ch.name, avatarUrl: ch.avatarUrl, subscriberCount: ch.subscriberCount, videoCount: ch.videoCount, viewCount: ch.viewCount, retrievedAt: now }).where(eq(schema.competitors.id, comp.id));
    for (const v of uploads) {
      const values = { userId, competitorId: comp.id, externalId: v.id, title: v.title, description: v.description?.slice(0, 2000) ?? null, thumbnailUrl: v.thumbnailUrl, publishedAt: new Date(v.publishedAt), durationSeconds: v.durationSeconds, viewCount: v.views, likeCount: v.likes, commentCount: v.comments, retrievedAt: now };
      await tx.insert(schema.competitorContent).values(values).onConflictDoUpdate({ target: [schema.competitorContent.competitorId, schema.competitorContent.externalId], set: values });
    }
  });
  return { videos: uploads.length };
}

type ContentRow = typeof schema.competitorContent.$inferSelect;

/** Deterministic metrics computed from verified public data. */
export function computeCompetitorStats(content: ContentRow[]) {
  if (!content.length) return null;
  const byDate = [...content].filter((c) => c.publishedAt).sort((a, b) => +a.publishedAt! - +b.publishedAt!);
  const spanDays = byDate.length > 1 ? (+byDate.at(-1)!.publishedAt! - +byDate[0].publishedAt!) / 86400_000 : 0;
  const views = content.map((c) => c.viewCount ?? 0).sort((a, b) => a - b);
  const median = views[Math.floor(views.length / 2)];
  const shorts = content.filter((c) => (c.durationSeconds ?? 0) > 0 && (c.durationSeconds ?? 0) <= 180).length;
  const titles = content.map((c) => c.title);
  const pct = (n: number) => Math.round((100 * n) / titles.length);
  return {
    sample: content.length,
    uploadsPerWeek: spanDays > 0 ? Number(((content.length - 1) / (spanDays / 7)).toFixed(2)) : null,
    medianViews: median,
    avgViews: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
    shortFormShare: pct(shorts),
    avgDurationSeconds: Math.round(content.reduce((a, c) => a + (c.durationSeconds ?? 0), 0) / content.length),
    titlePatterns: {
      avgLength: Math.round(titles.reduce((a, t) => a + t.length, 0) / titles.length),
      questionPct: pct(titles.filter((t) => t.includes("?")).length),
      numberPct: pct(titles.filter((t) => /\d/.test(t)).length),
      allCapsWordPct: pct(titles.filter((t) => /\b[A-Z]{3,}\b/.test(t)).length),
      bracketPct: pct(titles.filter((t) => /[([]/.test(t)).length),
    },
    outliers: content
      .filter((c) => median > 0 && (c.viewCount ?? 0) >= 2 * median)
      .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
      .slice(0, 10)
      .map((c) => ({ id: c.id, title: c.title, views: c.viewCount, multiple: Number(((c.viewCount ?? 0) / median).toFixed(1)) })),
  };
}

const analysisSchema = z.object({
  topics: z.array(z.object({ topic: z.string(), evidence: z.string() })).max(10),
  hookPatterns: z.array(z.string()).max(8),
  titleInsights: z.array(z.string()).max(8),
  thumbnailInsights: z.array(z.string()).max(6),
  formatInsights: z.array(z.string()).max(6),
  audiencePositioning: z.string(),
  contentGaps: z.array(z.string()).max(8),
  originalIdeas: z.array(z.object({ title: z.string(), angle: z.string() })).max(8),
});

export async function analyzeCompetitor(userId: string, competitorId: string, creatorNiche?: string) {
  const { comp, content } = await withUser(userId, async (tx) => {
    const [comp] = await tx.select().from(schema.competitors).where(eq(schema.competitors.id, competitorId));
    const content = await tx.select().from(schema.competitorContent).where(eq(schema.competitorContent.competitorId, competitorId)).orderBy(desc(schema.competitorContent.publishedAt)).limit(50);
    return { comp, content };
  });
  if (!comp) throw notFound("Competitor");
  if (!content.length) throw new ApiError(400, "No public content stored yet for this competitor. Refresh it first (YouTube) or add content manually.", "no_data");
  const stats = computeCompetitorStats(content);
  const { data, provider, model } = await generateStructured(analysisSchema, {
    system: "You analyze public competitor content patterns at a GENERAL level. Derive insights from titles/descriptions only; never reproduce their scripts or titles verbatim in ideas. Thumbnail insights must be phrased as hypotheses since you only see titles and stats, not images.",
    prompt: `Competitor: ${comp.name} (${comp.platform})\nCreator niche to generate ideas for: ${creatorNiche || "same general space"}\nComputed stats (verified): ${JSON.stringify(stats)}\nRecent titles with views:\n${content.map((c) => `- ${c.title} | ${c.viewCount ?? "?"} views | ${c.durationSeconds ?? "?"}s`).join("\n")}`,
    shapeHint: `{"topics":[{"topic":string,"evidence":string}],"hookPatterns":[string],"titleInsights":[string],"thumbnailInsights":[string],"formatInsights":[string],"audiencePositioning":string,"contentGaps":[string],"originalIdeas":[{"title":string,"angle":string}]}`,
  });
  const analysis = { stats, ai: data, provider, model, generatedAt: new Date().toISOString() };
  await withUser(userId, (tx) => tx.update(schema.competitors).set({ analysis, analysisAt: new Date() }).where(eq(schema.competitors.id, competitorId)));
  return analysis;
}

export async function listCompetitors(userId: string) {
  return withUser(userId, async (tx) => {
    const comps = await tx.select().from(schema.competitors).orderBy(desc(schema.competitors.createdAt));
    const content = await tx.select().from(schema.competitorContent);
    return comps.map((c) => {
      const mine = content.filter((x) => x.competitorId === c.id);
      return { ...c, stats: computeCompetitorStats(mine), contentCount: mine.length };
    });
  });
}

export function refreshCompetitor(userId: string, competitorId: string) {
  return meteredAs(userId, () => refreshCompetitorUnmetered(userId, competitorId));
}
