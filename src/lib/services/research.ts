import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import { generateStructured } from "../providers/ai";
import { notFound } from "../api/errors";

export const SCORE_FACTORS = ["audienceDemand", "trendMomentum", "competition", "creatorRelevance", "productionDifficulty", "potentialRetention", "contentOriginality", "monetizationPotential"] as const;
type Factor = (typeof SCORE_FACTORS)[number];

/** Weights sum to 1. Competition and production difficulty are inverted (lower is better). */
export const SCORE_WEIGHTS: Record<Factor, number> = {
  audienceDemand: 0.2,
  trendMomentum: 0.12,
  competition: 0.13,
  creatorRelevance: 0.15,
  productionDifficulty: 0.08,
  potentialRetention: 0.12,
  contentOriginality: 0.1,
  monetizationPotential: 0.1,
};
const INVERTED: Factor[] = ["competition", "productionDifficulty"];

export function overallScore(breakdown: Record<Factor, { score: number }>) {
  let total = 0;
  for (const f of SCORE_FACTORS) {
    const raw = Math.max(0, Math.min(100, breakdown[f]?.score ?? 50));
    total += SCORE_WEIGHTS[f] * (INVERTED.includes(f) ? 100 - raw : raw);
  }
  return Math.round(total);
}

const factorSchema = z.object({ score: z.number().min(0).max(100), reason: z.string() });
const ideaSchema = z.object({
  title: z.string(),
  angle: z.string(),
  format: z.string(),
  type: z.enum(["evergreen", "trend-based", "series", "gap"]),
  factors: z.object(Object.fromEntries(SCORE_FACTORS.map((f) => [f, factorSchema])) as Record<Factor, typeof factorSchema>),
  confidence: z.enum(["low", "medium", "high"]),
  confidenceReason: z.string(),
});

const researchSchema = z.object({
  summary: z.string(),
  painPoints: z.array(z.object({ pain: z.string(), detail: z.string() })).max(10),
  questions: z.array(z.string()).max(15),
  searchIntent: z.array(z.object({ intent: z.string(), share: z.enum(["dominant", "common", "niche"]), notes: z.string() })).max(6),
  contentGaps: z.array(z.string()).max(10),
  viralFormats: z.array(z.object({ format: z.string(), whyItWorks: z.string() })).max(8),
  angles: z.array(z.string()).max(10),
  clusters: z.array(z.object({ pillar: z.string(), subtopics: z.array(z.string()) })).max(6),
  series: z.array(z.object({ name: z.string(), episodes: z.array(z.string()) })).max(4),
});

const personaSchema = z.object({
  personas: z.array(z.object({ name: z.string(), summary: z.string(), goals: z.array(z.string()), frustrations: z.array(z.string()), platforms: z.array(z.string()), contentPreferences: z.array(z.string()), objections: z.array(z.string()) })).min(1).max(4),
});

const briefSchema = z.object({
  workingTitle: z.string(),
  objective: z.string(),
  targetAudience: z.string(),
  keyMessage: z.string(),
  hookOptions: z.array(z.string()).max(5),
  outline: z.array(z.object({ section: z.string(), points: z.array(z.string()) })),
  cta: z.string(),
  successMetrics: z.array(z.string()),
  productionNotes: z.array(z.string()),
});

async function saveRun(userId: string, kind: string, input: Record<string, unknown>, output: Record<string, unknown>, provider: string, model: string) {
  const [run] = await withUser(userId, (tx) => tx.insert(schema.researchRuns).values({ userId, kind, input, output, provider, model, sources: [{ label: `AI analysis (${provider}/${model})`, retrievedAt: new Date().toISOString() }] }).returning());
  return run;
}

const SYSTEM = "You are a senior content strategist and audience researcher for short-form and long-form social video. Be specific and practical. When you lack data, say so qualitatively.";

export async function researchNiche(userId: string, input: { niche: string; audience?: string; platforms: string[]; language: string }) {
  const { data, provider, model } = await generateStructured(researchSchema, {
    system: SYSTEM,
    prompt: `Research the niche "${input.niche}"${input.audience ? ` for the audience: ${input.audience}` : ""}. Platforms: ${input.platforms.join(", ")}. Language: ${input.language}.`,
    shapeHint: `{"summary":string,"painPoints":[{"pain":string,"detail":string}],"questions":[string],"searchIntent":[{"intent":string,"share":"dominant|common|niche","notes":string}],"contentGaps":[string],"viralFormats":[{"format":string,"whyItWorks":string}],"angles":[string],"clusters":[{"pillar":string,"subtopics":[string]}],"series":[{"name":string,"episodes":[string]}]}`,
    maxTokens: 6000,
  });
  return saveRun(userId, "niche_research", input, data, provider, model);
}

export async function generateIdeas(userId: string, input: { niche: string; audience?: string; count: number; focus?: string }) {
  const trends = await withUser(userId, (tx) => tx.select().from(schema.trendItems).orderBy(desc(schema.trendItems.opportunityScore)).limit(10));
  const trendContext = trends.length
    ? `Verified trending items (YouTube API, retrieved ${trends[0].retrievedAt.toISOString()}):\n${trends.map((t) => `- ${t.title} (${t.metrics.views} views)`).join("\n")}`
    : "No verified trend data is available; rate trendMomentum conservatively and say so in the reason.";
  const schemaOut = z.object({ ideas: z.array(ideaSchema).min(1).max(15) });
  const { data, provider, model } = await generateStructured(schemaOut, {
    system: SYSTEM,
    prompt: `Generate ${input.count} original content ideas for the niche "${input.niche}"${input.audience ? `, audience: ${input.audience}` : ""}${input.focus ? `, focus: ${input.focus}` : ""}.
Mix evergreen and trend-based ideas. Score each factor 0-100 with a one-sentence reason. For "competition" and "productionDifficulty", higher means MORE competition/difficulty.
${trendContext}`,
    shapeHint: `{"ideas":[{"title":string,"angle":string,"format":string,"type":"evergreen|trend-based|series|gap","factors":{${SCORE_FACTORS.map((f) => `"${f}":{"score":0-100,"reason":string}`).join(",")}},"confidence":"low|medium|high","confidenceReason":string}]}`,
    maxTokens: 8000,
  });
  const run = await saveRun(userId, "idea_generation", input, data, provider, model);
  const rows = await withUser(userId, (tx) =>
    tx
      .insert(schema.ideas)
      .values(
        data.ideas.map((i) => ({
          userId,
          title: i.title,
          angle: i.angle,
          format: i.format,
          sourceType: "research",
          sourceRef: run.id,
          score: overallScore(i.factors),
          scoreBreakdown: i.factors,
          confidence: `${i.confidence}: ${i.confidenceReason}`,
          scoreSource: "ai_estimate" as const,
        })),
      )
      .returning(),
  );
  return { run, ideas: rows };
}

export async function createPersonas(userId: string, input: { niche: string; audience?: string }) {
  const { data, provider, model } = await generateStructured(personaSchema, {
    system: SYSTEM,
    prompt: `Create 3 audience personas for "${input.niche}"${input.audience ? ` (${input.audience})` : ""}. These are archetypes, not real people.`,
    shapeHint: `{"personas":[{"name":string,"summary":string,"goals":[string],"frustrations":[string],"platforms":[string],"contentPreferences":[string],"objections":[string]}]}`,
  });
  return saveRun(userId, "personas", input, data, provider, model);
}

export async function createBrief(userId: string, ideaId: string) {
  const idea = await withUser(userId, async (tx) => (await tx.select().from(schema.ideas).where(eq(schema.ideas.id, ideaId)))[0]);
  if (!idea) throw notFound("Idea");
  const { data, provider, model } = await generateStructured(briefSchema, {
    system: SYSTEM,
    prompt: `Write a production-ready content brief for this idea.\nTitle: ${idea.title}\nAngle: ${idea.angle}\nFormat: ${idea.format}`,
    shapeHint: `{"workingTitle":string,"objective":string,"targetAudience":string,"keyMessage":string,"hookOptions":[string],"outline":[{"section":string,"points":[string]}],"cta":string,"successMetrics":[string],"productionNotes":[string]}`,
  });
  return saveRun(userId, "brief", { ideaId, title: idea.title }, data, provider, model);
}

export async function listRuns(userId: string, kind?: string) {
  return withUser(userId, (tx) => tx.select().from(schema.researchRuns).where(kind ? eq(schema.researchRuns.kind, kind) : undefined).orderBy(desc(schema.researchRuns.createdAt)).limit(100));
}
