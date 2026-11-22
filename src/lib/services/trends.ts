import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { serviceDb, schema, withUser } from "../db/client";
import { youtubePublic, type PublicVideo } from "../providers/platforms/youtube";
import { env } from "../env";
import { NotConfiguredError, notFound } from "../api/errors";
import { notify } from "./notifications";
import { emitAutomationEvent } from "./automation";
import { generateStructured } from "../providers/ai";

export const TREND_SOURCE = "youtube_most_popular";

/** Average views per hour since publish (used on first sighting). */
export function viewsPerHour(views: number, publishedAt: Date, now = new Date()) {
  const hours = Math.max(1, (now.getTime() - publishedAt.getTime()) / 3600_000);
  return views / hours;
}

/**
 * Momentum: views gained per hour between the two latest snapshots (verified),
 * falling back to lifetime average views/hour on first sighting.
 */
export function computeMomentum(history: { at: string; views: number }[], publishedAt: Date | null, now = new Date()) {
  if (history.length >= 2) {
    const [a, b] = history.slice(-2);
    const hours = Math.max(0.25, (new Date(b.at).getTime() - new Date(a.at).getTime()) / 3600_000);
    return { value: Math.max(0, (b.views - a.views) / hours), method: "views gained per hour between the last two retrievals" };
  }
  const last = history[history.length - 1];
  if (!last || !publishedAt) return { value: null, method: "insufficient data" };
  return { value: viewsPerHour(last.views, publishedAt, now), method: "average views per hour since publish (first retrieval)" };
}

/**
 * Opportunity score (0–100), computed: momentum percentile within the batch (60%),
 * recency (25%), and engagement rate percentile (15%). Labeled as a computed heuristic.
 */
export function opportunityScores(items: { momentum: number | null; ageHours: number; engagement: number }[]) {
  const pct = (arr: number[], v: number) => (arr.length <= 1 ? 0.5 : arr.filter((x) => x < v).length / (arr.length - 1));
  const moms = items.map((i) => i.momentum ?? 0);
  const engs = items.map((i) => i.engagement);
  return items.map((i) => {
    const recency = Math.max(0, 1 - i.ageHours / (24 * 14));
    return Math.round(100 * (0.6 * pct(moms, i.momentum ?? 0) + 0.25 * recency + 0.15 * pct(engs, i.engagement)));
  });
}

/**
 * Estimated trend expiry (heuristic, labeled as estimate): content on the most-popular chart
 * typically decays; if momentum is falling between snapshots we project when hourly gain
 * drops below 10% of its peak, otherwise assume ~7 days from publish.
 */
export function estimateExpiry(history: { at: string; views: number }[], publishedAt: Date | null) {
  const base = publishedAt ? new Date(publishedAt.getTime() + 7 * 86400_000) : new Date(Date.now() + 3 * 86400_000);
  if (history.length < 3) return base;
  const rates: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const h = Math.max(0.25, (new Date(history[i].at).getTime() - new Date(history[i - 1].at).getTime()) / 3600_000);
    rates.push((history[i].views - history[i - 1].views) / h);
  }
  const peak = Math.max(...rates);
  const last = rates[rates.length - 1];
  const prev = rates[rates.length - 2];
  if (peak <= 0 || last >= prev) return base;
  const decayPerHour = (prev - last) / Math.max(1, (new Date(history.at(-1)!.at).getTime() - new Date(history.at(-2)!.at).getTime()) / 3600_000);
  const hoursLeft = decayPerHour > 0 ? Math.max(0, (last - 0.1 * peak) / decayPerHour) : 72;
  return new Date(Date.now() + Math.min(hoursLeft, 14 * 24) * 3600_000);
}

export async function refreshTrends(userId: string, region: string, categoryId?: string) {
  if (!env().YOUTUBE_API_KEY) throw new NotConfiguredError("YouTube Data API key", "Set YOUTUBE_API_KEY (Google Cloud Console → APIs & Services → Credentials) to load trending data.");
  const videos = await youtubePublic.mostPopular(region, categoryId, 50);
  const now = new Date();
  const db = serviceDb();
  const existing = await db.select().from(schema.trendItems).where(and(eq(schema.trendItems.userId, userId), eq(schema.trendItems.source, TREND_SOURCE), eq(schema.trendItems.region, region)));
  const prepared = videos.map((v: PublicVideo) => {
    const prev = existing.find((e) => e.externalId === v.id);
    const history = [...(prev?.history ?? []), { at: now.toISOString(), views: v.views }].slice(-48);
    const publishedAt = new Date(v.publishedAt);
    const momentum = computeMomentum(history, publishedAt, now);
    return { v, prev, history, publishedAt, momentum, ageHours: (now.getTime() - publishedAt.getTime()) / 3600_000, engagement: v.views ? (v.likes + v.comments) / v.views : 0 };
  });
  const scores = opportunityScores(prepared.map((p) => ({ momentum: p.momentum.value, ageHours: p.ageHours, engagement: p.engagement })));
  const categories = categoryId ? [] : await youtubePublic.videoCategories(region).catch(() => []);

  for (const [i, p] of prepared.entries()) {
    const values = {
      userId,
      source: TREND_SOURCE,
      externalId: p.v.id,
      region,
      title: p.v.title,
      channelTitle: p.v.channelTitle,
      category: categories.find((c) => c.id === p.v.categoryId)?.title ?? p.v.categoryId ?? null,
      thumbnailUrl: p.v.thumbnailUrl,
      url: `https://www.youtube.com/watch?v=${p.v.id}`,
      publishedAt: p.publishedAt,
      metrics: { views: p.v.views, likes: p.v.likes, comments: p.v.comments, durationSeconds: p.v.durationSeconds ?? 0 },
      momentum: p.momentum.value,
      opportunityScore: scores[i],
      estimatedExpiry: estimateExpiry(p.history, p.publishedAt),
      history: p.history,
      retrievedAt: now,
    };
    await db
      .insert(schema.trendItems)
      .values(values)
      .onConflictDoUpdate({ target: [schema.trendItems.userId, schema.trendItems.source, schema.trendItems.externalId, schema.trendItems.region], set: { ...values, saved: p.prev?.saved ?? false } });
  }

  // Watchlist alerts: keyword matches in title/tags of NEW trending items.
  const watchlists = await db.select().from(schema.trendWatchlists).where(and(eq(schema.trendWatchlists.userId, userId), eq(schema.trendWatchlists.region, region)));
  let alerts = 0;
  for (const wl of watchlists) {
    const matches = prepared.filter((p) => !p.prev && wl.keywords.some((k) => `${p.v.title} ${(p.v.tags ?? []).join(" ")}`.toLowerCase().includes(k.toLowerCase())));
    await db.update(schema.trendWatchlists).set({ lastCheckedAt: now }).where(eq(schema.trendWatchlists.id, wl.id));
    if (matches.length && wl.alertsEnabled) {
      alerts += 1;
      await notify(userId, { type: "info", title: `Trend alert: ${wl.name}`, body: `${matches.length} new trending video(s) match your watchlist, e.g. "${matches[0].v.title}".`, link: "/trends" });
      await emitAutomationEvent(userId, { type: "trend_alert", watchlistId: wl.id });
    }
  }
  return { count: videos.length, alerts, retrievedAt: now };
}

export async function listTrends(userId: string, opts: { region?: string; saved?: boolean; q?: string }) {
  return withUser(userId, async (tx) => {
    const conds = [eq(schema.trendItems.source, TREND_SOURCE)];
    if (opts.region) conds.push(eq(schema.trendItems.region, opts.region));
    if (opts.saved) conds.push(eq(schema.trendItems.saved, true));
    const rows = await tx.select().from(schema.trendItems).where(and(...conds)).orderBy(desc(schema.trendItems.opportunityScore)).limit(300);
    const q = opts.q?.toLowerCase().trim();
    return q ? rows.filter((r) => r.title.toLowerCase().includes(q) || (r.channelTitle ?? "").toLowerCase().includes(q)) : rows;
  });
}

const trendIdeasSchema = z.object({
  interpretation: z.string(),
  ideas: z.array(z.object({ title: z.string(), angle: z.string(), format: z.string(), whyNow: z.string() })).min(1).max(8),
});

export async function ideasFromTrend(userId: string, trendId: string, niche: string | undefined) {
  const trend = await withUser(userId, async (tx) => (await tx.select().from(schema.trendItems).where(eq(schema.trendItems.id, trendId)))[0]);
  if (!trend) throw notFound("Trend");
  const { data, provider, model } = await generateStructured(trendIdeasSchema, {
    system: "You are a content strategist who turns verified trend data into ORIGINAL content ideas for a creator. Never copy the trending video; derive a fresh angle.",
    prompt: `Verified trend data (source: YouTube Data API mostPopular, retrieved ${trend.retrievedAt.toISOString()}):
Title: ${trend.title}
Channel: ${trend.channelTitle}
Category: ${trend.category}
Views: ${trend.metrics.views}; Likes: ${trend.metrics.likes}; Comments: ${trend.metrics.comments}
Creator niche: ${niche || "general"}
Explain briefly why this may be resonating (label as interpretation), then give 5 original ideas the creator could make.`,
    shapeHint: `{"interpretation": string, "ideas": [{"title": string, "angle": string, "format": string, "whyNow": string}]}`,
  });
  const inserted = await withUser(userId, (tx) =>
    tx.insert(schema.ideas).values(data.ideas.map((i) => ({ userId, title: i.title, angle: `${i.angle}\n\nWhy now: ${i.whyNow}`, format: i.format, sourceType: "trend", sourceRef: trend.id, scoreSource: "ai_estimate" as const }))).returning(),
  );
  return { interpretation: data.interpretation, ideas: inserted, provider, model };
}
