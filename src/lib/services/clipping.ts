import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceDb, schema, withUser } from "../db/client";
import { storage } from "../storage";
import { probe, analyzeSignals, summarizeLoudness, type ProbeResult } from "../clipping/signals";
import { findCandidates, selectTop, WEIGHTS } from "../clipping/candidates";
import { parseCaptions, segmentsInRange, transcribeFile, isTranscriptionConfigured, type Segment } from "../clipping/transcript";
import { DEFAULT_RENDER, renderClip, type RenderSettings } from "../clipping/render";
import { renderSettingsSchema } from "../clipping/settings";
import { generateStructured, isAIConfigured } from "../providers/ai";
import { enqueueClip } from "../queue/queues";
import { notify } from "./notifications";
import { logActivity } from "./activity";
import { createPost } from "./publishing";
import { ApiError, badRequest, notFound } from "../api/errors";
import { logger } from "../logger";
import { createYouTubeClipJob, runYouTubeJob } from "./youtube-clips";
import { meteredFor } from "../usage";
import { assertOwned } from "./ownership";

// ------------------------------------------------------------------ input validation

export { renderSettingsSchema };

export const clipSettingsSchema = z.object({
    assetId: z.string().uuid(),
    projectId: z.string().uuid().nullable().optional(),
    minSeconds: z.number().min(5).max(170).default(15),
    maxSeconds: z.number().min(8).max(180).default(60),
    count: z.number().int().min(1).max(12).default(5),
    /** captions: use an uploaded .srt/.vtt; auto: speech-to-text; none: signal-only clipping. */
    transcriptMode: z.enum(["captions", "auto", "none"]).default("none"),
    captionsText: z.string().max(2_000_000).optional(),
    autoRender: z.boolean().default(true),
    render: renderSettingsSchema.default(DEFAULT_RENDER),
  });

export const clipJobInputSchema = clipSettingsSchema
  .refine((v) => v.maxSeconds >= v.minSeconds + 3, { message: "Maximum length must be at least 3 seconds longer than the minimum", path: ["maxSeconds"] })
  .refine((v) => v.transcriptMode !== "captions" || !!v.captionsText?.trim(), { message: "Attach an .srt or .vtt file, or choose another transcript option", path: ["captionsText"] });

export type ClipJobInput = z.infer<typeof clipJobInputSchema>;
type JobRow = typeof schema.clipJobs.$inferSelect;
type ClipRow = typeof schema.clips.$inferSelect;

const STALE_MINUTES = 30;

// ------------------------------------------------------------------ create / query

export async function createClipJob(userId: string, raw: unknown) {
  if (raw && typeof raw === "object" && (raw as { source?: unknown }).source === "youtube") return createYouTubeClipJob(userId, raw);
  const input = clipJobInputSchema.parse(raw);
  await assertOwned(userId, { projects: [input.projectId] });
  const asset = await withUser(userId, async (tx) => (await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, input.assetId)))[0]);
  if (!asset) throw notFound("Source video");
  if (asset.kind !== "video") throw badRequest("Choose a video file to clip.");
  let transcript: Segment[] | null = null;
  if (input.transcriptMode === "captions") transcript = parseCaptions(input.captionsText!); // validates now, before queueing
  if (input.transcriptMode === "auto" && !isTranscriptionConfigured()) throw new ApiError(503, "Automatic transcription needs OPENAI_API_KEY. Upload an .srt/.vtt file or choose 'No transcript'.", "not_configured", { integration: "Automatic transcription" });
  const { captionsText, ...settings } = input;
  void captionsText;
  const [job] = await withUser(userId, (tx) =>
    tx
      .insert(schema.clipJobs)
      .values({ userId, sourceAssetId: asset.id, projectId: input.projectId ?? null, settings, transcriptSource: input.transcriptMode === "captions" ? "provided" : input.transcriptMode === "auto" ? "openai" : "none", transcript, stage: "Waiting for the worker" })
      .returning(),
  );
  await enqueueClip({ kind: "analyze", jobId: job.id });
  await logActivity(userId, { action: "clips.job_created", entityType: "clip_job", entityId: job.id, summary: `Started clipping "${asset.filename}"` });
  return job;
}

export async function listClipJobs(userId: string) {
  return withUser(userId, async (tx) => {
    const jobs = await tx.select({ id: schema.clipJobs.id, sourceType: schema.clipJobs.sourceType, youtubeVideoId: schema.clipJobs.youtubeVideoId, status: schema.clipJobs.status, progress: schema.clipJobs.progress, stage: schema.clipJobs.stage, sourceAssetId: schema.clipJobs.sourceAssetId, transcriptSource: schema.clipJobs.transcriptSource, settings: schema.clipJobs.settings, error: schema.clipJobs.error, createdAt: schema.clipJobs.createdAt, finishedAt: schema.clipJobs.finishedAt, source: schema.clipJobs.source }).from(schema.clipJobs).orderBy(desc(schema.clipJobs.createdAt)).limit(100);
    const assets = jobs.length ? await tx.select({ id: schema.mediaAssets.id, filename: schema.mediaAssets.filename }).from(schema.mediaAssets).where(inArray(schema.mediaAssets.id, jobs.map((j) => j.sourceAssetId).filter((x): x is string => !!x))) : [];
    const counts = jobs.length ? await tx.select({ jobId: schema.clips.jobId, n: sql<number>`count(*)::int`, ready: sql<number>`count(*) filter (where ${schema.clips.status} = 'ready')::int` }).from(schema.clips).where(inArray(schema.clips.jobId, jobs.map((j) => j.id))).groupBy(schema.clips.jobId) : [];
    return jobs.map((j) => ({ ...j, sourceFilename: j.sourceType === "youtube" ? String((j.source as { title?: string } | null)?.title ?? "YouTube video") : assets.find((a) => a.id === j.sourceAssetId)?.filename ?? "Deleted video", clipCount: counts.find((c) => c.jobId === j.id)?.n ?? 0, readyCount: counts.find((c) => c.jobId === j.id)?.ready ?? 0 }));
  });
}

export async function getClipJob(userId: string, jobId: string) {
  return withUser(userId, async (tx) => {
    const [job] = await tx.select().from(schema.clipJobs).where(eq(schema.clipJobs.id, jobId));
    if (!job) throw notFound("Clip job");
    const rows = await tx.select().from(schema.clips).where(eq(schema.clips.jobId, jobId)).orderBy(schema.clips.rank);
    const [asset] = job.sourceAssetId ? await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, job.sourceAssetId)) : [];
    const { lockedAt, ...rest } = job;
    void lockedAt;
    return { ...rest, sourceAsset: asset ?? null, clips: rows.map(({ lockedAt: _l, ...c }) => (void _l, c)) };
  });
}

export async function deleteClipJob(userId: string, jobId: string) {
  const rows = await withUser(userId, (tx) => tx.delete(schema.clipJobs).where(eq(schema.clipJobs.id, jobId)).returning({ id: schema.clipJobs.id }));
  if (!rows.length) throw notFound("Clip job");
}

export async function retryClipJob(userId: string, jobId: string) {
  const [job] = await withUser(userId, (tx) =>
    tx.update(schema.clipJobs).set({ status: "queued", progress: 0, stage: "Waiting for the worker", error: null, lockedAt: null, updatedAt: new Date() }).where(and(eq(schema.clipJobs.id, jobId), eq(schema.clipJobs.status, "failed"))).returning(),
  );
  if (!job) throw new ApiError(409, "Only failed jobs can be retried.", "not_retryable");
  await withUser(userId, (tx) => tx.delete(schema.clips).where(eq(schema.clips.jobId, jobId)));
  await enqueueClip({ kind: "analyze", jobId });
}

// ------------------------------------------------------------------ worker: analysis

export async function setJob(jobId: string, patch: Partial<typeof schema.clipJobs.$inferInsert>) {
  await serviceDb().update(schema.clipJobs).set({ ...patch, lockedAt: new Date(), updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
}

/** Copy the source to a temp file the ffmpeg tools can seek in. */
async function materialize(storageKey: string, filename: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "vos-src-"));
  const file = path.join(dir, `source${path.extname(filename) || ".mp4"}`);
  await storage().downloadToFile(storageKey, file);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Title and caption derived from the transcript when no AI provider is available. */
export function fallbackCopy(c: { start: number; end: number; transcript: string }, index: number) {
  const text = c.transcript.trim();
  // No times in the title: they are shown next to it and change when the clip is trimmed.
  if (!text) return { title: `Highlight ${index + 1}`, hook: null, caption: "" };
  const firstSentence = (/^.*?[.!?](\s|$)/.exec(text)?.[0] ?? text).trim();
  const title = firstSentence.length > 70 ? `${firstSentence.slice(0, 67).trimEnd()}…` : firstSentence;
  return { title, hook: firstSentence, caption: text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text };
}

const aiSchema = z.object({
  clips: z.array(z.object({
    index: z.number().int().min(0),
    score: z.number().min(0).max(100),
    title: z.string().min(1).max(100),
    hook: z.string().max(200),
    caption: z.string().max(600),
    hashtags: z.array(z.string().max(40)).max(10),
    reason: z.string().max(400),
  })),
});

export async function aiEnrich(pool: { start: number; end: number; score: number; transcript: string }[]) {
  const { data, model } = await generateStructured(aiSchema, {
    system: "You are a short-form video editor. Rate how likely each excerpt works as a standalone short clip (strong hook, self-contained, emotional or useful payoff). Scores are your estimate, not measured performance. Write an original title, a hook line taken from or faithful to the excerpt, a caption and hashtags without '#'. Never invent facts that are not in the excerpt.",
    prompt: pool.map((c, i) => `#${i} (${fmtTime(c.start)}–${fmtTime(c.end)}, measured score ${c.score}): "${c.transcript.slice(0, 1200)}"`).join("\n\n"),
    shapeHint: `{"clips":[{"index":number,"score":0-100,"title":string,"hook":string,"caption":string,"hashtags":[string],"reason":string}]}`,
    maxTokens: 4000,
  });
  return { byIndex: new Map(data.clips.filter((c) => c.index < pool.length).map((c) => [c.index, c])), model };
}

/**
 * Analyze a source video and create ranked clip candidates (then render them if requested).
 * Claimed atomically: concurrent workers never run the same job twice; stale claims are recoverable.
 */
async function runClipJobUnmetered(jobId: string): Promise<"skipped" | "completed" | "failed"> {
  const db = serviceDb();
  const stale = sql`now() - (${STALE_MINUTES} || ' minutes')::interval`;
  const [job] = await db
    .update(schema.clipJobs)
    .set({ status: "analyzing", stage: "Reading the video", progress: 5, lockedAt: sql`now()`, startedAt: sql`coalesce(${schema.clipJobs.startedAt}, now())`, updatedAt: sql`now()` })
    .where(and(eq(schema.clipJobs.id, jobId), or(eq(schema.clipJobs.status, "queued"), and(inArray(schema.clipJobs.status, ["analyzing", "transcribing", "scoring"]), lt(schema.clipJobs.lockedAt, stale)))))
    .returning();
  if (!job) return "skipped";
  if (job.sourceType === "youtube") return runYouTubeJob(job);
  const settings = clipSettingsSchema.parse(job.settings);
  const notes: string[] = [];
  let src: Awaited<ReturnType<typeof materialize>> | null = null;
  try {
    const [asset] = job.sourceAssetId ? await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, job.sourceAssetId)) : [];
    if (!asset) throw new Error("The source video was deleted.");
    src = await materialize(asset.storageKey, asset.filename);
    const info = await probe(src.file);
    if (!info.hasVideo) throw new Error("The file has no video stream.");
    if (info.duration < settings.minSeconds) throw new Error(`The video is ${info.duration.toFixed(1)}s long, shorter than the ${settings.minSeconds}s minimum clip length.`);
    await setJob(jobId, { stage: "Measuring loudness, pauses and scene cuts", progress: 15, source: { ...info, filename: asset.filename } });

    const signals = await analyzeSignals(src.file, info);
    await setJob(jobId, { progress: 40, signals: { loudness: summarizeLoudness(signals.loudness), silences: signals.silences, cuts: signals.cuts, windowSeconds: 0.5 } });

    let transcript: Segment[] | null = job.transcript ?? null;
    if (job.transcriptSource === "openai") {
      await setJob(jobId, { status: "transcribing", stage: "Transcribing speech", progress: 45 });
      transcript = await transcribeFile(src.file, info.duration);
      if (!transcript.length) notes.push("No speech was detected, so clips were chosen from audio and visual signals only.");
      await setJob(jobId, { transcript });
    }
    if (transcript?.length && transcript[transcript.length - 1].start > info.duration + 1) notes.push("Some captions are timed past the end of the video and were ignored. Check that the caption file matches this video.");
    if (!transcript?.length && job.transcriptSource === "none") notes.push("No transcript: clips were chosen from measured loudness, pauses and scene cuts. Captions are off.");

    await setJob(jobId, { status: "scoring", stage: "Finding and scoring moments", progress: 60 });
    const opts = { minSeconds: settings.minSeconds, maxSeconds: Math.min(settings.maxSeconds, info.duration), targetSeconds: Math.round((settings.minSeconds + Math.min(settings.maxSeconds, info.duration)) / 2) };
    const usable = transcript?.filter((s) => s.start < info.duration) ?? [];
    let cands = findCandidates(info.duration, signals, opts, usable.length ? usable : undefined);
    if (!cands.length && usable.length) {
      notes.push("No run of complete sentences fits the chosen length, so clips follow pauses and cuts instead.");
      cands = findCandidates(info.duration, signals, opts);
    }
    if (!cands.length) throw new Error("No clip windows fit the chosen length range for this video.");

    // Shortlist for ranking: the best non-overlapping set first (so distinct moments are never crowded out),
    // then extra near-alternatives the AI may prefer.
    const diverse = selectTop(cands, settings.count, 0.15);
    const pool = [...diverse, ...selectTop(cands.filter((c) => !diverse.includes(c)), settings.count * 2, 0.5)];
    let ai: Awaited<ReturnType<typeof aiEnrich>> | null = null;
    if (usable.length && isAIConfigured()) {
      try {
        ai = await aiEnrich(pool);
      } catch (err) {
        notes.push(`AI titles and ranking were skipped (${(err as Error).message}). Clips are ranked by the measured score.`);
      }
    } else if (usable.length) notes.push("No AI provider configured: titles come from the transcript and ranking uses the measured score only.");

    const ranked = pool.map((c, i) => {
      const a = ai?.byIndex.get(i);
      return { c, a, final: a ? Math.round(0.5 * a.score + 0.5 * c.score) : c.score };
    });
    const chosen = selectTop(ranked.map((r) => ({ ...r.c, score: r.final })), settings.count).map((c) => ranked.find((r) => r.c.start === c.start && r.c.end === c.end)!);

    const rows = chosen.map((r, i) => {
      const fb = fallbackCopy(r.c, i);
      return {
        userId: job.userId,
        jobId,
        rank: i + 1,
        startSec: r.c.start,
        endSec: r.c.end,
        title: r.a?.title ?? fb.title,
        hook: r.a?.hook ?? fb.hook,
        caption: r.a?.caption ?? fb.caption,
        hashtags: (r.a?.hashtags ?? []).map((h) => h.replace(/^#+/, "")),
        transcript: r.c.transcript,
        computedScore: r.c.score,
        scoreBreakdown: r.c.breakdown,
        aiScore: r.a ? Math.round(r.a.score) : null,
        aiReason: r.a ? `${r.a.reason} (${ai!.model})` : null,
        status: settings.autoRender ? "queued" : "candidate",
        renderSettings: { ...settings.render, captions: settings.render.captions && usable.length > 0 },
      };
    });
    const inserted = await db.insert(schema.clips).values(rows).returning();
    await setJob(jobId, { notes, transcript: usable.length ? usable : null });

    if (settings.autoRender) {
      await setJob(jobId, { status: "rendering", stage: `Rendering ${inserted.length} clips`, progress: 70 });
      for (const [i, clip] of inserted.entries()) {
        await renderClipRow(clip.id, src.file, info);
        await setJob(jobId, { progress: 70 + Math.round((30 * (i + 1)) / inserted.length), stage: `Rendered ${i + 1} of ${inserted.length}` });
      }
    }
    await db.update(schema.clipJobs).set({ status: "completed", stage: "Done", progress: 100, finishedAt: new Date(), lockedAt: null, updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
    const failed = settings.autoRender ? (await db.select({ id: schema.clips.id }).from(schema.clips).where(and(eq(schema.clips.jobId, jobId), eq(schema.clips.status, "failed")))).length : 0;
    await notify(job.userId, { type: failed ? "warning" : "success", title: `${inserted.length} clips ready from "${asset.filename}"`, body: failed ? `${failed} clip(s) failed to render; open the job to retry them.` : undefined, link: `/clips?job=${jobId}` });
    return "completed";
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    logger.warn("clip job failed", { jobId, err: message });
    await db.update(schema.clipJobs).set({ status: "failed", stage: "Failed", error: message, notes, finishedAt: new Date(), lockedAt: null, updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
    await notify(job.userId, { type: "error", title: "Clipping failed", body: message, link: `/clips?job=${jobId}` });
    return "failed";
  } finally {
    await src?.cleanup();
  }
}

// ------------------------------------------------------------------ worker: rendering

/** Render one clip. `localSource`/`info` let the analysis step reuse the already-downloaded source. */
async function renderClipRowUnmetered(clipId: string, localSource?: string, info?: ProbeResult): Promise<"skipped" | "ready" | "failed"> {
  const db = serviceDb();
  const stale = sql`now() - (${STALE_MINUTES} || ' minutes')::interval`;
  const [clip] = await db
    .update(schema.clips)
    .set({ status: "rendering", error: null, lockedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(schema.clips.id, clipId), or(eq(schema.clips.status, "queued"), and(eq(schema.clips.status, "rendering"), lt(schema.clips.lockedAt, stale)))))
    .returning();
  if (!clip) return "skipped";
  let src: Awaited<ReturnType<typeof materialize>> | null = null;
  let out: Awaited<ReturnType<typeof renderClip>> | null = null;
  try {
    const [job] = await db.select().from(schema.clipJobs).where(eq(schema.clipJobs.id, clip.jobId));
    const [asset] = job?.sourceAssetId ? await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, job.sourceAssetId)) : [];
    if (!asset) throw new Error("The source video was deleted.");
    let file = localSource;
    if (!file) {
      src = await materialize(asset.storageKey, asset.filename);
      file = src.file;
    }
    const meta = info ?? (await probe(file));
    if (job.sourceType === "youtube") {
      const ytDuration = Number((job.source as { duration?: number } | null)?.duration ?? 0);
      if (ytDuration && Math.abs(meta.duration - ytDuration) > 2) throw new Error(`The attached file is ${meta.duration.toFixed(1)}s long but the YouTube video is ${ytDuration}s. Attach the original file you uploaded to YouTube.`);
    }
    const settings = renderSettingsSchema.parse(clip.renderSettings) as RenderSettings;
    const captions = job.transcript?.length ? segmentsInRange(job.transcript, clip.startSec, clip.endSec) : null;
    out = await renderClip(file, meta, clip.startSec, clip.endSec, settings, captions);

    const base = `${clip.title.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "clip"}-${clip.rank}`;
    const month = new Date().toISOString().slice(0, 7);
    const videoKey = `${clip.userId}/${month}/${randomUUID()}-${base}.mp4`;
    const thumbKey = `${clip.userId}/${month}/${randomUUID()}-${base}.jpg`;
    await storage().putFile(videoKey, out.file, "video/mp4");
    await storage().putFile(thumbKey, out.thumbnail, "image/jpeg");
    const [video] = await db.insert(schema.mediaAssets).values({ userId: clip.userId, kind: "video", filename: `${base}.mp4`, mimeType: "video/mp4", sizeBytes: (await stat(out.file)).size, storageKey: videoKey, width: out.width, height: out.height, durationSeconds: out.duration, folder: "Clips", tags: ["clip"] }).returning();
    const [thumb] = await db.insert(schema.mediaAssets).values({ userId: clip.userId, kind: "image", filename: `${base}.jpg`, mimeType: "image/jpeg", sizeBytes: (await stat(out.thumbnail)).size, storageKey: thumbKey, width: out.width, height: out.height, folder: "Clips", tags: ["clip", "thumbnail"] }).returning();

    // Replace a previous render's files when re-rendering after a trim.
    const old = [clip.assetId, clip.thumbnailAssetId].filter((x): x is string => !!x);
    await db.update(schema.clips).set({ status: "ready", assetId: video.id, thumbnailAssetId: thumb.id, renderInfo: { width: out.width, height: out.height, duration: Number(out.duration.toFixed(2)), reframe: out.mode, captions: !!captions?.length && settings.captions, renderedAt: new Date().toISOString() }, lockedAt: null, updatedAt: new Date() }).where(eq(schema.clips.id, clip.id));
    if (old.length) {
      const prev = await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, old)).returning({ key: schema.mediaAssets.storageKey });
      for (const p of prev) await storage().remove(p.key).catch(() => {});
    }
    return "ready";
  } catch (err) {
    await db.update(schema.clips).set({ status: "failed", error: (err as Error).message.slice(0, 1000), lockedAt: null, updatedAt: new Date() }).where(eq(schema.clips.id, clip.id));
    return "failed";
  } finally {
    await out?.cleanup();
    await src?.cleanup();
  }
}

export const clipUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  hook: z.string().max(300).nullable().optional(),
  caption: z.string().max(2200).optional(),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  render: renderSettingsSchema.partial().optional(),
});

/** Edit copy, trim points or render settings. Changing timing or render settings re-queues a render. */
export async function updateClip(userId: string, clipId: string, raw: unknown) {
  const b = clipUpdateSchema.parse(raw);
  const { clip, job } = await withUser(userId, async (tx) => {
    const [clip] = await tx.select().from(schema.clips).where(eq(schema.clips.id, clipId));
    if (!clip) throw notFound("Clip");
    const [job] = await tx.select().from(schema.clipJobs).where(eq(schema.clipJobs.id, clip.jobId));
    return { clip, job };
  });
  const duration = Number((job.source as { duration?: number } | null)?.duration ?? Infinity);
  const youtube = job.sourceType === "youtube";
  // The embedded player only accepts whole seconds.
  const start = youtube ? Math.floor(b.startSec ?? clip.startSec) : b.startSec ?? clip.startSec;
  const end = youtube ? Math.ceil(b.endSec ?? clip.endSec) : b.endSec ?? clip.endSec;
  if (end > duration + 0.01) throw badRequest(`The source video is only ${duration.toFixed(1)}s long.`);
  if (end - start < 1) throw badRequest("A clip must be at least 1 second long.");
  if (end - start > 180) throw badRequest("A clip can be at most 3 minutes long.");
  if (clip.status === "rendering") throw new ApiError(409, "This clip is rendering. Wait for it to finish, then edit.", "locked");
  const retime = b.startSec !== undefined || b.endSec !== undefined || b.render !== undefined;
  const embedOnly = clip.status === "embed"; // nothing to render: the clip plays in YouTube's player
  const transcript = retime && job.transcript ? segmentsInRange(job.transcript, start, end).map((s) => s.text).join(" ") : undefined;
  const [row] = await withUser(userId, (tx) =>
    tx
      .update(schema.clips)
      .set({
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.hook !== undefined ? { hook: b.hook } : {}),
        ...(b.caption !== undefined ? { caption: b.caption } : {}),
        ...(b.hashtags !== undefined ? { hashtags: b.hashtags.map((h) => h.replace(/^#+/, "")).filter(Boolean) } : {}),
        startSec: start,
        endSec: end,
        ...(transcript !== undefined ? { transcript } : {}),
        ...(b.render ? { renderSettings: { ...clip.renderSettings, ...b.render } } : {}),
        ...(retime && !embedOnly ? { status: "queued" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.clips.id, clipId))
      .returning(),
  );
  if (retime && !embedOnly) await enqueueClip({ kind: "render", clipId });
  return row;
}

export async function requestRender(userId: string, clipId: string) {
  const [current] = await withUser(userId, (tx) => tx.select({ status: schema.clips.status }).from(schema.clips).where(eq(schema.clips.id, clipId)));
  if (!current) throw notFound("Clip");
  if (current.status === "embed") throw new ApiError(409, "This clip plays in YouTube's player. To render a file, attach your original video (only for videos on your connected channel).", "embed_only");
  const [row] = await withUser(userId, (tx) =>
    tx.update(schema.clips).set({ status: "queued", error: null, updatedAt: new Date() }).where(and(eq(schema.clips.id, clipId), inArray(schema.clips.status, ["candidate", "failed", "ready"]))).returning(),
  );
  if (!row) throw new ApiError(409, "This clip is already queued or rendering.", "busy");
  await enqueueClip({ kind: "render", clipId });
  return row;
}

export async function deleteClip(userId: string, clipId: string) {
  const [row] = await withUser(userId, (tx) => tx.delete(schema.clips).where(eq(schema.clips.id, clipId)).returning());
  if (!row) throw notFound("Clip");
}

/** Create a draft post in the Publishing Center from a rendered clip. */
export async function createPostFromClip(userId: string, clipId: string) {
  const [clip] = await withUser(userId, (tx) => tx.select().from(schema.clips).where(eq(schema.clips.id, clipId)));
  if (!clip) throw notFound("Clip");
  if (clip.status !== "ready" || !clip.assetId) throw new ApiError(409, "Render this clip before creating a post from it.", "not_rendered");
  const [job] = await withUser(userId, (tx) => tx.select({ projectId: schema.clipJobs.projectId }).from(schema.clipJobs).where(eq(schema.clipJobs.id, clip.jobId)));
  const tags = clip.hashtags.length ? `\n\n${clip.hashtags.map((h) => `#${h}`).join(" ")}` : "";
  const post = await createPost(userId, { title: clip.title.slice(0, 200), baseCaption: `${clip.caption}${tags}`.trim().slice(0, 5000), mediaAssetId: clip.assetId, thumbnailAssetId: clip.thumbnailAssetId, projectId: job?.projectId ?? null, status: "draft", targets: [] });
  await logActivity(userId, { action: "clips.post_created", entityType: "post", entityId: post.id, summary: `Created a post from clip "${clip.title}"` });
  return post;
}

/** Durable recovery: run queued work and reclaim stale work regardless of the Redis queue state. */
export async function reconcileClips(limit = 5) {
  const db = serviceDb();
  const stale = sql`now() - (${STALE_MINUTES} || ' minutes')::interval`;
  const jobs = await db.select({ id: schema.clipJobs.id }).from(schema.clipJobs).where(or(eq(schema.clipJobs.status, "queued"), and(inArray(schema.clipJobs.status, ["analyzing", "transcribing", "scoring"]), lt(schema.clipJobs.lockedAt, stale)))).orderBy(schema.clipJobs.createdAt).limit(limit);
  for (const j of jobs) await runClipJob(j.id);
  const renders = await db.select({ id: schema.clips.id }).from(schema.clips).where(or(eq(schema.clips.status, "queued"), and(eq(schema.clips.status, "rendering"), lt(schema.clips.lockedAt, stale)))).orderBy(schema.clips.updatedAt).limit(limit * 3);
  for (const r of renders) await renderClipRow(r.id);
  return { jobs: jobs.length, renders: renders.length };
}

export const SCORE_WEIGHTS_DOC = WEIGHTS;
export type { JobRow, ClipRow };

export function runClipJob(jobId: string): Promise<"skipped" | "completed" | "failed"> {
  return meteredFor("clip_jobs", jobId, () => runClipJobUnmetered(jobId));
}

export function renderClipRow(clipId: string, localSource?: string, info?: ProbeResult): Promise<"skipped" | "ready" | "failed"> {
  return meteredFor("clips", clipId, () => renderClipRowUnmetered(clipId, localSource, info));
}
