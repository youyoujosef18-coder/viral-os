import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceDb, schema, withUser } from "../db/client";
import { env } from "../env";
import { ApiError, badRequest, notFound } from "../api/errors";
import { ProviderError } from "../providers/http";
import { youtubeClipData, YOUTUBE_CAPTION_SCOPE, type ClipVideoDetails } from "../providers/platforms/youtube";
import { isAIConfigured } from "../providers/ai";
import { parseCaptions, segmentsInRange, type Segment } from "../clipping/transcript";
import { DEFAULT_RENDER } from "../clipping/render";
import { commentMentions, findYouTubeCandidates, parseChapters, parseRetention, parseYouTubeId, selectTop, type Chapter, type Mention, type RetentionPoint } from "../clipping/youtube-moments";
import { getValidAccessToken } from "./connections";
import { notify } from "./notifications";
import { logActivity } from "./activity";
import { enqueueClip } from "../queue/queues";
import { logger } from "../logger";
import { renderSettingsSchema } from "../clipping/settings";
import { aiEnrich, fallbackCopy, setJob } from "./clipping";
import { assertOwned } from "./ownership";

/**
 * Clip Studio for YouTube links.
 *
 * The video file is never downloaded, streamed or proxied: YouTube's Terms of Service only allow access to
 * videos through YouTube's own player and API, and the API policies forbid downloading or separating the
 * audio/video. Moments are found from official API data only, and each clip is a start/end range played
 * in the official embedded player. For videos on a channel the user has connected, the user can attach
 * their own original file and render real vertical clips from it with the regular engine.
 */

export const youtubeClipInputSchema = z
  .object({
    source: z.literal("youtube"),
    url: z.string().trim().min(1, "Paste a YouTube link").max(500),
    projectId: z.string().uuid().nullable().optional(),
    minSeconds: z.number().min(5).max(170).default(15),
    maxSeconds: z.number().min(8).max(180).default(60),
    count: z.number().int().min(1).max(12).default(5),
    /** youtube: caption track of your own video (captions.download); captions: an .srt/.vtt you supply; none */
    transcriptMode: z.enum(["youtube", "captions", "none"]).default("none"),
    captionsText: z.string().max(2_000_000).optional(),
    /** Pages of up to 100 comments read for timestamps (1 quota unit each). */
    commentPages: z.number().int().min(0).max(10).default(3),
    render: renderSettingsSchema.default(DEFAULT_RENDER),
  })
  .refine((v) => v.maxSeconds >= v.minSeconds + 3, { message: "Maximum length must be at least 3 seconds longer than the minimum", path: ["maxSeconds"] })
  .refine((v) => v.transcriptMode !== "captions" || !!v.captionsText?.trim(), { message: "Attach an .srt or .vtt file, or choose another transcript option", path: ["captionsText"] });

const ytSettingsSchema = z.object({
  minSeconds: z.number(),
  maxSeconds: z.number(),
  count: z.number().int(),
  transcriptMode: z.enum(["youtube", "captions", "none"]),
  commentPages: z.number().int(),
  render: renderSettingsSchema,
});

export type YouTubeSource = {
  provider: "youtube";
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  description: string;
  duration: number;
  embeddable: boolean;
  privacyStatus: string | null;
  /** The video is on a YouTube channel this user connected through OAuth. */
  owned: boolean;
  /** Connection whose channel owns the video (retention, captions, attaching the original). */
  connectionId: string | null;
  /** Connection used to read public data when no API key is configured. */
  readConnectionId: string | null;
  quotaUnits: number;
};

async function youtubeConnections(userId: string) {
  return serviceDb()
    .select()
    .from(schema.platformConnections)
    .where(and(eq(schema.platformConnections.userId, userId), eq(schema.platformConnections.platform, "youtube"), eq(schema.platformConnections.status, "active")));
}

/** What the Clip Studio form needs to know before a YouTube job is created. */
export async function youtubeClipCapabilities(userId: string) {
  const conns = await youtubeConnections(userId);
  return {
    apiKey: !!env().YOUTUBE_API_KEY,
    channels: conns.map((c) => ({ id: c.id, name: c.accountName, captions: c.scopes.includes(YOUTUBE_CAPTION_SCOPE) })),
    captionScopeRequested: env().YOUTUBE_CAPTION_ACCESS === "true",
  };
}

function providerToApi(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.opts.code === "not_configured") throw new ApiError(503, err.message, "not_configured", { integration: "YouTube Data API" });
    throw new ApiError(err.opts.status && err.opts.status < 500 ? 400 : 502, err.message, err.opts.code ?? "youtube_error");
  }
  throw err;
}

export async function createYouTubeClipJob(userId: string, raw: unknown) {
  const input = youtubeClipInputSchema.parse(raw);
  await assertOwned(userId, { projects: [input.projectId] });
  const videoId = parseYouTubeId(input.url);
  if (!videoId) throw badRequest("That isn't a YouTube video link. Paste a link like https://www.youtube.com/watch?v=… or https://youtu.be/…");

  const conns = await youtubeConnections(userId);
  const readConn = env().YOUTUBE_API_KEY ? null : conns[0] ?? null;
  let video: ClipVideoDetails | null;
  try {
    video = await youtubeClipData.video(videoId, readConn ? { accessToken: await getValidAccessToken(readConn) } : {});
  } catch (err) {
    providerToApi(err);
  }
  if (!video) throw notFound("YouTube video (it may be private, deleted or the link is wrong)");
  if (video.liveBroadcastContent === "live" || video.liveBroadcastContent === "upcoming") throw badRequest("Live streams and premieres can be clipped once they have ended.");
  if (!video.durationSeconds) throw badRequest("YouTube did not report a length for this video.");
  if (video.durationSeconds < input.minSeconds) throw badRequest(`The video is ${video.durationSeconds}s long, shorter than the ${input.minSeconds}s minimum clip length.`);

  const owner = conns.find((c) => c.externalAccountId === video.channelId) ?? null;
  if (input.transcriptMode === "youtube") {
    if (!owner) throw badRequest("YouTube captions can only be read for videos on a channel you've connected. Upload an .srt/.vtt file or choose 'No transcript'.");
    if (!owner.scopes.includes(YOUTUBE_CAPTION_SCOPE)) throw badRequest("Your YouTube connection doesn't include caption access. Set YOUTUBE_CAPTION_ACCESS=true, reconnect YouTube in Settings, or upload an .srt/.vtt file.");
  }
  const transcript: Segment[] | null = input.transcriptMode === "captions" ? parseCaptions(input.captionsText!) : null;

  const source: YouTubeSource = {
    provider: "youtube",
    videoId,
    title: video.title,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    publishedAt: video.publishedAt,
    thumbnailUrl: video.thumbnailUrl,
    description: (video.description ?? "").slice(0, 5000),
    duration: video.durationSeconds,
    embeddable: video.embeddable,
    privacyStatus: video.privacyStatus,
    owned: !!owner,
    connectionId: owner?.id ?? null,
    readConnectionId: readConn?.id ?? null,
    quotaUnits: 1,
  };
  const { captionsText, url, source: _s, projectId, ...settings } = input;
  void captionsText;
  void url;
  void _s;
  const [job] = await withUser(userId, (tx) =>
    tx
      .insert(schema.clipJobs)
      .values({
        userId,
        sourceType: "youtube",
        youtubeVideoId: videoId,
        projectId: projectId ?? null,
        settings,
        transcriptSource: input.transcriptMode === "youtube" ? "youtube" : input.transcriptMode === "captions" ? "provided" : "none",
        transcript,
        source,
        stage: "Waiting for the worker",
      })
      .returning(),
  );
  await enqueueClip({ kind: "analyze", jobId: job.id });
  await logActivity(userId, { action: "clips.job_created", entityType: "clip_job", entityId: job.id, summary: `Started finding clips in YouTube video "${video.title}"` });
  return job;
}

async function tokenFor(connectionId: string | null) {
  if (!connectionId) return undefined;
  const [conn] = await serviceDb().select().from(schema.platformConnections).where(eq(schema.platformConnections.id, connectionId));
  if (!conn) throw new Error("The YouTube connection used for this job was removed. Reconnect YouTube and retry.");
  return getValidAccessToken(conn);
}

/** Worker step for YouTube jobs. The job row has already been claimed by runClipJob. */
export async function runYouTubeJob(job: typeof schema.clipJobs.$inferSelect): Promise<"completed" | "failed"> {
  const db = serviceDb();
  const jobId = job.id;
  const settings = ytSettingsSchema.parse(job.settings);
  const src = job.source as unknown as YouTubeSource;
  const notes: string[] = [];
  let quota = src.quotaUnits ?? 0;
  try {
    const ownerToken = src.owned ? await tokenFor(src.connectionId) : undefined;
    const readAuth = env().YOUTUBE_API_KEY ? {} : { accessToken: ownerToken ?? (await tokenFor(src.readConnectionId)) };
    const duration = src.duration;

    await setJob(jobId, { stage: "Reading chapters and comments", progress: 15 });
    const { chapters, valid } = parseChapters(src.description, duration);
    if (chapters.length && !valid) notes.push("The description has timestamps that don't meet YouTube's chapter rules; they were still used as moment boundaries.");

    let mentions: Mention[] = [];
    if (settings.commentPages > 0) {
      const c = await youtubeClipData.comments(src.videoId, settings.commentPages, readAuth);
      quota += c.calls;
      if (c.disabled) notes.push("Comments are turned off on this video, so viewer timestamps weren't available.");
      mentions = commentMentions(c.comments, duration);
      if (!c.disabled) notes.push(`Read ${c.comments.length} comments; ${new Set(mentions.map((m) => m.excerpt)).size} mention a timestamp.`);
    }

    let retention: RetentionPoint[] | null = null;
    if (src.owned && ownerToken) {
      await setJob(jobId, { stage: "Reading audience retention", progress: 35 });
      const start = src.publishedAt.slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      try {
        let report;
        try {
          report = await youtubeClipData.retention(src.videoId, start, end, ownerToken);
        } catch (err) {
          if (!(err instanceof ProviderError) || err.opts.status !== 400) throw err;
          report = await youtubeClipData.retention(src.videoId, start, end, ownerToken, "audienceWatchRatio");
        }
        const pts = parseRetention(report);
        if (pts.length) retention = pts;
        else notes.push("YouTube Analytics returned no retention data for this video yet (new or low-view videos often have none).");
      } catch (err) {
        notes.push(`Audience retention couldn't be read (${(err as Error).message}).`);
      }
    } else if (!src.owned) {
      notes.push("This video isn't on a channel you've connected, so audience retention isn't available. Moments come from public data only.");
    }

    let transcript: Segment[] | null = job.transcript ?? null;
    if (job.transcriptSource === "youtube" && ownerToken) {
      await setJob(jobId, { status: "transcribing", stage: "Reading your caption track", progress: 50 });
      const tracks = (await youtubeClipData.captionTracks(src.videoId, ownerToken)).filter((t) => !t.isDraft && t.status !== "failed");
      quota += 50;
      const track = tracks.find((t) => t.kind === "standard") ?? tracks.find((t) => t.kind === "asr") ?? tracks[0];
      if (!track) notes.push("This video has no caption tracks yet, so clips were chosen without a transcript.");
      else {
        const vtt = await youtubeClipData.downloadCaption(track.id, ownerToken);
        quota += 200;
        transcript = parseCaptions(vtt);
        notes.push(`Used the ${track.kind === "asr" ? "automatic" : track.name || track.language} caption track.`);
      }
    }
    const usable = transcript?.filter((s) => s.start < duration) ?? [];

    await setJob(jobId, { status: "scoring", stage: "Finding and scoring moments", progress: 65, transcript: usable.length ? usable : null, signals: { kind: "youtube", chapters, mentions: mentions.map((m) => ({ t: m.t, weight: m.weight })), retention: retention?.map((p) => ({ ratio: p.ratio, watch: p.watch, relative: p.relative })) ?? null } });
    const max = Math.min(settings.maxSeconds, duration);
    const opts = { minSeconds: settings.minSeconds, maxSeconds: max, targetSeconds: Math.round((settings.minSeconds + max) / 2) };
    const cands = findYouTubeCandidates({ duration, segments: usable.length ? usable : undefined, chapters, mentions, retention }, opts);

    let inserted = 0;
    if (!cands.length) {
      notes.push("There were no chapters, timestamped comments, retention data or captions to find moments from. Add clips by hand with the start and end times you want.");
    } else {
      const diverse = selectTop(cands, settings.count, 0.15);
      const pool = [...diverse, ...selectTop(cands.filter((c) => !diverse.includes(c)), settings.count * 2, 0.5)];
      let ai: Awaited<ReturnType<typeof aiEnrich>> | null = null;
      if (usable.length && isAIConfigured()) {
        try {
          ai = await aiEnrich(pool);
        } catch (err) {
          notes.push(`AI titles and ranking were skipped (${(err as Error).message}). Clips are ranked by the computed score.`);
        }
      }
      const ranked = pool.map((c, i) => {
        const a = ai?.byIndex.get(i);
        return { c, a, final: a ? Math.round(0.5 * a.score + 0.5 * c.score) : c.score };
      });
      const chosen = selectTop(ranked.map((r) => ({ ...r.c, score: r.final })), settings.count).map((c) => ranked.find((r) => r.c.start === c.start && r.c.end === c.end)!);
      const rows = chosen.map((r, i) => {
        const copy = r.c.transcript ? fallbackCopy(r.c, i) : chapterCopy(chapters, r.c.start, i);
        return {
          userId: job.userId,
          jobId,
          rank: i + 1,
          startSec: r.c.start,
          endSec: r.c.end,
          title: r.a?.title ?? copy.title,
          hook: r.a?.hook ?? copy.hook,
          caption: r.a?.caption ?? copy.caption,
          hashtags: (r.a?.hashtags ?? []).map((h) => h.replace(/^#+/, "")),
          transcript: r.c.transcript,
          computedScore: r.c.score,
          scoreBreakdown: r.c.breakdown as Record<string, { value: number; weight: number; detail: string }>,
          aiScore: r.a ? Math.round(r.a.score) : null,
          aiReason: r.a ? `${r.a.reason} (${ai!.model})` : null,
          status: "embed",
          renderSettings: { ...settings.render, captions: settings.render.captions && usable.length > 0 },
        };
      });
      inserted = (await db.insert(schema.clips).values(rows).returning({ id: schema.clips.id })).length;
    }
    if (!src.embeddable) notes.push("The owner has turned off embedding for this video, so clips can't play here. Use the timestamp links to watch each clip on YouTube.");
    notes.push(`Used about ${quota} YouTube API quota units.`);

    await db.update(schema.clipJobs).set({ status: "completed", stage: "Done", progress: 100, notes, source: { ...src, quotaUnits: quota }, finishedAt: new Date(), lockedAt: null, updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
    await notify(job.userId, { type: "success", title: inserted ? `${inserted} clips found in "${src.title}"` : `No moments found automatically in "${src.title}"`, body: inserted ? undefined : "Add clips by hand with start and end times.", link: `/clips?job=${jobId}` });
    return "completed";
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    logger.warn("youtube clip job failed", { jobId, err: message });
    await db.update(schema.clipJobs).set({ status: "failed", stage: "Failed", error: message, notes, source: { ...src, quotaUnits: quota }, finishedAt: new Date(), lockedAt: null, updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
    await notify(job.userId, { type: "error", title: "Finding YouTube clips failed", body: message, link: `/clips?job=${jobId}` });
    return "failed";
  }
}

function chapterCopy(chapters: Chapter[], start: number, i: number) {
  const ch = chapters.find((c) => start >= c.start - 2 && start < c.end);
  // Times are shown next to the title and change when trimmed, so they stay out of it.
  return { title: ch ? ch.title : `Highlight ${i + 1}`, hook: null, caption: "" };
}

async function loadYouTubeJob(userId: string, jobId: string) {
  const [job] = await withUser(userId, (tx) => tx.select().from(schema.clipJobs).where(eq(schema.clipJobs.id, jobId)));
  if (!job) throw notFound("Clip job");
  if (job.sourceType !== "youtube") throw badRequest("This action is only for YouTube clip jobs.");
  return { job, src: job.source as unknown as YouTubeSource };
}

/**
 * Attach the creator's own original file so clips of their own YouTube video can be rendered as real files.
 * Only allowed when the video's channel is one of the user's OAuth-verified connections.
 */
export async function attachOriginal(userId: string, jobId: string, assetId: string) {
  const { job, src } = await loadYouTubeJob(userId, jobId);
  if (job.status !== "completed") throw new ApiError(409, "Wait for the job to finish before attaching a file.", "busy");
  const conns = await youtubeConnections(userId);
  if (!src.owned || !conns.some((c) => c.externalAccountId === src.channelId)) {
    throw new ApiError(403, "Only videos on a YouTube channel you've connected can be rendered from your own file. Clips of other videos play in YouTube's player.", "not_owner");
  }
  const [asset] = await withUser(userId, (tx) => tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)));
  if (!asset) throw notFound("Video file");
  if (asset.kind !== "video") throw badRequest("Choose a video file.");
  if (asset.durationSeconds && Math.abs(asset.durationSeconds - src.duration) > 2) {
    throw badRequest(`That file is ${asset.durationSeconds.toFixed(1)}s long but the YouTube video is ${src.duration}s. Attach the original file you uploaded to YouTube.`);
  }
  await withUser(userId, async (tx) => {
    await tx.update(schema.clipJobs).set({ sourceAssetId: asset.id, updatedAt: new Date() }).where(eq(schema.clipJobs.id, jobId));
    await tx.update(schema.clips).set({ status: "candidate", updatedAt: new Date() }).where(and(eq(schema.clips.jobId, jobId), eq(schema.clips.status, "embed")));
  });
  await logActivity(userId, { action: "clips.original_attached", entityType: "clip_job", entityId: jobId, summary: `Attached "${asset.filename}" to clips of "${src.title}"` });
  return { ok: true };
}

export const manualClipSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(1),
  title: z.string().trim().max(120).optional(),
});

/** Add a clip by hand (start/end in whole seconds, as the embedded player requires). */
export async function addManualClip(userId: string, jobId: string, raw: unknown) {
  const b = manualClipSchema.parse(raw);
  const { job, src } = await loadYouTubeJob(userId, jobId);
  if (job.status !== "completed") throw new ApiError(409, "Wait for the job to finish before adding clips.", "busy");
  const start = Math.floor(b.startSec), end = Math.ceil(b.endSec);
  if (end > Math.ceil(src.duration)) throw badRequest(`The video is only ${src.duration}s long.`);
  if (end - start < 1) throw badRequest("A clip must be at least 1 second long.");
  if (end - start > 180) throw badRequest("A clip can be at most 3 minutes long.");
  const settings = ytSettingsSchema.parse(job.settings);
  const [{ next }] = await withUser(userId, (tx) => tx.select({ next: sql<number>`coalesce(max(${schema.clips.rank}), 0)::int + 1` }).from(schema.clips).where(eq(schema.clips.jobId, jobId)));
  const transcript = job.transcript?.length ? segmentsInRange(job.transcript, start, end).map((s) => s.text).join(" ") : "";
  const [row] = await withUser(userId, (tx) =>
    tx
      .insert(schema.clips)
      .values({
        userId,
        jobId,
        rank: next,
        startSec: start,
        endSec: end,
        title: b.title?.trim() || `Clip ${next}`,
        transcript,
        computedScore: 0,
        scoreBreakdown: {},
        status: job.sourceAssetId ? "candidate" : "embed",
        renderSettings: { ...settings.render, captions: settings.render.captions && !!job.transcript?.length },
      })
      .returning(),
  );
  return row;
}

/** Clip ids of a job that are still embed-only (used by tests and the UI). */
export async function embedClipIds(userId: string, jobId: string) {
  const rows = await withUser(userId, (tx) => tx.select({ id: schema.clips.id }).from(schema.clips).where(and(eq(schema.clips.jobId, jobId), inArray(schema.clips.status, ["embed"]))));
  return rows.map((r) => r.id);
}
