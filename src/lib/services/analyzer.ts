import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import { storage } from "../storage";
import { generateStructured } from "../providers/ai";
import { ApiError, notFound } from "../api/errors";
import { assertOwned } from "./ownership";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export async function ffmpegAvailable() {
  try {
    await run(FFPROBE, ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Parse ffmpeg showinfo output for scene-change timestamps. */
export function parseSceneTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) out.push(Number(m[1]));
  return out;
}

export function pacingFromCuts(cuts: number[], duration: number) {
  const cutsPerMinute = duration > 0 ? (cuts.length / duration) * 60 : 0;
  const gaps = [0, ...cuts, duration].slice(1).map((t, i, arr) => t - (i === 0 ? 0 : arr[i - 1]));
  const allTimes = [0, ...cuts, duration];
  const shots = allTimes.slice(1).map((t, i) => t - allTimes[i]).filter((g) => g > 0);
  void gaps;
  return {
    sceneChanges: cuts.length,
    cutsPerMinute: Number(cutsPerMinute.toFixed(1)),
    averageShotSeconds: shots.length ? Number((shots.reduce((a, b) => a + b, 0) / shots.length).toFixed(2)) : duration,
    longestShotSeconds: shots.length ? Number(Math.max(...shots).toFixed(2)) : duration,
    firstCutSeconds: cuts.length ? Number(cuts[0].toFixed(2)) : null,
  };
}

/** Measured technical analysis with ffprobe/ffmpeg. */
/** `source` is the video bytes, or a storage key to stream to disk (large files never pass through memory). */
export async function technicalAnalysis(source: Buffer | { storageKey: string }, filename: string) {
  if (!(await ffmpegAvailable())) return { available: false as const, reason: "ffmpeg/ffprobe not installed on this server (set FFMPEG_PATH/FFPROBE_PATH or run analysis on the worker host)." };
  const dir = await mkdtemp(path.join(tmpdir(), "vos-"));
  const file = path.join(/*turbopackIgnore: true*/ dir, path.basename(filename).replace(/[^\w.-]/g, "_") || "video");
  try {
    if (Buffer.isBuffer(source)) await writeFile(file, source);
    else await storage().downloadToFile(source.storageKey, file);
    const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    const probe = JSON.parse(stdout) as { format?: { duration?: string; bit_rate?: string }; streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; codec_name?: string }[] };
    const video = probe.streams?.find((s) => s.codec_type === "video");
    const audio = probe.streams?.find((s) => s.codec_type === "audio");
    const duration = Number(probe.format?.duration ?? 0);
    const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
    const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file, "-vf", "select='gt(scene,0.35)',showinfo", "-an", "-f", "null", "-"], { timeout: 180_000, maxBuffer: 50 * 1024 * 1024 }).catch((e) => ({ stderr: String((e as { stderr?: string }).stderr ?? "") }));
    const cuts = parseSceneTimes(stderr);
    const width = video?.width ?? 0, height = video?.height ?? 0;
    return {
      available: true as const,
      durationSeconds: Number(duration.toFixed(2)),
      width,
      height,
      orientation: height > width ? "vertical" : height === width ? "square" : "horizontal",
      fps: den ? Number((num / den).toFixed(2)) : null,
      videoCodec: video?.codec_name ?? null,
      hasAudio: !!audio,
      bitrateKbps: probe.format?.bit_rate ? Math.round(Number(probe.format.bit_rate) / 1000) : null,
      ...pacingFromCuts(cuts, duration),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const scoreSchema = z.object({ score: z.number().min(0).max(100), rationale: z.string() });
const analysisSchema = z.object({
  overall: scoreSchema,
  hook: scoreSchema,
  clarity: scoreSchema,
  retention: scoreSchema,
  originality: scoreSchema,
  platformFit: scoreSchema,
  cta: scoreSchema,
  pacing: z.string(),
  storytelling: z.string(),
  titleFeedback: z.string(),
  descriptionFeedback: z.string(),
  hashtagFeedback: z.string(),
  audienceFit: z.string(),
  recommendations: z.array(z.object({ priority: z.number().int().min(1), title: z.string(), detail: z.string(), impact: z.enum(["high", "medium", "low"]) })).min(1).max(12),
  editingChanges: z.array(z.string()).max(10),
  alternativeHooks: z.array(z.string()).max(5),
  titleVariants: z.array(z.string()).max(6),
  confidence: z.enum(["low", "medium", "high"]),
  confidenceExplanation: z.string(),
});

export const analyzerInputSchema = z.object({
  assetId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  platform: z.enum(["YouTube", "YouTube Shorts", "TikTok", "Instagram Reels"]),
  title: z.string().max(200).default(""),
  description: z.string().max(5000).default(""),
  hashtags: z.string().max(1000).default(""),
  transcript: z.string().max(60000).default(""),
  audience: z.string().max(300).default(""),
});

export async function analyzeVideo(userId: string, raw: unknown) {
  const input = analyzerInputSchema.parse(raw);
  await assertOwned(userId, { projects: [input.projectId] });
  if (!input.assetId && !input.transcript.trim() && !input.title.trim()) throw new ApiError(400, "Provide a video file, a transcript, or at least a title to analyze.", "bad_request");
  let technical: Awaited<ReturnType<typeof technicalAnalysis>> | null = null;
  if (input.assetId) {
    const asset = await withUser(userId, async (tx) => (await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, input.assetId!)))[0]);
    if (!asset) throw notFound("Media asset");
    if (asset.kind !== "video") throw new ApiError(400, "Selected asset is not a video.", "bad_request");
    if (asset.sizeBytes > 500 * 1024 * 1024) technical = { available: false, reason: "File larger than 500 MB; technical analysis skipped in the web tier." };
    else technical = await technicalAnalysis({ storageKey: asset.storageKey }, asset.filename);
  }
  const { data, provider, model } = await generateStructured(analysisSchema, {
    system: `You are a video performance consultant. All scores are AI ASSESSMENTS of predicted quality, not measured performance. You do NOT know actual retention or views. Base pacing comments on the measured technical data when present. Lower your confidence when the transcript is missing.`,
    prompt: `Platform: ${input.platform}
Audience: ${input.audience || "not specified"}
Title: ${input.title || "(none)"}
Description: ${input.description || "(none)"}
Hashtags: ${input.hashtags || "(none)"}
Measured technical data: ${technical && technical.available ? JSON.stringify(technical) : "not available"}
Transcript:
${input.transcript ? input.transcript.slice(0, 50000) : "(no transcript provided)"}`,
    shapeHint: `{"overall":{"score":0-100,"rationale":string},"hook":{...},"clarity":{...},"retention":{...},"originality":{...},"platformFit":{...},"cta":{...},"pacing":string,"storytelling":string,"titleFeedback":string,"descriptionFeedback":string,"hashtagFeedback":string,"audienceFit":string,"recommendations":[{"priority":1,"title":string,"detail":string,"impact":"high|medium|low"}],"editingChanges":[string],"alternativeHooks":[string],"titleVariants":[string],"confidence":"low|medium|high","confidenceExplanation":string}`,
    maxTokens: 6000,
  });
  data.recommendations.sort((a, b) => a.priority - b.priority);
  const [row] = await withUser(userId, (tx) =>
    tx.insert(schema.videoAnalyses).values({ userId, assetId: input.assetId ?? null, projectId: input.projectId ?? null, platform: input.platform, input, technical: technical ?? undefined, result: { ...data, provider, model, label: "AI assessment — predicted quality, not actual performance" }, overallScore: Math.round(data.overall.score), confidence: data.confidence }).returning(),
  );
  return row;
}
