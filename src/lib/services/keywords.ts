import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import { generateStructured } from "../providers/ai";
import { youtubePublic, type PublicVideo } from "../providers/platforms/youtube";
import { env } from "../env";
import { NotConfiguredError, notFound } from "../api/errors";
import { assertOwned } from "./ownership";

const expansionSchema = z.object({
  keywords: z
    .array(
      z.object({
        keyword: z.string().min(1),
        intent: z.enum(["informational", "navigational", "commercial", "transactional", "entertainment"]),
        cluster: z.string(),
        isQuestion: z.boolean(),
        difficultyEstimate: z.number().min(0).max(100),
        rationale: z.string(),
      }),
    )
    .min(3)
    .max(60),
  titleSuggestions: z.array(z.string()).max(10),
  contentGaps: z.array(z.string()).max(10),
});

export async function discoverKeywords(userId: string, input: { seed: string; platform: string; language: string; listId?: string | null }) {
  await assertOwned(userId, { keywordLists: [input.listId] });
  const { data, provider, model } = await generateStructured(expansionSchema, {
    system: "You are an SEO and YouTube search strategist. Expand a seed topic into keywords people actually type. Include long-tail and question keywords, group them into clusters, and label search intent.",
    prompt: `Seed: "${input.seed}"\nPlatform: ${input.platform}\nLanguage: ${input.language}\nReturn 25-40 keywords. difficultyEstimate is your qualitative estimate (0=easy, 100=very hard) — it will be shown labeled as an AI estimate. Do NOT provide search volume numbers.`,
    shapeHint: `{"keywords":[{"keyword":string,"intent":"informational|navigational|commercial|transactional|entertainment","cluster":string,"isQuestion":boolean,"difficultyEstimate":0-100,"rationale":string}],"titleSuggestions":[string],"contentGaps":[string]}`,
  });
  const rows = await withUser(userId, (tx) =>
    tx
      .insert(schema.keywords)
      .values(
        data.keywords.map((k) => ({
          userId,
          listId: input.listId ?? null,
          keyword: k.keyword.trim(),
          seed: input.seed,
          intent: k.intent,
          cluster: k.cluster,
          isQuestion: k.isQuestion,
          searchVolume: null,
          volumeSource: null,
          difficulty: Math.round(k.difficultyEstimate),
          difficultySource: "ai_estimate" as const,
          opportunity: null,
          competitionData: { rationale: k.rationale },
          retrievedAt: new Date(),
        })),
      )
      .returning(),
  );
  return { keywords: rows, titleSuggestions: data.titleSuggestions, contentGaps: data.contentGaps, provider, model };
}

/**
 * Competition metrics computed from the top YouTube results for the keyword (verified data):
 *  - medianViews, avgAgeDays, titleMatchRatio (how many top titles contain the keyword),
 *  - difficulty = 0.5*log-scaled median views + 0.3*title optimization + 0.2*freshness,
 *  - opportunity favors high demand (median views) with weak title optimization or older results.
 */
export function competitionFromResults(keyword: string, videos: PublicVideo[], now = new Date()) {
  if (videos.length === 0) return null;
  const views = videos.map((v) => v.views).sort((a, b) => a - b);
  const medianViews = views[Math.floor(views.length / 2)];
  const ages = videos.map((v) => (now.getTime() - new Date(v.publishedAt).getTime()) / 86400_000);
  const avgAgeDays = ages.reduce((a, b) => a + b, 0) / ages.length;
  const kw = keyword.toLowerCase();
  const words = kw.split(/\s+/).filter((w) => w.length > 2);
  const titleMatchRatio = videos.filter((v) => { const t = v.title.toLowerCase(); return t.includes(kw) || (words.length > 0 && words.every((w) => t.includes(w))); }).length / videos.length;
  const demand = Math.min(1, Math.log10(Math.max(1, medianViews)) / 7); // 10M median ≈ 1.0
  const freshness = Math.max(0, 1 - avgAgeDays / 730);
  const difficulty = Math.round(100 * (0.5 * demand + 0.3 * titleMatchRatio + 0.2 * freshness));
  const opportunity = Math.round(100 * Math.max(0, Math.min(1, 0.55 * demand + 0.3 * (1 - titleMatchRatio) + 0.15 * (1 - freshness))));
  return { medianViews, avgAgeDays: Math.round(avgAgeDays), titleMatchRatio: Number(titleMatchRatio.toFixed(2)), sampleSize: videos.length, difficulty, opportunity };
}

export async function analyzeKeywordCompetition(userId: string, keywordId: string) {
  if (!env().YOUTUBE_API_KEY) throw new NotConfiguredError("YouTube Data API key", "Set YOUTUBE_API_KEY to measure keyword competition from real YouTube results (each measurement uses 1 of the project's 100 daily YouTube search calls).");
  const kw = await withUser(userId, async (tx) => (await tx.select().from(schema.keywords).where(eq(schema.keywords.id, keywordId)))[0]);
  if (!kw) throw notFound("Keyword");
  const fresh = kw.difficultySource === "computed" && kw.retrievedAt && Date.now() - kw.retrievedAt.getTime() < 24 * 3600_000;
  if (fresh) return kw; // cached for 24h to protect API quota
  const result = await youtubePublic.search(kw.keyword, { maxResults: 20 });
  const comp = competitionFromResults(kw.keyword, result.videos);
  const [updated] = await withUser(userId, (tx) =>
    tx
      .update(schema.keywords)
      .set({
        difficulty: comp?.difficulty ?? kw.difficulty,
        difficultySource: comp ? "computed" : kw.difficultySource,
        opportunity: comp?.opportunity ?? null,
        competitionData: {
          ...(kw.competitionData ?? {}),
          ...(comp ?? {}),
          source: "YouTube Data API search.list + videos.list (top 20 results)",
          topResults: result.videos.slice(0, 5).map((v) => ({ id: v.id, title: v.title, channel: v.channelTitle, views: v.views, publishedAt: v.publishedAt })),
        },
        retrievedAt: new Date(),
      })
      .where(eq(schema.keywords.id, keywordId))
      .returning(),
  );
  return updated;
}

export async function listKeywords(userId: string, opts: { listId?: string; seed?: string; days?: number }) {
  return withUser(userId, async (tx) => {
    const conds = [];
    if (opts.listId) conds.push(eq(schema.keywords.listId, opts.listId));
    if (opts.seed) conds.push(eq(schema.keywords.seed, opts.seed));
    if (opts.days) conds.push(gte(schema.keywords.createdAt, new Date(Date.now() - opts.days * 86400_000)));
    return tx.select().from(schema.keywords).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.keywords.createdAt)).limit(1000);
  });
}

export function keywordsToCsv(rows: (typeof schema.keywords.$inferSelect)[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["keyword", "seed", "cluster", "intent", "is_question", "difficulty", "difficulty_source", "opportunity", "search_volume", "volume_source", "retrieved_at"];
  const lines = rows.map((r) => [r.keyword, r.seed, r.cluster, r.intent, r.isQuestion, r.difficulty, r.difficultySource, r.opportunity, r.searchVolume ?? "not available", r.volumeSource ?? "no licensed volume provider configured", r.retrievedAt?.toISOString()].map(esc).join(","));
  return [header.join(","), ...lines].join("\n");
}
